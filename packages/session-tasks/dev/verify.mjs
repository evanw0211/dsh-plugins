/**
 * Functional check for @local/dsh-session-tasks that runs without the Harness.
 *
 * It imports the plugin, captures the tool definitions `apply()` registers, and
 * drives both callbacks against a fake Session service. That covers what an
 * installed-but-not-reloaded module cannot show: argument validation, the
 * conversation filter, the delivered message and its durable attribution,
 * delivery routing, and error translation.
 *
 * Run: node dev/verify.mjs
 */

import assert from 'node:assert/strict';
import { apply, inject } from '../index.js';

/** Register the plugin against a capturing tool registry. */
function load() {
  const definitions = new Map();
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(definitions.has(definition.name), false, `duplicate tool ${definition.name}`);
        definitions.set(definition.name, definition);
        return () => {};
      }
    }
  };
  apply(ctx);
  return { definitions, ctx };
}

/** A Session service stub backed by an ordered fixture. */
function sessions(items) {
  const calls = { followups: [], steers: [], prompts: [], flushes: 0, flushResult: true, flushThrows: false };
  const agent = {
    session: { id: 'target-session' },
    followup(message) { calls.followups.push(message); },
    steer(message) { calls.steers.push(message); }
  };
  const controller = {
    list: async () => ({ items }),
    resolveAgent: async (sessionId) => (sessionId === 'session-missing'
      ? { error: Object.assign(new Error(`session "${sessionId}" not found`), { code: 'session/not-found' }) }
      : { agent }),
    prompt: async (request) => { calls.prompts.push(request); return { accepted: true }; }
  };
  const store = {
    flush: async () => {
      calls.flushes += 1;
      if (calls.flushThrows) throw new Error('persistence unavailable');
      return calls.flushResult;
    }
  };
  return { calls, agent, controller, store };
}

const SELF = 'session-self';
const items = [
  {
    sessionId: SELF,
    updatedAt: 300,
    running: true,
    blank: false,
    cwd: 'C:/work',
    projections: { kind: 'cached', asOfSeq: 9, values: { title: 'My own conversation' } }
  },
  {
    sessionId: 'sub-0001',
    updatedAt: 200,
    running: false,
    blank: false,
    origin: 'subagent',
    parentSessionId: SELF,
    cwd: 'C:/work',
    projections: { values: { title: 'Subagent child' } }
  },
  {
    sessionId: 'session-alpha',
    updatedAt: 100,
    running: false,
    blank: false,
    cwd: 'C:/alpha',
    projections: { values: { title: 'Alpha notes' } }
  },
  { sessionId: 'session-beta', updatedAt: 50, running: false, blank: false, cwd: 'C:/beta' }
];

/** The execution context the registry hands a tool body. */
const exec = { agent: { id: SELF }, signal: undefined };

const { definitions, ctx } = load();
assert.deepEqual([...definitions.keys()], ['list_conversations', 'send_task_to_conversation']);
assert.deepEqual(inject, ['tools', 'sessionController', 'sessions']);

const list = definitions.get('list_conversations');
const send = definitions.get('send_task_to_conversation');

// --- registration shape -----------------------------------------------------
for (const definition of [list, send]) {
  assert.equal(definition.parameters.type, 'object');
  assert.equal(definition.parameters.additionalProperties, false);
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(definition.output.schema.type, 'object');
  assert.equal(definition.output.schema.additionalProperties, false);
  assert.ok(Array.isArray(definition.output.schema.required));
}
assert.deepEqual(list.parameters.required, undefined, 'list has no required parameter');
assert.deepEqual(send.parameters.required, ['sessionId', 'task']);
assert.deepEqual(send.parameters.properties.mode.enum, ['queue', 'steer']);

// --- listing ----------------------------------------------------------------
const listing = sessions(items);
ctx.sessionController = listing.controller;

