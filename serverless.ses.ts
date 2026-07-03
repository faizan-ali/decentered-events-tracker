import type { AWS } from '@serverless/typescript'

// SES-native ingestion stack (us-west-2 — SES inbound is not available in
// us-west-1). Deploy: pnpm serverless deploy --config serverless.ses.ts
// Receives via ses.proteus.tools MX → SES receipt rule → S3 → Lambda.
const serverlessConfiguration: AWS = {
  service: 'events-parser-ses',
  frameworkVersion: '4',

  provider: {
    name: 'aws',
    runtime: 'nodejs20.x',
    region: 'us-west-2',
    // Not behind API Gateway: no 29s ceiling. Big emails need parse headroom.
    timeout: 120,
    memorySize: 2048,
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
      SES_INBOX_BUCKET: 'decentered-ses-inbox',
      SES_INBOX_REGION: 'us-west-2'
    },
    iam: {
      role: {
        statements: [
          {
            Effect: 'Allow',
            Action: ['s3:GetObject'],
            Resource: 'arn:aws:s3:::decentered-ses-inbox/*'
          },
          {
            Effect: 'Allow',
            Action: ['s3:PutObject'],
            Resource: 'arn:aws:s3:::${env:S3_BUCKET}/*'
          }
        ]
      }
    }
  },

  plugins: ['serverless-dotenv-plugin'],

  functions: {
    parseSesEmail: {
      handler: 'src/handlers/ses-inbound.parseSesEmail'
      // Invoked by the SES receipt rule (LambdaAction), not a serverless event.
      // The invoke permission for ses.amazonaws.com is granted in resources.
    }
  },

  resources: {
    Resources: {
      SesInvokePermission: {
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { 'Fn::GetAtt': ['ParseSesEmailLambdaFunction', 'Arn'] },
          Action: 'lambda:InvokeFunction',
          Principal: 'ses.amazonaws.com',
          SourceAccount: '668453767712'
        }
      }
    }
  },

  package: {
    individually: true
  }
}

module.exports = serverlessConfiguration
