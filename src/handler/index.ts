import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { PricingClient } from '@aws-sdk/client-pricing';
import {
  DescribeWorkspacesCommand,
  DescribeWorkspacesConnectionStatusCommand,
  RunningMode,
  Workspace,
  WorkspaceConnectionStatus,
  WorkSpacesClient,
} from '@aws-sdk/client-workspaces';
import type { ScheduledHandler } from 'aws-lambda';
import { fetchPriceTable, PRICING_API_REGION } from './pricing';

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
  /** WorkSpaces compute type (VALUE, STANDARD, PERFORMANCE, POWER, ...). */
  computeType?: string;
  /**
   * Estimated current monthly cost in USD, derived from the price table and
   * running mode. `undefined` when the compute type has no configured price.
   */
  estimatedMonthlyCostUsd?: number;
}

export interface UnusedReport {
  /** Workspaces unused for >= threshold days, sorted ascending by days unused. */
  unused: WorkspaceRecord[];
  /** Workspaces that have never recorded a user connection. */
  unknown: WorkspaceRecord[];
}

/** Estimated monthly USD price for a single compute type. */
export interface ComputePrice {
  /** Flat monthly rate when billed ALWAYS_ON. */
  readonly alwaysOn: number;
  /** Monthly base fee under AUTO_STOP (excludes hourly usage, ~0 when idle). */
  readonly autoStopBase: number;
}

export type PriceTable = Record<string, ComputePrice>;

/**
 * Rough monthly USD estimates per compute type (Amazon WorkSpaces Personal,
 * us-east-1 ballpark figures). These are ESTIMATES used only to size the
 * potential savings opportunity; actual billing varies by region, OS, bundle,
 * license, and usage. Override per environment via the WORKSPACE_PRICES_JSON
 * env var. Authoritative numbers live in AWS Cost Explorer / the pricing page.
 */
export const DEFAULT_PRICES: PriceTable = {
  VALUE: { alwaysOn: 21, autoStopBase: 7.25 },
  STANDARD: { alwaysOn: 35, autoStopBase: 9.75 },
  PERFORMANCE: { alwaysOn: 60, autoStopBase: 13 },
  POWER: { alwaysOn: 78, autoStopBase: 19 },
  POWERPRO: { alwaysOn: 124, autoStopBase: 38 },
  GRAPHICS_G4DN: { alwaysOn: 220, autoStopBase: 35 },
  GRAPHICSPRO_G4DN: { alwaysOn: 350, autoStopBase: 92 },
};

/**
 * Aggregate FinOps view of the idle-WorkSpaces spend.
 *
 * Important distinction: "current run-rate" is what is being spent on idle
 * WorkSpaces right now; "realizable saving by termination" is what stops being
 * billed if those WorkSpaces are terminated (this tool's only lever). For an
 * idle WorkSpace those are numerically equal, but they are different concepts
 * and are labeled as such. Billing-mode switching (AlwaysOn<->AutoStop) is NOT
 * modeled here; that is handled by Cost Optimizer for Amazon WorkSpaces (WCO).
 */