const plain = await list.execute({}, exec);
assert.deepEqual(plain.conversations.map((row) => row.sessionId), ['session-alpha', 'session-beta']);
assert.equal(plain.total, 2, 'self and the subagent child are excluded');
assert.equal(plain.truncated, false);
assert.equal(plain.current, SELF);
assert.equal(plain.conversations[0].title, 'Alpha notes');
assert.equal(plain.conversations[1].title, '', 'a session without a title projects an empty string');
assert.deepEqual(plain.conversations[0], {
  sessionId: 'session-alpha',
  title: 'Alpha notes',
  running: false,
  cwd: 'C:/alpha',
  updatedAt: 100,
  isCurrent: false
});
assert.ok(!('parentSessionId' in plain.conversations[0]));
assert.match(list.output.render({}, plain)[0].text, /session-alpha/);

const withSelf = await list.execute({ includeSelf: true }, exec);
assert.deepEqual(withSelf.conversations.map((row) => row.sessionId), [SELF, 'session-alpha', 'session-beta']);
assert.equal(withSelf.total, 3);
assert.equal(withSelf.conversations[0].isCurrent, true);

const withSubagents = await list.execute({ includeSubagents: true }, exec);
assert.deepEqual(withSubagents.conversations.map((row) => row.sessionId), ['sub-0001', 'session-alpha', 'session-beta']);
assert.equal(withSubagents.total, 3);
assert.equal(withSubagents.conversations[0].parentSessionId, SELF);

const queried = await list.execute({ query: 'ALPHA' }, exec);
assert.deepEqual(queried.conversations.map((row) => row.sessionId), ['session-alpha']);

const byPath = await list.execute({ query: 'c:/beta' }, exec);
assert.deepEqual(byPath.conversations.map((row) => row.sessionId), ['session-beta']);

const capped = await list.execute({ limit: 1 }, exec);
assert.equal(capped.conversations.length, 1);
assert.equal(capped.total, 2);
assert.equal(capped.truncated, true);
assert.match(list.output.render({}, capped)[0].text, /1 of 2/);

const none = await list.execute({ query: 'nothing-matches' }, exec);
assert.deepEqual(none.conversations, []);
assert.equal(none.total, 0);
assert.match(list.output.render({}, none)[0].text, /No other conversation is available/);
assert.match(list.output.render({ query: 'nothing-matches' }, none)[0].text, /No conversation matched "nothing-matches"/);

// A service failure keeps its code.
ctx.sessionController = { list: async () => { throw Object.assign(new Error('store offline'), { code: 'gateway/internal' }); } };
await assert.rejects(list.execute({}, exec), /cannot list conversations: gateway\/internal: store offline/);

// --- sending ----------------------------------------------------------------
const delivery = sessions(items);
ctx.sessionController = delivery.controller;
ctx.sessions = delivery.store;

const sent = await send.execute({ sessionId: 'session-alpha', task: 'Summarize the notes.' }, exec);
assert.deepEqual(sent, { accepted: true, sessionId: 'session-alpha', mode: 'queue', from: SELF, durable: true });
assert.equal(delivery.calls.prompts.length, 0, 'the plain-user prompt path is not used');
assert.equal(delivery.calls.steers.length, 0);
assert.equal(delivery.calls.followups.length, 1, 'queue opens an ordinary follow-up turn');
assert.equal(delivery.calls.flushes, 1, 'delivery is checkpointed');

const message = delivery.calls.followups[0];
assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source']);
assert.equal(message.role, 'user');
assert.equal(typeof message.id, 'string');
assert.ok(message.id.length >= 8);
assert.deepEqual(message.source, { kind: 'agent-message', form: 'relay', senderSessionId: SELF });
assert.deepEqual(message.content, [
  { type: 'text', text: `Agent ${SELF} sent a message: ` },
  { type: 'text', text: 'Summarize the notes.' }
]);
assert.ok(Object.isFrozen(message), 'the message is frozen before publication');
assert.ok(Object.isFrozen(message.source));
assert.ok(Object.isFrozen(message.content[0]));
assert.match(send.output.render({}, sent)[0].text, /is recorded in that conversation/);

