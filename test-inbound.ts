import dotenv from 'dotenv'
dotenv.config()

import type { APIGatewayProxyEvent } from 'aws-lambda'
import { realInboundEvent } from './real-inbound-event'
import { parseSendgridInbound } from './src/handlers/inbound'

async function testParsing() {
  console.log('Testing inbound email parsing with real event...')

  try {
    // Type cast the real event to match the expected API Gateway event structure
    const result = await parseSendgridInbound(realInboundEvent as unknown as APIGatewayProxyEvent, {} as any, {} as any)

    if (result) {
      console.log('Parse result status:', result.statusCode)
      console.log('Result body:', result.body)
    }
  } catch (error) {
    console.error('Error during testing:', error)
  }
}

// Run the test
testParsing()
