/**
 * Model-facing tools that hand a task from one conversation to another.
 *
 * `list_conversations` reports the other conversations (Sessions) this Harness
 * knows about, together with the id needed to address one.
 * `send_task_to_conversation` admits one task message into a target
 * conversation's inbox, resuming a closed conversation first: a running
 * conversation takes the message at its next step boundary, an idle one starts
 * a new turn. Both calls return as soon as the target accepted the message;
 * neither waits for the task to finish.
 *
 * The delivered message carries the durable attribution
 * `{ kind: 'agent-message', form: 'relay', senderSessionId }` instead of the
 * `user` source a browser prompt uses, so the target records it as a message
 * another conversation sent rather than as something the human typed. The
 * client shows that attribution as its built-in "task message received" notice,
 * and the model reads the same `Agent <id> sent a message:` framing the built-in
 * agent-to-agent relay uses. The recipient can hand a result back with the same
 * tool.
 *
 * @module @local/dsh-session-tasks
 */

import { randomUUID } from 'node:crypto';

/** Loader metadata: the plugin row name used in diagnostics. */
export const name = 'session-tasks';

/** Required services; without any one of them this plugin stays inactive. */
export const inject = ['tools', 'sessionController', 'sessions'];

/** Conversations returned when the caller passes no `limit`. */
const DEFAULT_LIST_LIMIT = 20;
/** Largest number of conversations one listing may return. */
const MAX_LIST_LIMIT = 50;
/** Longest task body delivered in one call. */
const MAX_TASK_LENGTH = 8000;
/** Longest conversation title kept in a listing. */
const TITLE_LIMIT = 160;
/** Delivery modes accepted by the Session prompt API. */
const MODES = ['queue', 'steer'];

/** Whether a value is a plain JSON record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field, or an empty string when absent. */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/** Error text for a caught value, keeping a stable failure code when present. */
function describeError(error) {
  if (isRecord(error) && typeof error.code === 'string') {
    const message = error instanceof Error ? error.message : String(error.message ?? error);
    return `${error.code}: ${message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The calling conversation's id, or undefined for a non-agent caller. */
function currentSessionId(exec) {
  const id = exec.agent?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** The human-readable title of one Session summary, or an empty string. */
function conversationTitle(summary) {
  const projections = summary.projections;
  if (!isRecord(projections) || !isRecord(projections.values)) return '';
  const title = text(projections.values.title).trim();
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT)}...` : title;
}

/** Freeze a message graph the way the message factories publish one. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Build the durable user message one conversation sends to another.
 *
 * This mirrors the built-in agent-to-agent relay: the same source attribution
 * the client renders as a task-message notice, and the same model-visible
 * framing, so the recipient can tell who sent the task and answer it. The local
 * copy exists because a profile-installed bundle cannot resolve the Harness
 * message factories; at runtime the factory adds nothing beyond this shape.
 *
 * @param senderSessionId - the sending conversation's id.
 * @param task - the task text the sender supplied.
 * @returns the frozen message to admit into the target's inbox.
 */
function agentTaskMessage(senderSessionId, task) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
    content: [
      { type: 'text', text: `Agent ${senderSessionId} sent a message: ` },
      { type: 'text', text: task }
    ]
  });
}

/** A required non-empty string argument. */
function requireString(value, argument, limit) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${argument} must be a non-empty string`);
  }
  if (value.length > limit) throw new Error(`${argument} is longer than ${limit} characters`);
  return value;
}

/** A bounded positive-integer argument. */
function boundedInteger(value, argument, fallback, cap) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${argument} must be a positive integer`);
  }
  return Math.min(value, cap);
}

/** The result schema of `list_conversations`. */
function listOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      conversations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionId: { type: 'string' },
            title: { type: 'string' },
            running: { type: 'boolean' },
            cwd: { type: 'string' },
            updatedAt: { type: 'integer' },
            isCurrent: { type: 'boolean' },
            parentSessionId: { type: 'string' }
          },
          required: ['sessionId', 'title', 'running', 'cwd', 'updatedAt', 'isCurrent']
        }
      },
      total: { type: 'integer' },
      truncated: { type: 'boolean' },
      current: { type: 'string' }
    },
    required: ['conversations', 'total', 'truncated', 'current']
  };
}

