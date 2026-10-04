/**
 * dsh-cost-stats — independent usage audit.
 *
 * Reads the durable DSH session logs (one zstd frame per JSONL line) and sums the
 * provider-reported usage straight out of them, then prices the result with the
 * SAME table the plugin uses. This is the ground truth the plugin's numbers are
 * checked against: if the token sums agree but the money does not, the tariff
 * table is wrong; if the token sums disagree, the plugin is miscounting.
 *
 * Usage:
 *   node tools/audit-usage.mjs                     # every session, per model + total
 *   node tools/audit-usage.mjs --session 3bc430b7  # one session only
 *   node tools/audit-usage.mjs --target 4.47       # solve the implied $/M for a target bill
 *   node tools/audit-usage.mjs --root <dir>        # another DSH home (default: $DSH_HOME, else ~/.dsh)
 *   node tools/audit-usage.mjs --sessions <dir>    # point straight at one session-log tree
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? undefined : argv[index + 1]
}

/* Nothing here is tied to one machine: the DSH home comes from `--root`, then
   `$DSH_HOME`, then `~/.dsh`, and the session logs plus the title projection cache
   both live under it. */
const DSH_HOME = flag('root') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSION_ROOT = flag('sessions') ?? join(DSH_HOME, 'sessions')
const SESSION_TITLES_ROOT = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/* ── the plugin's tariff table, kept in step with lib/client.js ───────────── */

// Cached input is not charged on this plan: see the calibration note in
// lib/client.js. Keep these four rows identical to that table.
const PRICES = {
  'deepseek-v4-pro': { miss: 1.32, hit: 0.044, write: 1.32, out: 3.96 },
  'deepseek-reasoner': { miss: 1.32, hit: 0.044, write: 1.32, out: 3.96 },
  'deepseek-v4-flash': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 },
  'deepseek-v4-flash-vision-exp': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 },
  'deepseek-flash': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 },
  'deepseek-chat': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 }
}
const FALLBACK = { miss: 0.27, hit: 0, write: 0.27, out: 1.1 }

/* ── log reading ─────────────────────────────────────────────────────────── */

function sessionFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sessionFiles(path, out)
    else if (name.endsWith('.jsonl.zstd')) out.push(path)
  }
  return out
}

/** One `.jsonl.zstd` file is a stream of independent zstd frames; split on the magic. */
function readRecords(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  const records = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // A torn or non-JSON line is skipped rather than aborting the audit.
      }
    }
  }
  return records
}

/* ── folding ─────────────────────────────────────────────────────────────── */

