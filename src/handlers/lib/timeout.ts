// Bound an await that has no native timeout knob (SDK clients constructed
// elsewhere, OAuth token fetches). The underlying request may keep running —
// this only caps how long WE wait, which is what protects the Lambda budget.
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
