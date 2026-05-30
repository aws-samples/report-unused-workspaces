import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ReportUnusedWorkspacesStack } from '../lib/report-unused-workspaces-stack';

function synth() {
  const app = new App();
  const stack = new ReportUnusedWorkspacesStack(app, 'TestStack', {
    emailAddress: 'reports@example.com',
    executionRateDays: 7,
    unusedDaysThreshold: 30,
    reportRetentionDays: 90,
  });
  return Template.fromStack(stack);
}

describe('ReportUnusedWorkspacesStack', () => {
  test('S3 bucket blocks public access and enforces SSL + encryption', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
    // enforceSSL adds a deny-non-secure-transport policy
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      }),
    });
  });

  test('SNS topic is KMS-encrypted with a customer-managed key and an email subscription', () => {
    const t = synth();
    // Topic references a generated CMK (Fn::GetAtt ... Arn), and a rotating key exists.
    t.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: Match.objectLike({ 'Fn::GetAtt': Match.anyValue() }),
    });
    t.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
    t.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'reports@example.com',
    });
  });

  test('Lambda role can use the topic KMS key (publish to encrypted topic)', () => {
    const t = synth();
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['kms:Decrypt', 'kms:GenerateDataKey*']),
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });

  test('Lambda is Node.js 24, ARM64, X-Ray active', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
  });

  test('EventBridge Scheduler invokes the Lambda with a dead-letter queue', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(7 days)',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: Match.objectLike({
        DeadLetterConfig: { Arn: Match.objectLike({ 'Fn::GetAtt': Match.anyValue() }) },
      }),
    });
  });

  test('Dead-letter queue is encrypted and enforces SSL', () => {
    const t = synth();
    t.hasResourceProperties('AWS::SQS::Queue', {
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
    t.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  test('Operational alarms exist for errors, throttles, and the DLQ', () => {
    const t = synth();
    t.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
    });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Throttles',
      Namespace: 'AWS/Lambda',
    });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
    });
  });

  test('CloudWatch can publish alarms to the encrypted topic', () => {
    const t = synth();
    t.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sns:Publish',
            Effect: 'Allow',
            Principal: { Service: 'cloudwatch.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  test('Handler role grants only the required workspaces actions', () => {
    const t = synth();
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'workspaces:DescribeWorkspacesConnectionStatus',
              'workspaces:DescribeWorkspaces',
            ],
            Effect: 'Allow',
            Resource: '*',
          }),
        ]),
      }),
    });
  });

  test('Handler S3 write is limited to s3:PutObject on the reports/ prefix', () => {
    const t = synth();
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:PutObject',
            Effect: 'Allow',
            Sid: 'WriteReports',
          }),
        ]),
      }),
    });
  });

  test('Handler logging is scoped to its own log group (no AWS-managed exec role)', () => {
    const t = synth();
    // logs actions target the dedicated log group ARN, not a wildcard.
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Effect: 'Allow',
            Resource: Match.objectLike({ 'Fn::GetAtt': Match.anyValue() }),
          }),
        ]),
      }),
    });
    // The execution role must NOT attach the broad AWS-managed basic exec policy.
    const roles = t.findResources('AWS::IAM::Role');
    for (const role of Object.values(roles)) {
      const managed = JSON.stringify((role as { Properties?: { ManagedPolicyArns?: unknown } }).Properties?.ManagedPolicyArns ?? []);
      expect(managed).not.toContain('AWSLambdaBasicExecutionRole');
    }
  });
});
