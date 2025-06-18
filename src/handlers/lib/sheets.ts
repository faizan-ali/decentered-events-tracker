import { JWT } from 'google-auth-library'
import { google } from 'googleapis'

interface Event {
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

interface FormattedEventRow {
  date: string
  eventName: string
  type: string
  startTime: string
  endTime: string
  location: string
  address: string
  description: string
  cost: string
  link: string
}

// Initialize Google Sheets API
async function getAuthenticatedSheetsClient() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  })

  const sheets = google.sheets({ version: 'v4', auth })
  return sheets
}

// Format date from YYYY-MM-DD or similar to MM/DD/YYYY
function formatDate(dateString: string | null): string {
  if (!dateString) return ''

  try {
    const date = new Date(dateString)
    if (Number.isNaN(date.getTime())) return dateString // Return original if can't parse

    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const year = date.getFullYear()

    return `${month}/${day}/${year}`
  } catch {
    return dateString // Return original if any error
  }
}

// Format time to HH:MM AM/PM
function formatTime(timeString: string | null): string {
  if (!timeString) return ''

  try {
    // Handle various time formats
    const time = timeString.trim()

    // If already in AM/PM format, return as is
    if (time.match(/\d{1,2}:\d{2}\s*(AM|PM)/i)) {
      return time.toUpperCase()
    }

    // Parse 24-hour format
    const timeMatch = time.match(/(\d{1,2}):(\d{2})/)
    if (timeMatch) {
      let hours = Number.parseInt(timeMatch[1])
      const minutes = timeMatch[2]
      const ampm = hours >= 12 ? 'PM' : 'AM'

      if (hours === 0) hours = 12
      else if (hours > 12) hours -= 12

      return `${hours}:${minutes} ${ampm}`
    }

    return time
  } catch {
    return timeString || ''
  }
}

// Format cost to $XX or Free
function formatCost(costString: string | null): string {
  if (!costString) return 'Free'

  const cost = costString.toLowerCase().trim()

  if (cost === 'free' || cost === '0' || cost === '$0') {
    return 'Free'
  }

  // If it already has $ sign, return as is
  if (cost.startsWith('$')) {
    return costString
  }

  // Try to parse as number and add $ sign
  const numMatch = cost.match(/(\d+(?:\.\d{2})?)/)
  if (numMatch) {
    return `$${numMatch[1]}`
  }

  return costString || 'Free'
}

// Convert event to spreadsheet row format
function formatEventForSpreadsheet(event: Event, s3Url: string): FormattedEventRow {
  return {
    date: formatDate(event.startDay),
    eventName: event.title || '',
    type: event.type || '',
    startTime: formatTime(event.startTime),
    endTime: formatTime(event.endTime),
    location: event.location || '',
    address: event.address || '',
    description: event.description || '',
    cost: formatCost(event.cost),
    link: s3Url
  }
}

// Add events to Google Spreadsheet
export async function addEventsToSpreadsheet(events: Event[], s3Url?: string): Promise<void> {
  if (!events.length) {
    console.log('No events to add to spreadsheet')
    return
  }

  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID
  if (!spreadsheetId) {
    throw new Error('GOOGLE_SPREADSHEET_ID environment variable not set')
  }

  const sheets = await getAuthenticatedSheetsClient()

  // Format events for spreadsheet
  const formattedEvents = events.map(event => formatEventForSpreadsheet(event, s3Url || ''))

  // Convert to array of arrays for batch insert
  const rows = formattedEvents.map(event => [
    event.date,
    event.eventName,
    event.type,
    event.startTime,
    event.endTime,
    event.location,
    event.address,
    event.description,
    event.cost,
    event.link
  ])

  try {
    // Append rows to the spreadsheet
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'A:J', // Columns A through J
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: rows
      }
    })

    console.log(`Successfully added ${rows.length} events to spreadsheet. Updated range: ${result.data.updates?.updatedRange}`)
  } catch (error) {
    console.error('Error adding events to spreadsheet:', error)
    throw error
  }
}

// Create headers if needed (call this once to set up the spreadsheet)
export async function createSpreadsheetHeaders(): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID
  if (!spreadsheetId) {
    throw new Error('GOOGLE_SPREADSHEET_ID environment variable not set')
  }

  const sheets = await getAuthenticatedSheetsClient()

  const headers = ['Date', 'Event Name', 'Type', 'Start Time', 'End Time', 'Location', 'Address', 'Description', 'Cost', 'Link']

  try {
    // Check if headers already exist
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'A1:J1'
    })

    // If first row is empty, add headers
    if (!response.data.values || response.data.values.length === 0 || response.data.values[0].length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'A1:J1',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [headers]
        }
      })
      console.log('Headers added to spreadsheet')
    } else {
      console.log('Headers already exist in spreadsheet')
    }
  } catch (error) {
    console.error('Error creating spreadsheet headers:', error)
    throw error
  }
}
