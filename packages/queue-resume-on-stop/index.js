/**
 * Resume queued inbox messages after the user's Stop.
 *
 * ## The gap this closes
 *
 * The Stop button calls `agent.cancel({ kind: 'user' }, { keepInbox: true })`
 * (`dsh-api-session-controller` → `session.cancel`): it aborts the in-flight
 * turn but deliberately keeps the pending inbox, so queued messages survive the
 * stop. Nothing, however, re-arms the driver afterwards.
 *
 * `ReactLoopAgent.kick()` only continues into another turn from a *normal* turn
 * end (`turn()` returns `true` while `inbox.hasPending`). An abort throws out of
 * `turn()`, so the driver unwinds and the pending prompts stay in the inbox
 * forever: they were accepted and are still shown as queued, but no model
 * request is ever issued for them.
 *
 * The loop already knows how to recover from this — `send()` classifies a
 * message that arrives *after* an abort as a wake (`wakingAfterAbort`) and latches
 * `phase.wakeRequested`, and `kick()`'s exit path replays that latch
 * (`if (wakeRequested && inbox.hasPending) this.wakeDriver()`). Messages queued
 * *before* the stop never set that latch.
 *
 * This plugin supplies the missing latch: when a turn ends aborted by the user
 * (or by a parent interrupting a child) while prompts are still pending, it asks
 * the loop to wake once more, exactly as a message typed a moment after the stop
 * would. The pending prompts are then claimed by the next turn and sent to the
 * model.
 *
 * ## Both inbox boundaries
 *
 * A prompt waiting for its own turn lives in `inbox.nextTurn`. Since DSH 0.2.1 a
 * prompt may also be delivered as *steering* (`agent.steer()`, `busyEnter:
 * 'steer'`, or the queue row's steer action), which places it in
 * `inbox.nextStep` instead. A stop that lands before the next step boundary
 * strands those prompts exactly the same way, so the plugin treats both
 * boundaries as pending work.
 *
 * `next-step` also carries injected context (`agent.inject()`, runtime snapshots,
 * subagent results). Injection is deliberately non-waking, so only messages whose
 * source carries a real prompt (`user`, `agent-message`) count.
 *
 * ## Why private `wakeDriver` first
 *
 * `Agent.inbox`, `followup()`, `steer()`, and `cancel()` are the public surface,
 * and the public surface has no wake primitive: re-queuing a pending message
 * would need `inbox.remove(id)` + `followup(message)`, which writes a durable
 * "canceled" inbox splice and re-insert — and `Session.append()` refuses to
 * reenter while a `session/event` observer is running, which is exactly where
 * this listener executes. `wakeDriver(true)` mutates only the in-memory phase
 * latch, appends nothing, and is the identical call `send()` makes on the
 * post-abort path.
 *
 * That method is private, so the plugin never relies on it alone: once the agent
 * settles to idle, any prompt still pending proves the wake did not take effect,
 * and the public remove + `followup()` path runs as the recovery. The same
 * recovery covers a loop that predates or renames `wakeDriver`.
 *
 * @module @local/dsh-queue-resume-on-stop
 */

import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Loader metadata: the plugin row name used in diagnostics. */
export const name = 'queue-resume-on-stop'
/** Required service: the live Agent registry addressed by session id. */
export const inject = ['agents']

/**
 * Abort causes that mean "the user asked to stop": the Stop button and a parent
 * interrupting a child. `disposed` (teardown) and `hook` (credential/session
 * invalidation) must never restart work.
 */
const USER_STOP_CAUSES = new Set(['user', 'parent'])

/**
 * Message sources that carry a prompt the model must answer. Injected context
 * uses other sources (runtime snapshots, tool results, subagent reports) and
 * must not wake the driver.
 */
const PROMPT_SOURCES = new Set(['user', 'agent-message'])

/** Diagnostic breadcrumb, written only while tracing is enabled. */
const TRACE_FILE = fileURLToPath(new URL('./apply.log', import.meta.url))

/**
 * Append one diagnostic line, never letting diagnostics break an agent turn.
 * @param enabled - whether tracing is on for this plugin row.
 * @param event - short event name.
 * @param data - extra fields to record.
 */
