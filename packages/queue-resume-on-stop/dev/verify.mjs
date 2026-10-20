// Verify the stop-resume decision logic against fake agents and inboxes.
//
// Covers both inbox boundaries (next-turn queue and next-step steering), the
// non-waking injected context, the abort causes that must not resume, and the
// public recovery path used when the private wake does not take effect.
//
// Usage: node dev/verify.mjs
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const stopEvent = (cause = 'user') => ({
  type: 'turn/end',
  data: { turn: 1, reason: { kind: 'aborted', reason: { kind: cause } } },
})
const completedEvent = () => ({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

const prompt = (id, kind = 'user') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text: id }] })
const context = (id, kind = 'runtime-context') => ({ id, role: 'user', source: { kind }, content: [{ type: 'text', text: id }] })

function makeAgent(id, { status = 'running', queued = [], steered = [], withWake = true } = {}) {
  const state = { queue: [...queued], steer: [...steered], wakes: [], followups: [], removals: [] }
  const agent = {
    id,
    session: { id },
    status,
    inbox: {
      get nextTurn() { return state.queue },
      get nextStep() { return state.steer },
      remove(messageId) {
        for (const list of [state.queue, state.steer]) {
          const index = list.findIndex((m) => m.id === messageId)
          if (index >= 0) {
            list.splice(index, 1)
            state.removals.push(messageId)
            return true
          }
        }
        return false
      },
    },
    followup(message) {
      state.followups.push(message)
      state.queue.push(message)
    },
    whenIdle() {
      return Promise.resolve()
    },
  }
  if (withWake) agent.wakeDriver = (flag) => { state.wakes.push(flag) }
  return { agent, state }
}

function makeCtx(agents) {
  const listeners = []
  return {
    agents: { get: (id) => agents.get(id) },
    logger: { info() {}, warn() {} },
    on(event, callback) {
      if (event === 'session/event') listeners.push(callback)
      return () => {
        const index = listeners.indexOf(callback)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    emit(session, event) {
      for (const callback of [...listeners]) callback(session, event)
    },
    listenerCount: () => listeners.length,
  }
}

/** Register one agent, run one event through the plugin, and return its state. */
function run(options, event) {
  const registry = new Map()
  const { agent, state } = makeAgent(options.id ?? 'session-1', options)
  registry.set(agent.id, agent)
  const ctx = makeCtx(registry)
  apply(ctx, options.config ?? {})
  ctx.emit(agent.session, event)
  return { state, agent, ctx }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push([true, name])
  } catch (error) {
    results.push([false, name, error])
  }
}

await check('queued next-turn prompt wakes the driver after a user stop', () => {
  const { state } = run({ queued: [prompt('a')] }, stopEvent())
  assert.deepEqual(state.wakes, [true])
})

await check('steered next-step prompt wakes the driver after a user stop', () => {
  const { state } = run({ steered: [prompt('b')] }, stopEvent())
  assert.deepEqual(state.wakes, [true])
})

await check('steered prompt wins when injected context shares next-step', () => {
  const { state } = run({ steered: [context('ctx'), prompt('c')] }, stopEvent())
  assert.deepEqual(state.wakes, [true])
})

await check('injected context alone does not wake the driver', () => {
  const { state } = run({ steered: [context('ctx')] }, stopEvent())
  assert.deepEqual(state.wakes, [])
})

await check('an empty inbox does not wake the driver', () => {
  const { state } = run({}, stopEvent())
  assert.deepEqual(state.wakes, [])
})

await check('a completed turn does not wake the driver', () => {
  const { state } = run({ queued: [prompt('d')] }, completedEvent())
  assert.deepEqual(state.wakes, [])
})

await check('a parent interruption wakes the driver', () => {
  const { state } = run({ queued: [prompt('e')] }, stopEvent('parent'))
  assert.deepEqual(state.wakes, [true])
})

await check('a disposed teardown does not resume', () => {
  const { state } = run({ queued: [prompt('f')] }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
  assert.deepEqual(state.wakes, [])
})

await check('a relayed agent-message prompt counts as pending work', () => {
  const { state } = run({ steered: [prompt('g', 'agent-message')] }, stopEvent())
  assert.deepEqual(state.wakes, [true])
})

await check('no wake primitive: idle agent re-offers the stranded prompt publicly', async () => {
  const { state } = run({ queued: [prompt('h')], withWake: false, status: 'idle' }, stopEvent())
  await settle()
  assert.deepEqual(state.removals, ['h'])
  assert.deepEqual(state.followups.map((m) => m.id), ['h'])
  assert.deepEqual(state.queue.map((m) => m.id), ['h'])
})

await check('wake that never starts a turn: idle agent recovers the stranded prompt', async () => {
  const { state } = run({ queued: [prompt('i')], status: 'idle' }, stopEvent())
  await settle()
  assert.deepEqual(state.wakes, [true], 'the private wake is still attempted first')
  assert.deepEqual(state.followups.map((m) => m.id), ['i'], 'recovery re-offers the prompt')
})

await check('wake that starts a turn is not re-offered', async () => {
  const { state } = run({ queued: [prompt('j')], status: 'running' }, stopEvent())
  await settle()
  assert.deepEqual(state.followups, [], 'a running agent needs no recovery')
})

await check('enabled: false registers no listener', () => {
  const { ctx } = run({ queued: [prompt('k')], config: { enabled: false } }, stopEvent())
  assert.equal(ctx.listenerCount(), 0)
})

const failed = results.filter(([ok]) => !ok)
for (const [ok, name, error] of results) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n      ${error?.message}`}`)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
