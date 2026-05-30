#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ReportUnusedWorkspacesStack } from '../lib/report-unused-workspaces-stack';

interface AppContext {
  emailAddress: string;
  executionRateDays: number;
  unusedDaysThreshold: number;
  reportRetentionDays: number;
  prices?: Record<string, { alwaysOn: number; autoStopBase: number }>;
  usePricingApi?: boolean;
}

const app = new cdk.App();

const ctx = (app.node.tryGetContext('reportUnusedWorkspaces') ?? {}) as Partial<AppContext>;

const ctxEmail = ctx.emailAddress;
const emailAddress =
  ctxEmail && !ctxEmail.includes('REPLACE_ME')
    ? ctxEmail
    : process.env.REPORT_EMAIL ?? '';
const executionRateDays = Number(ctx.executionRateDays ?? 7);
const unusedDaysThreshold = Number(ctx.unusedDaysThreshold ?? 30);
const reportRetentionDays = Number(ctx.reportRetentionDays ?? 365);
// Optional FinOps price-table override (context object or env JSON string).
const pricesJson = ctx.prices
  ? JSON.stringify(ctx.prices)
  : process.env.WORKSPACE_PRICES_JSON;
// Opt-in to live AWS Price List lookups (context flag or env var).
const usePricingApi = ctx.usePricingApi === true || process.env.USE_PRICING_API === 'true';

if (!emailAddress) {
  throw new Error(
    'Set context "reportUnusedWorkspaces.emailAddress" in cdk.json or env REPORT_EMAIL.',
  );
}
// Basic shape check; SNS still requires the recipient to confirm the subscription.
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
  throw new Error(`emailAddress "${emailAddress}" is not a valid email address.`);
}
if (!Number.isInteger(executionRateDays) || executionRateDays < 3 || executionRateDays > 30) {
  throw new Error('executionRateDays must be an integer between 3 and 30.');
}
if (!Number.isInteger(unusedDaysThreshold) || unusedDaysThreshold < 7 || unusedDaysThreshold > 90) {
  throw new Error('unusedDaysThreshold must be an integer between 7 and 90.');
}
if (!Number.isInteger(reportRetentionDays) || reportRetentionDays < 1) {
  throw new Error('reportRetentionDays must be an integer >= 1.');
}

new ReportUnusedWorkspacesStack(app, 'ReportUnusedWorkspacesStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Detects and reports unused Amazon WorkSpaces (CDK).',
  emailAddress,
  executionRateDays,
  unusedDaysThreshold,
  reportRetentionDays,
  pricesJson,
  usePricingApi,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