function trace(enabled, event, data = {}) {
  if (!enabled) return
  try {
    appendFileSync(TRACE_FILE, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...data })}\n`)
  } catch {
    /* diagnostics must never affect the agent */
  }
}

/**
 * Whether one `turn/end` reason is a user-requested stop.
 * @param reason - the durable `turn/end` reason payload.
 * @returns true when the turn was aborted by the user or by a parent.
 */
function isUserStop(reason) {
  return reason?.kind === 'aborted' && USER_STOP_CAUSES.has(reason.reason?.kind)
}

/**
 * Whether one pending message is a prompt the model still has to answer.
 * @param message - an inbox message.
 * @returns true for user/relayed prompts, false for injected context.
 */
function isPrompt(message) {
  return message?.role === 'user' && PROMPT_SOURCES.has(message?.source?.kind)
}

/**
 * Prompts the stop stranded, across both inbox boundaries.
 * @param agent - the agent whose turn just ended.
 * @returns the boundary holding the stranded prompts, or undefined when none.
 */
function strandedPrompts(agent) {
  const nextTurn = agent.inbox?.nextTurn ?? []
  if (nextTurn.length > 0) return { boundary: 'next-turn', count: nextTurn.length }
  const steered = (agent.inbox?.nextStep ?? []).filter(isPrompt)
  return steered.length > 0 ? { boundary: 'next-step', count: steered.length } : undefined
}

/**
 * The first stranded prompt, preferring the queue that owns whole turns.
 * @param agent - the agent whose turn just ended.
 * @returns the message to re-offer, or undefined.
 */
function firstStrandedPrompt(agent) {
  const nextTurn = agent.inbox?.nextTurn ?? []
  if (nextTurn.length > 0) return nextTurn[0]
  return (agent.inbox?.nextStep ?? []).find(isPrompt)
}

/**
 * Re-offer one stranded prompt through the public surface: remove it from the
 * inbox, then queue it as a follow-up, which wakes the driver.
 * @param ctx - the plugin context, used for diagnostics only.
 * @param agent - the idle agent to recover.
 * @param tracing - whether tracing is on for this plugin row.
 */
function reoffer(ctx, agent, tracing) {
  const message = firstStrandedPrompt(agent)
  if (message === undefined) return
  let removed = false
  try {
    removed = agent.inbox?.remove?.(message.id) ?? false
  } catch {
    removed = false
  }
  if (!removed) return
  agent.followup(message)
  ctx.logger?.info?.(`queue-resume-on-stop: recovered session "${agent.id}" by re-queuing stranded prompt "${message.id}"`)
  trace(tracing, 'reoffered', { session: agent.id, message: message.id })
}

/**
 * Ask the agent's driver to run one more turn for the prompts still in the inbox.
 *
 * Called synchronously from a `session/event` observer while the aborted turn is
 * still unwinding, so the abort signal is already fired and the phase is still
 * `running`: the latch this sets is replayed by `kick()`'s exit path. Once the
 * agent settles to idle, any prompt still pending proves the wake did not take
 * effect, and the public recovery path runs instead.
 * @param ctx - the plugin context, used for diagnostics only.
 * @param agent - the agent whose turn just ended.
 * @param pending - the stranded prompts found at stop time.
 * @param tracing - whether tracing is on for this plugin row.
 */
function resumeQueued(ctx, agent, pending, tracing) {
  const wake = agent.wakeDriver
  if (typeof wake === 'function') {
    // Mirrors `send()`'s post-abort classification: latch a wake for the turn exit.
    wake.call(agent, true)
    ctx.logger?.info?.(`queue-resume-on-stop: resuming ${pending.count} queued message(s) from ${pending.boundary} for session "${agent.id}" after stop`)
    trace(tracing, 'wake', { session: agent.id, boundary: pending.boundary, count: pending.count })
  } else {
    trace(tracing, 'no-wake-driver', { session: agent.id })
  }
  // Verifies the private wake actually started a turn; covers a renamed or
  // missing wake primitive, and a loop whose latch is never replayed.
  const settled = typeof agent.whenIdle === 'function' ? agent.whenIdle() : undefined
  Promise.resolve(settled)
    .then(() => {
      if (agent.status !== 'idle') return
      const remaining = strandedPrompts(agent)
      if (remaining === undefined) return
      trace(tracing, 'wake-did-not-take', { session: agent.id, ...remaining })
      reoffer(ctx, agent, tracing)
    })
    .catch(() => {})
}

/**
 * Watch durable turn ends and re-arm the driver when a user stop stranded queued
 * prompts.
 * @param ctx - plugin context carrying the Agent registry.
 * @param config - row config from `cordis.patch.yml`; `enabled: false` disables,
 *   `trace: true` writes a breadcrumb next to the plugin.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const tracing = config.trace === true || process.env.DSH_QUEUE_RESUME_TRACE === '1'
  trace(tracing, 'apply', {})
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (!isUserStop(event.data?.reason)) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session?.id !== session.id) return
    const pending = strandedPrompts(agent)
    if (pending === undefined) {
      trace(tracing, 'no-stranded-prompt', { session: session.id })
      return
    }
    resumeQueued(ctx, agent, pending, tracing)
  })
}
