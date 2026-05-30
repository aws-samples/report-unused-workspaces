<!-- Language selector -->
**🌐 Language:** English · [Español](./README.es.md) · [Português](./README.pt.md)

# Report Unused Amazon WorkSpaces (CDK)

[![CI](https://github.com/aws-samples/report-unused-workspaces/actions/workflows/ci.yml/badge.svg)](https://github.com/aws-samples/report-unused-workspaces/actions/workflows/ci.yml)

Detect and report Amazon WorkSpaces that haven't been used for N days, then email
a summary and archive a CSV in S3. Modernized implementation built with **AWS CDK
v2 + TypeScript**, **AWS Lambda Node.js 24** on **Graviton (arm64)**, **AWS SDK
v3**, **Amazon EventBridge Scheduler**, operational alarms with a dead-letter
queue, and security defaults validated by **cdk-nag**.

> [!NOTE]
> This project was modernized from a single-file CloudFormation template into a
> CDK v2 application. Deploy using the CDK app described below.

## Table of contents

- [Architecture](#architecture)
- [How it works](#how-it-works)
- [Security defaults](#security-defaults)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Deploy](#deploy)
- [Testing](#testing)
- [Cleanup](#cleanup)
- [Cost](#cost)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [Contributing & security](#contributing--security)
- [License](#license)

## Architecture

![Architecture diagram of the Report Unused WorkSpaces solution](./images/report-unused-workspaces-architecture.png)

> The editable source is [`images/report-unused-workspaces-architecture.drawio`](./images/report-unused-workspaces-architecture.drawio)
> (open with [draw.io](https://draw.io) / diagrams.net). Re-export the PNG after edits.

| Component | Service | Purpose |
| --- | --- | --- |
| Scheduler | Amazon EventBridge Scheduler | Triggers the function every `executionRateDays` days |
| Compute | AWS Lambda (Node.js 24, arm64) | Queries WorkSpaces, builds the report |
| Notification | Amazon SNS (KMS-encrypted) | Emails the summary to subscribers |
| Storage | Amazon S3 (private, versioned) | Archives the CSV report under `reports/` |
| Resilience | Amazon SQS (dead-letter queue) | Captures failed scheduled invocations |
| Alerting | Amazon CloudWatch Alarms | Notifies on Lambda errors/throttles and DLQ messages |
| Observability | Amazon CloudWatch Logs + AWS X-Ray | Logs and traces each execution |

## How it works

1. **EventBridge Scheduler** invokes the Lambda function on a configurable cadence.
2. The **Lambda** calls `workspaces:DescribeWorkspacesConnectionStatus` (paginated)
   and computes, per workspace, the number of days since the last user connection.
3. Workspaces are split into two buckets: *unused for ≥ threshold days* and
   *never connected* (no `LastKnownUserConnectionTimestamp`).
4. Flagged workspaces are enriched via `workspaces:DescribeWorkspaces` with the
   user name, directory, bundle, and running mode (AlwaysOn vs AutoStop) so the
   report is actionable and highlights cost-saving opportunities.
5. The function writes a timestamped CSV to `s3://<bucket>/reports/` (values are
   escaped per RFC 4180 and guarded against spreadsheet formula injection) and
   publishes a human-readable summary to **SNS**.
6. **SNS** delivers the report to the subscribed email address.
7. If a scheduled invocation fails after retries, the event lands in an **SQS
   dead-letter queue**, and **CloudWatch Alarms** publish to the same SNS topic on
   Lambda errors/throttles or DLQ activity.
8. **CloudWatch Logs** and **X-Ray** capture execution detail for troubleshooting.

## Security defaults

This solution is designed around least privilege and AWS security best practices:

- **S3** — `BlockPublicAccess.BLOCK_ALL`, `BucketOwnerEnforced` (ACLs disabled),
  SSL enforced via bucket policy, versioning enabled, S3-managed encryption,
  lifecycle rules to expire reports after `reportRetentionDays`, server access
  logging to a dedicated logs bucket, and `RETAIN` on stack deletion.
- **SNS** — encrypted at rest with the AWS-managed key `alias/aws/sns`.
- **Lambda** — arm64 (Graviton), Node.js 24, AWS X-Ray active, configuration via
  environment variables, dedicated log group with one-month retention.
- **IAM** — scoped strictly to what the code uses:
  - `workspaces:DescribeWorkspacesConnectionStatus` and
    `workspaces:DescribeWorkspaces` on `*` (these APIs do **not** support
    resource-level permissions).
  - `s3:PutObject` only on the `reports/*` prefix.
  - `sns:Publish` only on the created topic ARN.
- **Resilience** — the EventBridge Scheduler target has an SQS dead-letter queue
  (SSE-enabled, SSL-enforced, 14-day retention) so failed invocations are never
  lost; CloudWatch alarms on Lambda `Errors`/`Throttles` and DLQ depth publish to
  the report's SNS topic.
- **cdk-nag** — the `AwsSolutionsChecks` pack runs on every `cdk synth` and fails
  the build on findings.

## Prerequisites

- **Node.js 20+** and npm
- An AWS account **bootstrapped for CDK v2** (`npx cdk bootstrap`)
- Credentials configured for the target account/region
- An **email address you control** (you must confirm the SNS subscription)

## Configuration

Set values in `cdk.json` under `context.reportUnusedWorkspaces`:

```json
{
  "reportUnusedWorkspaces": {
    "emailAddress": "you@example.com",
    "executionRateDays": 7,
    "unusedDaysThreshold": 30,
    "reportRetentionDays": 365
  }
}
```

| Parameter | Description | Default | Range |
| --- | --- | --- | --- |
| `emailAddress` | Recipient of the report (SNS subscription) | — (required) | valid email |
| `executionRateDays` | How often the report runs, in days | `7` | `3`–`30` |
| `unusedDaysThreshold` | Inactivity threshold to flag a workspace | `30` | `7`–`90` |
| `reportRetentionDays` | How long CSV reports are kept in S3 | `365` | ≥ `1` |

Alternatively, provide the email via the `REPORT_EMAIL` environment variable and
override defaults with `--context`:

```sh
REPORT_EMAIL=you@example.com npx cdk deploy \
  -c reportUnusedWorkspaces.executionRateDays=7 \
  -c reportUnusedWorkspaces.unusedDaysThreshold=30
```

## Deploy

```sh
npm install
npm test           # run unit + CDK assertion tests
npm run synth      # cdk synth (runs cdk-nag)
npm run deploy     # cdk deploy
```

After deployment, **check your inbox and confirm the SNS subscription** so you
start receiving reports.

## Testing

The repository ships with two Jest suites:

- **Stack assertion tests** validate the synthesized template (S3 hardening, SNS
  encryption, runtime/architecture, scheduler + DLQ wiring, alarms, and IAM
  scoping).
- **Handler unit tests** cover the business logic in isolation using
  `aws-sdk-client-mock` (classification/day math, RFC-4180 CSV escaping and
  formula-injection guarding, pagination, metadata enrichment, and the email
  summary).

```sh
npm test               # run both suites
npm run test:coverage  # run with a coverage report
```

## Cleanup

```sh
npm run destroy    # cdk destroy
```

> [!IMPORTANT]
> The report bucket and its access-logs bucket use a `RETAIN` removal policy, so
> they are **not** deleted with the stack. Empty and delete them manually if you
> no longer need the archived reports.

## Cost

Running this solution incurs standard AWS charges for the resources it creates
(Lambda invocations, S3 storage, SNS notifications, CloudWatch Logs, X-Ray
traces). For a small WorkSpaces fleet on a weekly schedule, the cost is typically
negligible, but you remain responsible for charges in your account.

## Project layout

```
.
├── .github/workflows/ci.yml            # Lint, test, synth + cdk-nag on PRs
├── bin/app.ts                          # CDK app entrypoint
├── lib/report-unused-workspaces-stack.ts
├── src/handler/index.ts                # Lambda (Node.js 24, AWS SDK v3)
├── test/report-unused-workspaces-stack.test.ts  # CDK assertion tests
├── test/handler.test.ts                # Lambda unit tests
├── cdk.json
└── package.json
```

## Roadmap

Recently shipped:

- ✅ **Operational hardening** — Lambda DLQ on the scheduler target plus
  CloudWatch error/throttle/DLQ alarms.
- ✅ **Richer reports** — enriched with user, directory, bundle, and AlwaysOn vs
  AutoStop running mode for cost-saving context.
- ✅ **CI** — GitHub Actions running lint, tests, synth and cdk-nag, with
  Dependabot keeping the AWS SDK and CDK current.

Ideas to take the solution even further:

- **Multi-account / multi-region** coverage via CloudFormation StackSets or
  Control Tower customizations, consolidating results centrally.
- **Auto-remediation** with an opt-in Step Functions workflow (report → human
  approval → resize, switch to AutoStop billing, or terminate).
- **Cost framing** that enriches the report with bundle pricing to show projected
  monthly savings in dollars.
- **Data lake mode** writing Parquet partitioned by date for Athena/QuickSight.
- **Pluggable destinations** (SES HTML, Slack, Teams, EventBridge bus).
- **CD** with OIDC-based deploys and security scans.

## Contributing & security

See [CONTRIBUTING](CONTRIBUTING.md) for guidelines and how to report security
issues.

## Author
Hernan Fernandez Retamal

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
