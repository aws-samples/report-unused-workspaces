import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  DescribeWorkspacesCommand,
  DescribeWorkspacesConnectionStatusCommand,
  RunningMode,
  Workspace,
  WorkspaceConnectionStatus,
  WorkSpacesClient,
} from '@aws-sdk/client-workspaces';
import type { ScheduledHandler } from 'aws-lambda';

/** Details collected for a single workspace flagged in the report. */
export interface WorkspaceRecord {
  workspaceId: string;
  /** Days since the last known user connection, or `null` if never connected. */
  daysUnused: number | null;
  userName?: string;
  directoryId?: string;
  bundleId?: string;
  /** AlwaysOn billing is the most wasteful for idle workspaces. */
  runningMode?: string;
}

export interface UnusedReport {
  /** Workspaces unused for >= threshold days, sorted ascending by days unused. */
  unused: WorkspaceRecord[];
  /** Workspaces that have never recorded a user connection. */
  unknown: WorkspaceRecord[];
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const region = process.env.AWS_REGION;
const workspaces = new WorkSpacesClient({ region });
const sns = new SNSClient({ region });
const s3 = new S3Client({ region });

export const handler: ScheduledHandler = async () => {
  const unusedDays = Number(requireEnv('UNUSED_DAYS'));
  const topicArn = requireEnv('SNS_TOPIC_ARN');
  const bucketName = requireEnv('BUCKET_NAME');

  const now = new Date();
  const report = await collectUnusedWorkspaces(workspaces, unusedDays, now);

  const csv = buildCsv(report);
  await uploadCsv(bucketName, csv, now);
  await publishReport(topicArn, report, unusedDays, now);
};

/**
 * Queries WorkSpaces connection status (paginated), enriches each flagged
 * workspace with metadata, and buckets them into "unused" vs "never connected".
 */
export async function collectUnusedWorkspaces(
  client: WorkSpacesClient,
  thresholdDays: number,
  now: Date,
): Promise<UnusedReport> {
  const statuses: WorkspaceConnectionStatus[] = [];

  let nextToken: string | undefined;
  do {
    const resp = await client.send(
      new DescribeWorkspacesConnectionStatusCommand({ NextToken: nextToken }),
    );
    statuses.push(...(resp.WorkspacesConnectionStatus ?? []));
    nextToken = resp.NextToken;
  } while (nextToken);

  const unusedIds: { id: string; days: number }[] = [];
  const unknownIds: string[] = [];

  for (const ws of statuses) {
    const classification = classify(ws, thresholdDays, now);
    if (classification === undefined) continue;
    if (classification === null) {
      unknownIds.push(ws.WorkspaceId as string);
    } else {
      unusedIds.push({ id: ws.WorkspaceId as string, days: classification });
    }
  }

  const flaggedIds = [...unusedIds.map((u) => u.id), ...unknownIds];
  const metadata = await describeWorkspaces(client, flaggedIds);

  const unused: WorkspaceRecord[] = unusedIds
    .sort((a, b) => a.days - b.days)
    .map(({ id, days }) => buildRecord(id, days, metadata.get(id)));
  const unknown: WorkspaceRecord[] = unknownIds.map((id) =>
    buildRecord(id, null, metadata.get(id)),
  );

  return { unused, unknown };
}

/**
 * Classifies a connection-status entry.
 * @returns the number of days unused (>= threshold), `null` if never connected,
 *   or `undefined` if the workspace should be ignored (missing id or below threshold).
 */
export function classify(
  ws: WorkspaceConnectionStatus,
  thresholdDays: number,
  now: Date,
): number | null | undefined {
  const id = ws.WorkspaceId;
  if (!id) return undefined;

  const last = ws.LastKnownUserConnectionTimestamp;
  if (!last) return null;

  const days = Math.floor((now.getTime() - new Date(last).getTime()) / MS_PER_DAY);
  return days >= thresholdDays ? days : undefined;
}

/** Fetches workspace metadata in batches of 25 (DescribeWorkspaces limit). */
async function describeWorkspaces(
  client: WorkSpacesClient,
  ids: string[],
): Promise<Map<string, Workspace>> {
  const result = new Map<string, Workspace>();
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    if (batch.length === 0) continue;
    const resp = await client.send(new DescribeWorkspacesCommand({ WorkspaceIds: batch }));
    for (const ws of resp.Workspaces ?? []) {
      if (ws.WorkspaceId) result.set(ws.WorkspaceId, ws);
    }
  }
  return result;
}

function buildRecord(
  id: string,
  daysUnused: number | null,
  meta: Workspace | undefined,
): WorkspaceRecord {
  return {
    workspaceId: id,
    daysUnused,
    userName: meta?.UserName,
    directoryId: meta?.DirectoryId,
    bundleId: meta?.BundleId,
    runningMode: meta?.WorkspaceProperties?.RunningMode,
  };
}

