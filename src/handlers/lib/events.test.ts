import { describe, expect, it } from 'vitest'
import { type Event, normalizeEvent } from './events'

describe('normalizeEvent', () => {
  const baseEvent: Event = {
    title: 'Test Event',
    address: '123 Main St',
    location: 'San Francisco',
    type: 'Music',
    startDay: '2025-03-15',
    startTime: '19:00',
    description: 'A test event',
    cost: '$20',
    endDay: '2025-03-15',
    endTime: '22:00'
  }

  describe('when all fields are present', () => {
    it('should return the event unchanged', () => {
      const result = normalizeEvent(baseEvent)

      expect(result).toEqual(baseEvent)
    })
  })

  describe('endTime calculation', () => {
    it('should add 3 hours to startTime when endTime is null', () => {
      const event: Event = {
        ...baseEvent,
        startTime: '14:30',
        endTime: null
      }

      const result = normalizeEvent(event)

      expect(result.endTime).toBe('17:30')
    })

    it('should add 3 hours to startTime when endTime is undefined', () => {
      const event: Event = {
        ...baseEvent,
        startTime: '09:00',
        endTime: null
      }

      const result = normalizeEvent(event)

      expect(result.endTime).toBe('12:00')
    })

    it('should handle midnight rollover (23:00 + 3 hours = 02:00)', () => {
      const event: Event = {
        ...baseEvent,
        startTime: '23:00',
        endTime: null
      }

      const result = normalizeEvent(event)

      expect(result.endTime).toBe('02:00')
    })

    it('should handle late night times (22:30 + 3 hours = 01:30)', () => {
      const event: Event = {
        ...baseEvent,
        startTime: '22:30',
        endTime: null
      }

      const result = normalizeEvent(event)

      expect(result.endTime).toBe('01:30')
    })

    it('should preserve existing endTime if present', () => {
      const event: Event = {
        ...baseEvent,
        startTime: '14:00',
        endTime: '16:00'
      }

      const result = normalizeEvent(event)

      expect(result.endTime).toBe('16:00')
    })

    it('should not add hours when startTime is null', () => {
      const event: Event = {
        ...baseEvent,
        startTime: null,
        endTime: null
      }

      const result = normalizeEvent(event)

      expect(result.endTime).toBeNull()
    })
  })

  describe('startDay/endDay normalization', () => {
    it('should set startDay to endDay when startDay is null', () => {
      const event: Event = {
        ...baseEvent,
        startDay: null,
        endDay: '2025-03-20'
      }

      const result = normalizeEvent(event)

      expect(result.startDay).toBe('2025-03-20')
    })

    it('should set endDay to startDay when endDay is null', () => {
      const event: Event = {
        ...baseEvent,
        startDay: '2025-03-15',
        endDay: null
      }

      const result = normalizeEvent(event)

      expect(result.endDay).toBe('2025-03-15')
    })

    it('should handle both startDay and endDay being null', () => {
      const event: Event = {
        ...baseEvent,
        startDay: null,
        endDay: null
      }

      const result = normalizeEvent(event)

      expect(result.startDay).toBeNull()
      expect(result.endDay).toBeNull()
    })
  })

  describe('startTime/endTime normalization', () => {
    it('should set startTime to endTime when startTime is null', () => {
      const event: Event = {
        ...baseEvent,
        startTime: null,
        endTime: '18:00'
      }

      const result = normalizeEvent(event)

      expect(result.startTime).toBe('18:00')
    })

    it('should handle both startTime and endTime being null', () => {
      const event: Event = {
        ...baseEvent,
        startTime: null,
        endTime: null
      }

      const result = normalizeEvent(event)

      expect(result.startTime).toBeNull()
      expect(result.endTime).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('should handle event with minimal data', () => {
      const event: Event = {
        title: 'Minimal Event',
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

      const result = normalizeEvent(event)

      expect(result.title).toBe('Minimal Event')
      expect(result.startDay).toBeNull()
      expect(result.endDay).toBeNull()
      expect(result.startTime).toBeNull()
      expect(result.endTime).toBeNull()
    })

    it('should preserve all other fields unchanged', () => {
      const event: Event = {
        title: 'Special Event',
        address: '456 Oak Ave',
        location: 'Oakland',
        type: 'Theater',
        startDay: '2025-04-01',
        startTime: '20:00',
        description: 'A very special event with lots of details',
        cost: 'Free',
        endDay: '2025-04-01',
        endTime: null
      }

      const result = normalizeEvent(event)

      expect(result.title).toBe('Special Event')
      expect(result.address).toBe('456 Oak Ave')
      expect(result.location).toBe('Oakland')
      expect(result.type).toBe('Theater')
      expect(result.description).toBe('A very special event with lots of details')
      expect(result.cost).toBe('Free')
    })
  })
})
