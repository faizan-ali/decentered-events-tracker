import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Use vi.hoisted to ensure mockCreate is available when vi.mock runs
const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn()
}))

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate
      }
    }
  }))
}))

// Import after mock is set up
import { extractEvents } from './openai'

describe('extractEvents', () => {
  const sampleImageBuffer = Buffer.from('fake-image-data')
  const sampleContentType = 'image/png'

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OPENAI_API_KEY = 'test-api-key'
  })

  afterEach(() => {
    process.env.OPENAI_API_KEY = undefined
  })

  describe('successful extraction', () => {
    it('should extract single event from image', async () => {
      const mockResponse = {
        events: [
          {
            title: 'Jazz Night',
            address: '123 Main St, San Francisco, CA',
            location: 'San Francisco',
            type: 'Music',
            startDay: '2025-03-15',
            startTime: '20:00',
            description: 'Live jazz performance',
            cost: '$25',
            endDay: null,
            endTime: null
          }
        ]
      }

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }]
      })

      const result = await extractEvents(sampleImageBuffer, sampleContentType)

      expect(result.events).toHaveLength(1)
      expect(result.events[0].title).toBe('Jazz Night')
      expect(result.events[0].endDay).toBe('2025-03-15') // Should be set to startDay
    })

    it('should extract multiple events from image', async () => {
      const mockResponse = {
        events: [
          {
            title: 'Event One',
            address: '123 Main St',
            location: 'San Francisco',
            type: 'Music',
            startDay: '2025-03-15',
            startTime: '19:00',
            description: 'First event',
            cost: '$20',
            endDay: null,
            endTime: null
          },
          {
            title: 'Event Two',
            address: '456 Oak Ave',
            location: 'Oakland',
            type: 'Theater',
            startDay: '2025-03-16',
            startTime: '20:00',
            description: 'Second event',
            cost: 'Free',
            endDay: null,
            endTime: null
          }
        ]
      }

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }]
      })

      const result = await extractEvents(sampleImageBuffer, sampleContentType)

      expect(result.events).toHaveLength(2)
      expect(result.events[0].title).toBe('Event One')
      expect(result.events[1].title).toBe('Event Two')
    })

    it('should return empty events array when no events found', async () => {
      const mockResponse = { events: [] }

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }]
      })

      const result = await extractEvents(sampleImageBuffer, sampleContentType)

      expect(result.events).toHaveLength(0)
    })
  })

  describe('endDay normalization', () => {
    it('should set endDay to startDay when endDay is null', async () => {
      const mockResponse = {
        events: [
          {
            title: 'Test Event',
            address: '123 Main St',
            location: 'San Francisco',
            type: 'Music',
            startDay: '2025-04-20',
            startTime: '19:00',
            description: 'Test',
            cost: null,
            endDay: null,
            endTime: null
          }
        ]
      }

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }]
      })

      const result = await extractEvents(sampleImageBuffer, sampleContentType)

      expect(result.events[0].endDay).toBe('2025-04-20')
    })

    it('should preserve endDay when it is provided', async () => {
      const mockResponse = {
        events: [
          {
            title: 'Multi-day Event',
            address: '123 Main St',
            location: 'San Francisco',
            type: 'Festival',
            startDay: '2025-04-20',
            startTime: '10:00',
            description: 'Weekend festival',
            cost: '$50',
            endDay: '2025-04-22',
            endTime: '23:00'
          }
        ]
      }

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(mockResponse) } }]
      })

      const result = await extractEvents(sampleImageBuffer, sampleContentType)

      expect(result.events[0].endDay).toBe('2025-04-22')
    })
  })

  describe('API call parameters', () => {
    it('should call OpenAI with correct model and parameters', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ events: [] }) } }]
      })

      await extractEvents(sampleImageBuffer, sampleContentType)

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o',
          response_format: { type: 'json_object' }
        })
      )
    })

    it('should send image as base64 with correct content type', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ events: [] }) } }]
      })

      await extractEvents(sampleImageBuffer, 'image/jpeg')

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'image_url',
                  image_url: expect.objectContaining({
                    url: expect.stringContaining('data:image/jpeg;base64,')
                  })
                })
              ])
            })
          ])
        })
      )
    })

    it('should include the prompt in the message', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ events: [] }) } }]
      })

      await extractEvents(sampleImageBuffer, sampleContentType)

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([expect.objectContaining({ type: 'text' })])
            })
          ])
        })
      )
    })
  })

  describe('different image types', () => {
    it('should handle PNG images', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ events: [] }) } }]
      })

      await extractEvents(sampleImageBuffer, 'image/png')

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  image_url: expect.objectContaining({
                    url: expect.stringContaining('data:image/png;base64,')
                  })
                })
              ])
            })
          ])
        })
      )
    })

    it('should handle JPEG images', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ events: [] }) } }]
      })

      await extractEvents(sampleImageBuffer, 'image/jpeg')

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  image_url: expect.objectContaining({
                    url: expect.stringContaining('data:image/jpeg;base64,')
                  })
                })
              ])
            })
          ])
        })
      )
    })

    it('should handle GIF images', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ events: [] }) } }]
      })

      await extractEvents(sampleImageBuffer, 'image/gif')

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  image_url: expect.objectContaining({
                    url: expect.stringContaining('data:image/gif;base64,')
                  })
                })
              ])
            })
          ])
        })
      )
    })
  })

  describe('error handling', () => {
    it('should propagate OpenAI API errors', async () => {
      mockCreate.mockRejectedValue(new Error('API rate limit exceeded'))

      await expect(extractEvents(sampleImageBuffer, sampleContentType)).rejects.toThrow('API rate limit exceeded')
    })

    it('should throw on malformed JSON response', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: 'not valid json' } }]
      })

      await expect(extractEvents(sampleImageBuffer, sampleContentType)).rejects.toThrow()
    })
  })

  describe('event field coverage', () => {
    it('should handle events with all fields populated', async () => {
      const fullEvent = {
        title: 'Complete Event',
        address: '123 Main St, San Francisco, CA 94102',
        location: 'San Francisco',
        type: 'Multi Media',
        startDay: '2025-05-01',
        startTime: '18:00',
        description: 'A complete event with all fields filled out for testing purposes.',
        cost: '$30',
        endDay: '2025-05-01',
        endTime: '21:00'
      }

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ events: [fullEvent] }) } }]
      })

      const result = await extractEvents(sampleImageBuffer, sampleContentType)

      expect(result.events[0]).toEqual(fullEvent)
    })

    it('should handle events with minimal fields', async () => {
      const minimalEvent = {
        title: 'Minimal Event',
        address: '',
        location: 'Other',
        type: 'Something Else',
        startDay: null,
        startTime: null,
        description: 'Just a description',
        cost: null,
        endDay: null,
        endTime: null
      }

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ events: [minimalEvent] }) } }]
      })

      const result = await extractEvents(sampleImageBuffer, sampleContentType)

      expect(result.events[0].title).toBe('Minimal Event')
      expect(result.events[0].startDay).toBeNull()
      expect(result.events[0].endDay).toBeNull() // Stays null because startDay is also null
    })

    it('should handle virtual events', async () => {
      const virtualEvent = {
        title: 'Online Workshop',
        address: 'Virtual',
        location: 'Virtual',
        type: 'Workshop',
        startDay: '2025-06-15',
        startTime: '14:00',
        description: 'An online workshop',
        cost: 'Free',
        endDay: null,
        endTime: '16:00'
      }

      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ events: [virtualEvent] }) } }]
      })

      const result = await extractEvents(sampleImageBuffer, sampleContentType)

      expect(result.events[0].address).toBe('Virtual')
      expect(result.events[0].location).toBe('Virtual')
    })
  })
})
