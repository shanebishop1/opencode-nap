// Policy schedules the next due rule directly, with a 250 ms minimum check.
// Leave enough idle time for prompt/observer setup even on concurrent CI jobs.
export const IDLE_MS = 2_000
export const napOptions = { idleMinutes: IDLE_MS / 60_000 }
export const NAP_TIMEOUT_MS = 15_000
// Upper bound on a nap's lateness: loose enough for eight files sharing a
// macOS runner, still far below any timer the tests rule out.
export const NAP_SLACK_MS = 10_000
