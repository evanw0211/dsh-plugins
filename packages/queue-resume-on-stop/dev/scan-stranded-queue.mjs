// Diagnose the "stop strands the queue" pattern across DSH session logs.
//
// Tracks both inbox boundaries: next-turn prompts and next-step steering prompts
// (DSH 0.2.1+). Injected context on next-step is not prompt work and is ignored,
// matching the plugin's own resume decision.
//
// Usage: node scan-stranded-queue.mjs [<sessions-root>] [days]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Sessions live under $DSH_HOME/sessions (default ~/.dsh/sessions). */
const root = process.argv[2] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
const days = Number(process.argv[3] ?? Infinity)
const cutoff = Date.now() - days * 86400_000

/** Sources that carry a prompt; injected context uses other sources. */
const PROMPT_SOURCES = new Set(['user', 'agent-message'])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (st.mtimeMs >= cutoff && (name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))) out.push(p)
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
      if (event && typeof event.type === 'string') events.push(event)
    } catch { /* skip malformed tail line */ }
  }
  return events
}

const isPrompt = (message) => message?.role === 'user' && PROMPT_SOURCES.has(message?.source?.kind)

let scanned = 0
let hits = 0
for (const file of walk(root)) {
  const events = readEvents(file)
  if (events.length === 0) continue
  scanned++
  /** boundary -> messageId -> message, while pending */
  const pending = { 'next-turn': new Map(), 'next-step': new Map() }
  const findings = []
  let stoppedAt = null
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'agent/inbox/spliced' && pending[d.target] !== undefined) {
      const queue = pending[d.target]
      if (d.removedCount === undefined) for (const m of d.inserted ?? []) queue.set(m.id, m)
      else {
        const ids = [...queue.keys()]
        for (let i = 0; i < d.removedCount; i++) queue.delete(ids[(d.start ?? 0) + i])
        for (const m of d.inserted ?? []) queue.set(m.id, m)
      }
    }
    if (e.type === 'agent/inbox/claimed' || e.type === 'agent/inbox/discarded') {
      for (const queue of Object.values(pending)) queue.delete(d.message?.id)
    }
    if (e.type === 'turn/end') {
      const reason = d.reason
      const queued = [...pending['next-turn'].values()]
      const steered = [...pending['next-step'].values()].filter(isPrompt)
      if (reason?.kind === 'aborted' && reason.reason?.kind === 'user' && (queued.length > 0 || steered.length > 0)) {
        stoppedAt = { seq: e.seq, queued: queued.length, steered: steered.length }
      } else if (queued.length === 0 && steered.length === 0) {
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
    console.log(`          user-stop turn/end at seq ${stoppedAt.seq} left ${stoppedAt.queued} next-turn + ${stoppedAt.steered} next-step prompt(s) with no later turn`)
  } else if (findings.length > 0) {
    console.log(`RESUMED   ${file}  (${findings.length} stop->resume edge(s); first ${JSON.stringify(findings[0])})`)
  }
}
console.log(`\nscanned ${scanned} session log(s); ${hits} with a stranded queue after a user stop`)
