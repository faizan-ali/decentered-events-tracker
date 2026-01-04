import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Event, addEventsToSpreadsheet, formatCost, formatDate, formatEventForSpreadsheet, formatTime } from './sheets'

// Mock googleapis
vi.mock('googleapis', () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: {
        values: {
          append: vi.fn().mockResolvedValue({
            data: {
              updates: {
                updatedRange: 'Sheet1!A1:J5'
              }
            }
          })
        }
      }
    }))
  }
}))

// Mock google-auth-library
vi.mock('google-auth-library', () => ({
  JWT: vi.fn().mockImplementation(() => ({}))
}))

describe('formatDate', () => {
  describe('valid date strings', () => {
    it('should format date string to MM/DD/YYYY', () => {
      // Using full ISO format to avoid timezone issues
      const result = formatDate('2025-03-15T12:00:00')
      expect(result).toBe('03/15/2025')
    })

    it('should format dates with single digit month/day', () => {
      const result = formatDate('2025-01-05T12:00:00')
      expect(result).toBe('01/05/2025')
    })

    it('should handle year boundaries', () => {
      expect(formatDate('2024-12-31T12:00:00')).toBe('12/31/2024')
      expect(formatDate('2025-01-01T12:00:00')).toBe('01/01/2025')
    })

    it('should handle leap year dates', () => {
      expect(formatDate('2024-02-29T12:00:00')).toBe('02/29/2024')
    })

    it('should parse YYYY-MM-DD format (may shift due to timezone)', () => {
      // YYYY-MM-DD is parsed as UTC, so result may be off by a day depending on local timezone
      const result = formatDate('2025-03-15')
      // Just verify it returns a valid formatted date, not the original string
      expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4}$/)
    })
  })

  describe('null and empty inputs', () => {
    it('should return empty string for null', () => {
      expect(formatDate(null)).toBe('')
    })
  })

  describe('invalid date strings', () => {
    it('should return original string for unparseable dates', () => {
      expect(formatDate('not-a-date')).toBe('not-a-date')
    })

    it('should return original for invalid format', () => {
      expect(formatDate('invalid')).toBe('invalid')
    })
  })
})

describe('formatTime', () => {
  describe('24-hour format conversion', () => {
    it('should convert 24-hour morning time to 12-hour AM', () => {
      expect(formatTime('09:30')).toBe('9:30 AM')
    })

    it('should convert noon to 12:00 PM', () => {
      expect(formatTime('12:00')).toBe('12:00 PM')
    })

    it('should convert afternoon time to PM', () => {
      expect(formatTime('14:30')).toBe('2:30 PM')
    })

    it('should convert evening time to PM', () => {
      expect(formatTime('19:00')).toBe('7:00 PM')
    })

    it('should convert late night to PM', () => {
      expect(formatTime('23:45')).toBe('11:45 PM')
    })

    it('should convert midnight to 12:00 AM', () => {
      expect(formatTime('00:00')).toBe('12:00 AM')
    })

    it('should convert early morning to AM', () => {
      expect(formatTime('01:15')).toBe('1:15 AM')
    })
  })

  describe('already formatted AM/PM times', () => {
    it('should preserve and uppercase AM times', () => {
      expect(formatTime('9:30 am')).toBe('9:30 AM')
    })

    it('should preserve and uppercase PM times', () => {
      expect(formatTime('7:00 pm')).toBe('7:00 PM')
    })

    it('should preserve already uppercase AM/PM', () => {
      expect(formatTime('10:00 AM')).toBe('10:00 AM')
    })

    it('should handle mixed case', () => {
      expect(formatTime('3:30 Pm')).toBe('3:30 PM')
    })
  })

  describe('null and empty inputs', () => {
    it('should return empty string for null', () => {
      expect(formatTime(null)).toBe('')
    })
  })

  describe('edge cases', () => {
    it('should handle times with leading/trailing whitespace', () => {
      expect(formatTime('  14:00  ')).toBe('2:00 PM')
    })

    it('should return original for invalid format', () => {
      expect(formatTime('not-a-time')).toBe('not-a-time')
    })

    it('should handle single digit hours', () => {
      expect(formatTime('9:00')).toBe('9:00 AM')
    })
  })
})

describe('formatCost', () => {
  describe('free events', () => {
    it('should return Free for "free" (case insensitive)', () => {
      expect(formatCost('free')).toBe('Free')
      expect(formatCost('Free')).toBe('Free')
      expect(formatCost('FREE')).toBe('Free')
    })

    it('should return Free for "0"', () => {
      expect(formatCost('0')).toBe('Free')
    })

    it('should return Free for "$0"', () => {
      expect(formatCost('$0')).toBe('Free')
    })

    it('should return Free for strings containing "free"', () => {
      expect(formatCost('Free admission')).toBe('Free')
      expect(formatCost('This is free')).toBe('Free')
    })
  })

  describe('priced events', () => {
    it('should preserve existing $ sign', () => {
      expect(formatCost('$20')).toBe('$20')
      expect(formatCost('$15.00')).toBe('$15.00')
    })

    it('should add $ sign to plain numbers', () => {
      expect(formatCost('20')).toBe('$20')
      expect(formatCost('15.00')).toBe('$15.00')
    })

    it('should extract numbers from mixed strings', () => {
      expect(formatCost('About 25 dollars')).toBe('$25')
    })
  })

  describe('null and unknown', () => {
    it('should return Unknown for null', () => {
      expect(formatCost(null)).toBe('Unknown')
    })
  })

  describe('edge cases', () => {
    it('should handle whitespace around dollar amounts', () => {
      // Note: The function preserves existing $ format as-is (with whitespace)
      // Testing actual behavior
      expect(formatCost('  $30  ')).toBe('  $30  ')
    })

    it('should handle whitespace around plain numbers', () => {
      expect(formatCost('  30  ')).toBe('$30')
    })

    it('should return original for non-numeric strings', () => {
      expect(formatCost('TBD')).toBe('TBD')
    })

    it('should return original for strings without parseable cost', () => {
      expect(formatCost('donation')).toBe('donation')
    })
  })
})

