// Policy schedules the next due rule directly, with a 250 ms minimum check.
// Leave enough idle time for prompt/observer setup even on concurrent CI jobs.
export const IDLE_MS = 2_000
export const napOptions = { idleMinutes: IDLE_MS / 60_000 }
export const NAP_TIMEOUT_MS = 15_000