const steered = await send.execute({ sessionId: 'session-beta', task: 'Ping.', mode: 'steer' }, exec);
assert.deepEqual(steered, { accepted: true, sessionId: 'session-beta', mode: 'steer', from: SELF, durable: true });
assert.equal(delivery.calls.steers.length, 1, 'steer targets the nearest step');
assert.equal(delivery.calls.followups.length, 1);
assert.equal(delivery.calls.steers[0].content[1].text, 'Ping.');
assert.notEqual(delivery.calls.steers[0].id, message.id, 'every delivery has a fresh identity');
assert.match(send.output.render({}, steered)[0].text, /next step boundary/);

// A session that is not persisted is delivered but reported as not durable.
delivery.calls.flushResult = false;
const unpersisted = await send.execute({ sessionId: 'session-alpha', task: 'Ephemeral.' }, exec);
assert.equal(unpersisted.durable, false);
assert.equal(delivery.calls.followups.length, 2);
assert.match(send.output.render({}, unpersisted)[0].text, /may not survive a restart/);

// A failing checkpoint never fails a delivery that was already admitted.
delivery.calls.flushThrows = true;
const unchecked = await send.execute({ sessionId: 'session-alpha', task: 'Still delivered.' }, exec);
assert.equal(unchecked.accepted, true);
assert.equal(unchecked.durable, false);
assert.equal(delivery.calls.followups.length, 3);

// --- delivery failures ------------------------------------------------------
await assert.rejects(
  send.execute({ sessionId: 'session-missing', task: 'x' }, exec),
  /cannot send a task to session-missing: session\/not-found: session "session-missing" not found/
);

ctx.sessionController = { resolveAgent: async () => ({ agent: {} }) };
await assert.rejects(send.execute({ sessionId: 'session-alpha', task: 'x' }, exec), /has no live agent/);

ctx.sessionController = { resolveAgent: async () => { throw new Error('boom'); } };
await assert.rejects(send.execute({ sessionId: 'session-alpha', task: 'x' }, exec), /cannot send a task to session-alpha: boom/);

ctx.sessionController = delivery.controller;
const target = delivery.agent;
delivery.agent.followup = () => { throw new Error('closing'); };
await assert.rejects(send.execute({ sessionId: 'session-alpha', task: 'x' }, exec), /cannot send a task to session-alpha: closing/);
delivery.agent.followup = (value) => { delivery.calls.followups.push(value); };
assert.equal(target, delivery.agent);

// A caller without a conversation identity cannot attribute a delivery.
await assert.rejects(send.execute({ sessionId: 'session-alpha', task: 'x' }, { signal: undefined }), /requires a calling conversation/);

// Cancellation before resolution stops the call.
const aborted = new AbortController();
aborted.abort();
await assert.rejects(send.execute({ sessionId: 'session-alpha', task: 'x' }, { agent: { id: SELF }, signal: aborted.signal }), /abort/i);

// --- argument validation ----------------------------------------------------
await assert.rejects(send.execute({}, exec), /sessionId must be a non-empty string/);
await assert.rejects(send.execute({ sessionId: 's', task: '   ' }, exec), /task must be a non-empty string/);
await assert.rejects(send.execute({ sessionId: 's', task: 'x'.repeat(8001) }, exec), /task is longer than 8000 characters/);
await assert.rejects(send.execute({ sessionId: 's', task: 'x', mode: 'later' }, exec), /mode must be one of 'queue', 'steer'/);
await assert.rejects(list.execute({ limit: 0 }, exec), /limit must be a positive integer/);
assert.equal((await list.execute({ limit: 999 }, exec)).conversations.length, 2, 'limit above the cap is clamped');
assert.equal(delivery.calls.followups.length, 3, 'a rejected call delivers nothing');

// --- call presentation ------------------------------------------------------
assert.deepEqual(send.presentCall({ sessionId: 'session-alpha' }), {
  card: 'generic',
  title: 'Send task to session-alpha',
  kind: 'other'
});
assert.equal(send.presentCall({}).title, 'Send task to a conversation');
assert.equal(list.presentCall({}).kind, 'search');

console.log('session-tasks: all checks passed');
console.log('--- list_conversations render ---');
console.log(list.output.render({}, plain)[0].text);
console.log('--- send_task_to_conversation render ---');
console.log(send.output.render({}, sent)[0].text);