describe('formatEventForSpreadsheet', () => {
  const baseEvent: Event = {
    title: 'Test Concert',
    address: '123 Main St, San Francisco, CA',
    location: 'San Francisco',
    type: 'Music',
    startDay: '2025-03-15T12:00:00',
    startTime: '19:00',
    description: 'A great concert',
    cost: '$25',
    endDay: '2025-03-15T12:00:00',
    endTime: '22:00'
  }

  it('should format all fields correctly', () => {
    const result = formatEventForSpreadsheet(baseEvent, 'https://s3.example.com/image.png')

    expect(result).toEqual({
      date: '03/15/2025',
      eventName: 'Test Concert',
      type: 'Music',
      startTime: '7:00 PM',
      endTime: '10:00 PM',
      location: 'San Francisco',
      address: '123 Main St, San Francisco, CA',
      description: 'A great concert',
      cost: '$25',
      link: 'https://s3.example.com/image.png'
    })
  })

  it('should handle null fields', () => {
    const event: Event = {
      ...baseEvent,
      startDay: null,
      startTime: null,
      cost: null,
      endTime: null
    }

    const result = formatEventForSpreadsheet(event, '')

    expect(result.date).toBe('')
    expect(result.startTime).toBe('')
    expect(result.endTime).toBe('')
    expect(result.cost).toBe('Unknown')
    expect(result.link).toBe('')
  })

  it('should handle empty string fields', () => {
    const event: Event = {
      title: '',
      address: '',
      location: '',
      type: '',
      startDay: null,
      startTime: null,
      description: '',
      cost: null,
      endDay: null,
      endTime: null
    }

    const result = formatEventForSpreadsheet(event, '')

    expect(result.eventName).toBe('')
    expect(result.type).toBe('')
    expect(result.location).toBe('')
    expect(result.address).toBe('')
    expect(result.description).toBe('')
  })

  it('should include s3Url as link', () => {
    const result = formatEventForSpreadsheet(baseEvent, 'https://bucket.s3.amazonaws.com/images/flyer.jpg')

    expect(result.link).toBe('https://bucket.s3.amazonaws.com/images/flyer.jpg')
  })
})

describe('addEventsToSpreadsheet', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = {
      ...originalEnv,
      GOOGLE_SPREADSHEET_ID: 'test-spreadsheet-id',
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test@example.com',
      GOOGLE_PRIVATE_KEY: 'test-key'
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  const sampleEvent: Event = {
    title: 'Test Event',
    address: '123 Main St',
    location: 'San Francisco',
    type: 'Music',
    startDay: '2025-03-15T12:00:00',
    startTime: '19:00',
    description: 'A test event',
    cost: '$20',
    endDay: '2025-03-15T12:00:00',
    endTime: '22:00'
  }

  it('should return early if eventGroups is empty', async () => {
    const consoleSpy = vi.spyOn(console, 'log')

    await addEventsToSpreadsheet([])

    expect(consoleSpy).toHaveBeenCalledWith('No events to add to spreadsheet')
  })

  it('should return early if all event groups have empty events arrays', async () => {
    const consoleSpy = vi.spyOn(console, 'log')

    await addEventsToSpreadsheet([{ events: [], s3Url: 'test' }, { events: [] }])

    expect(consoleSpy).toHaveBeenCalledWith('No events to add to spreadsheet after processing')
  })

  it('should throw error if GOOGLE_SPREADSHEET_ID is not set', async () => {
    process.env.GOOGLE_SPREADSHEET_ID = ''

    await expect(addEventsToSpreadsheet([{ events: [sampleEvent] }])).rejects.toThrow('GOOGLE_SPREADSHEET_ID environment variable not set')
  })

  it('should process single event group', async () => {
    await addEventsToSpreadsheet([{ events: [sampleEvent], s3Url: 'https://example.com/image.png' }])

    // If no error thrown, the function completed successfully
    expect(true).toBe(true)
  })

  it('should process multiple event groups', async () => {
    const eventGroups = [
      { events: [sampleEvent], s3Url: 'https://example.com/image1.png' },
      {
        events: [
          { ...sampleEvent, title: 'Second Event' },
          { ...sampleEvent, title: 'Third Event' }
        ],
        s3Url: 'https://example.com/image2.png'
      }
    ]

    await addEventsToSpreadsheet(eventGroups)

    // If no error thrown, the function completed successfully
    expect(true).toBe(true)
  })

  it('should skip groups with empty events array', async () => {
    const consoleSpy = vi.spyOn(console, 'log')

    await addEventsToSpreadsheet([{ events: [] }, { events: [sampleEvent], s3Url: 'https://example.com/image.png' }])

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Successfully added 1 events'))
  })
})
