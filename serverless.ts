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
      REGION: '${env:REGION}'
    },
    apiGateway: {
      binaryMediaTypes: ['multipart/form-data', 'application/octet-stream', 'image/*']
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
    parseSendgridInbound: {
      handler: 'src/handlers/inbound.parseSendgridInbound',
      events: [
        {
          http: {
            method: 'post',
            path: 'parse-sendgrid-inbound',
            cors: {
              origin: '*',
              headers: ['Content-Type']
            }
          }
        }
      ]
    }
  },

  package: {
    individually: true
  }
}

module.exports = serverlessConfiguration