/** The result schema of `send_task_to_conversation`. */
function sendOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      accepted: { type: 'boolean' },
      sessionId: { type: 'string' },
      mode: { type: 'string', enum: MODES },
      from: { type: 'string' },
      durable: { type: 'boolean' }
    },
    required: ['accepted', 'sessionId', 'mode', 'from', 'durable']
  };
}

/** Render a listing as the text the model reads. */
function renderList(args, value) {
  if (value.conversations.length === 0) {
    const query = isRecord(args) ? text(args.query).trim() : '';
    return query === ''
      ? 'No other conversation is available.'
      : `No conversation matched "${query}".`;
  }
  const headline = value.truncated
    ? `Other conversations (${value.conversations.length} of ${value.total}, most recently active first):`
    : `Other conversations (${value.conversations.length}, most recently active first):`;
  const lines = [headline];
  for (const row of value.conversations) {
    const parts = [`- ${row.sessionId}`];
    if (row.title !== '') parts.push(`"${row.title}"`);
    if (row.isCurrent) parts.push('(this conversation)');
    parts.push(row.running ? '[running]' : '[idle]');
    if (row.parentSessionId !== undefined) parts.push(`child of ${row.parentSessionId}`);
    if (row.cwd !== '') parts.push(`cwd=${row.cwd}`);
    if (row.updatedAt > 0) parts.push(`last active ${new Date(row.updatedAt).toISOString()}`);
    lines.push(parts.join(' '));
  }
  if (value.current !== '') lines.push('', `This conversation is ${value.current}.`);
  lines.push('', 'Send a task with send_task_to_conversation and the sessionId above.');
  return lines.join('\n');
}

/** Render one delivery acknowledgement as the text the model reads. */
function renderSend(value) {
  const delivery = value.mode === 'steer'
    ? 'delivered into its current turn at the next step boundary'
    : 'queued for its next turn, starting one when it is idle';
  const lines = [`Task accepted by conversation ${value.sessionId} and ${delivery}.`];
  lines.push(value.durable
    ? 'The delivery is recorded in that conversation.'
    : 'That conversation is not confirmed durable, so the delivery may not survive a restart.');
  if (value.from !== '') {
    lines.push(`It was sent as ${value.from}; that conversation can hand a result back with the same tool.`);
  }
  lines.push('Delivery is not completion: the target handles the task on its own schedule.');
  return lines.join('\n');
}

