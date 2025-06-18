import dotenv from 'dotenv'
import { createSpreadsheetHeaders } from './src/handlers/lib/sheets'

dotenv.config()

async function setupSpreadsheet() {
  try {
    console.log('Setting up Google Spreadsheet headers...')
    await createSpreadsheetHeaders()
    console.log('Spreadsheet setup completed successfully!')
  } catch (error) {
    console.error('Failed to setup spreadsheet:', error)
    process.exit(1)
  }
}

setupSpreadsheet()
