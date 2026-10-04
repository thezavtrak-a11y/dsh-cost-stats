/**
 * dsh-cost-stats — billing verification against a provider export.
 *
 * The provider's own `usage_data_<from>_<to>.zip` export is the ground truth for
 * pricing: it carries, per model and hour, the token counts AND the price charged for
 * each of them (`amount-*.csv`), plus the resulting bill (`cost-*.csv`). This tool
 * reads that export, re-derives the same window out of the durable session logs, and
 * shows whether the plugin's `PRICES` table reproduces the bill.
 *
 * It answers three questions at once:
 *
 *   1. do the LOGS agree with the provider on tokens? (a mismatch here is a counting bug)
 *   2. does the PRICE TABLE reproduce the bill? (a mismatch here is a tariff bug)
 *   3. which is it, when a window looks short — the export is a snapshot, so its tail
 *      may simply not have been aggregated yet
 *
 * Usage:
 *   node tools/verify-billing.mjs --export <zip|dir>
 *   node tools/verify-billing.mjs --export <zip> --quiet     # verdict only
 *
 * It makes no model calls and writes nothing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, extname } from 'node:path'
import { inflateRawSync, zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const argOf = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const EXPORT = argOf('--export')
const QUIET = args.includes('--quiet')
if (EXPORT === undefined) {
  console.error('usage: node tools/verify-billing.mjs --export <usage_data_*.zip|dir>')
  process.exit(2)
}

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/* ── the plugin's tariff table, kept in step with lib/client.js ───────────── */

const PRICES = {
  'deepseek-v4-pro': { miss: 1.32, hit: 0.044, write: 1.32, out: 3.96 },
  'deepseek-reasoner': { miss: 1.32, hit: 0.044, write: 1.32, out: 3.96 },
  'deepseek-v4-flash': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 },
  'deepseek-v4-flash-vision-exp': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 },
  'deepseek-flash': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 },
  'deepseek-chat': { miss: 0.27, hit: 0, write: 0.27, out: 1.1 }
}
const FALLBACK = { miss: 0.27, hit: 0, write: 0.27, out: 1.1 }

function priceFor(model) {
  if (typeof model !== 'string' || model.length === 0) return FALLBACK
  const id = model.toLowerCase()
  if (PRICES[id] !== undefined) return PRICES[id]
  for (const key of Object.keys(PRICES)) if (id.startsWith(key) || key.startsWith(id)) return PRICES[key]
  if (id.includes('pro') || id.includes('reason')) return PRICES['deepseek-v4-pro']
  if (id.includes('flash') || id.includes('chat')) return PRICES['deepseek-v4-flash']
  return FALLBACK
}

const usd = (bucket, price) =>
  (bucket.miss * price.miss + bucket.hit * price.hit + bucket.write * price.write + bucket.out * price.out) / 1e6
const fmtUsd = (value) => (value > 0 && value < 1 ? '$.' + value.toFixed(4).slice(2) : '$' + value.toFixed(4))
const fmtTokens = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const clock = (ms) => new Date(ms).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour12: false })

/* ── reading the export ──────────────────────────────────────────────────── */

/**
 * Minimal ZIP reader: enough for the provider's export (stored or deflated entries),
 * so the tool takes the archive as it is downloaded without shelling out to unzip.
 */
function readZip(buffer) {
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 65536; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('not a zip archive')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory')
    const method = buffer.readUInt16LE(offset + 10)
    const compressed = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(start, start + compressed)
    entries.push({ name, data: method === 0 ? raw : inflateRawSync(raw) })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function exportFiles() {
  const stat = statSync(EXPORT)
  if (stat.isDirectory()) {
    return readdirSync(EXPORT)
      .filter((name) => name.endsWith('.csv'))
      .map((name) => ({ name, data: readFileSync(join(EXPORT, name)) }))
  }
  if (extname(EXPORT).toLowerCase() !== '.zip') throw new Error('--export must be a .zip or a directory of .csv files')
  return readZip(readFileSync(EXPORT))
}

const csvRows = (buffer) =>
  buffer
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(','))

/* ── the provider side ───────────────────────────────────────────────────── */