const CSV_HEADER = 'WorkspaceId,UserName,DirectoryId,BundleId,RunningMode,DaysUnused';

export function buildCsv(report: UnusedReport): string {
  const rows: string[] = [CSV_HEADER];
  for (const r of report.unused) rows.push(csvRow(r, String(r.daysUnused)));
  for (const r of report.unknown) rows.push(csvRow(r, 'not used'));
  return rows.join('\r\n') + '\r\n';
}

function csvRow(r: WorkspaceRecord, days: string): string {
  return [r.workspaceId, r.userName ?? '', r.directoryId ?? '', r.bundleId ?? '', r.runningMode ?? '', days]
    .map(csvEscape)
    .join(',');
}

/**
 * Escapes a value per RFC 4180 and neutralizes CSV/formula injection.
 * Values beginning with =, +, -, @, tab, or CR are prefixed with a single
 * quote so spreadsheet apps treat them as text, not formulas.
 */
export function csvEscape(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) {
    v = `'${v}`;
  }
  if (/[",\r\n]/.test(v)) {
    v = `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

async function uploadCsv(bucketName: string, csv: string, now: Date): Promise<void> {
  const key = `reports/unused_workspaces_report_${formatDate(now)}.csv`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: csv,
      ContentType: 'text/csv',
      ServerSideEncryption: 'AES256',
    }),
  );
}

const DIVIDER = '='.repeat(52);
const SUB_DIVIDER = '-'.repeat(52);

/** Builds the human-readable email body. Pure and exported for testing. */
export function buildMessage(report: UnusedReport, thresholdDays: number): string {
  const lines: string[] = [];

  // Header + at-a-glance summary.
  lines.push('Amazon WorkSpaces - Unused Report', DIVIDER, '');
  lines.push(`Idle for ${thresholdDays}+ days`.padEnd(20) + `: ${report.unused.length}`);
  lines.push('Never connected'.padEnd(20) + `: ${report.unknown.length}`);
  lines.push('');

  // --- Unused workspaces ---------------------------------------------------
  lines.push(SUB_DIVIDER, `UNUSED WORKSPACES (idle ${thresholdDays}+ days)`, SUB_DIVIDER, '');

  if (report.unused.length > 0) {
    report.unused.forEach((r, i) => {
      lines.push(
        `${i + 1}) ${r.workspaceId}`,
        `     User         : ${r.userName ?? 'n/a'}`,
        `     Bundle       : ${r.bundleId ?? 'n/a'}`,
        `     Running mode : ${r.runningMode ?? 'n/a'}`,
        `     Days unused  : ${r.daysUnused}`,
        '',
      );
    });

    const alwaysOn = report.unused.filter((r) => r.runningMode === RunningMode.ALWAYS_ON).length;
    if (alwaysOn > 0) {
      lines.push(
        `Note: ${alwaysOn} of these run in ALWAYS_ON billing mode. Switching idle`,
        'workspaces to AUTO_STOP (or terminating them) typically reduces cost.',
        '',
      );
    }
  } else {
    lines.push(`There are no unused workspaces in the last ${thresholdDays} days.`, '');
  }

  // --- Never connected -----------------------------------------------------
  lines.push(SUB_DIVIDER, 'NEVER CONNECTED', SUB_DIVIDER, '');

  if (report.unknown.length > 0) {
    report.unknown.forEach((r, i) => {
      lines.push(
        `${i + 1}) ${r.workspaceId}`,
        `     User   : ${r.userName ?? 'n/a'}`,
        `     Bundle : ${r.bundleId ?? 'n/a'}`,
        '',
      );
    });
    lines.push('These WorkSpaces have not recorded a user connection since creation.', '');
  } else {
    lines.push('No WorkSpaces with unknown last usage.', '');
  }

  lines.push(
    SUB_DIVIDER,
    'Source: workspaces:DescribeWorkspacesConnectionStatus + DescribeWorkspaces.',
    'A detailed CSV of this report is stored in S3.',
    '',
    'Regards,',
    'Amazon WorkSpaces report',
  );

  return lines.join('\n');
}

async function publishReport(
  topicArn: string,
  report: UnusedReport,
  unusedDays: number,
  now: Date,
): Promise<void> {
  if (report.unused.length === 0 && report.unknown.length === 0) {
    console.info('No unused workspaces to report.');
    return;
  }

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: `Report: Unused Amazon WorkSpaces (${formatDate(now)})`,
      Message: buildMessage(report, unusedDays),
    }),
  );
}

export function formatDate(d: Date): string {
  // Stable ISO date (UTC), no locale dependence.
  return d.toISOString().slice(0, 10);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
