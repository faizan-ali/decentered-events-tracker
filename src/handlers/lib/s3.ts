import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const S3_BUCKET = process.env.S3_BUCKET
const REGION = process.env.REGION

const s3Client = new S3Client({ region: REGION })

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export async function uploadToS3(buffer: Buffer, filename: string, contentType: string): Promise<string> {
  const sanitized = sanitizeFilename(filename)
  const s3Key = `images/${Date.now()}_${sanitized}`

  const uploadCommand = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: contentType,
    Metadata: {
      originalFilename: encodeURIComponent(filename),
      uploadTimestamp: new Date().toISOString()
    }
  })

  await s3Client.send(uploadCommand)

  return `https://${S3_BUCKET}.s3.${REGION}.amazonaws.com/${s3Key}`
}
