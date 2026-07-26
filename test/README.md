# Testing

Two gates before every commit: **`test/run.sh e2e`** and **`test/run.sh browser2`** - both must be green, never commit on red.

```bash
test/run.sh e2e          # fast, no browser (~4 min)
test/run.sh browser2     # the desktop-parity UX in a real browser (~10 min)
test/run.sh all          # everything, in sequence
# browser suites need the sandbox off on this firefox build:
export MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_DISABLE_GMP_SANDBOX=1 MOZ_DISABLE_RDD_SANDBOX=1
```

**The harness.** Every run makes a fresh copy of the repo into
`/tmp/rdv-test` and does a REAL install there (`run.sh` downloads the Linux
builds, patches them, starts caddy + serve-web + the orchestrator - the
same code as production). There is no docker in tests: **the "container"
is the machine itself**, driven by two fakes on `PATH`
(`test/fakebin/docker` and `test/fakebin/devcontainer-cli.js`) that log
every invocation for assertions. Everything cleans up after itself; logs
in `/tmp/rdv-test/start.log`, screenshots in `/tmp/rdv-test/shots/`.

**The suites.**

| suite | what it proves |
|---|---|
| `e2e` | the protocol, byte-level: resolve, bridge handshake + reconnect, allocator, docker-published passthrough, watchdog + freeze heal, recreate rescue (our bind / external holder / release lag), stop-and-retry and rebind prompts, clone-in-volume, token gate, enter links |
| `browser` | the entry: workbench loads the builtin resolver, authority resolution on the dev-container reload, lands in the container window |
| `browser2` | desktop-parity UX: remote indicator + name, trust, real terminal, Ports view (auto-detect, toast, live status, manual forward, **edit via right-click → Change Local Address Port**), reload → reconnect, Close Remote Connection, daemon reuse, Rebuild, Reopen Folder Locally |
| `browser3` | slow-build UI: progress notification + streaming build lines during a ~10 s fake build, pink identity on landing |
| `browser4` | the real user entry: the stock "Reopen in Container" notification fires on a folder with `.devcontainer`, click → our resolver takes over |
| `browser5` | the proposal lifecycle: desktop text + buttons, don't-show-again persistence, the Reset command |
| `browser6` | the command-surface audit: every Dev Containers/Remote palette entry, dumped + screenshots |
| `browser7` | both rescue paths watched in the UI (`FAKE_UP_FAIL_ONCE` + broken net), then the remaining palette commands for real |
| `browser8` | the exotic build: 48 s with hostile docker output (bare-`\r`, unicode, dead silence), unicode name, `forwardPorts` + `appPort`, one bogus extension |
| `browser9` | the palette gauntlet: every Dev Containers/Remote entry EXECUTED and its observable effect asserted |
| `browsercc` | the title-bar pill theme regression (the white-on-white bug): computed styles of the agent-status input area must be the theme color with white text |
| `real` | entry against REAL docker (state-sensitive, standalone on purpose) |

**Writing new tests.** The fakes answer failure-injection flags through
`$FAKE_STATE` files and env: `FAKE_UP_FAIL_ONCE`, `up-fail-armed` (one-shot
CLI up failure), `up-fail-always`, `compose-port-fail=PORT[:N][:v6]`
(docker's "port is already allocated", N times, either family),
`broken-net` (container with no network attachment), `inspect-lag`,
`publish-holder` (another project publishing a port), `vol-built` /
`vol-devcontainer.json` (clone-in-volume fixtures). Assert against
`cli-args.log` / `docker-args.log` (every fake invocation), the
`/progress` lines (what the user sees), and computed styles for anything
visual - never guess a UI color from pixels alone.
