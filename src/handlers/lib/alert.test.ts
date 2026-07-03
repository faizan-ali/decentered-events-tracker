import type { InboundWebhookEmail } from 'inboundemail'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))
vi.mock('inboundemail', () => ({
  Inbound: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } }))
}))

import { sendFailureAlert, sendOpsAlert } from './alert'

function makeEmail(): InboundWebhookEmail {
  return {
    id: 'email_123',
    messageId: '<abc@example.com>',
    from: { text: 'Liz Cahill <liz@decentered.org>', addresses: [{ address: 'liz@decentered.org', name: 'Liz Cahill' }] },
    to: { text: 'decentered@proteus.tools', addresses: [{ address: 'decentered@proteus.tools', name: null }] },
    recipient: 'decentered@proteus.tools',
    subject: 'New flyers',
    receivedAt: '2026-06-29T20:31:22.622Z',
    parsedData: {
      messageId: '<abc@example.com>',
      date: new Date('2026-06-29T20:31:22.622Z'),
      subject: 'New flyers',
      from: { text: 'Liz Cahill <liz@decentered.org>', addresses: [{ address: 'liz@decentered.org', name: 'Liz Cahill' }] },
      to: { text: 'decentered@proteus.tools', addresses: [{ address: 'decentered@proteus.tools', name: null }] },
      cc: null,
      bcc: null,
      replyTo: null,
      inReplyTo: undefined,
      references: undefined,
      textBody: 'here are the flyers',
      htmlBody: '<p>here are the flyers</p>',
      raw: '',
      attachments: [],
      headers: {},
      priority: undefined
    },
    cleanedContent: { html: null, text: null, hasHtml: false, hasText: false, attachments: [], headers: {} }
  }
}

describe('sendFailureAlert', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.clearAllMocks())

  it('sends to the configured recipients with the failure reasons and original message', async () => {
    const reasons = ['Google Drive link https://drive.google.com/file/d/FILE_A — not a public image']
    await sendFailureAlert(makeEmail(), reasons, ['me@example.com'])

    expect(mockSend).toHaveBeenCalledTimes(1)
    const arg = mockSend.mock.calls[0][0]
    expect(arg.to).toEqual(['me@example.com'])
    expect(arg.from).toBe('alerts@proteus.tools')
    expect(arg.subject).toContain('Flyer parse failed')
    expect(arg.text).toContain('FILE_A')
    expect(arg.text).toContain('liz@decentered.org')
    // forwards the original message body
    expect(arg.html).toContain('here are the flyers')
  })

  it('handles minimal payloads with null from and parsedData', async () => {
    const email = { ...makeEmail(), from: null, parsedData: null } as any
    await sendFailureAlert(email, ['inbound.new failed to ingest this email'], ['me@example.com'])

    expect(mockSend).toHaveBeenCalledTimes(1)
    const arg = mockSend.mock.calls[0][0]
    expect(arg.subject).toContain('unknown')
    expect(arg.text).toContain('failed to ingest')
  })
})

describe('sendOpsAlert', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends error details to the maintainer only', async () => {
    await sendOpsAlert(new TypeError("Cannot read properties of null (reading 'text')"), 'top-level catch')

    expect(mockSend).toHaveBeenCalledTimes(1)
    const arg = mockSend.mock.calls[0][0]
    expect(arg.to).toEqual(['faizanali619@gmail.com'])
    expect(arg.subject).toContain('Handler error')
    expect(arg.text).toContain("Cannot read properties of null (reading 'text')")
  })

  it('stringifies non-Error throws', async () => {
    await sendOpsAlert('string failure', 'ctx')
    expect(mockSend.mock.calls[0][0].text).toContain('string failure')
  })

  it('tags errors matching the minimal-payload signature with the known-issue note', async () => {
    await sendOpsAlert(new TypeError("Cannot read properties of null (reading 'text')"), 'ctx')
    const text = mockSend.mock.calls[0][0].text
    expect(text).toContain('minimal-payload issue')
    expect(text).not.toContain('No known failure mode matched')
  })

  it('tags transient-looking errors as likely retryable', async () => {
    await sendOpsAlert(new Error('fetch failed: ETIMEDOUT'), 'ctx')
    expect(mockSend.mock.calls[0][0].text).toContain('Looks transient')
  })

  it('falls back to the unknown-issue checklist when nothing matches', async () => {
    await sendOpsAlert(new Error('something entirely novel'), 'ctx')
    const text = mockSend.mock.calls[0][0].text
    expect(text).toContain('No known failure mode matched')
    expect(text).toContain('CLAUDE.md')
  })
})
