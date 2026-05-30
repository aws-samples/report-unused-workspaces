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
  estimateMonthlyCost,
  formatDate,
  formatUsd,
  loadPrices,
  summarizeSavings,
  DEFAULT_PRICES,
  type PriceTable,
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
          computeType: 'STANDARD',
          runningMode: RunningMode.ALWAYS_ON,
          estimatedMonthlyCostUsd: 35,
        },
      ],
      unknown: [{ workspaceId: 'ws-3', daysUnused: null, userName: 'carol' }],
    };
    const csv = buildCsv(report);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'WorkspaceId,UserName,DirectoryId,BundleId,ComputeType,RunningMode,DaysUnused,EstMonthlyRunRateUSD',
    );
    expect(lines[1]).toBe('ws-2,bob,d-1,b-1,STANDARD,ALWAYS_ON,40,35.00');
    expect(lines[2]).toBe('ws-3,carol,,,,,not used,');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('buildMessage', () => {
  test('summarizes unused, unknown, and AlwaysOn cost framing', () => {
    const report: UnusedReport = {
      unused: [
        {
          workspaceId: 'ws-2',
          daysUnused: 40,
          userName: 'bob',
          computeType: 'STANDARD',
          runningMode: RunningMode.ALWAYS_ON,
          estimatedMonthlyCostUsd: 35,
        },
      ],
      unknown: [{ workspaceId: 'ws-3', daysUnused: null }],
    };
    const msg = buildMessage(report, 30);
    expect(msg).toContain('Idle for 30+ days');
    expect(msg).toContain('ws-2');
    expect(msg).toContain('ALWAYS_ON idle');
    expect(msg).toContain('NEVER CONNECTED');
  });

  test('renders the FinOps view with run-rate and per-mode breakdown', () => {
    const report: UnusedReport = {
      unused: [
        {
          workspaceId: 'ws-1',
          daysUnused: 40,
          computeType: 'STANDARD',
          runningMode: RunningMode.ALWAYS_ON,
          estimatedMonthlyCostUsd: 35,
        },
      ],
      unknown: [
        {
          workspaceId: 'ws-2',
          daysUnused: null,
          computeType: 'POWER',
          runningMode: RunningMode.AUTO_STOP,
          estimatedMonthlyCostUsd: 19,
        },
      ],
    };
    const msg = buildMessage(report, 30);
    expect(msg).toContain('FINOPS VIEW');
    // 35 + 19 = 54 monthly run-rate, * 12 = 648 annual.
    expect(msg).toContain('$54.00');
    expect(msg).toContain('$648.00');
    // Per-mode breakdown surfaces ALWAYS_ON as the priority.
    expect(msg).toContain('ALWAYS_ON idle (1)');
    expect(msg).toContain('AUTO_STOP idle (1)');
    expect(msg).toContain('priority');
    // Positions the report relative to WCO for mode switching.
    expect(msg).toContain('Cost Optimizer for Amazon WorkSpaces');
  });

  test('states when there is nothing to report in a bucket', () => {
    const report: UnusedReport = { unused: [], unknown: [] };
    const msg = buildMessage(report, 14);
    expect(msg).toContain('no unused workspaces in the last 14 days');
    expect(msg).toContain('No WorkSpaces with unknown last usage');
  });
});

describe('estimateMonthlyCost', () => {
  test('uses the AlwaysOn flat rate for ALWAYS_ON workspaces', () => {
    expect(estimateMonthlyCost('STANDARD', RunningMode.ALWAYS_ON, DEFAULT_PRICES)).toBe(
      DEFAULT_PRICES.STANDARD.alwaysOn,
    );
  });

  test('uses the AutoStop base fee for AUTO_STOP workspaces', () => {
    expect(estimateMonthlyCost('STANDARD', RunningMode.AUTO_STOP, DEFAULT_PRICES)).toBe(
      DEFAULT_PRICES.STANDARD.autoStopBase,
    );
  });

  test('is case-insensitive on the compute type', () => {
    expect(estimateMonthlyCost('power', RunningMode.ALWAYS_ON, DEFAULT_PRICES)).toBe(
      DEFAULT_PRICES.POWER.alwaysOn,
    );
  });

  test('returns undefined for unknown or missing compute types', () => {
    expect(estimateMonthlyCost('MARS', RunningMode.ALWAYS_ON, DEFAULT_PRICES)).toBeUndefined();
    expect(estimateMonthlyCost(undefined, RunningMode.ALWAYS_ON, DEFAULT_PRICES)).toBeUndefined();
  });
});