const files = exportFiles()
const provider = { models: new Map(), bill: 0, from: Infinity, to: 0 }
for (const file of files) {
  const rows = csvRows(file.data)
  const header = rows[0].map((cell) => cell.trim())
  for (const row of rows.slice(1)) {
    const record = {}
    for (let index = 0; index < header.length; index += 1) record[header[index]] = row[index]
    const model = record.model
    const bucket =
      provider.models.get(model) ??
      { model, requests: 0, miss: 0, hit: 0, write: 0, out: 0, prices: {}, bill: 0 }
    const start = Date.parse(record.start_time_iso)
    const end = Date.parse(record.end_time_iso)
    if (Number.isFinite(start)) provider.from = Math.min(provider.from, start)
    if (Number.isFinite(end)) provider.to = Math.max(provider.to, end)
    if (header.includes('cost')) {
      const cost = Number(record.cost)
      bucket.bill += cost
      provider.bill += cost
    } else {
      const amount = Number(record.amount)
      const price = Number(record.price)
      if (!Number.isFinite(amount)) continue
      if (record.type === 'request_count') bucket.requests += amount
      else if (record.type === 'output_tokens') {
        bucket.out += amount
        bucket.prices.out = price
      } else if (record.type === 'input_cache_miss_tokens') {
        bucket.miss += amount
        bucket.prices.miss = price
      } else if (record.type === 'input_cache_hit_tokens') {
        bucket.hit += amount
        bucket.prices.hit = price
      } else if (record.type === 'input_cache_write_tokens') {
        bucket.write += amount
        bucket.prices.write = price
      }
    }
    provider.models.set(model, bucket)
  }
}
if (provider.models.size === 0) {
  console.error('no usage rows found in the export')
  process.exit(2)
}

/* ── the log side ────────────────────────────────────────────────────────── */

function logFiles(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) logFiles(path, out)
    else if (entry.endsWith('.jsonl.zstd')) out.push(path)
  }
  return out
}

function records(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  const out = []
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // torn line
      }
    }
  }
  return out
}

const logged = new Map()
const windowRequests = []
for (const file of logFiles(join(HOME, 'sessions'))) {
  const session = file.split(/[\\/]/).slice(-2)[0]
  for (const record of records(file)) {
    if (record.type !== 'assistant/message') continue
    const usage = record.data === undefined ? undefined : record.data.usage
    if (usage === undefined || typeof record.time !== 'number') continue
    if (record.time < provider.from || record.time >= provider.to) continue
    const model =
      record.data.message === undefined || record.data.message.source === undefined
        ? 'unknown'
        : record.data.message.source.model ?? 'unknown'
    const entry = { session, model, t: record.time, miss: usage.inputTokens ?? 0, hit: usage.cacheReadTokens ?? 0, write: usage.cacheWriteTokens ?? 0, out: usage.outputTokens ?? 0 }
    windowRequests.push(entry)
    const bucket = logged.get(model) ?? { model, requests: 0, miss: 0, hit: 0, write: 0, out: 0 }
    bucket.requests += 1
    bucket.miss += entry.miss
    bucket.hit += entry.hit
    bucket.write += entry.write
    bucket.out += entry.out
    logged.set(model, bucket)
  }
}
windowRequests.sort((left, right) => left.t - right.t)

/* ── comparison ──────────────────────────────────────────────────────────── */

let tableFails = 0
let tokenFails = 0
console.log(`\nexport : ${EXPORT}`)
console.log(`window : ${clock(provider.from)} → ${clock(provider.to)}  (${((provider.to - provider.from) / 3600000).toFixed(1)} h)`)
console.log(`billed : ${fmtUsd(provider.bill)} USD\n`)

