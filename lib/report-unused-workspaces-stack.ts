import * as path from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cw_actions,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_scheduler as scheduler,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface ReportUnusedWorkspacesStackProps extends StackProps {
  /** Email address that receives the report. */
  readonly emailAddress: string;
  /** How often the report runs, in days (3..30). */
  readonly executionRateDays: number;
  /** Threshold of inactivity in days to consider a workspace unused (7..90). */
  readonly unusedDaysThreshold: number;
  /** How long to keep generated CSV reports in S3, in days. */
  readonly reportRetentionDays: number;
}

/**
 * Modernized "Report Unused Amazon WorkSpaces" stack:
 *  - EventBridge Scheduler -> Lambda (Node.js 24, ARM64, AWS SDK v3)
 *  - SNS topic (KMS-encrypted with a customer-managed key) -> email subscription
 *  - S3 bucket (BlockPublicAccess.BLOCK_ALL, BucketOwnerEnforced, enforceSSL,
 *    versioned, lifecycle, S3-managed encryption)
 *  - Tight, scoped IAM policies; least privilege
 *  - cdk-nag (AwsSolutions) clean
 */
export class ReportUnusedWorkspacesStack extends Stack {
  public readonly reportBucket: s3.Bucket;
  public readonly topic: sns.Topic;
  public readonly handler: NodejsFunction;
  public readonly scheduleDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: ReportUnusedWorkspacesStackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // SNS topic (KMS-encrypted) + email subscription
    // -----------------------------------------------------------------------
    // Use a customer-managed KMS key so that `topic.grantPublish()` can wire up
    // the required kms:GenerateDataKey*/kms:Decrypt permissions on the publisher
    // (the AWS-managed alias/aws/sns key cannot be granted to a role, which would
    // cause Publish to fail at runtime with KMSAccessDeniedException).
    const topicKey = new kms.Key(this, 'TopicKey', {
      description: 'Encrypts the unused-workspaces SNS topic.',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.topic = new sns.Topic(this, 'UnusedWorkspacesTopic', {
      displayName: 'Unused Amazon WorkSpaces report',
      masterKey: topicKey,
    });

    this.topic.addSubscription(new subscriptions.EmailSubscription(props.emailAddress));

    // -----------------------------------------------------------------------
    // S3 bucket for CSV reports + access-logs bucket
    // -----------------------------------------------------------------------
    const accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-access-logs',
          enabled: true,
          expiration: Duration.days(90),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    this.reportBucket = new s3.Bucket(this, 'ReportBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'report-bucket/',
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-old-reports',
          enabled: true,
          expiration: Duration.days(props.reportRetentionDays),
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    // -----------------------------------------------------------------------
    // Lambda log group (explicit, with retention)
    // -----------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, 'HandlerLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // -----------------------------------------------------------------------
    // Lambda handler
    // -----------------------------------------------------------------------
    // Custom execution role so we can scope logging to *this* log group only,
    // instead of attaching the broader AWS-managed AWSLambdaBasicExecutionRole
    // (which permits logs:CreateLogGroup and writing to any /aws/lambda/* group).
    const handlerRole = new iam.Role(this, 'HandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the unused-workspaces report Lambda.',
    });
    // logs:CreateLogStream + logs:PutLogEvents scoped to the dedicated group.
    logGroup.grantWrite(handlerRole);

    this.handler = new NodejsFunction(this, 'Handler', {
      entry: path.join(__dirname, '..', 'src', 'handler', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(60),
      tracing: lambda.Tracing.ACTIVE,
      role: handlerRole,
      logGroup,
      environment: {
        UNUSED_DAYS: String(props.unusedDaysThreshold),
        SNS_TOPIC_ARN: this.topic.topicArn,
        BUCKET_NAME: this.reportBucket.bucketName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        format: OutputFormat.CJS,
        externalModules: [
          // Lambda Node 24 ships AWS SDK v3 in the runtime; keep them external
          // to shrink the bundle and avoid version drift.
          '@aws-sdk/*',
        ],
      },
    });

    // Grant least-privilege permissions to the handler role
    this.topic.grantPublish(this.handler);

    // The handler only calls PutObject; grant exactly that on the reports/ prefix
    // (grantPut() would also add PutObjectAcl/Tagging/LegalHold/Retention/Abort).
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WriteReports',
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject'],
        resources: [this.reportBucket.arnForObjects('reports/*')],
      }),
    );

