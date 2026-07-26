# Troubleshooting

| symptom | cause / action |
|---|---|
| `Unauthorized client refused` | old tab with a dead cookie - mint a fresh enter link (`./run.sh link`) |
| workbench won't load | serve-web down, wrong internal IP, or wrong token |
| `cannot resolve authority` after Reopen in Container | the resolver is not registered - re-run `./run.sh` (setup-workbench.py is loud on anchor drift) and hard-reload the tab (workbench.js is cached for a year) |
| build progress | the run.sh output - `devcontainer up` streams there (a first image pull takes minutes) |
| `An error occurred starting Docker Compose up` | the CLI hides docker's own error; the orchestrator re-runs the failing command with `--force-recreate` - a transient failure heals, a real one finally shows docker's exact error in the log |
| `container has no IP` / containers with only `lo` inside | OrbStack's STALE port forwards: after half-created containers, OrbStack keeps the published ports bound with NO container running, so every new `up` dies mid-attach. `lsof -nP -iTCP -sTCP:LISTEN` for your compose's ports with no container up, then **restart OrbStack** |
| `port is already allocated` at container (re)start | rescued when it is OUR forward (released, retried - watch the channel); otherwise the error names the holder AND disambiguates: `Code Helper` = a forward in ANOTHER VS Code (close it there), no container publishing = a stale OrbStack forward (restart OrbStack), or the live container already publishing it (stop it or change the compose port). Note: docker cannot "bind elsewhere" - `ports:` is a hard 0.0.0.0 contract; drop the publish if the forward alone suffices |
| `daemon never answered on <ip>:10001` | the daemon crashed in the container - `docker exec <container> cat /tmp/remote-dev/serve-web.log` |

## Port forwarding details

All matching desktop:

- collision (two containers, one port) → the allocator takes the next free
  port, stably per (container, port); a privileged port (<1024) falls back
  to a kernel-assigned port
- ports published by docker itself (compose `ports:`) are never squatted -
  they answer as-is
- servers bound to `127.0.0.1` *inside* the container are relayed out by a
  durable gate that closes when the server dies and re-opens when it returns
- edit the forwarded port from the Ports view (right-click → *Change Local
  Address Port*) - it re-binds exactly what you ask, or fails honestly
- the status is live: a dead server closes the row; a host **sleep** looks
  like a dead server to the watchdog, so condemnations are re-probed and
  heal themselves on wake - your forwards survive the Mac's nap; a server
  that comes back later resurrects its row with the same address
- a recreate that would die on `port is already allocated` is rescued: our
  own bind on that port is released and retried automatically; an external
  holder (another VS Code's forward, a stale OrbStack bind) is **named** in
  the error instead of a dead end

The forwarded address is `http://<the workbench's IP>:<port>` - the remote
equivalent of desktop's `localhost:N`. OAuth callbacks (wrangler login,
gcloud auth) just need `localhost` replaced with the workbench's address,
port unchanged.