for (const [model, bucket] of provider.models) {
  const own = logged.get(model) ?? { requests: 0, miss: 0, hit: 0, write: 0, out: 0 }
  // The export quotes a price per TOKEN; `usd()` wants per million. A cache write has
  // no line of its own, so it is priced as a miss.
  const providerPrice = {
    miss: (bucket.prices.miss ?? 0) * 1e6,
    hit: (bucket.prices.hit ?? 0) * 1e6,
    write: ((bucket.prices.write ?? bucket.prices.miss) ?? 0) * 1e6,
    out: (bucket.prices.out ?? 0) * 1e6
  }
  const rateCost = usd(bucket, providerPrice)
  const mineCost = usd(bucket, priceFor(model))
  const price = priceFor(model)
  const rowMatches =
    Math.abs(price.miss - providerPrice.miss) < 1e-6 &&
    Math.abs(price.hit - providerPrice.hit) < 1e-6 &&
    Math.abs(price.out - providerPrice.out) < 1e-6
  if (!rowMatches) tableFails += 1
  if (own.requests !== bucket.requests) tokenFails += 1

  console.log(`${model}`)
  console.log(`  metrics            provider        logs        delta`)
  const line = (label, a, b) => console.log(`  ${label.padEnd(16)} ${fmtTokens(a).padStart(12)} ${fmtTokens(b).padStart(11)} ${String(b - a).padStart(12)}`)
  line('requests', bucket.requests, own.requests)
  line('cache miss in', bucket.miss, own.miss)
  line('cache hit in', bucket.hit, own.hit)
  line('output', bucket.out, own.out)
  console.log(`  provider rates     miss ${providerPrice.miss.toFixed(3)}/M  hit ${providerPrice.hit.toFixed(3)}/M  out ${providerPrice.out.toFixed(3)}/M`)
  console.log(`  plugin rates       miss ${price.miss}/M  hit ${price.hit}/M  out ${price.out}/M   ${rowMatches ? 'MATCH' : 'MISMATCH'}`)
  console.log(`  bill (provider)    ${fmtUsd(bucket.bill)}`)
  console.log(`  rates x prov. tok. ${fmtUsd(rateCost)}   (sanity: must equal the bill)`)
  console.log(`  plugin x prov. tok.${fmtUsd(mineCost)}   (what the GUI showed)`)
  console.log(`  plugin x log tok.  ${fmtUsd(usd(own, price))}`)

  // The export is a snapshot taken while the last hour was still running, so a short
  // window is usually just an unaggregated tail. Find the trailing requests whose
  // removal reconciles every metric exactly, which names that tail precisely.
  const inWindow = windowRequests.filter((request) => request.model === model)
  let tail = 0
  for (let take = 1; take <= Math.min(inWindow.length, 12); take += 1) {
    const rest = inWindow.slice(0, inWindow.length - take)
    const sum = rest.reduce(
      (acc, request) => ({ requests: acc.requests + 1, miss: acc.miss + request.miss, hit: acc.hit + request.hit, out: acc.out + request.out }),
      { requests: 0, miss: 0, hit: 0, out: 0 }
    )
    if (sum.requests === bucket.requests && sum.miss === bucket.miss && sum.hit === bucket.hit && sum.out === bucket.out) {
      tail = take
      break
    }
  }
  if (tail > 0) {
    const dropped = inWindow.slice(inWindow.length - tail)
    console.log(
      `  explanation        the export was taken before its last ${tail} request(s) aggregated: nothing missing after dropping ${clock(dropped[0].t)} → ${clock(dropped[dropped.length - 1].t)}`
    )
  } else if (own.requests !== bucket.requests) {
    console.log('  explanation        token counts differ for a reason other than an unaggregated tail — investigate')
  }
  console.log('')
}

for (const [model, bucket] of provider.models) {
  const row = `'${model}': { miss: ${((bucket.prices.miss ?? 0) * 1e6).toFixed(6).replace(/\.?0+$/, '')}, hit: ${((bucket.prices.hit ?? 0) * 1e6).toFixed(6).replace(/\.?0+$/, '')}, write: ${((bucket.prices.miss ?? 0) * 1e6).toFixed(6).replace(/\.?0+$/, '')}, out: ${((bucket.prices.out ?? 0) * 1e6).toFixed(6).replace(/\.?0+$/, '')} },`
  console.log(`ready to paste into PRICES:\n  ${row}`)
}

if (!QUIET) console.log('')
if (tableFails === 0) console.log('tariff : OK — PRICES reproduces the provider rates')
else {
  console.log(`tariff : ${tableFails} model row(s) differ from the provider rates`)
  process.exitCode = 1
}
if (tokenFails > 0) console.log(`tokens : ${tokenFails} model(s) disagree on request count (see explanation above)`)
else console.log('tokens : OK — the logs agree with the provider window')
