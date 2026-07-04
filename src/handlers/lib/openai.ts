import OpenAI from 'openai'
import { buildPrompt } from './prompt'

// "Today" for flyer purposes is Pacific time — Lambda runs in UTC, where the
// date flips at 4/5pm PT and would resolve an evening "TONIGHT 8PM"
// screenshot to tomorrow
const todayPacific = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // SDK defaults (10 min timeout, 2 auto-retries) can blow the 29s API Gateway
  // budget → 504 → inbound.new redelivers → every image billed again. GPT-5.4
  // typically answers in 3-4s; a failure here triggers the failure alert instead.
  timeout: 20_000,
  maxRetries: 0
})

interface GPTResponse {
  events: Array<{
    title: string
    address: string
    location: string
    type: string
    startDay: string | null
    startTime: string | null
    description: string
    cost: string | null
    endDay: string | null
    endTime: string | null
  }>
}

export async function extractEvents(imageBuffer: Buffer, fileType: string): Promise<GPTResponse> {
  const response = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(todayPacific()) },
          {
            type: 'image_url',
            image_url: {
              url: `data:${fileType};base64,${imageBuffer.toString('base64')}`
            }
          }
        ]
      }
    ],
    response_format: { type: 'json_object' }
  })

  const content = response.choices[0].message.content
  if (!content) {
    return { events: [] }
  }

  const result = JSON.parse(content) as GPTResponse

  if (!Array.isArray(result.events)) {
    return { events: [] }
  }

  result.events = result.events.map(event => ({
    title: event.title || '',
    address: event.address || '',
    location: event.location || 'Other',
    type: event.type || 'Something Else',
    startDay: event.startDay || null,
    startTime: event.startTime || null,
    description: event.description || '',
    cost: event.cost || null,
    endDay: event.endDay || event.startDay || null,
    endTime: event.endTime || null
  }))

  return result
}
