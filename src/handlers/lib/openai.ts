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
    model: 'gpt-5.4',
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