describe('summarizeSavings', () => {
  test('sums priced workspaces, counts unpriced, and breaks down by mode', () => {
    const report: UnusedReport = {
      unused: [
        {
          workspaceId: 'ws-1',
          daysUnused: 40,
          runningMode: RunningMode.ALWAYS_ON,
          estimatedMonthlyCostUsd: 35,
        },
        { workspaceId: 'ws-2', daysUnused: 50 }, // unpriced
      ],
      unknown: [
        {
          workspaceId: 'ws-3',
          daysUnused: null,
          runningMode: RunningMode.AUTO_STOP,
          estimatedMonthlyCostUsd: 21,
        },
      ],
    };
    const s = summarizeSavings(report);
    expect(s.totalMonthlyUsd).toBe(56);
    expect(s.totalAnnualUsd).toBe(672);
    expect(s.pricedCount).toBe(2);
    expect(s.unpricedCount).toBe(1);
    expect(s.alwaysOnMonthlyUsd).toBe(35);
    expect(s.alwaysOnCount).toBe(1);
    expect(s.autoStopMonthlyUsd).toBe(21);
    expect(s.autoStopCount).toBe(1);
  });

  test('returns zeros when nothing is priced', () => {
    const s = summarizeSavings({ unused: [], unknown: [] });
    expect(s).toEqual({
      totalMonthlyUsd: 0,
      totalAnnualUsd: 0,
      pricedCount: 0,
      unpricedCount: 0,
      alwaysOnMonthlyUsd: 0,
      alwaysOnCount: 0,
      autoStopMonthlyUsd: 0,
      autoStopCount: 0,
    });
  });
});

describe('loadPrices', () => {
  test('returns defaults when no override is provided', () => {
    expect(loadPrices(undefined)).toBe(DEFAULT_PRICES);
  });

  test('merges a valid override over defaults (keys upper-cased)', () => {
    const table: PriceTable = loadPrices('{"standard":{"alwaysOn":99,"autoStopBase":10}}');
    expect(table.STANDARD).toEqual({ alwaysOn: 99, autoStopBase: 10 });
    // Untouched defaults remain.
    expect(table.POWER).toEqual(DEFAULT_PRICES.POWER);
  });

  test('falls back to defaults on invalid JSON', () => {
    expect(loadPrices('{not json')).toBe(DEFAULT_PRICES);
  });
});

describe('formatUsd', () => {
  test('formats with thousands separators and two decimals', () => {
    expect(formatUsd(1356)).toBe('$1,356.00');
    expect(formatUsd(7.25)).toBe('$7.25');
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
          WorkspaceProperties: {
            RunningMode: RunningMode.ALWAYS_ON,
            ComputeTypeName: 'STANDARD',
          },
        },
        { WorkspaceId: 'ws-never', UserName: 'dave', DirectoryId: 'd-1', BundleId: 'b-2' },
      ],
    });

    const report = await collectUnusedWorkspaces(new WorkSpacesClient({}), 30, NOW);

    expect(report.unused.map((r) => r.workspaceId)).toEqual(['ws-old']);
    expect(report.unused[0].userName).toBe('alice');
    expect(report.unused[0].runningMode).toBe(RunningMode.ALWAYS_ON);
    expect(report.unused[0].computeType).toBe('STANDARD');
    expect(report.unused[0].estimatedMonthlyCostUsd).toBe(DEFAULT_PRICES.STANDARD.alwaysOn);
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
