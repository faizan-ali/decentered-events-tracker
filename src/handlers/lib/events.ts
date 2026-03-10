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
      const time = event.startTime.trim()
      let startDateTime: Date

      // Try 24-hour format first (e.g. "14:30"), then 12-hour (e.g. "2:30 PM")
      if (time.match(/^\d{1,2}:\d{2}$/)) {
        startDateTime = parse(time, 'HH:mm', new Date())
      } else if (time.match(/\d{1,2}:\d{2}\s*(AM|PM)/i)) {
        startDateTime = parse(time.toUpperCase(), 'h:mm aa', new Date())
      } else {
        startDateTime = parse(time, 'HH:mm', new Date())
      }

      if (!Number.isNaN(startDateTime.getTime())) {
        const endDateTime = addHours(startDateTime, 3)
        endTime = format(endDateTime, 'HH:mm')
      }
    } catch (error) {
      console.error('Error parsing start time:', error, event)
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