export interface SavingsSummary {
  /** Sum of current estimated monthly run-rate of all priced, flagged workspaces. */
  totalMonthlyUsd: number;
  /** Annualized projection (monthly * 12). */
  totalAnnualUsd: number;
  /** Number of workspaces with a known estimated cost. */
  pricedCount: number;
  /** Number of workspaces whose compute type had no configured price. */
  unpricedCount: number;
  /**
   * Monthly run-rate of idle ALWAYS_ON workspaces. Highest-value, highest-
   * confidence saving (the full flat fee is wasted) and a possible WCO gap.
   */
  alwaysOnMonthlyUsd: number;
  /** Count of idle ALWAYS_ON workspaces with a price estimate. */
  alwaysOnCount: number;
  /**
   * Monthly run-rate of idle AUTO_STOP workspaces. Lower value: an idle
   * AUTO_STOP workspace already bills close to its fixed monthly base fee.
   */
  autoStopMonthlyUsd: number;
  /** Count of idle AUTO_STOP workspaces with a price estimate. */
  autoStopCount: number;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const region = process.env.AWS_REGION;
const workspaces = new WorkSpacesClient({ region });
const sns = new SNSClient({ region });
const s3 = new S3Client({ region });
// The Pricing API is only served from specific Regions; target Region is passed
// as a filter, not as the client Region.
const pricing = new PricingClient({ region: PRICING_API_REGION });

export const handler: ScheduledHandler = async () => {
  const unusedDays = Number(requireEnv('UNUSED_DAYS'));
  const topicArn = requireEnv('SNS_TOPIC_ARN');
  const bucketName = requireEnv('BUCKET_NAME');
  const prices = await resolvePrices();

  const now = new Date();
  const report = await collectUnusedWorkspaces(workspaces, unusedDays, now, prices);

  const csv = buildCsv(report);
  await uploadCsv(bucketName, csv, now);
  await publishReport(topicArn, report, unusedDays, now);
};

/**
 * Resolves the price table using a layered strategy, most authoritative first:
 *  1. Live AWS Price List API (when USE_PRICING_API is enabled),
 *  2. WORKSPACE_PRICES_JSON override,
 *  3. built-in DEFAULT_PRICES.
 * Each layer is merged over the next, and pricing failures never break the run.
 */
export async function resolvePrices(): Promise<PriceTable> {
  const base = loadPrices(process.env.WORKSPACE_PRICES_JSON);

  if (process.env.USE_PRICING_API !== 'true') {
    return base;
  }

  const regionCode = process.env.PRICING_REGION_CODE ?? region;
  if (!regionCode) {
    console.warn('USE_PRICING_API is set but no Region is available; using configured prices.');
    return base;
  }

  try {
    const live = await fetchPriceTable(pricing, regionCode);
    const count = Object.keys(live).length;
    if (count === 0) {
      console.warn('Pricing API returned no usable prices; using configured prices.');
      return base;
    }
    console.info(`Loaded ${count} compute-type prices from the Pricing API.`);
    // Live prices win, but keep configured/default entries for any gaps.
    return { ...base, ...live };
  } catch (err) {
    console.warn('Pricing API lookup failed; using configured prices.', err);
    return base;
  }
}

/**
 * Parses an optional JSON price-table override, falling back to DEFAULT_PRICES.
 * Compute-type keys are upper-cased so they match the SDK's ComputeTypeName.
 */
export function loadPrices(json: string | undefined): PriceTable {
  if (!json) return DEFAULT_PRICES;
  try {
    const parsed = JSON.parse(json) as PriceTable;
    const normalized: PriceTable = {};
    for (const [key, value] of Object.entries(parsed)) {
      normalized[key.toUpperCase()] = value;
    }
    return { ...DEFAULT_PRICES, ...normalized };
  } catch (err) {
    console.warn('Invalid WORKSPACE_PRICES_JSON; using default prices.', err);
    return DEFAULT_PRICES;
  }
}

/**
 * Estimates the current monthly USD cost of a workspace from its compute type
 * and running mode. Returns `undefined` when the compute type is unknown/unpriced.
 */
export function estimateMonthlyCost(
  computeType: string | undefined,
  runningMode: string | undefined,
  prices: PriceTable,
): number | undefined {
  if (!computeType) return undefined;
  const price = prices[computeType.toUpperCase()];
  if (!price) return undefined;
  // An idle AUTO_STOP workspace still incurs its monthly base fee; an idle
  // ALWAYS_ON workspace incurs the full flat rate.
  return runningMode === RunningMode.AUTO_STOP ? price.autoStopBase : price.alwaysOn;
}

/** Aggregates the idle-spend / termination-saving view across flagged workspaces. */
export function summarizeSavings(report: UnusedReport): SavingsSummary {
  const all = [...report.unused, ...report.unknown];
  let totalMonthlyUsd = 0;
  let pricedCount = 0;
  let unpricedCount = 0;
  let alwaysOnMonthlyUsd = 0;
  let alwaysOnCount = 0;
  let autoStopMonthlyUsd = 0;
  let autoStopCount = 0;

  for (const r of all) {
    if (typeof r.estimatedMonthlyCostUsd !== 'number') {
      unpricedCount += 1;
      continue;
    }
    totalMonthlyUsd += r.estimatedMonthlyCostUsd;
    pricedCount += 1;

    if (r.runningMode === RunningMode.ALWAYS_ON) {
      alwaysOnMonthlyUsd += r.estimatedMonthlyCostUsd;
      alwaysOnCount += 1;
    } else if (r.runningMode === RunningMode.AUTO_STOP) {
      autoStopMonthlyUsd += r.estimatedMonthlyCostUsd;
      autoStopCount += 1;
    }
  }

  return {
    totalMonthlyUsd: round2(totalMonthlyUsd),
    totalAnnualUsd: round2(totalMonthlyUsd * 12),
    pricedCount,
    unpricedCount,
    alwaysOnMonthlyUsd: round2(alwaysOnMonthlyUsd),
    alwaysOnCount,
    autoStopMonthlyUsd: round2(autoStopMonthlyUsd),
    autoStopCount,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Queries WorkSpaces connection status (paginated), enriches each flagged
 * workspace with metadata, and buckets them into "unused" vs "never connected".
 */
export async function collectUnusedWorkspaces(
  client: WorkSpacesClient,
  thresholdDays: number,
  now: Date,
  prices: PriceTable = DEFAULT_PRICES,
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
    .map(({ id, days }) => buildRecord(id, days, metadata.get(id), prices));
  const unknown: WorkspaceRecord[] = unknownIds.map((id) =>
    buildRecord(id, null, metadata.get(id), prices),
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
  prices: PriceTable,
): WorkspaceRecord {
  const computeType = meta?.WorkspaceProperties?.ComputeTypeName;
  const runningMode = meta?.WorkspaceProperties?.RunningMode;
  return {
    workspaceId: id,
    daysUnused,
    userName: meta?.UserName,
    directoryId: meta?.DirectoryId,
    bundleId: meta?.BundleId,
    runningMode,
    computeType,
    estimatedMonthlyCostUsd: estimateMonthlyCost(computeType, runningMode, prices),
  };
}

const CSV_HEADER =
  'WorkspaceId,UserName,DirectoryId,BundleId,ComputeType,RunningMode,DaysUnused,EstMonthlyRunRateUSD';

export function buildCsv(report: UnusedReport): string {
  const rows: string[] = [CSV_HEADER];
  for (const r of report.unused) rows.push(csvRow(r, String(r.daysUnused)));
  for (const r of report.unknown) rows.push(csvRow(r, 'not used'));
  return rows.join('\r\n') + '\r\n';
}

function csvRow(r: WorkspaceRecord, days: string): string {
  const cost =
    typeof r.estimatedMonthlyCostUsd === 'number' ? r.estimatedMonthlyCostUsd.toFixed(2) : '';
  return [
    r.workspaceId,
    r.userName ?? '',
    r.directoryId ?? '',
    r.bundleId ?? '',
    r.computeType ?? '',
    r.runningMode ?? '',
    days,
    cost,
  ]
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
  const savings = summarizeSavings(report);

  // Header + at-a-glance summary.
  lines.push('Amazon WorkSpaces - Unused Report', DIVIDER, '');
  lines.push(`Idle for ${thresholdDays}+ days`.padEnd(20) + `: ${report.unused.length}`);
  lines.push('Never connected'.padEnd(20) + `: ${report.unknown.length}`);
  lines.push('');

  // --- FinOps: idle spend & realizable saving -----------------------------
  lines.push(SUB_DIVIDER, 'FINOPS VIEW (estimate)', SUB_DIVIDER, '');
  if (savings.pricedCount > 0) {
    lines.push(
      'Current monthly run-rate of idle WorkSpaces below:',
      '',
      'Idle run-rate / month'.padEnd(26) + `: ${formatUsd(savings.totalMonthlyUsd)}`,
      'Idle run-rate / year'.padEnd(26) + `: ${formatUsd(savings.totalAnnualUsd)}`,
      '',
      'Realizable saving by TERMINATING these WorkSpaces (this report\'s lever):',
      '',
      `  ALWAYS_ON idle (${savings.alwaysOnCount})`.padEnd(26) +
        `: ${formatUsd(savings.alwaysOnMonthlyUsd)}/mo  <- priority`,
      `  AUTO_STOP idle (${savings.autoStopCount})`.padEnd(26) +
        `: ${formatUsd(savings.autoStopMonthlyUsd)}/mo`,
    );
    if (savings.unpricedCount > 0) {
      lines.push(
        'Without a price estimate'.padEnd(26) + `: ${savings.unpricedCount} (unknown compute type)`,
      );
    }
    lines.push('');
    if (savings.alwaysOnCount > 0) {
      lines.push(
        `Priority: ${savings.alwaysOnCount} idle WorkSpace(s) still run ALWAYS_ON and pay the`,
        'full flat fee while unused. Terminating them yields the largest, most',
        'certain saving. (If they should stay, switching ALWAYS_ON -> AUTO_STOP is',
        'handled by Cost Optimizer for Amazon WorkSpaces, not this report.)',
        '',
      );
    }
    lines.push(
      'Note: an idle AUTO_STOP WorkSpace already bills close to its fixed monthly',
      'base fee, so its run-rate is modeled as that base, not full usage. Figures',
      'are list-price estimates; AWS Cost Explorer holds the authoritative amounts.',
      '',
    );
  } else {
    lines.push(
      'No cost estimate available (no priced compute types among flagged',
      'WorkSpaces). Configure WORKSPACE_PRICES_JSON or enable the Pricing API.',
      '',
    );
  }

  // --- Unused workspaces ---------------------------------------------------
  lines.push(SUB_DIVIDER, `UNUSED WORKSPACES (idle ${thresholdDays}+ days)`, SUB_DIVIDER, '');

  if (report.unused.length > 0) {
    report.unused.forEach((r, i) => {
      lines.push(
        `${i + 1}) ${r.workspaceId}`,
        `     User         : ${r.userName ?? 'n/a'}`,
        `     Bundle       : ${r.bundleId ?? 'n/a'}`,
        `     Compute type : ${r.computeType ?? 'n/a'}`,
        `     Running mode : ${r.runningMode ?? 'n/a'}`,
        `     Days unused  : ${r.daysUnused}`,
        `     Run-rate/mo  : ${
          typeof r.estimatedMonthlyCostUsd === 'number' ? formatUsd(r.estimatedMonthlyCostUsd) : 'n/a'
        }`,
        '',
      );
    });
  } else {
    lines.push(`There are no unused workspaces in the last ${thresholdDays} days.`, '');
  }

  // --- Never connected -----------------------------------------------------
  lines.push(SUB_DIVIDER, 'NEVER CONNECTED', SUB_DIVIDER, '');

  if (report.unknown.length > 0) {
    report.unknown.forEach((r, i) => {
      lines.push(
        `${i + 1}) ${r.workspaceId}`,
        `     User         : ${r.userName ?? 'n/a'}`,
        `     Bundle       : ${r.bundleId ?? 'n/a'}`,
        `     Compute type : ${r.computeType ?? 'n/a'}`,
        `     Run-rate/mo  : ${
          typeof r.estimatedMonthlyCostUsd === 'number' ? formatUsd(r.estimatedMonthlyCostUsd) : 'n/a'
        }`,
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

/** Formats a number as a USD amount, e.g. 1234.5 -> "$1,234.50". */
export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
