/**
 * dsh-cost-stats — long-range series check.
 *
 * Runs the host half's session scan directly, without a running server, and
 * prints what it found. This is the verification for `GET /cost-stats/series`:
 * the route is a thin wrapper around the same `scanSeries()`.
 *
 * It also asserts the contract the browser half depends on — row shape, model
 * indexes, category codes and the category name list both halves must agree on —
 * because that list is duplicated, and a drift between the two halves would show
 * up as mis-coloured bars rather than as an error.
 *
 * Usage:
 *   node tools/series-check.mjs              # summary of the whole corpus
 *   node tools/series-check.mjs --hours      # per-hour histogram
 *   DSH_HOME=/path node tools/series-check.mjs
 *
 * The other host route has its own check: `node tools/balance-check.mjs`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanSeries } from '../index.js'

const CATEGORY_NAMES = ['reasoning', 'read', 'tools']
const CATEGORY = { reasoning: 0, read: 1, tools: 2 }

let failures = 0
const check = (condition, message) => {
  if (condition) return
  failures += 1
  console.error(`  CONTRACT FAIL: ${message}`)
}

const fmtClock = (ms) => {
  const date = new Date(ms)
  const two = (value) => String(value).padStart(2, '0')
  return `${two(date.getDate())}.${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`
}

const fmtDuration = (ms) => {
  const hours = ms / 3_600_000
  return hours >= 1 ? `${hours.toFixed(1)} h` : `${(ms / 60_000).toFixed(1)} min`
}

const payload = await scanSeries()
const rows = payload.rows

console.log(`\nsessions scanned : ${payload.sessions}`)
console.log(`model requests   : ${payload.records}`)
console.log(`models           : ${payload.models.join(', ')}`)
if (rows.length === 0) {
  console.log('no usage records found')
  process.exit(0)
}

const first = rows[0][0]
const last = rows[rows.length - 1][0]
console.log(`span             : ${fmtClock(first)} → ${fmtClock(last)}  (${fmtDuration(last - first)})`)
console.log(`payload          : ${(JSON.stringify(payload).length / 1024).toFixed(0)} KB, generated ${fmtClock(payload.generatedAt)}`)

const perCategory = [0, 0, 0]
let miss = 0
let hit = 0
let write = 0
let out = 0
for (const row of rows) {
  perCategory[row[6]] += 1
  miss += row[2]
  hit += row[3]
  write += row[4]
  out += row[5]
}
console.log(
  `categories       : ${CATEGORY_NAMES.map((name, index) => `${name}=${perCategory[index]}`).join('  ')}`
)
console.log(
  `tokens           : miss=${(miss / 1e6).toFixed(2)}M  cache=${(hit / 1e6).toFixed(1)}M  write=${(write / 1e6).toFixed(3)}M  out=${(out / 1e6).toFixed(2)}M`
)

// Gaps are what the timeline compresses: report the idle stretches, not just totals.
const IDLE_MS = 20 * 60 * 1000
const gaps = []
for (let index = 1; index < rows.length; index += 1) {
  const delta = rows[index][0] - rows[index - 1][0]
  if (delta >= IDLE_MS) gaps.push({ from: rows[index - 1][0], to: rows[index][0], delta })
}
console.log(`idle stretches   : ${gaps.length} over ${IDLE_MS / 60000} min`)
for (const gap of gaps.slice(0, 8)) {
  console.log(`  ${fmtClock(gap.from)} → ${fmtClock(gap.to)}  ${fmtDuration(gap.delta)}`)
}
if (gaps.length > 8) console.log(`  … and ${gaps.length - 8} more`)

if (process.argv.includes('--hours')) {
  const buckets = new Map()
  for (const row of rows) {
    const hour = Math.floor(row[0] / 3_600_000) * 3_600_000
    const bucket = buckets.get(hour) ?? { requests: 0, tokens: 0 }
    bucket.requests += 1
    bucket.tokens += row[2] + row[3] + row[4] + row[5]
    buckets.set(hour, bucket)
  }
  console.log('\nper hour:')
  for (const [hour, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${fmtClock(hour)}  ${String(bucket.requests).padStart(4)} req  ${(bucket.tokens / 1e6).toFixed(1).padStart(7)}M tok`)
  }
}

/* ── the contract the browser half relies on ─────────────────────────────── */

check(payload.v === 1, 'payload version is 1')
check(payload.categories.read === CATEGORY.read, 'payload carries the category code map')
check(payload.rows.length === payload.records, 'records equals the number of rows')
check(JSON.stringify(payload).length < 4 * 1024 * 1024, 'payload stays under 4 MB')
for (const row of rows) {
  check(Array.isArray(row) && row.length === 7, 'every row has seven fields')
  check(typeof row[0] === 'number' && row[0] > 0, 'row time is a positive number')
  check(typeof payload.models[row[1]] === 'string', 'row model index resolves to a model id')
  check(row[6] >= 0 && row[6] < CATEGORY_NAMES.length, 'row category code is in range')
}

// The category name list exists in both halves; read the browser one and compare.
const here = fileURLToPath(new URL('.', import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const match = clientSource.match(/const SERIES_CATEGORY = \[([^\]]+)\]/)
check(match !== null, 'lib/client.js declares SERIES_CATEGORY')
if (match !== null) {
  const clientOrder = match[1].split(',').map((part) => part.trim().replace(/^'|'$/g, ''))
  check(
    clientOrder.join(',') === CATEGORY_NAMES.join(','),
    `category order matches the browser half (host ${CATEGORY_NAMES.join(',')} vs client ${clientOrder.join(',')})`
  )
}
const routeMatch = clientSource.match(/const SERIES_ROUTE = '([^']+)'/)
check(routeMatch !== null && routeMatch[1] === '/cost-stats/series', 'both halves agree on the route path')

if (failures === 0) console.log('\ncontract: OK — the browser half can consume this payload')
else {
  console.error(`\ncontract: ${failures} failure(s)`)
  process.exitCode = 1
}
