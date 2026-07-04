import { describe, expect, it } from 'vitest'
import { buildPrompt } from './prompt'

describe('buildPrompt', () => {
  it('anchors the model with the supplied date so relative dates ("TODAY 8PM") resolve', () => {
    const prompt = buildPrompt('2026-07-03')
    expect(prompt).toContain("Today's date is 2026-07-03")
    expect(prompt).toContain('Relative dates ARE explicitly stated')
  })

  it('keeps the multi-event extraction instruction', () => {
    expect(buildPrompt('2026-07-03')).toContain('extract EVERY event as a separate entry')
  })
})
