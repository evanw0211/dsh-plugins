# Session Tasks

Host plugin for the DeepSeek Harness that lets one conversation hand a task to
another conversation.

It registers two model-facing tools:

| Tool | Purpose |
|---|---|
| `list_conversations` | Lists the other conversations (Sessions) with the id needed to address one, most recently active first. The calling conversation is excluded unless `includeSelf` is set; conversations owned by subagent routing are excluded unless `includeSubagents` is set, because `send_task_to_conversation` cannot address them. |
| `send_task_to_conversation` | Sends one task message to a conversation by `sessionId`. |

## Delivery

`send_task_to_conversation` resolves the target Agent (resuming a closed
conversation) and admits the message into its inbox, so the target does not have
to be running:

- a **running** conversation receives the message at its next step boundary;
- an **idle or closed** conversation starts a new turn.

`mode` selects the delivery policy:

- `queue` (default) — `agent.followup`: the message becomes its own ordinary turn;
- `steer` — `agent.steer`: the message targets the nearest step.

The call returns as soon as the target accepted the message. It does not wait for
the task to finish, so a success result means "delivered", not "done".

### Attribution

The message is recorded with the durable source
`{ kind: 'agent-message', form: 'relay', senderSessionId: <sender> }` rather than
the `user` source a browser prompt uses. Three consequences:

- the target's client renders its built-in **task-message notice** for the turn
  instead of showing the text as if the human had typed it;
- the target model reads the same framing the built-in agent-to-agent relay uses,
  `Agent <sender> sent a message:` followed by the task;
- the Harness treats the message as an agent message, not as a human
  instruction carrying the user's authority.

The recipient hands a result back by calling the same tool with the sender id.
Both tools are global, so every conversation can use them. A delivery requires a
calling conversation to attribute: an agentless call is rejected.

### Durability

Delivery is followed by a `ctx.sessions.flush` checkpoint, and the result reports
`durable`. A target that is not persisted is still delivered with `durable:
false`; a failed checkpoint never fails the call, because the message is already
admitted and a reported failure would invite a duplicate send.

## Install

```powershell
plugin_manager install_bundle  # target: this directory
```

The bundle inserts one row (`session-tasks`) pointing at `@local/dsh-session-tasks`.
Requires the `tools`, `sessionController`, and `sessions` Host services; in a
profile without one of them the plugin stays inactive instead of throwing.

Changing `index.js` after installation needs a Harness restart: the profile holds
the installed JavaScript generation in memory.

## Check

```powershell
node dev/verify.mjs
```

This runs the plugin outside the Harness against a fake Session service and
asserts the conversation filtering, the delivered message and its attribution,
delivery routing, argument validation, and error translation.
