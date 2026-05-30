import {
  DescribeWorkspacesCommand,
  DescribeWorkspacesConnectionStatusCommand,
  RunningMode,
  WorkSpacesClient,
} from '@aws-sdk/client-workspaces';
import { mockClient } from 'aws-sdk-client-mock';
import {
  buildCsv,
  buildMessage,
  classify,
  collectUnusedWorkspaces,
  csvEscape,
  formatDate,
  type UnusedReport,
} from '../src/handler/index';

const NOW = new Date('2025-02-01T00:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('classify', () => {
  test('returns undefined when WorkspaceId is missing', () => {
    expect(classify({ LastKnownUserConnectionTimestamp: new Date() }, 30, NOW)).toBeUndefined();
  });

  test('returns null when never connected', () => {
    expect(classify({ WorkspaceId: 'ws-1' }, 30, NOW)).toBeNull();
  });

  test('returns undefined when used more recently than the threshold', () => {
    const ws = { WorkspaceId: 'ws-1', LastKnownUserConnectionTimestamp: new Date(daysAgo(10)) };
    expect(classify(ws, 30, NOW)).toBeUndefined();
  });

  test('returns the day count when at or beyond the threshold', () => {
    const ws = { WorkspaceId: 'ws-1', LastKnownUserConnectionTimestamp: new Date(daysAgo(45)) };
    expect(classify(ws, 30, NOW)).toBe(45);
  });

  test('is inclusive at exactly the threshold', () => {
    const ws = { WorkspaceId: 'ws-1', LastKnownUserConnectionTimestamp: new Date(daysAgo(30)) };
    expect(classify(ws, 30, NOW)).toBe(30);
  });
});

describe('csvEscape', () => {
  test('passes through plain values', () => {
    expect(csvEscape('ws-abc123')).toBe('ws-abc123');
  });

  test('quotes and escapes commas, quotes and newlines (RFC 4180)', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape('a\nb')).toBe('"a\nb"');
  });

  test('neutralizes formula/CSV injection', () => {
    expect(csvEscape('=cmd()')).toBe("'=cmd()");
    expect(csvEscape('+1')).toBe("'+1");
    expect(csvEscape('-1')).toBe("'-1");
    expect(csvEscape('@x')).toBe("'@x");
  });

  test('handles a value that is both a formula and contains a comma', () => {
    expect(csvEscape('=a,b')).toBe('"\'=a,b"');
  });
});

