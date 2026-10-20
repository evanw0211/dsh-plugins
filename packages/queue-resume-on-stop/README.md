# Resume Queue On Stop

A small Host plugin for DSH that keeps **queued messages flowing after you press Stop**.

## The problem

While a turn is running, anything you send is queued in the agent's inbox
(`agent.inbox.nextTurn`) and is claimed at the next turn boundary.

The Stop button calls `agent.cancel({ kind: 'user' }, { keepInbox: true })`
(`dsh-api-session-controller` → `session.cancel`). That aborts the in-flight turn
**and deliberately keeps the queue** — but nothing re-arms the driver afterwards:

- A normal turn end keeps looping: `turn()` returns `true` while `inbox.hasPending`,
  so the next queued prompt is claimed immediately.
- An abort *throws* out of `turn()`, so `kick()` unwinds and the driver stops.
  The queued prompts stay in the inbox and are never sent to the model.

The loop already handles the mirror case: a message that arrives *after* the abort
is classified as a wake (`send()` → `wakingAfterAbort`), which latches
`phase.wakeRequested`; `kick()`'s exit path replays that latch. A message queued
*before* the Stop never sets the latch — that is the gap this plugin closes.

Symptom the user sees: the queued message still sits in the queue (and is never
answered) until some *new* message happens to wake the driver.

## What it does

On every durable `turn/end` whose reason is `aborted` with cause `user` (the Stop
button) or `parent` (a parent interrupting a child), if the same agent still has
pending prompts, the plugin asks the loop to wake once more — exactly as a message
typed a moment after the Stop would. The next turn then claims the pending
prompts and sends them to the model.

"Pending" covers both inbox boundaries:

- **`nextTurn`** — prompts waiting for their own turn (the normal queue).
- **`nextStep`** — *steering* prompts, which DSH 0.2.1 introduced
  (`agent.steer()`, `busyEnter: 'steer'`, or the queue row's steer action). A stop
  that lands before the next step boundary strands them exactly like a queued
  prompt.

`nextStep` also carries injected context (`agent.inject()`, runtime snapshots,
subagent results). Injection is deliberately non-waking, so only messages whose
source is a real prompt (`user`, `agent-message`) count.

`disposed` (teardown) and `hook` (credential/session invalidation) aborts are
ignored: restarting work there would fight the teardown.

If the private wake primitive is missing or does not start a turn, the plugin
falls back to the public surface once the agent settles to idle: it removes one
stranded prompt and re-queues it with `followup()`, which wakes the driver.

## Install

It is a plain Host bundle: no dependencies, no build step. Point DSH's plugin
manager at this directory (absolute path) and it installs the package, adds the
bundle to the profile, and activates over HMR:

```
plugin_manager install_bundle  <path-to-this-directory>
```

Equivalently, from the CLI: `dsh plugin --profile <name> add <path-to-this-directory>`.

Requires DSH `0.2.0-rc.2`. Verified against `0.2.1-rc.2` (both inbox boundaries).
The bundle resolves every Harness package from the running installation, so it
declares no dependencies of its own.

## Configuration

`cordis.patch.yml` inserts one row; override it in your profile patch:

```yaml
- id: queue-resume-on-stop
  config:
    enabled: false   # turn the behavior off without uninstalling
    trace: true      # append apply/wake/recovery breadcrumbs to apply.log
```

`trace: true` (or `DSH_QUEUE_RESUME_TRACE=1` in the environment) writes one JSON
line per apply, wake, and recovery to `apply.log` beside `index.js`, so a silent
no-op is visible without a debugger.

## Files

| File | Role |
|---|---|
| `index.js` | Host plugin: the `session/event` trigger and the wake |
| `cordis.patch.yml` | Inserts the `queue-resume-on-stop` row |
| `package.json` | Bundle manifest (`dsh.bundle.patch`) |
| `locale/*.json` | Plugin Manager display text |
| `dev/verify.mjs` | Decision-logic checks (both boundaries, injected context, recovery) |
| `dev/scan-stranded-queue.mjs` | Scans stored session logs for "stop stranded the queue" occurrences |
| `dev/dump-session.mjs` | Dumps a slice of one `session.v4.jsonl.zstd` log |

## Notes on the wake

The public `Agent` surface (`followup`/`steer`/`inject`/`cancel`/`inbox`) has no
wake primitive. Re-queuing a pending prompt would need `inbox.remove(id)` +
`followup(message)`, which writes a durable "canceled" inbox splice and re-insert —
and `Session.append()` refuses to reenter while a `session/event` observer is
running, which is exactly where this listener executes.

So the plugin calls `wakeDriver(true)` when it exists: it mutates only the
in-memory phase latch (the identical call `send()` makes on its post-abort path)
and appends nothing to the session log. Because that primitive is private, the
plugin then waits for the agent to settle: an idle agent that still has pending
prompts means the wake did not take, so the public remove + `followup()` recovery
runs instead. That also covers a loop that renames or drops `wakeDriver`.
