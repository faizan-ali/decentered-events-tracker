import { addHours, format, parse } from 'date-fns'

export interface Event {
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
}

export const normalizeEvent = (event: Event) => {
  let endTime = event.endTime

  // If endTime is not defined but startTime is defined, add 3 hours to startTime
  if (!endTime && event.startTime) {
    try {
      // Parse the start time (assuming format like "14:30" or "2:30 PM")
      const startDateTime = parse(event.startTime, 'HH:mm', new Date())
      const endDateTime = addHours(startDateTime, 3)
      endTime = format(endDateTime, 'HH:mm')
    } catch (error) {
      console.error('Error parsing start time:', error, event)
      // If parsing fails, fall back to the original logic
    }
  }

  return {
    ...event,
    startDay: event.startDay || event.endDay,
    startTime: event.startTime || event.endTime,
    endDay: event.endDay || event.startDay,
    endTime
  }
}
