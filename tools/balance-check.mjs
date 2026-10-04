/**
 * dsh-cost-stats — account balance check.
 *
 * Exercises the host half's other route, `GET /cost-stats/balance`, without a running
 * server: the credential lookup (environment, then `$DSH_HOME/.credentials.yaml`) and
 * the provider round trip. The key itself is never printed.
 *
 * Usage:
 *   node tools/balance-check.mjs
 *   DEEPSEEK_API_KEY=… node tools/balance-check.mjs          # environment wins
 *   DSH_BALANCE_URL=… node tools/balance-check.mjs           # another endpoint
 */

import { readBalance } from '../index.js'

const balance = await readBalance()
if (balance.error !== undefined) {
  console.error(`balance: unavailable (${balance.error})`)
  process.exitCode = 1
} else {
  console.log(`balance  : ${balance.total} ${balance.currency}`)
  console.log(`toppedUp : ${balance.toppedUp}`)
  console.log(`granted  : ${balance.granted}`)
  console.log(`available: ${balance.available}`)
}
