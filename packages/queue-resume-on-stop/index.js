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
 * `turn()`, so the driver unwinds and the queued `next-turn` messages stay in the
 * inbox forever: they were accepted and are still shown as queued, but no model
 * request is ever issued for them.
 *
 * The loop already knows how to recover from this — `send()` classifies a
 * message that arrives *after* an abort as a wake (`wakingAfterAbort`) and latches
 * `phase.wakeRequested`, and `kick()`'s exit path replays that latch
 * (`if (wakeRequested && inbox.hasPending) this.wakeDriver()`). Messages queued
 * *before* the stop never set that latch.
 *
 * This plugin supplies the missing latch: when a turn ends aborted by the user
 * (or by a parent interrupting a child) while prompts are still queued, it asks
 * the loop to wake once more, exactly as a message typed a moment after the stop
 * would. The queued messages are then claimed by the next turn and sent to the
 * model.
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
 * post-abort path. It is used when present and the public fallback covers a
 * version that renames it.
 * @module @local/dsh-queue-resume-on-stop
 */

/** Loader metadata: the plugin row name used in diagnostics. */
export const name = 'queue-resume-on-stop';
/** Required service: the live Agent registry addressed by session id. */
export const inject = ['agents'];

/**
 * Abort causes that mean "the user asked to stop": the Stop button and a parent
 * interrupting a child. `disposed` (teardown) and `hook` (credential/session
 * invalidation) must never restart work.
 */
const USER_STOP_CAUSES = new Set(['user', 'parent']);

/**
 * Whether one `turn/end` reason is a user-requested stop.
 * @param reason - the durable `turn/end` reason payload.
 * @returns true when the turn was aborted by the user or by a parent.
 */
function isUserStop(reason) {
  return reason?.kind === 'aborted' && USER_STOP_CAUSES.has(reason.reason?.kind);
}

/**
 * Ask the agent's driver to run one more turn for the prompts still in the inbox.
 *
 * Called synchronously from a `session/event` observer while the aborted turn is
 * still unwinding, so the abort signal is already fired and the phase is still
 * `running`: the latch this sets is replayed by `kick()`'s exit path.
 * @param ctx - the plugin context, used for diagnostics only.
 * @param agent - the agent whose turn just ended.
 */
function resumeQueued(ctx, agent) {
  const wake = agent.wakeDriver;
  if (typeof wake === 'function') {
    // Mirrors `send()`'s post-abort classification: latch a wake for the turn exit.
    wake.call(agent, true);
    ctx.logger?.info?.(`queue-resume-on-stop: resuming ${agent.inbox.nextTurn.length} queued message(s) for session "${agent.id}" after stop`);
    return;
  }
  // Fallback for a loop without `wakeDriver`: re-offer the first queued prompt
  // after the current append has finished, which both wakes the driver and keeps
  // the message pending.
  queueMicrotask(() => {
    if (agent.status !== 'idle') return;
    const [first] = agent.inbox.nextTurn;
    if (first === undefined) return;
    if (agent.inbox.remove(first.id)) agent.followup(first);
  });
}

/**
 * Watch durable turn ends and re-arm the driver when a user stop stranded queued
 * prompts.
 * @param ctx - plugin context carrying the Agent registry.
 * @param config - row config from `cordis.patch.yml`; `enabled: false` disables.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;
    if (!isUserStop(event.data?.reason)) return;
    const agent = ctx.agents.get(session.id);
    if (agent === undefined || agent.session !== session) return;
    // `next-step` holds injected context, which is deliberately non-waking; only
    // prompts awaiting a turn justify a new turn.
    if (agent.inbox.nextTurn.length === 0) return;
    resumeQueued(ctx, agent);
  });
}
