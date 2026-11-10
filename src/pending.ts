/** The plugin's own storage writes, which must land before the process is replaced. */
export interface PendingWrites {
  track<T>(write: Promise<T>): Promise<T>
  settled(): Promise<void>
}

export function createPendingWrites(): PendingWrites {
  const pending = new Set<Promise<unknown>>()
  return {
    track(write) {
      pending.add(write)
      const forget = () => pending.delete(write)
      write.then(forget, forget)
      return write
    },
    async settled() {
      await Promise.allSettled([...pending])
    },
  }
}
