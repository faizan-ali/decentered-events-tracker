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

  package: {
    individually: true
  }
}

module.exports = serverlessConfiguration
