import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const S3_BUCKET = process.env.S3_BUCKET
const AWS_REGION = process.env.REGION

const s3Client = new S3Client({ region: AWS_REGION })

export async function uploadToS3(buffer: Buffer, filename: string, contentType: string): Promise<string> {
  const s3Key = `images/${filename}`

  const uploadCommand = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: buffer,
    ContentType: contentType,
    Metadata: {
      originalFilename: filename,
      uploadTimestamp: new Date().toISOString()
    }
  })

  await s3Client.send(uploadCommand)

  return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${s3Key}`
}
