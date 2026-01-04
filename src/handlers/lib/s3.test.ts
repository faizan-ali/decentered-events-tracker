import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock AWS SDK before any imports
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn()
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockSend
  })),
  PutObjectCommand: vi.fn().mockImplementation(params => params)
}))

describe('uploadToS3', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    // Set env vars before importing the module
    process.env = {
      ...originalEnv,
      S3_BUCKET: 'test-bucket',
      REGION: 'us-west-1'
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  async function getUploadToS3() {
    const { uploadToS3 } = await import('./s3')
    return uploadToS3
  }

  describe('successful uploads', () => {
    it('should upload buffer to S3 and return URL', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const buffer = Buffer.from('test image data')
      const filename = 'test-image.png'
      const contentType = 'image/png'

      const result = await uploadToS3(buffer, filename, contentType)

      expect(result).toBe('https://test-bucket.s3.us-west-1.amazonaws.com/images/test-image.png')
    })

    it('should upload with correct S3 key format', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const buffer = Buffer.from('test')
      const filename = 'my-flyer.jpg'

      await uploadToS3(buffer, filename, 'image/jpeg')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: 'images/my-flyer.jpg'
        })
      )
    })

    it('should set correct bucket name', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const buffer = Buffer.from('test')

      await uploadToS3(buffer, 'test.png', 'image/png')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'test-bucket'
        })
      )
    })

    it('should pass buffer as Body', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const buffer = Buffer.from('image binary content')

      await uploadToS3(buffer, 'test.png', 'image/png')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Body: buffer
        })
      )
    })

    it('should set correct content type', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const buffer = Buffer.from('test')

      await uploadToS3(buffer, 'test.jpg', 'image/jpeg')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: 'image/jpeg'
        })
      )
    })
  })

  describe('metadata', () => {
    it('should include original filename in metadata', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const buffer = Buffer.from('test')
      const filename = 'original-name.png'

      await uploadToS3(buffer, filename, 'image/png')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Metadata: expect.objectContaining({
            originalFilename: filename
          })
        })
      )
    })

    it('should include upload timestamp in metadata', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const buffer = Buffer.from('test')

      await uploadToS3(buffer, 'test.png', 'image/png')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Metadata: expect.objectContaining({
            uploadTimestamp: expect.any(String)
          })
        })
      )
    })

    it('should have ISO format timestamp', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const buffer = Buffer.from('test')

      await uploadToS3(buffer, 'test.png', 'image/png')

      const callArg = mockSend.mock.calls[0][0]
      const timestamp = callArg.Metadata.uploadTimestamp

      // Should be a valid ISO date string
      expect(new Date(timestamp).toISOString()).toBe(timestamp)
    })
  })

  describe('URL generation', () => {
    it('should generate correct URL for us-west-1 region', async () => {
      process.env.REGION = 'us-west-1'
      process.env.S3_BUCKET = 'my-bucket'
      vi.resetModules()
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const result = await uploadToS3(Buffer.from('test'), 'image.png', 'image/png')

      expect(result).toBe('https://my-bucket.s3.us-west-1.amazonaws.com/images/image.png')
    })

    it('should generate correct URL for us-east-1 region', async () => {
      process.env.REGION = 'us-east-1'
      process.env.S3_BUCKET = 'east-bucket'
      vi.resetModules()
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const result = await uploadToS3(Buffer.from('test'), 'photo.jpg', 'image/jpeg')

      expect(result).toBe('https://east-bucket.s3.us-east-1.amazonaws.com/images/photo.jpg')
    })

    it('should handle filenames with spaces', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const result = await uploadToS3(Buffer.from('test'), 'my image file.png', 'image/png')

      expect(result).toContain('my image file.png')
    })

    it('should handle filenames with special characters', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const result = await uploadToS3(Buffer.from('test'), 'image-2025_03.png', 'image/png')

      expect(result).toContain('image-2025_03.png')
    })
  })

  describe('different content types', () => {
    it('should handle PNG images', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      await uploadToS3(Buffer.from('test'), 'test.png', 'image/png')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: 'image/png'
        })
      )
    })

    it('should handle JPEG images', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      await uploadToS3(Buffer.from('test'), 'test.jpg', 'image/jpeg')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: 'image/jpeg'
        })
      )
    })

    it('should handle GIF images', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      await uploadToS3(Buffer.from('test'), 'test.gif', 'image/gif')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: 'image/gif'
        })
      )
    })

    it('should handle WebP images', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      await uploadToS3(Buffer.from('test'), 'test.webp', 'image/webp')

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: 'image/webp'
        })
      )
    })
  })

  describe('error handling', () => {
    it('should propagate S3 errors', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockRejectedValue(new Error('S3 access denied'))

      await expect(uploadToS3(Buffer.from('test'), 'test.png', 'image/png')).rejects.toThrow('S3 access denied')
    })

    it('should propagate network errors', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockRejectedValue(new Error('Network error'))

      await expect(uploadToS3(Buffer.from('test'), 'test.png', 'image/png')).rejects.toThrow('Network error')
    })

    it('should propagate bucket not found errors', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockRejectedValue(new Error('NoSuchBucket: The specified bucket does not exist'))

      await expect(uploadToS3(Buffer.from('test'), 'test.png', 'image/png')).rejects.toThrow('NoSuchBucket')
    })
  })

  describe('edge cases', () => {
    it('should handle empty buffer', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const emptyBuffer = Buffer.from('')

      const result = await uploadToS3(emptyBuffer, 'empty.png', 'image/png')

      expect(result).toBe('https://test-bucket.s3.us-west-1.amazonaws.com/images/empty.png')
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          Body: emptyBuffer
        })
      )
    })

    it('should handle large buffers', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const largeBuffer = Buffer.alloc(10 * 1024 * 1024) // 10MB

      const result = await uploadToS3(largeBuffer, 'large.png', 'image/png')

      expect(result).toContain('large.png')
      expect(mockSend).toHaveBeenCalled()
    })

    it('should handle very long filenames', async () => {
      const uploadToS3 = await getUploadToS3()
      mockSend.mockResolvedValue({})

      const longFilename = `${'a'.repeat(200)}.png`

      const result = await uploadToS3(Buffer.from('test'), longFilename, 'image/png')

      expect(result).toContain(longFilename)
    })
  })
})
