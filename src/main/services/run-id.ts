import { randomBytes } from 'node:crypto'

/** This run of the app: CLAUDETERM_TAB is `<run>.<tab>`, so events left by an earlier run never reach a tab of this one. */
export const RUN_ID = randomBytes(4).toString('hex')
