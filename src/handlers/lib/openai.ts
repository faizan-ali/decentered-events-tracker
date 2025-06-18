import OpenAI from 'openai'
import { PROMPT } from './prompt'

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
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
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          {
            type: 'image_url',
            image_url: {
              url: `data:${fileType};base64,${imageBuffer.toString('base64')}`
            }
          }
        ]
      }
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1000
  })

  const result = JSON.parse(response.choices[0].message.content!) as GPTResponse

  result.events = result.events.map(event => {
    return {
      ...event,
      endDay: event.endDay || event.startDay
    }
  })

  return result
}
