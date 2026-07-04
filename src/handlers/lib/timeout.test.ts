import { describe, expect, it } from 'vitest'
import { withTimeout } from './timeout'

describe('withTimeout', () => {
  it('resolves with the promise value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'test')).resolves.toBe(42)
  })

  it('rejects with the promise error when it fails in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'test')).rejects.toThrow('boom')
  })

  it('rejects with a labeled timeout error when the promise hangs', async () => {
    const hang = new Promise(() => {})
    await expect(withTimeout(hang, 20, 'OAuth token fetch')).rejects.toThrow('OAuth token fetch timed out after 20ms')
  })
})
