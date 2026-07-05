// Every alert email is also archived to S3 BEFORE sending, so:
// 1. alerts are queryable without anyone forwarding/pasting emails
//    (aws s3 ls s3://$S3_BUCKET/alerts/), and
// 2. alert content survives even when inbound.new — the email transport
//    itself — is the thing that's down.
// Archive failures never block the send; they only log.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const S3_BUCKET = process.env.S3_BUCKET
const REGION = process.env.REGION

const s3Client = new S3Client({ region: REGION })

export async function archiveAlert(kind: string, subject: string, text: string, to: string[]): Promise<void> {
  try {
    // ISO timestamp key: lexicographic order == chronological order
    const key = `alerts/${new Date().toISOString()}_${kind}.json`
    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: JSON.stringify({ kind, subject, to, sentAt: new Date().toISOString(), text }, null, 2),
        ContentType: 'application/json'
      })
    )
  } catch (error) {
    console.warn('Failed to archive alert (non-fatal, email still sends):', error)
  }
}
