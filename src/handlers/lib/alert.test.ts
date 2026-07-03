import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))
vi.mock('inboundemail', () => ({
  Inbound: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } }))
}))

import { type AlertEmailInfo, sendFailureAlert, sendOpsAlert } from './alert'

function makeEmail(): AlertEmailInfo {
  return {
    from: 'Liz Cahill <liz@decentered.org>',
    subject: 'New flyers',
    receivedAt: '2026-06-29T20:31:22.622Z',
    textBody: 'here are the flyers',
    htmlBody: '<p>here are the flyers</p>'
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

  it('falls back to "unknown"/defaults when fields are empty (minimal payloads)', async () => {
    await sendFailureAlert({ from: '', subject: '', receivedAt: '', textBody: '', htmlBody: null }, ['inbound.new failed to ingest this email'], ['me@example.com'])

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
