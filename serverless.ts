import type { AWS } from '@serverless/typescript'

const serverlessConfiguration: AWS = {
  service: 'events-parser',
  frameworkVersion: '4',

  provider: {
    name: 'aws',
    runtime: 'nodejs20.x',
    region: 'us-west-1',
    timeout: 29,
    environment: {
      NODE_ENV: 'production',
      OPENAI_API_KEY: '${env:OPENAI_API_KEY}',
      GOOGLE_SPREADSHEET_ID: '${env:GOOGLE_SPREADSHEET_ID}',
      GOOGLE_SERVICE_ACCOUNT_EMAIL: '${env:GOOGLE_SERVICE_ACCOUNT_EMAIL}',
      GOOGLE_PRIVATE_KEY: '${env:GOOGLE_PRIVATE_KEY}',
      S3_BUCKET: '${env:S3_BUCKET}',
      REGION: '${env:REGION}',
      INBOUND_API_KEY: '${env:INBOUND_API_KEY}',
      ALERT_EMAIL_FROM: '${env:ALERT_EMAIL_FROM}',
      ALERT_EMAIL_TO: '${env:ALERT_EMAIL_TO}',
      DRIVE_INBOX_FOLDER_ID: '${env:DRIVE_INBOX_FOLDER_ID}',
      DRIVE_PROCESSED_FOLDER_ID: '${env:DRIVE_PROCESSED_FOLDER_ID}'
    },
    iam: {
      role: {
        statements: [
          {
            // Historically S3 access rode on the bucket's wide-open policy;
            // grant it properly so the policy can be tightened to public-read
            Effect: 'Allow',
            Action: ['s3:PutObject'],
            Resource: 'arn:aws:s3:::${env:S3_BUCKET}/images/*'
          },
          {
            // Drive-inbox ledger + ops-alert throttle marker
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject'],
            Resource: 'arn:aws:s3:::${env:S3_BUCKET}/drive-inbox/*'
          },
          {
            // Required for GetObject on a MISSING key to return 404 NoSuchKey
            // instead of 403 AccessDenied — without this, first-run ledger
            // bootstrap (and any state.json deletion) bricks the poller
            Effect: 'Allow',
            Action: ['s3:ListBucket'],
            Resource: 'arn:aws:s3:::${env:S3_BUCKET}'
          }
        ]
      }
    }
  },

  plugins: ['serverless-dotenv-plugin', 'serverless-offline'],

  custom: {
    esbuild: {
      watch: {
        pattern: 'src/**/*.ts'
      },
      bundle: true,
      minify: false,
      sourcemap: true,
      exclude: ['aws-sdk'],
      target: 'node20',
      define: { 'require.resolve': undefined },
      platform: 'node',
      concurrency: 10
    }
  },

  functions: {
    parseInboundEmail: {
      handler: 'src/handlers/inbound.parseInboundEmail',
      events: [
        {
          http: {
            method: 'post',
            path: 'parse-inbound-email',
            cors: {
              origin: '*',
              headers: ['Content-Type']
            }
          }
        }
      ]
    },
    pollDriveInbox: {
      handler: 'src/handlers/drive-inbox.pollDriveInbox',
      // No API Gateway on this path, so no 29s ceiling. rate > timeout plus
      // reservedConcurrency: 1 guarantee runs never overlap, which is what
      // makes the read-modify-write S3 ledger safe.
      timeout: 120,
      memorySize: 1536,
      reservedConcurrency: 1,
      events: [{ schedule: 'rate(5 minutes)' }]
    }
  },

  // Watcher-independent alerting: the in-code alerts (sendFailureAlert /
  // sendOpsAlert) ride on inbound.new, so they go silent exactly when
  // inbound.new is the thing that's down — and nothing in-code can detect the
  // scheduler itself dying. These alarms email via SNS with no dependency on
  // the application's own plumbing.
  resources: {
    Resources: {
      OpsAlarmTopic: {
        Type: 'AWS::SNS::Topic',
        Properties: {
          TopicName: 'decentered-ops-alarms',
          // Subscription requires a one-time email confirmation click
          Subscription: [{ Protocol: 'email', Endpoint: 'faizanali619@gmail.com' }]
        }
      },
      // Unhandled crashes (timeouts, OOM) — the handlers catch everything
      // else, so the AWS/Lambda Errors metric fires only for these
      DriveInboxCrashAlarm: {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          AlarmName: 'decentered-drive-inbox-crashes',
          AlarmDescription: 'pollDriveInbox crashed (timeout/OOM) 2+ times in 15 min. Debug: aws logs tail /aws/lambda/events-parser-dev-pollDriveInbox --region us-west-1 --since 1h',
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Dimensions: [{ Name: 'FunctionName', Value: 'events-parser-dev-pollDriveInbox' }],
          Statistic: 'Sum',
          Period: 900,
          EvaluationPeriods: 1,
          Threshold: 2,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          TreatMissingData: 'notBreaching',
          AlarmActions: [{ Ref: 'OpsAlarmTopic' }]
        }
      },
      WebhookCrashAlarm: {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          AlarmName: 'decentered-webhook-crashes',
          AlarmDescription: 'parseInboundEmail crashed (timeout/OOM) 2+ times in 15 min. Debug: aws logs tail /aws/lambda/events-parser-dev-parseInboundEmail --region us-west-1 --since 1h',
          Namespace: 'AWS/Lambda',
          MetricName: 'Errors',
          Dimensions: [{ Name: 'FunctionName', Value: 'events-parser-dev-parseInboundEmail' }],
          Statistic: 'Sum',
          Period: 900,
          EvaluationPeriods: 1,
          Threshold: 2,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          TreatMissingData: 'notBreaching',
          AlarmActions: [{ Ref: 'OpsAlarmTopic' }]
        }
      },
      // The poller's top-level catch swallows errors by design (it must ack
      // and retry next tick), so caught failures never hit the Errors metric.
      // Surface sustained ones via a log metric filter instead — this fires
      // even when inbound.new (the in-code alert channel) is what's broken.
      DriveInboxCaughtErrorFilter: {
        Type: 'AWS::Logs::MetricFilter',
        DependsOn: 'PollDriveInboxLogGroup',
        Properties: {
          LogGroupName: '/aws/lambda/events-parser-dev-pollDriveInbox',
          FilterPattern: '"Error polling Drive inbox"',
          MetricTransformations: [{ MetricName: 'DriveInboxCaughtErrors', MetricNamespace: 'Decentered', MetricValue: '1', DefaultValue: 0, Unit: 'Count' }]
        }
      },
      DriveInboxCaughtErrorAlarm: {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          AlarmName: 'decentered-drive-inbox-poll-failures',
          AlarmDescription: 'pollDriveInbox hit its top-level catch 3+ times in 30 min (every poll failing — Drive API, S3 ledger, or Sheets down). Debug: aws logs tail /aws/lambda/events-parser-dev-pollDriveInbox --region us-west-1 --since 1h',
          Namespace: 'Decentered',
          MetricName: 'DriveInboxCaughtErrors',
          Statistic: 'Sum',
          Period: 1800,
          EvaluationPeriods: 1,
          Threshold: 3,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          TreatMissingData: 'notBreaching',
          AlarmActions: [{ Ref: 'OpsAlarmTopic' }]
        }
      },
      // Watches the watcher: the schedule should tick 12x/hour. Missing data
      // = zero invocations = the scheduler itself is dead, which no in-code
      // alert can ever report.
      DriveInboxHeartbeatAlarm: {
        Type: 'AWS::CloudWatch::Alarm',
        Properties: {
          AlarmName: 'decentered-drive-inbox-heartbeat',
          AlarmDescription: 'pollDriveInbox ran fewer than 6 times in the last hour (expected 12). The EventBridge schedule is disabled, throttled, or the function is gone.',
          Namespace: 'AWS/Lambda',
          MetricName: 'Invocations',
          Dimensions: [{ Name: 'FunctionName', Value: 'events-parser-dev-pollDriveInbox' }],
          Statistic: 'Sum',
          Period: 3600,
          EvaluationPeriods: 1,
          Threshold: 6,
          ComparisonOperator: 'LessThanThreshold',
          TreatMissingData: 'breaching',
          AlarmActions: [{ Ref: 'OpsAlarmTopic' }]
        }
      }
    }
  },

  package: {
    individually: true
  }
}

module.exports = serverlessConfiguration
