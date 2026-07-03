// Some senders share flyers as Google Drive links (Gmail "Insert files using
// Drive" → "as link") instead of attaching them. In that case the webhook has
// no MIME attachment — only `drive.google.com/file/d/<ID>` links in the body —
// so those events would otherwise be silently dropped.

const DRIVE_FILE_LINKS = [/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/g, /drive\.google\.com\/open\?id=([A-Za-z0-9_-]+)/g]

// Strip quoted reply history so Drive links from earlier emails in a thread are
// not reprocessed (and re-alerted on) every time someone replies. Gmail wraps
// quotes in <blockquote>/<div class="gmail_quote">; plaintext quotes use "> ".
function stripQuotedContent(body: string): string {
  return body
    .replace(/<blockquote[\s\S]*<\/blockquote>/gi, '')
    .replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/gi, '')
    .replace(/^\s*On .{0,200} wrote:\s*$[\s\S]*/m, '')
    .split('\n')
    .filter(line => !line.startsWith('>'))
    .join('\n')
}

// Extract unique Drive file IDs from the email body. The small 32px
// `drive-thirdparty.googleusercontent.com` file-type icons Gmail inlines do not
// match this pattern, so they are ignored.
export function extractDriveFileIds(...bodies: Array<string | null | undefined>): string[] {
  const ids = new Set<string>()

  for (const body of bodies) {
    if (!body) continue
    const fresh = stripQuotedContent(body)
    for (const pattern of DRIVE_FILE_LINKS) {
      for (const match of fresh.matchAll(pattern)) {
        ids.add(match[1])
      }
    }
  }

  return [...ids]
}

// Fetch a Drive-hosted image via the thumbnail endpoint, which returns a
// normalized PNG at a bounded resolution. This avoids the raw-download path,
// which can hand back multi-MB originals or non-image formats (e.g. PDF).
//
// The endpoint returns HTTP 200 with an HTML "Sign in" page when the file is
// not publicly shared, so a bad status is not enough — we must reject any
// response that is not actually image bytes, otherwise HTML would be handed to
// the vision model and silently yield no events.
export async function downloadDriveImage(fileId: string): Promise<Buffer> {
  const url = `https://drive.google.com/thumbnail?id=${fileId}&sz=w2000`
  // Bounded: a hung fetch would otherwise burn the whole 29s API Gateway budget
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) })

  if (!response.ok) {
    throw new Error(`Failed to download Drive image ${fileId}: ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  const buffer = Buffer.from(await response.arrayBuffer())

  if (!contentType.startsWith('image/') || !isImageBuffer(buffer)) {
    throw new Error(`Drive file ${fileId} is not a public image (got ${contentType || 'unknown'}, ${buffer.length} bytes) — likely a private "share required" file`)
  }

  return buffer
}

// Detect image bytes by magic number (PNG, JPEG, GIF, WebP) so we never forward
// an HTML interstitial to the vision model.
export function isImageBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) return false
  const hex4 = buffer.subarray(0, 4).toString('hex')
  if (hex4 === '89504e47') return true // PNG
  if (hex4.startsWith('ffd8')) return true // JPEG
  if (hex4 === '47494638') return true // GIF
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return true // WebP
  return false
}