/**
 * Register `list_conversations` and `send_task_to_conversation` on `ctx.tools`.
 * @param ctx - the plugin context carrying the tool and Session services.
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'list_conversations',
    description: 'List the other conversations in this Harness with the id needed to send one a task, most recently active first. The calling conversation is excluded unless includeSelf is set.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'integer',
          description: `Conversations returned. Defaults to ${DEFAULT_LIST_LIMIT}, maximum ${MAX_LIST_LIMIT}.`
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring matched against each conversation title, working directory, and id.'
        },
        includeSelf: {
          type: 'boolean',
          description: 'Include the calling conversation itself. Defaults to false.'
        },
        includeSubagents: {
          type: 'boolean',
          description: 'Include conversations owned by subagent routing. They are listed for completeness, but send_task_to_conversation cannot address them. Defaults to false.'
        }
      }
    },
    output: {
      schema: listOutputSchema(),
      render: (args, value) => [{ type: 'text', text: renderList(args, value) }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const record = isRecord(args) ? args : {};
      const limit = boundedInteger(record.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
      const includeSelf = record.includeSelf === true;
      const includeSubagents = record.includeSubagents === true;
      const query = text(record.query).trim().toLowerCase();
      const current = currentSessionId(exec);

      let summaries;
      try {
        const listed = await ctx.sessionController.list({}, exec.signal);
        summaries = Array.isArray(listed?.items) ? listed.items : [];
      } catch (error) {
        throw new Error(`cannot list conversations: ${describeError(error)}`);
      }

      const conversations = [];
      let total = 0;
      for (const summary of summaries) {
        if (!isRecord(summary)) continue;
        const sessionId = text(summary.sessionId);
        if (sessionId === '') continue;
        if (!includeSubagents && summary.origin === 'subagent') continue;
        const title = conversationTitle(summary);
        const cwd = text(summary.cwd);
        const isCurrent = current !== undefined && sessionId === current;
        if (isCurrent && !includeSelf) continue;
        if (query !== '' && !`${title}\n${cwd}\n${sessionId}`.toLowerCase().includes(query)) continue;
        total += 1;
        if (conversations.length >= limit) continue;
        conversations.push({
          sessionId,
          title,
          running: summary.running === true,
          cwd,
          updatedAt: typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt) ? Math.trunc(summary.updatedAt) : 0,
          isCurrent,
          ...text(summary.parentSessionId) === '' ? {} : { parentSessionId: text(summary.parentSessionId) }
        });
      }

      return { conversations, total, truncated: total > conversations.length, current: current ?? '' };
    },
    presentCall() {
      return { card: 'generic', title: 'List conversations', kind: 'search' };
    }
  });

  ctx.tools.register({
    name: 'send_task_to_conversation',
    description: 'Send one task message to another conversation, addressed by the sessionId that list_conversations reports. That conversation records it as a message from this conversation, shows it as a task-message notice, and reads it as "Agent <this conversation> sent a message:" followed by the task. A running conversation takes it at its next step boundary; an idle or closed one is resumed and starts a new turn. Returns once the target accepted the message, without waiting for the task to run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: {
          type: 'string',
          description: 'Target conversation id, such as session-1a2b3c4d-....'
        },
        task: {
          type: 'string',
          description: `Task message delivered to the target conversation. Up to ${MAX_TASK_LENGTH} characters.`
        },
        mode: {
          type: 'string',
          enum: MODES,
          description: "Delivery: 'queue' waits for the target's next turn and starts one when it is idle; 'steer' admits into the target's current turn at its next step boundary."
        }
      },
      required: ['sessionId', 'task']
    },
    output: {
      schema: sendOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderSend(value) }]
    },
    async execute(args, exec) {
      const record = isRecord(args) ? args : {};
      const sessionId = requireString(record.sessionId, 'sessionId', 200).trim();
      const task = requireString(record.task, 'task', MAX_TASK_LENGTH);
      const mode = record.mode === undefined ? 'queue' : record.mode;
      if (typeof mode !== 'string' || !MODES.includes(mode)) {
        throw new Error(`mode must be one of ${MODES.map((entry) => `'${entry}'`).join(', ')}`);
      }

      const from = currentSessionId(exec);
      if (from === undefined) {
        throw new Error('send_task_to_conversation requires a calling conversation');
      }

      exec.signal?.throwIfAborted?.();
      let resolved;
      try {
        resolved = await ctx.sessionController.resolveAgent(sessionId);
      } catch (error) {
        throw new Error(`cannot send a task to ${sessionId}: ${describeError(error)}`);
      }
      if (isRecord(resolved) && resolved.error !== undefined) {
        throw new Error(`cannot send a task to ${sessionId}: ${describeError(resolved.error)}`);
      }
      const agent = resolved?.agent;
      if (agent === undefined || agent === null
        || typeof agent.followup !== 'function' || typeof agent.steer !== 'function') {
        throw new Error(`cannot send a task to ${sessionId}: the target conversation has no live agent`);
      }

      const message = agentTaskMessage(from, task);
      try {
        // `followup` opens an ordinary turn of its own; `steer` targets the
        // nearest step. Both are what the browser prompt itself routes to.
        if (mode === 'steer') agent.steer(message);
        else agent.followup(message);
      } catch (error) {
        throw new Error(`cannot send a task to ${sessionId}: ${describeError(error)}`);
      }

      // The message is admitted now; the checkpoint only reports whether it is
      // on the target's log. A failed checkpoint must not fail the call, which
      // would invite the model to send the same task twice.
      let durable = false;
      try {
        durable = await ctx.sessions.flush(agent.session) === true;
      } catch {
        durable = false;
      }

      return { accepted: true, sessionId, mode, from, durable };
    },
    presentCall(args) {
      const sessionId = isRecord(args) ? text(args.sessionId) : '';
      return {
        card: 'generic',
        title: sessionId === '' ? 'Send task to a conversation' : `Send task to ${sessionId}`,
        kind: 'other'
      };
    }
  });
}
