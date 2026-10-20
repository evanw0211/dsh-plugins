# dsh-plugins

DeepSeek Harness **Host plugins** by [evanw0211](https://github.com/evanw0211), kept as a pnpm monorepo.

| Package | What it does |
|---|---|
| [`queue-resume-on-stop`](packages/queue-resume-on-stop) | Keeps queued messages flowing after you press **Stop**: when a user abort strands `agent.inbox.nextTurn`, it wakes the loop once more so the queued prompts are sent to the model. |
| [`session-tasks`](packages/session-tasks) | Lets one conversation hand a task to another, with `list_conversations` and `send_task_to_conversation`. |

## Layout

```
packages/
  queue-resume-on-stop/   @local/dsh-queue-resume-on-stop
  session-tasks/          @local/dsh-session-tasks
```

Each package is a plain Host bundle: an `index.js` plus a `cordis.patch.yml`
patch that inserts its loader row. Neither declares runtime dependencies — every
Harness package resolves from the running installation — so there is no build
step and no bundler output to commit.

## Install into a DSH profile

Point the plugin manager at the package directory (absolute path):

```powershell
plugin_manager install_bundle   # target: <repo>/packages/<name>
```

Equivalently, from the CLI:

```powershell
dsh plugin --profile <profile> add <repo>/packages/<name>
```

That links the directory under `node_modules/@local/` and appends the package to
`dsh.profile.bundles`; the loader reads the inserted row from the package's
`cordis.patch.yml`.

Requires DSH `0.2.0-rc.2`.

## Development

There is nothing to build. To link the workspace and run a package's own check:

```powershell
pnpm install
node packages/queue-resume-on-stop/dev/verify.mjs
node packages/session-tasks/dev/verify.mjs
```

## License

MIT — see [LICENSE](LICENSE).
