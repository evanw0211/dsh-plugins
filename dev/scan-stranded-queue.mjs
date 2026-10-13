// Diagnose the "stop strands the queue" pattern across DSH session logs.
// Usage: node scan-stranded-queue.mjs [<sessions-root>]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Sessions live under $DSH_HOME/sessions (default ~/.dsh/sessions). */
const root = process.argv[2]
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/** DSH stores one zstd frame per append, so split on the frame magic and decode each. */
function decodeZstdFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  if (starts.length === 0 || starts[0] !== 0) starts.unshift(0)
  let text = ''
  let pending = null
  for (let k = 0; k < starts.length; k++) {
    const chunk = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    const candidate = pending ? Buffer.concat([pending, chunk]) : chunk
    try {
      text += zstdDecompressSync(candidate).toString('utf8')
      pending = null
    } catch {
      pending = candidate
    }
  }
  return text
}

function readEvents(file) {
  const buf = readFileSync(file)
  const raw = file.endsWith('.zstd') ? decodeZstdFrames(buf) : buf.toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const record = JSON.parse(trimmed)
      // Envelope shapes observed: { seq, event: {...} } or the event itself.
      const event = record.event ?? record
      if (event && typeof event.type === 'string') events.push({ seq: event.seq ?? record.seq, ...event })
    } catch { /* skip malformed tail line */ }
  }
  return events
}

let scanned = 0
let hits = 0
for (const file of walk(root)) {
  const events = readEvents(file)
  if (events.length === 0) continue
  scanned++
  /** messageId -> true while pending in next-turn */
  const pending = new Map()
  const findings = []
  let stoppedAt = null
  for (const e of events) {
    if (e.type === 'agent/inbox/spliced') {
      const d = e.data ?? {}
      if (d.target === 'next-turn') {
        const ids = [...pending.keys()]
        for (let i = 0; i < (d.removedCount ?? 0); i++) pending.delete(ids[d.start + i])
        for (const m of d.inserted ?? []) pending.set(m.id, true)
      }
    }
    if (e.type === 'agent/inbox/claimed') pending.delete(e.data?.message?.id)
    if (e.type === 'agent/inbox/discarded') pending.delete(e.data?.message?.id)
    if (e.type === 'turn/end') {
      const reason = e.data?.reason
      if (reason?.kind === 'aborted' && reason.reason?.kind === 'user' && pending.size > 0) {
        stoppedAt = { seq: e.seq, pending: pending.size }
      } else if (pending.size === 0) {
        stoppedAt = null
      }
    }
    if (stoppedAt !== null && (e.type === 'turn/start' || e.type === 'agent/inbox/claimed')) {
      findings.push({ stoppedAt, resumedAt: e.seq, by: e.type })
      stoppedAt = null
    }
  }
  if (stoppedAt !== null) {
    hits++
    console.log(`STRANDED  ${file}`)
    console.log(`          user-stop turn/end at seq ${stoppedAt.seq} left ${stoppedAt.pending} queued prompt(s) with no later turn`)
  } else if (findings.length > 0) {
    console.log(`RESUMED   ${file}  (${findings.length} stop->resume edge(s); first ${JSON.stringify(findings[0])})`)
  }
}
console.log(`\nscanned ${scanned} session log(s); ${hits} with a stranded queue after a user stop`)