function priceFor(model) {
  if (typeof model !== 'string' || model.length === 0) return FALLBACK
  const id = model.toLowerCase()
  if (PRICES[id] !== undefined) return PRICES[id]
  for (const key of Object.keys(PRICES)) if (id.startsWith(key) || key.startsWith(id)) return PRICES[key]
  if (id.includes('pro') || id.includes('reason')) return PRICES['deepseek-v4-pro']
  if (id.includes('flash') || id.includes('chat')) return PRICES['deepseek-v4-flash']
  return FALLBACK
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function emptyBucket() {
  return { miss: 0, hit: 0, write: 0, out: 0, reasoning: 0, messages: 0, cost: 0 }
}

function audit({ sessionFilter }) {
  const files = sessionFiles(SESSION_ROOT)
  const byModel = new Map()
  const totals = emptyBucket()
  const messageIds = new Map()
  const sessions = new Map()
  let usageMessages = 0
  let messagesWithoutUsage = 0

  for (const file of files) {
    if (sessionFilter !== undefined && !file.includes(sessionFilter)) continue
    const records = readRecords(file)
    let config = undefined
    const sessionId = file.split(/[\\/]/).slice(-2)[0]
    for (const record of records) {
      const type = record.type
      const data = record.data ?? {}
      if (type === 'request/header') {
        config = data.config ?? data
        continue
      }
      if (type !== 'assistant/message') continue
      const usage = data.usage
      if (usage === null || usage === undefined) {
        messagesWithoutUsage += 1
        continue
      }
      usageMessages += 1
      // The message itself carries the route it was served by; the request header is
      // only a fallback for records that predate it.
      const source = data.message !== null && data.message !== undefined ? data.message.source : undefined
      const model =
        (source !== null && source !== undefined && typeof source.model === 'string' ? source.model : undefined) ??
        (config !== undefined && typeof config.model === 'string' ? config.model : undefined) ??
        'unknown'
      const price = priceFor(model)
      const miss = num(usage.inputTokens)
      const hit = num(usage.cacheReadTokens)
      const write = num(usage.cacheWriteTokens)
      const out = num(usage.outputTokens)
      const reasoning = num(usage.reasoningTokens)
      const cost = (miss * price.miss + hit * price.hit + write * price.write + out * price.out) / 1e6
      let bucket = byModel.get(model)
      if (bucket === undefined) {
        bucket = emptyBucket()
        byModel.set(model, bucket)
      }
      bucket.miss += miss
      bucket.hit += hit
      bucket.write += write
      bucket.out += out
      bucket.reasoning += reasoning
      bucket.messages += 1
      bucket.cost += cost
      totals.miss += miss
      totals.hit += hit
      totals.write += write
      totals.out += out
      totals.reasoning += reasoning
      totals.messages += 1
      totals.cost += cost
      let session = sessions.get(sessionId)
      if (session === undefined) {
        session = emptyBucket()
        sessions.set(sessionId, session)
      }
      session.cost += cost
      session.messages += 1
      const id = data.message !== null && data.message !== undefined ? data.message.id : undefined
      if (typeof id === 'string') messageIds.set(id, (messageIds.get(id) ?? 0) + 1)
    }
  }
  return { byModel, totals, sessions, messageIds, usageMessages, messagesWithoutUsage, files: files.length }
}

/* ── reporting ───────────────────────────────────────────────────────────── */

const fmtTokens = (value) =>
  value >= 1e9 ? (value / 1e9).toFixed(2) + 'B' : value >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : value >= 1e3 ? (value / 1e3).toFixed(1) + 'k' : String(value)

/** Session title from the projection cache, so the report names the work, not a uuid. */
function titleOf(sessionId) {
  const candidates = sessionId.startsWith('session-') ? [sessionId] : [sessionId, 'session-' + sessionId]
  for (const name of candidates) {
    try {
      const raw = readFileSync(join(SESSION_TITLES_ROOT, name + '.json'), 'utf8')
      const title = JSON.parse(raw)?.record?.rows?.title?.val
      if (typeof title === 'string' && title.length > 0) return title
    } catch {
      // No cached title for this session — fall through.
    }
  }
  return ''
}
/** Same money rule as the plugin: no leading zero, no trailing zeros below $1. */
const fmtUsd = (value) => {
  if (value === 0) return '$0'
  if (value < 1) {
    let digits = value.toFixed(4).slice(2)
    while (digits.length > 2 && digits.endsWith('0')) digits = digits.slice(0, -1)
    return '$.' + digits
  }
  let text = value.toFixed(3)
  while (text.endsWith('0') && text.length - text.indexOf('.') - 1 > 2) text = text.slice(0, -1)
  return '$' + text
}

const sessionFilter = flag('session')
const target = Number(flag('target'))

if (!existsSync(SESSION_ROOT)) {
  console.error(`\nno session logs at ${SESSION_ROOT}`)
  console.error('pass --root <DSH home>, --sessions <session-log tree>, or set DSH_HOME')
  process.exit(1)
}

const result = audit({ sessionFilter })

console.log(`\nlogs root: ${SESSION_ROOT}`)
console.log(`Session logs read: ${String(result.files)}${sessionFilter === undefined ? '' : ` (filter "${sessionFilter}")`}`)
console.log(`assistant/message records: ${String(result.usageMessages)} with usage, ${String(result.messagesWithoutUsage)} without\n`)

const rows = [...result.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)
const header = ['model', 'msgs', 'in-miss', 'in-cache', 'out', 'reasoning', 'cost']
console.log(header.map((h) => h.padEnd(12)).join(''))
for (const [model, b] of rows) {
  console.log(
    [
      model,
      String(b.messages),
      fmtTokens(b.miss),
      fmtTokens(b.hit),
      fmtTokens(b.out),
      fmtTokens(b.reasoning),
      fmtUsd(b.cost)
    ]
      .map((v) => String(v).padEnd(12))
      .join('')
  )
}
const t = result.totals
console.log(
  [
    'TOTAL',
    String(t.messages),
    fmtTokens(t.miss),
    fmtTokens(t.hit),
    fmtTokens(t.out),
    fmtTokens(t.reasoning),
    fmtUsd(t.cost)
  ]
    .map((v) => String(v).padEnd(12))
    .join('')
)

const billedInput = t.miss + t.hit + t.write
console.log(
  `\nbilled input: ${fmtTokens(billedInput)} (cache hit ${(billedInput > 0 ? (t.hit / billedInput) * 100 : 0).toFixed(1)}%), output: ${fmtTokens(t.out)}`
)
console.log(`plugin tariff says this corpus cost ${fmtUsd(t.cost)}`)

const priced = t.miss * 0.27 + t.hit * 0.07 + t.out * 1.1
console.log(`pure deepseek-flash tariff (0.27/0.07/1.10) says ${fmtUsd(priced / 1e6)}`)
console.log(`all tokens at the cache-hit price only: ${fmtUsd((t.hit / 1e6) * 0.07)}`)
console.log(`all tokens (in+out) at 0.07/M: ${fmtUsd(((billedInput + t.out) / 1e6) * 0.07)}`)

if (Number.isFinite(target)) {
  const tokens = t.miss + t.hit + t.write + t.out
  const perMillion = (target / tokens) * 1e6
  const scale = t.cost > 0 ? target / t.cost : 0
  console.log(`\ntarget bill ${fmtUsd(target)} over ${fmtTokens(tokens)} tokens → implied ${perMillion.toFixed(4)} $/M all-in`)
  console.log(`scaling this table by ${scale.toFixed(4)} reproduces the target exactly:`)
  const scaled = (value) => Number((value * scale).toFixed(4))
  for (const [model, price] of Object.entries(PRICES)) {
    console.log(
      `  '${model}': { miss: ${String(scaled(price.miss))}, hit: ${String(scaled(price.hit))}, write: ${String(
        scaled(price.write)
      )}, out: ${String(scaled(price.out))} },`
    )
  }
  const hitOnly = t.hit > 0 ? ((target - (t.miss * FALLBACK.miss + t.out * FALLBACK.out) / 1e6) / t.hit) * 1e6 : 0
  console.log(
    `or holding miss ${String(FALLBACK.miss)} / out ${String(FALLBACK.out)}, the cache-hit price would be ${hitOnly.toFixed(4)} $/M`
  )
}

const topSessions = [...result.sessions.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 12)
console.log('\ntop sessions by plugin-tariff cost:')
for (const [id, bucket] of topSessions) {
  const title = titleOf(id)
  console.log(
    `  ${fmtUsd(bucket.cost).padStart(10)}  ${String(bucket.messages).padStart(5)} msgs  ${id.padEnd(46)} ${title}`
  )
}

const duplicates = [...result.messageIds.entries()].filter(([, count]) => count > 1)
console.log(`\nmessage ids: ${String(result.messageIds.size)} unique, ${String(duplicates.length)} seen more than once`)
if (duplicates.length > 0) console.log('  duplicates:', duplicates.slice(0, 5))