    // workspaces:DescribeWorkspacesConnectionStatus and DescribeWorkspaces do
    // NOT support resource-level permissions, so resource must be "*".
    // See: https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonworkspaces.html
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DescribeWorkspaces',
        effect: iam.Effect.ALLOW,
        actions: [
          'workspaces:DescribeWorkspacesConnectionStatus',
          'workspaces:DescribeWorkspaces',
        ],
        resources: ['*'],
      }),
    );

    // -----------------------------------------------------------------------
    // EventBridge Scheduler -> Lambda (with a dead-letter queue)
    // -----------------------------------------------------------------------
    // If the scheduler exhausts its retries, the failed invocation event is
    // sent here instead of being silently dropped.
    const deadLetterQueue = new sqs.Queue(this, 'ScheduleDlq', {
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    this.scheduleDlq = deadLetterQueue;

    // This queue *is* the dead-letter queue for the schedule target, so it does
    // not itself need a further DLQ (AwsSolutions-SQS3 is a false positive here).
    NagSuppressions.addResourceSuppressions(deadLetterQueue, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This queue is the dead-letter queue for the EventBridge Scheduler target.',
      },
    ]);

    const schedulerRole = new iam.Role(this, 'SchedulerInvokeRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
          },
        },
      }),
      description: 'Allows EventBridge Scheduler to invoke the report handler.',
    });
    this.handler.grantInvoke(schedulerRole);
    deadLetterQueue.grantSendMessages(schedulerRole);

    new scheduler.CfnSchedule(this, 'ReportSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: `rate(${props.executionRateDays} days)`,
      scheduleExpressionTimezone: 'UTC',
      description: 'Triggers the unused-workspaces report Lambda.',
      target: {
        arn: this.handler.functionArn,
        roleArn: schedulerRole.roleArn,
        deadLetterConfig: {
          arn: deadLetterQueue.queueArn,
        },
        retryPolicy: {
          maximumRetryAttempts: 2,
          maximumEventAgeInSeconds: 3600,
        },
      },
    });

    // -----------------------------------------------------------------------
    // Operational alarms -> SNS (same topic that delivers the report)
    // -----------------------------------------------------------------------
    // Allow CloudWatch to publish to the KMS-encrypted topic.
    topicKey.grant(
      new iam.ServicePrincipal('cloudwatch.amazonaws.com'),
      'kms:Decrypt',
      'kms:GenerateDataKey*',
    );
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
    );

    const alarmAction = new cw_actions.SnsAction(this.topic);

    const errorsAlarm = this.handler
      .metricErrors({ period: Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'HandlerErrorsAlarm', {
        alarmDescription: 'The unused-workspaces report Lambda reported errors.',
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    errorsAlarm.addAlarmAction(alarmAction);

    const throttlesAlarm = this.handler
      .metricThrottles({ period: Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'HandlerThrottlesAlarm', {
        alarmDescription: 'The unused-workspaces report Lambda was throttled.',
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    throttlesAlarm.addAlarmAction(alarmAction);

    const dlqAlarm = deadLetterQueue
      .metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      })
      .createAlarm(this, 'ScheduleDlqAlarm', {
        alarmDescription: 'A scheduled report invocation landed in the dead-letter queue.',
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    dlqAlarm.addAlarmAction(alarmAction);

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------
    new CfnOutput(this, 'ReportBucketName', { value: this.reportBucket.bucketName });
    new CfnOutput(this, 'TopicArn', { value: this.topic.topicArn });
    new CfnOutput(this, 'FunctionName', { value: this.handler.functionName });
    new CfnOutput(this, 'ScheduleDlqUrl', { value: this.scheduleDlq.queueUrl });

    // -----------------------------------------------------------------------
    // cdk-nag suppressions (with documented reasons)
    // -----------------------------------------------------------------------
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/HandlerRole/DefaultPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'workspaces:DescribeWorkspacesConnectionStatus and xray:Put* do not support resource-level permissions (Resource must be *); the kms:GenerateDataKey* action wildcard is the standard grantPublish pattern scoped to the topic CMK ARN; the reports/* object wildcard is required because each run writes a new dated report object. S3 and SNS are scoped to specific ARNs.',
          appliesTo: [
            'Resource::*',
            'Action::kms:GenerateDataKey*',
            { regex: '/^Resource::<ReportBucket.*\\.Arn>\\/reports\\/\\*$/g' },
          ],
        },
      ],
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/SchedulerInvokeRole/DefaultPolicy/Resource`,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'lambda:InvokeFunction grant from grantInvoke includes the version/alias wildcard (<arn>:*); standard CDK pattern.',
          appliesTo: [{ regex: '/^Resource::<Handler.*\\.Arn>:\\*$/g' }],
        },
      ],
    );
  }
}
