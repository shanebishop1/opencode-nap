/** The plugin's own storage writes, which must land before the process is replaced. */
export interface PendingWrites {
  track<T>(write: Promise<T>): Promise<T>
  /** True once every tracked write has settled; false when that takes longer than the limit. */
  settled(): Promise<boolean>
}

// A write that never settles must not stop the plugin from ever napping again.
const SETTLE_LIMIT_MS = 2_000

export function createPendingWrites(limitMs = SETTLE_LIMIT_MS): PendingWrites {
  const pending = new Set<Promise<unknown>>()
  return {
    track(write) {
      pending.add(write)
      const forget = () => pending.delete(write)
      write.then(forget, forget)
      return write
    },
    async settled() {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<false>(done => {
        timer = setTimeout(() => done(false), limitMs)
        timer.unref?.()
      })
      try {
        return await Promise.race([Promise.allSettled([...pending]).then(() => true), late])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