describe('buildCsv', () => {
  test('emits a header, enriched rows, and CRLF line endings', () => {
    const report: UnusedReport = {
      unused: [
        {
          workspaceId: 'ws-2',
          daysUnused: 40,
          userName: 'bob',
          directoryId: 'd-1',
          bundleId: 'b-1',
          runningMode: RunningMode.ALWAYS_ON,
        },
      ],
      unknown: [{ workspaceId: 'ws-3', daysUnused: null, userName: 'carol' }],
    };
    const csv = buildCsv(report);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('WorkspaceId,UserName,DirectoryId,BundleId,RunningMode,DaysUnused');
    expect(lines[1]).toBe('ws-2,bob,d-1,b-1,ALWAYS_ON,40');
    expect(lines[2]).toBe('ws-3,carol,,,,not used');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('buildMessage', () => {
  test('summarizes unused, unknown, and AlwaysOn cost framing', () => {
    const report: UnusedReport = {
      unused: [
        { workspaceId: 'ws-2', daysUnused: 40, userName: 'bob', runningMode: RunningMode.ALWAYS_ON },
      ],
      unknown: [{ workspaceId: 'ws-3', daysUnused: null }],
    };
    const msg = buildMessage(report, 30);
    expect(msg).toContain('Idle for 30+ days');
    expect(msg).toContain('ws-2');
    expect(msg).toContain('ALWAYS_ON billing mode');
    expect(msg).toContain('NEVER CONNECTED');
  });

  test('states when there is nothing to report in a bucket', () => {
    const report: UnusedReport = { unused: [], unknown: [] };
    const msg = buildMessage(report, 14);
    expect(msg).toContain('no unused workspaces in the last 14 days');
    expect(msg).toContain('No WorkSpaces with unknown last usage');
  });
});

describe('formatDate', () => {
  test('produces a stable UTC ISO date', () => {
    expect(formatDate(new Date('2025-02-01T23:59:59.000Z'))).toBe('2025-02-01');
  });
});

describe('collectUnusedWorkspaces', () => {
  const wsMock = mockClient(WorkSpacesClient);

  beforeEach(() => wsMock.reset());

  test('paginates status, enriches metadata, and buckets results', async () => {
    wsMock
      .on(DescribeWorkspacesConnectionStatusCommand, { NextToken: undefined })
      .resolves({
        WorkspacesConnectionStatus: [
          { WorkspaceId: 'ws-old', LastKnownUserConnectionTimestamp: new Date(daysAgo(45)) },
          { WorkspaceId: 'ws-recent', LastKnownUserConnectionTimestamp: new Date(daysAgo(5)) },
        ],
        NextToken: 'page2',
      })
      .on(DescribeWorkspacesConnectionStatusCommand, { NextToken: 'page2' })
      .resolves({
        WorkspacesConnectionStatus: [{ WorkspaceId: 'ws-never' }],
      });

    wsMock.on(DescribeWorkspacesCommand).resolves({
      Workspaces: [
        {
          WorkspaceId: 'ws-old',
          UserName: 'alice',
          DirectoryId: 'd-1',
          BundleId: 'b-1',
          WorkspaceProperties: { RunningMode: RunningMode.ALWAYS_ON },
        },
        { WorkspaceId: 'ws-never', UserName: 'dave', DirectoryId: 'd-1', BundleId: 'b-2' },
      ],
    });

    const report = await collectUnusedWorkspaces(new WorkSpacesClient({}), 30, NOW);

    expect(report.unused.map((r) => r.workspaceId)).toEqual(['ws-old']);
    expect(report.unused[0].userName).toBe('alice');
    expect(report.unused[0].runningMode).toBe(RunningMode.ALWAYS_ON);
    expect(report.unknown.map((r) => r.workspaceId)).toEqual(['ws-never']);
    expect(report.unknown[0].userName).toBe('dave');

    const describeCalls = wsMock.commandCalls(DescribeWorkspacesConnectionStatusCommand);
    expect(describeCalls).toHaveLength(2);
  });

  test('sorts unused workspaces ascending by days unused', async () => {
    wsMock.on(DescribeWorkspacesConnectionStatusCommand).resolves({
      WorkspacesConnectionStatus: [
        { WorkspaceId: 'ws-a', LastKnownUserConnectionTimestamp: new Date(daysAgo(60)) },
        { WorkspaceId: 'ws-b', LastKnownUserConnectionTimestamp: new Date(daysAgo(35)) },
      ],
    });
    wsMock.on(DescribeWorkspacesCommand).resolves({ Workspaces: [] });

    const report = await collectUnusedWorkspaces(new WorkSpacesClient({}), 30, NOW);
    expect(report.unused.map((r) => r.workspaceId)).toEqual(['ws-b', 'ws-a']);
    expect(report.unused.map((r) => r.daysUnused)).toEqual([35, 60]);
  });

  test('does not call DescribeWorkspaces when nothing is flagged', async () => {
    wsMock.on(DescribeWorkspacesConnectionStatusCommand).resolves({
      WorkspacesConnectionStatus: [
        { WorkspaceId: 'ws-recent', LastKnownUserConnectionTimestamp: new Date(daysAgo(1)) },
      ],
    });

    const report = await collectUnusedWorkspaces(new WorkSpacesClient({}), 30, NOW);
    expect(report.unused).toHaveLength(0);
    expect(report.unknown).toHaveLength(0);
    expect(wsMock.commandCalls(DescribeWorkspacesCommand)).toHaveLength(0);
  });
});
