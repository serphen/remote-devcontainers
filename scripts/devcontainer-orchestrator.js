#!/usr/bin/env node
/**
 * devcontainer-orchestrator — the host-side half of the desktop-parity flow.
 * Runs next to docker on the host machine, never in a container; listens
 * on a unix socket (caddy proxies /api/remote-dev/* onto it), no TCP port.
 *
 * This service executes there what the Dev Containers extension would
 * execute on the CLIENT computer on desktop: it offloads the extension's
 * host-side commands. On desktop the extension's resolver runs inside the
 * VS Code client process with full machine access (spawn docker, install
 * the server into the container, open a raw socket to it). A browser
 * workbench can do none of that — web extensions get no processes and no
 * TCP — so the browser half (scripts/remote-devcontainers-extension, a web worker in
 * the browser tab) POSTs the dev-container payload here, through caddy
 * (the only network door), and this service does the machine work:
 *
 *   1. build/start the container if missing (Microsoft's bundled
 *      devcontainer CLI — on desktop the build is the resolver's job too);
 *   2. install the standard VS Code server DAEMON (flavor server-linux-*,
 *      NON-web — the same daemon Remote-SSH/Dev Containers install on
 *      desktop) into the container and launch it with a connection token;
 *   3. answer {ip, port, connectionToken} — the extension then gives the
 *      workbench a managed connection whose transport is the WebSocket
 *      bridge below (the browser cannot open raw TCP; the desktop relay
 *      could).
 *
 * The Microsoft Dev Containers extension on the host does NOT talk to
 * this service (it only owns the entry UI and lends us its CLI). The
 * ONLY caller is the browser resolver extension, via caddy.
 *
 * Endpoints (loopback only; caddy proxies /api/remote-dev/* here):
 *   POST /resolve    body: payload JSON — answers {ip, port, connectionToken}
 *   GET  /progress   ?path=<hostPath>  — current step, for the resolve
 *                    notification (desktop shows the same steps)
 *   WS   /bridge     ?ip&port — WebSocket ↔ raw TCP splice to the daemon.
 *                    The workbench's own protocol upgrade flows through it
 *                    untouched (auth, reconnects), like the desktop relay.
 *
 * Env:
 *   REMOTE_DEV_TKN_FILE         the master's connection-token file (auth)
 *   REMOTE_DEV_SERVE_PORT       daemon port inside containers (default 10001)
 *   REMOTE_DEV_DEVCONTAINER_CLI Microsoft's bundled devcontainer CLI (builds)
 *   REMOTE_DEV_COMMIT           the host build's commit (pins container bits)
 *   REMOTE_DEV_CACHE_DIR        where artifacts are cached (downloaded once)
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// process helper

const { execFile } = require("child_process");

/** Run a command, streaming output to the channel. Rejects on non-zero exit. */
function run(channel, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        maxBuffer: opts.maxBuffer || 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          channel.appendLine(`✗ ${cmd} ${args.join(" ")}`);
          if (stderr) {
            channel.appendLine(stderr.trim());
          }
          const tail = `${stderr.trim()}\n${stdout.trim()}`
            .trim()
            .split("\n")
            .slice(-12)
            .join("\n");
          const e = new Error(`${cmd} exited (${err.code}):\n${tail}`);
          e.captured = { stdout, stderr }; // full output, for post-mortems
          reject(e);
        } else {
          resolve(stdout);
        }
      },
    );
    if (!opts.quiet) {
      channel.appendLine(`$ ${cmd} ${args.join(" ")}`);
    }
    // quiet probe commands stay quiet — desktop's log doesn't dump 100KB
    // of inspect JSON / commit lists into the user's channel either
    if (p.stdout && !opts.quiet) {
      p.stdout.on("data", (d) => {
        channel.append(d.toString());
        if (opts.onData) {
          opts.onData(d);
        }
      });
    }
    if (p.stderr) {
      p.stderr.on("data", (d) => {
        channel.append(d.toString());
        if (opts.onData) {
          opts.onData(d);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// container work (docker + server daemon inside the container)
/**
 * @typedef {{ id: string, ip: string, name: string }} ContainerInfo
 */

const IN_CONTAINER_DIR = "/tmp/remote-dev"; // supervisor, token, logs
const VSCODE_SERVER_DIR = "/tmp/remote-dev/vscode-server"; // bin/<commit> + server data

/** Global docker flags for the payload's docker context (settings.context,
 *  e.g. "orbstack"). The build happens THERE — the default context sees
 *  nothing. */
function dockerArgs(ctx) {
  return ctx ? ["--context", ctx] : [];
}

/** Locate the dev container for a workspace folder via the CLI's labels. */
async function findContainer(channel, folder, ctx) {
  const out = await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "ps",
      "--filter",
      `label=devcontainer.local_folder=${folder}`,
      "--format",
      "{{.ID}} {{.Names}}",
    ],
    { quiet: true },
  );
  const line = out.trim().split("\n")[0];
  channel.appendLine(
    `findContainer(${folder}${ctx ? `, ctx=${ctx}` : ""}) → ${line || "NOTHING RUNNING"}`,
  );
  if (!line) {
    return undefined;
  }
  const [id, name] = line.split(" ");
  return discoverIp(channel, id, name, ctx);
}

/** Locate a RUNNING container by EXACT name (Attach to Running Container —
 *  the attached-container+<hex> authority carries {containerName}). A prefix
 *  match would let /stop-container kill an unrelated container ("h" → the
 *  first thing running); the id-prefix form is kept (docker's convention). */
async function findContainerByName(channel, wanted, ctx) {
  if (!wanted) {
    return undefined;
  }
  const out = await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "ps",
      "--filter",
      `name=${wanted}`,
      "--format",
      "{{.ID}} {{.Names}}",
    ],
    { quiet: true },
  );
  const line =
    out
      .trim()
      .split("\n")
      .find(
        (l) =>
          l.split(" ")[1] === wanted || l.split(" ")[0].startsWith(wanted),
      ) || "";
  channel.appendLine(
    `findContainerByName(${wanted}${ctx ? `, ctx=${ctx}` : ""}) → ${line || "NOTHING RUNNING"}`,
  );
  if (!line) {
    return undefined;
  }
  const [id, name] = line.split(" ");
  return discoverIp(channel, id, name, ctx);
}

/** Full network diagnostics when a container has NO ip after every retry —
 *  what "ils n'ont pas d'IP bind" looks like from docker's side. Printed to
 *  the channel so it can be pasted straight back to us. */
async function dumpNetworkDiagnostics(channel, id, name, ctx) {
  try {
    const raw = await run(
      channel,
      "docker",
      [...dockerArgs(ctx), "inspect", id],
      { quiet: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const info = JSON.parse(raw)[0] || {};
    const state = info.State || {};
    const hc = info.HostConfig || {};
    const ns = info.NetworkSettings || {};
    const nets = Object.entries(ns.Networks || {})
      .map(
        ([n, v]) =>
          `${n}: ip=${(v && v.IPAddress) || "∅"} gw=${(v && v.Gateway) || "∅"}`,
      )
      .join("; ");
    channel.appendLine(
      `network diagnostics for ${name} (${id.slice(0, 12)}):\n` +
        `  state: ${state.Status} (started ${state.StartedAt})\n` +
        `  networkMode: ${hc.NetworkMode || "?"}\n` +
        `  networks: ${nets || "(none)"}\n` +
        `  portBindings: ${JSON.stringify(hc.PortBindings || {})}\n` +
        `  ports: ${JSON.stringify(ns.Ports || {})}`,
    );
    if (hc.NetworkMode && !/^(host|none|container:|$)/.test(hc.NetworkMode)) {
      const raw2 = await run(
        channel,
        "docker",
        [...dockerArgs(ctx), "network", "inspect", hc.NetworkMode],
        { quiet: true },
      );
      const net = JSON.parse(raw2)[0] || {};
      const members = Object.entries(net.Containers || {})
        .map(([cid, m]) => `${m.Name || cid.slice(0, 12)}: ${m.IPv4Address || "∅"}`)
        .join("; ");
      channel.appendLine(
        `  network ${hc.NetworkMode} members: ${members || "(EMPTY — the leaked-IP OrbStack state)"}\n` +
          `  ipam: ${JSON.stringify((net.Status && net.Status.IPAM) || net.IPAM || {})}`,
      );
    }
    const inside = await run(
      channel,
      "docker",
      [
        ...dockerArgs(ctx),
        "exec",
        id,
        "sh",
        "-c",
        "ip -4 addr show 2>/dev/null || true",
      ],
      { quiet: true },
    ).catch(() => "");
    if (inside.trim()) {
      channel.appendLine(
        "  inside the container (ip -4 addr):\n" +
          inside
            .trim()
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n"),
      );
    }
  } catch (e) {
    channel.appendLine(`network diagnostics failed: ${(e && e.message) || e}`);
  }
}

/** IP discovery for a found container, robust: compose containers can sit
 *  on SEVERAL networks (the first one's IP field can be empty), share
 *  another container's net namespace (Networks empty), or use the host
 *  network outright. And right after `up`, the network plumbing can lag
 *  the container start (observed on OrbStack: State.Running=true with
 *  Networks={} and Ports={} for a moment) — so an empty answer is
 *  RETRIED, then asked to the network itself. */
async function discoverIp(channel, id, name, ctx) {
  let ip = "";
  let networkMode = "";
  const published = new Map(); // containerPort → hostPort (docker's own)
  for (let attempt = 0; attempt < 10 && !ip; attempt++) {
    if (attempt) {
      channel.appendLine(
        `no IP yet on ${name} — waiting for the network plumbing (${attempt}/9)`,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }
    const raw = await run(
      channel,
      "docker",
      [...dockerArgs(ctx), "inspect", id],
      { quiet: true, maxBuffer: 16 * 1024 * 1024 },
    );
    let info = {};
    try {
      info = JSON.parse(raw)[0] || {};
    } catch {
      /* leave empty */
    }
    const nets = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
    for (const n of Object.values(nets)) {
      if (n && n.IPAddress) {
        ip = n.IPAddress;
        break;
      }
    }
    if (!ip && info.NetworkSettings && info.NetworkSettings.IPAddress) {
      ip = info.NetworkSettings.IPAddress;
    }
    networkMode = (info.HostConfig && info.HostConfig.NetworkMode) || "";
    if (!ip && networkMode === "host") {
      ip = "127.0.0.1"; // host networking: the container IS the host's stack
    }
    // docker's OWN published ports for this container (compose `ports:`):
    // they are ALREADY reachable at <the workbench's IP>:hostPort — our
    // same-port bind would be redundant, and WORSE it squats the port the
    // next recreate wants to publish ("Bind for 0.0.0.0:8080 failed: port
    // is already allocated" — raven's rebuild died on exactly this)
    const pb = (info.HostConfig && info.HostConfig.PortBindings) || {};
    for (const [cport, binds] of Object.entries(pb)) {
      const containerPort = Number(String(cport).split("/")[0]);
      const hostPort = Number(
        (Array.isArray(binds) && binds[0] && binds[0].HostPort) || 0,
      );
      if (containerPort > 0 && hostPort > 0) {
        published.set(containerPort, hostPort);
      }
    }
  }
  if (!ip && networkMode && !/^(host|none|container:|$)/.test(networkMode)) {
    // last resort: the network knows its members even when the
    // container's own inspect stays empty
    try {
      const raw = await run(
        channel,
        "docker",
        [...dockerArgs(ctx), "network", "inspect", networkMode],
        { quiet: true },
      );
      const members = (JSON.parse(raw)[0] || {}).Containers || {};
      for (const [cid, m] of Object.entries(members)) {
        if (cid.startsWith(id) && m.IPv4Address) {
          ip = m.IPv4Address.split("/")[0];
          break;
        }
      }
      if (ip) {
        channel.appendLine(
          `IP ${ip} found via docker network inspect ${networkMode}`,
        );
      }
    } catch (e) {
      channel.appendLine(`network inspect ${networkMode} failed: ${e.message}`);
    }
  }
  if (!ip) {
    channel.appendLine(
      `no IP on ${name} (networkMode=${networkMode || "?"} — retried 10× over ~9s)`,
    );
    await dumpNetworkDiagnostics(channel, id, name, ctx);
  } else {
    knownContainerIps.add(ip); // the bridge may dial resolved containers only
  }
  return { id, name, ip, networkMode, published };
}

/** Diagnostic: dump what docker actually sees (running OR stopped, labels
 *  included). A wrong context or label assumption shows up here immediately
 *  instead of looking like "the build never ran". */
async function dumpContainers(channel, ctx) {
  try {
    const out = await run(
      channel,
      "docker",
      [
        ...dockerArgs(ctx),
        "ps",
        "-a",
        "--format",
        '{{.Names}} | {{.Status}} | folder={{.Label "devcontainer.local_folder"}}',
      ],
      { quiet: true },
    );
    channel.appendLine(
      `docker (ctx=${ctx || "default"}) sees:\n${out.trim() || "(no containers at all)"}`,
    );
  } catch (e) {
    channel.appendLine(`docker ps -a failed: ${e.message}`);
  }
}

/**
 * Build/start the dev container with Microsoft's OWN engine — the
 * devcontainer CLI bundled inside the Dev Containers extension
 * (dist/spec-node/devContainersSpecCLI.js). On desktop the build is driven
 * by the extension's resolver — so is ours, just on the host. Idempotent:
 * an already-up container makes this return in seconds. Output streams to
 * the run.sh log.
 */
async function buildContainer(
  channel,
  folder,
  configFile,
  ctx,
  extraFlags = [],
  opts = {},
) {
  const cli = process.env.REMOTE_DEV_DEVCONTAINER_CLI;
  if (!cli) {
    throw new Error(
      "devcontainer CLI not found (REMOTE_DEV_DEVCONTAINER_CLI unset) " +
        "— run ./run.sh install",
    );
  }
  const args = [cli, "up", "--workspace-folder", folder, ...extraFlags];
  if (configFile) {
    args.push("--config", configFile);
  }
  // host docker for the container, the official way (devcontainers'
  // docker-outside-of-docker feature): the host socket bind-mounted at the
  // default path. Only at (re)create — a container built before this just
  // lacks the mount until its next rebuild (the daemon logs a hint).
  if (fs.existsSync(DOCKER_SOCK)) {
    args.push(
      "--mount",
      `type=bind,source=${DOCKER_SOCK},target=/var/run/docker.sock`,
    );
  }
  // desktop passes these two on every up (their config tracking);
  // every other desktop flag matches the CLI's own defaults
  // (verified in the CLI source: mount-workspace-git-root=true,
  // update-remote-user-uid-default=on, user-env-probe=loginInteractiveShell,
  // and dev.containers.lockfile defaults true on BOTH sides)
  args.push("--include-configuration", "--include-merged-configuration");
  channel.appendLine(
    `container ${extraFlags.length ? "rebuild" : "missing"} — devcontainer up ${extraFlags.join(" ")} (ctx=${ctx || "default"})`,
  );
  // The CLI shells out to the docker CLI, which honors DOCKER_CONTEXT.
  const env = ctx ? { DOCKER_CONTEXT: ctx } : {};
  // Desktop's progress steps (their bundle, verbatim titles): "Building
  // image" until the stream shows the build is done, then "Starting
  // container". 20% each, their increment curve.
  setProgress(folder, "Building image…", 20);
  let started = false;
  const onData = (d) => {
    if (!started && /up -d|Built|Starting/.test(d.toString())) {
      started = true;
      setProgress(folder, "Starting container…", 20);
    }
  };
  try {
    await run(channel, process.execPath, args, {
      env,
      maxBuffer: 64 * 1024 * 1024,
      onData,
    });
  } catch (err) {
    await rescueComposeFailure(channel, err, env, ctx, opts);
  }
}

/** The port-conflict escape hatch, without editing the user's compose: an
 *  override file in /tmp that REPLACES every service's published ports with
 *  target-only (ephemeral) mappings — docker assigns free host ports, and
 *  our passthrough surfaces them in the Ports view automatically. Uses the
 *  compose `!override` tag (compose ≥ 2.24; merges would APPEND, never
 *  remove the colliding publish). */
async function ephemeralPortsOverride(channel, composeCmd, env) {
  const configCmd = composeCmd.replace(/\s+up\s+-d.*$/, " config --format json");
  const out = await run(channel, "sh", ["-c", configCmd], { env, quiet: true });
  const cfg = JSON.parse(out);
  const lines = ["# generated by remote-dev — the user's compose is untouched"];
  let any = false;
  for (const [name, svc] of Object.entries(cfg.services || {})) {
    const ports = Array.isArray(svc.ports) ? svc.ports : [];
    if (!ports.length) {
      continue;
    }
    any = true;
    lines.push(`  ${name}:`, "    ports: !override");
    for (const p of ports) {
      const target = p.target || Number(String(p.published || "").split(":").pop());
      if (target) {
        lines.push(`      - target: ${target}`);
      }
    }
  }
  if (!any) {
    return undefined;
  }
  const file = path.join(
    os.tmpdir(),
    `rdv-ephemeral-${crypto.createHash("sha256").update(composeCmd).digest("hex").slice(0, 10)}.yml`,
  );
  fs.writeFileSync(file, `services:\n${lines.join("\n")}\n`);
  return file;
}

/** The compose command re-run by the rescue comes from the CLI's own log —
 *  which embeds paths from devcontainer.json (compose files, workspace). A
 *  crafted devcontainer.json (a hostile folder, or a crafted vscode-remote
 *  link) could smuggle shell metacharacters into it, and our `sh -c` would
 *  execute them. Validate the shape BEFORE re-running: a docker compose
 *  command with no shell metacharacters, or we fall back to the plain error. */
function isSafeComposeCommand(last) {
  if (!/^docker (?:--context \S+ )?compose /.test(last)) {
    return false;
  }
  return !/[;|&`$\\<>]/.test(last) && !last.includes("\n");
}

/**
 * The CLI swallows the stderr of the docker/compose commands it runs
 * (runCommandNoPty with print off; the failure is wrapped in a generic
 * "An error occurred starting Docker Compose up."). So a failed `up` tells
 * us NOTHING — and some of those failures are transient (compose/image-
 * store race right after a build, observed in the wild).
 *
 * The naive re-run of the failing command is a TRAP: when the first
 * `up -d` died mid-attach (port programming / fresh-network race), the
 * container exists created-but-never-attached, and a plain `up -d` just
 * "starts" it — exit 0, still no network (verified live: Networks={}
 * forever). So for an `up -d` command the re-run is a FULL converge:
 * --force-recreate. Transient failure → a properly attached container;
 * persistent failure (port already allocated, …) → docker's REAL error
 * lands in the channel and the thrown error, actionable at last.
 */
async function rescueComposeFailure(channel, err, env, ctx, opts = {}) {
  const blob = `${(err.captured && err.captured.stdout) || ""}\n${(err.captured && err.captured.stderr) || ""}`;
  const dockers = [...blob.matchAll(/Start: Run: (docker [^\n]+)/g)].map(
    (m) => m[1],
  );
  let last = dockers[dockers.length - 1];
  if (!last) {
    throw err;
  } // failed before any docker command — nothing to re-run
  if (!isSafeComposeCommand(last)) {
    // the CLI's logged command carries paths from devcontainer.json — a
    // crafted one could smuggle shell metacharacters, and our `sh -c`
    // would execute them. Never run an unexpected shape.
    throw err;
  }
  if (/\bup -d\b/.test(last) && !last.includes("--force-recreate")) {
    last += " --force-recreate";
    channel.appendLine(
      "the CLI hid the real docker error — re-running its last command " +
        "with --force-recreate (a plain up would just start the half-created container):",
    );
  } else {
    channel.appendLine(
      "the CLI hid the real docker error — re-running its last command directly:",
    );
  }
  try {
    await run(channel, "sh", ["-c", last], { env });
    channel.appendLine(
      "…which succeeded — the CLI failure was transient. Continuing.",
    );
  } catch (err2) {
    // docker's REAL error is visible now. The classic: "port is already
    // allocated" — a recreate re-publishes the compose ports and something
    // squats one. If that something is US (a forward bound before the
    // publish existed; the upstream watchdog would reap it in ~15 s but
    // the recreate starts NOW), release and retry ONCE. Otherwise NAME
    // the squatter — a bare "port is already allocated" is a dead end
    // (raven: "je suis censé faire quoi avec ça").
    const blob2 = `${(err2.captured && err2.captured.stdout) || ""}\n${(err2.captured && err2.captured.stderr) || ""}`;
    // docker reports the failed bind family-dependently: "0.0.0.0:8080"
    // (v4 wildcard) or ":::8080" (v6 wildcard, seen live on the same
    // recreate a day later) — the port is what matters, after the LAST colon
    const m = blob2.match(
      /Bind for .+?:(\d+) failed: port is already allocated/,
    );
    if (!m) {
      throw err2;
    }
    const port = Number(m[1]);
    if (releaseBindsOnPort(channel, port)) {
      channel.appendLine(
        `:${port} was squatted by OUR forward — released, retrying the compose command:`,
      );
      await run(channel, "sh", ["-c", last], { env });
      channel.appendLine(
        "…which succeeded once our bind was released. Continuing.",
      );
      return;
    }
    // not ours. The container's OWN predecessor can squat it: OrbStack's
    // userspace proxy holds the publish briefly after the old container
    // dies (compose Recreate = stop → create → start — raven's "le
    // container se squatte en bootant deux fois?"). That is TRANSIENT: if
    // no LIVE container publishes the port, wait and retry once before
    // naming anyone.
    if (!(await containerPublishes(channel, port, ctx))) {
      channel.appendLine(
        `:${port} is held with NO container publishing it (OrbStack release lag?) — waiting 4 s and retrying once:`,
      );
      await new Promise((r) => setTimeout(r, 4000));
      try {
        await run(channel, "sh", ["-c", last], { env });
        channel.appendLine(
          "…which succeeded — it was the release lag. Continuing.",
        );
        return;
      } catch {
        // genuinely held — fall through
      }
    }
    // the user chose "Rebind to free ports" in the workbench prompt:
    // neutralize THIS project's publishes via a /tmp override (their
    // compose file is never touched) and retry with it
    if (opts.rebindPorts) {
      channel.appendLine(
        "rebind requested — generating the ephemeral-ports override in /tmp:",
      );
      const override = await ephemeralPortsOverride(channel, last, env);
      if (override) {
        const rebound = last.replace(/\s+up\s+-d/, ` -f ${override} up -d`);
        channel.appendLine(`$ sh -c ${rebound}`);
        await run(channel, "sh", ["-c", rebound], { env });
        channel.appendLine(
          "…up with ephemeral ports — docker assigned free host ports " +
            "(the Ports view shows them). Continuing.",
        );
        return;
      }
      channel.appendLine("no published ports to override — naming the holder instead");
    }
    const who = await squatterOn(channel, port, ctx);
    throw new Error(
      `${err2.message}\nport ${port} is held by:\n${who || "(lsof sees nothing — a stale OrbStack forward with no container; restart OrbStack)"}`,
    );
  }
}

/** The rebuild marker written by the patched Dev Containers extension (see
 *  install-devcontainers-extension.py): "1" = rebuild, "nocache" = rebuild
 *  without cache. Consumed (deleted) here — desktop semantics are the same
 *  one-shot, and the flags passed to the CLI are the desktop ones. */
async function consumeRebuildMarker(channel, container, ctx) {
  const marker = await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "exec",
      container.id,
      "sh",
      "-c",
      `cat ${IN_CONTAINER_DIR}/rebuild 2>/dev/null || true`,
    ],
    { quiet: true },
  );
  const mode = marker.trim();
  if (!mode) {
    return undefined;
  }
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "exec",
      container.id,
      "rm",
      "-f",
      `${IN_CONTAINER_DIR}/rebuild`,
    ],
    { quiet: true },
  );
  channel.appendLine(`rebuild requested from the container window (${mode})`);
  return mode;
}

/** The parsed devcontainer.json (via Microsoft's CLI — handles JSONC).
 *  Best effort: {} on any failure. */
async function readDevcontainerConfig(channel, folder, ctx) {
  const cli = process.env.REMOTE_DEV_DEVCONTAINER_CLI;
  if (!cli) {
    return {};
  }
  try {
    const out = await run(
      channel,
      process.execPath,
      [cli, "read-configuration", "--workspace-folder", folder],
      { quiet: true, env: ctx ? { DOCKER_CONTEXT: ctx } : {} },
    );
    return JSON.parse(out).configuration || {};
  } catch (e) {
    channel.appendLine(`read-configuration failed (${e.message})`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Clone Repository in Container Volume — the payload carries
// {volumeName, folder, settings, cloneInfo}, NOT hostPath: the code lives in
// a docker volume (the extension created it and cloned the repo into it).
// BUILDING from the volume is the resolver's job (desktop steps "Building
// image" → "Starting server" run after the reload) — ours does it here.

/** Minimal JSONC: strip // and /* … *\/ comments outside strings — enough
 *  for a devcontainer.json read inside a container (best effort). */
function stripJsonc(text) {
  let out = "";
  let str = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (str) {
      out += c;
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === '"') {
        str = false;
      }
    } else if (c === '"') {
      str = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** The config of a VOLUME workspace lives in the volume — read it inside
 *  the container (host paths mean nothing here). */
async function readDevcontainerConfigInContainer(channel, container, ctx) {
  try {
    const out = await run(
      channel,
      "docker",
      [
        ...dockerArgs(ctx),
        "exec",
        container.id,
        "sh",
        "-c",
        "cat /workspaces/*/.devcontainer/devcontainer.json 2>/dev/null || true",
      ],
      { quiet: true },
    );
    return out.trim() ? JSON.parse(stripJsonc(out)) : {};
  } catch (e) {
    channel.appendLine(
      `in-container devcontainer.json unreadable (${(e && e.message) || e})`,
    );
    return {};
  }
}

/** Locate a volume dev container: the stock clone-in-volume label first,
 *  then any container with the volume mounted (stock-built ones). */
async function findContainerByVolume(channel, vol, ctx) {
  const ps = async (filter) =>
    run(
      channel,
      "docker",
      [
        ...dockerArgs(ctx),
        "ps",
        "--filter",
        filter,
        "--format",
        "{{.ID}} {{.Names}}",
      ],
      { quiet: true },
    );
  let line = (await ps(`label=vsch.local.volume=${vol}`)).trim().split("\n")[0];
  if (!line) {
    line = (await ps(`volume=${vol}`)).trim().split("\n")[0];
  }
  channel.appendLine(
    `findContainerByVolume(${vol}${ctx ? `, ctx=${ctx}` : ""}) → ${line || "NOTHING RUNNING"}`,
  );
  if (!line) {
    return undefined;
  }
  const [id, name] = line.split(" ");
  return discoverIp(channel, id, name, ctx);
}

/** "__UNIQUE__" is NOT a volume name — it is the stock clone-in-volume
 *  MARKER (docker rejects it as a name, seen live). The real volume is
 *  looked up by its labels: vsch.local.repository=<url> or
 *  vsch.local.repository.folder=<repo>. */
async function resolveVolumeName(channel, payload, ctx) {
  const vol = payload.volumeName;
  if (vol && vol !== "__UNIQUE__") {
    return vol;
  }
  const keys = [];
  const repo =
    payload.cloneInfo &&
    (payload.cloneInfo.repository ||
      payload.cloneInfo.url ||
      payload.cloneInfo.repositoryUrl);
  if (repo) {
    keys.push(`vsch.local.repository=${repo}`);
  }
  if (payload.folder) {
    keys.push(`vsch.local.repository.folder=${payload.folder}`);
  }
  for (const label of keys) {
    const out = await run(
      channel,
      "docker",
      [...dockerArgs(ctx), "volume", "ls", "-q", "--filter", `label=${label}`],
      { quiet: true },
    );
    const name = out.trim().split("\n")[0];
    if (name) {
      channel.appendLine(`__UNIQUE__ → volume ${name} (label ${label})`);
      return name;
    }
  }
  throw new Error(
    "Clone in Container Volume: no docker volume labeled " +
      (keys.join(" or ") || "vsch.local.repository*") +
      " — the clone step did not create one (did it fail earlier?)",
  );
}

/** The override config for a volume build: the repo's devcontainer.json
 *  (read from the volume through a throwaway container), normalized by the
 *  CLI, with the workspace FORCED to the volume mount — exactly what the
 *  stock extension feeds its CLI (`--override-config`). */
async function volumeOverrideConfig(channel, payload, wsFolder, ctx) {
  const vol = payload.volumeName;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rdv-vol-"));
  const raw = await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "run",
      "--rm",
      "-v",
      `${vol}:/w:ro`,
      "alpine",
      "sh",
      "-c",
      "cat /w/.devcontainer/devcontainer.json 2>/dev/null || true",
    ],
    { quiet: true },
  ).catch(() => "");
  let conf = {};
  if (raw.trim()) {
    fs.mkdirSync(`${tmp}/.devcontainer`, { recursive: true });
    fs.writeFileSync(`${tmp}/.devcontainer/devcontainer.json`, raw);
    conf = await readDevcontainerConfig(channel, tmp, ctx);
  }
  conf.workspaceFolder = wsFolder;
  conf.workspaceMount = `type=volume,source=${vol},target=${wsFolder}`;
  // a repo without .devcontainer gets the stock default image (desktop
  // does the same for config-less clones)
  if (!conf.image && !conf.dockerFile && !conf.dockerComposeFile) {
    conf.image = "mcr.microsoft.com/devcontainers/base:ubuntu";
  }
  const p = path.join(tmp, "override.json");
  fs.writeFileSync(p, JSON.stringify(conf, null, "\t"));
  return p;
}

/** The devcontainer.json's customizations.vscode.extensions — the
 *  extensions the container's server should carry (desktop passes them as
 *  --install-extension to the server launch; so do we). */
function customizedExtensions(conf) {
  const list = ((conf.customizations || {}).vscode || {}).extensions;
  return Array.isArray(list) ? list.filter((e) => typeof e === "string") : [];
}

/** The workspace mount inside the container (first /workspaces/* mount)
 *  — where postAttachCommand runs, like the desktop client. */
async function workspaceMount(channel, container, ctx) {
  try {
    const out = await run(
      channel,
      "docker",
      [
        ...dockerArgs(ctx),
        "inspect",
        "-f",
        "{{range .Mounts}}{{.Destination}}\n{{end}}",
        container.id,
      ],
      { quiet: true },
    );
    return out.split("\n").find((d) => d.startsWith("/workspaces/"));
  } catch {
    return undefined;
  }
}

/** postAttachCommand, desktop semantics: run on every attach (every
 *  resolve), in the workspace folder, as the container user. */
async function runPostAttach(channel, container, conf, ctx) {
  let cmd = conf.postAttachCommand;
  if (Array.isArray(cmd)) {
    cmd = cmd.join(" && ");
  }
  if (typeof cmd !== "string" || !cmd.trim()) {
    return;
  }
  const user = await containerUser(channel, container, ctx);
  const workspacePath = await workspaceMount(channel, container, ctx);
  channel.appendLine(`postAttachCommand: ${cmd.slice(0, 80)}`);
  try {
    await run(
      channel,
      "docker",
      [
        ...dockerArgs(ctx),
        "exec",
        "--user",
        user,
        ...(workspacePath ? ["-w", workspacePath] : []),
        container.id,
        "sh",
        "-c",
        cmd,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    channel.appendLine(
      `postAttachCommand failed (${e.message}) — continuing (desktop logs it too)`,
    );
  }
}

// ---------------------------------------------------------------------------
// artifact push — host downloads once (cached), every container gets a copy

const COMMIT = process.env.REMOTE_DEV_COMMIT || ""; // the host build's commit
const CACHE_DIR = process.env.REMOTE_DEV_CACHE_DIR || os.tmpdir();

/** Pinned to the host's commit when known: identical versions everywhere. */
function artifactUrl(flavor, commit) {
  return commit
    ? `https://update.code.visualstudio.com/commit:${commit}/${flavor}/stable`
    : `https://update.code.visualstudio.com/latest/${flavor}/stable`;
}

/** Which commit a flavor is currently at (also validates the flavor). */
async function probeFlavor(channel, flavor) {
  try {
    const out = await run(
      channel,
      "curl",
      [
        "-sfL",
        "--max-time",
        "30",
        `https://update.code.visualstudio.com/api/commits/stable/${flavor}`,
      ],
      { quiet: true },
    );
    const commits = JSON.parse(out);
    return Array.isArray(commits) && commits.length ? commits[0] : undefined;
  } catch {
    return undefined;
  }
}

/** The container's arch and libc, probed once per install. */
async function containerPlatform(channel, container, ctx) {
  const arch = (
    await run(
      channel,
      "docker",
      [...dockerArgs(ctx), "exec", container.id, "uname", "-m"],
      { quiet: true },
    )
  ).trim();
  const musl =
    (
      await run(
        channel,
        "docker",
        [
          ...dockerArgs(ctx),
          "exec",
          container.id,
          "sh",
          "-c",
          "ldd --version 2>&1 | grep -qi musl && echo yes || echo no",
        ],
        { quiet: true },
      )
    ).trim() === "yes";
  return { arch, musl };
}

/** The server DAEMON flavor for this container (NON-web — the desktop one).
 *  Alpine naming has drifted over time: probe candidates, first valid wins. */
async function pickServerFlavor(channel, plat) {
  const candidates = plat.musl
    ? plat.arch === "aarch64"
      ? ["server-alpine-arm64", "server-linux-alpine-arm64"]
      : ["server-alpine-x64", "server-linux-alpine"]
    : plat.arch === "aarch64"
      ? ["server-linux-arm64"]
      : ["server-linux-x64"];
  for (const flavor of candidates) {
    const commit = await probeFlavor(channel, flavor);
    if (commit) {
      return { flavor, probedCommit: commit };
    }
  }
  throw new Error(
    `no server flavor found for arch=${plat.arch} musl=${plat.musl} ` +
      `(tried: ${candidates.join(", ")})`,
  );
}

/** Fetch a Microsoft artifact into the host cache (downloaded once, ever),
 *  docker cp it into the container and extract. */
async function pushArtifact(channel, container, ctx, flavor, commit, destDir) {
  const tgz = `vscode-${flavor}${commit ? `-${commit}` : ""}.tgz`;
  const cached = path.join(CACHE_DIR, tgz);
  if (!fs.existsSync(cached)) {
    channel.appendLine(
      `downloading ${flavor} (once — cached on the host afterwards)`,
    );
    await run(channel, "curl", [
      "-sfL",
      artifactUrl(flavor, commit),
      "-o",
      `${cached}.part`,
    ]);
    fs.renameSync(`${cached}.part`, cached);
  }
  await execRoot(channel, ctx, container.id, ["mkdir", "-p", destDir], {
    quiet: true,
  });
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "cp",
      cached,
      `${container.id}:${IN_CONTAINER_DIR}/artifact.tgz`,
    ],
    { quiet: true },
  );
  await execRoot(channel, ctx, container.id, [
    "sh",
    "-c",
    `tar xzf ${IN_CONTAINER_DIR}/artifact.tgz -C ${destDir} --strip-components=1 && rm ${IN_CONTAINER_DIR}/artifact.tgz`,
  ]);
}

/**
 * Push the static docker CLI (downloaded by run.sh into the cache) into
 * the container, at ${IN_CONTAINER_DIR}/bin/docker. The host's socket is
 * bind-mounted at the default path (see buildContainer) — the CLI and the
 * container-side extension drive the host's docker directly, like
 * desktop's UI-side extension. Best effort: without the cached binary
 * the container just stays docker-less (today's behavior).
 */
async function pushDockerCli(channel, container, ctx) {
  const tgz = path.join(CACHE_DIR, "docker-cli-linux-arm64.tgz");
  if (!fs.existsSync(tgz)) {
    channel.appendLine(
      "docker CLI not cached (run.sh step 7/7) — container stays without docker",
    );
    return;
  }
  await execRoot(channel, ctx, container.id, [
    "mkdir",
    "-p",
    `${IN_CONTAINER_DIR}/bin`,
  ]);
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "cp",
      tgz,
      `${container.id}:${IN_CONTAINER_DIR}/docker-cli.tgz`,
    ],
    { quiet: true },
  );
  await execRoot(channel, ctx, container.id, [
    "sh",
    "-c",
    `tar xzf ${IN_CONTAINER_DIR}/docker-cli.tgz -C ${IN_CONTAINER_DIR}/bin --strip-components=1 docker/docker ` +
      `&& chmod +x ${IN_CONTAINER_DIR}/bin/docker && rm ${IN_CONTAINER_DIR}/docker-cli.tgz`,
  ]);
  channel.appendLine(
    "docker CLI pushed into the container (host docker via the bind-mounted socket)",
  );
}

// ---------------------------------------------------------------------------
// the daemon (the desktop one: server-main.js via bin/code-server)

/** docker exec as ROOT — the daemon-install phase needs it: images with a
 *  non-root USER (vscode, node — the clone-in-volume base image) make every
 *  docker exec default to that user, and the install's chown then dies with
 *  "Operation not permitted" (seen live). The daemon still STARTS as the
 *  remote user; only the install needs root. */
function execRoot(channel, ctx, id, args, opts = {}) {
  return run(
    channel,
    "docker",
    [...dockerArgs(ctx), "exec", "--user", "root", id, ...args],
    opts,
  );
}

/** The container's configured user; empty in docker inspect means root. */
async function containerUser(channel, container, ctx) {
  const out = await run(
    channel,
    "docker",
    [...dockerArgs(ctx), "inspect", "-f", "{{.Config.User}}", container.id],
    { quiet: true },
  );
  return out.trim() || "root";
}

/** Fresh connection token per daemon launch: generated on the host, lives
 *  only for the daemon's lifetime. When the daemon is already running, its
 *  token is read back — a reconnect must get the EXISTING token. */
function generateToken() {
  return crypto.randomBytes(24).toString("hex");
}

// --- tiny protocol client (the workbench's own dance: HTTP upgrade, then a
// --- 13-byte-framed auth control message) --------------------------------

function protocolFrame(type, id, ack, data) {
  const h = Buffer.alloc(13);
  h.writeUInt8(type, 0);
  h.writeUInt32BE(id, 1);
  h.writeUInt32BE(ack, 5);
  h.writeUInt32BE(data.length, 9);
  return Buffer.concat([h, data]);
}

/**
 * Is the daemon on ip:port the one this token belongs to? Speaks the
 * workbench's handshake: upgrade, then {type:"auth"} — and looks at what
 * comes back. A WRONG process holding the port (an orphan from an older
 * install, with an older token) answers {type:"error"} — a pidfile alone
 * cannot tell the difference (verified live: an orphaned daemon caused
 * "auth mismatch" for every window while the pidfile said "running").
 */
function checkDaemon(channel, ip, port, token, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const done = (ok, why) => {
      clearTimeout(timer);
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      if (!ok && why) {
        channel.appendLine(`daemon check failed: ${why}`);
      }
      resolve(ok);
    };
    const s = net.connect({ host: ip, port }, () => {
      s.write(
        "GET ws://localhost/?reconnectionToken=check&reconnection=false&skipWebSocketFrames=true HTTP/1.1\r\n" +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n\r\n`,
      );
    });
    s.setTimeout(timeoutMs, () => done(false, "timeout"));
    s.on("error", (e) => done(false, e.code || e.message));
    let buf = Buffer.alloc(0);
    let stage = 0;
    const timer = setTimeout(() => done(false, "handshake timeout"), timeoutMs);
    s.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) {
          return;
        }
        stage = 1;
        buf = buf.subarray(i + 4);
        s.write(
          protocolFrame(
            2,
            0,
            0,
            Buffer.from(
              JSON.stringify({
                type: "auth",
                auth: token,
                data: crypto.randomBytes(16).toString("base64"),
              }),
            ),
          ),
        );
      }
      for (;;) {
        if (buf.length < 13) {
          return;
        }
        const len = buf.readUInt32BE(9);
        if (buf.length < 13 + len) {
          return;
        }
        const data = buf.subarray(13, 13 + len);
        buf = buf.subarray(13 + len);
        try {
          const msg = JSON.parse(data.toString("utf8"));
          if (msg.type === "error") {
            return done(false, msg.reason || "server error");
          }
          if (msg.type === "sign" || msg.type === "ok") {
            return done(true);
          }
        } catch {
          // not a control message — the daemon is talking protocol: good enough
          return done(true);
        }
      }
    });
  });
}

/** Kill our supervisor and anything from OUR install inside the container
 *  (an orphaned daemon holding the port with a stale token). */
async function killDaemon(channel, container, ctx) {
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "exec",
      container.id,
      "sh",
      "-c",
      `[ ! -f ${IN_CONTAINER_DIR}/serve.pid ] || kill "$(cat ${IN_CONTAINER_DIR}/serve.pid)" 2>/dev/null;` +
        ` pkill -f '${VSCODE_SERVER_DIR}/[b]in' 2>/dev/null; rm -f ${IN_CONTAINER_DIR}/serve.pid; true`,
    ],
    { quiet: true },
  );
}

/** Wait (from the host) until the daemon accepts TCP connections. */
async function waitForPort(channel, ip, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host: ip, port }, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
      s.setTimeout(2000, () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `daemon never answered on ${ip}:${port} after ${Math.round(timeoutMs / 1000)}s ` +
          `(see ${IN_CONTAINER_DIR}/serve-web.log in the container)`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Desktop parity inside the container window: on desktop the Dev
 * Containers extension is present there (its commands — Rebuild, Reopen
 * Locally — gate on remoteName === 'dev-container'). In a browser it can
 * only run on the container's own extension host, so it must live in the
 * daemon's extensions dir. We push the already-flipped copy the host has.
 */
async function installMsExtension(channel, container, ctx) {
  const src = process.env.REMOTE_DEV_MS_EXTENSION_DIR;
  if (!src || !fs.existsSync(src)) {
    channel.appendLine(
      "MS extension dir unset — the container window will lack Dev Containers commands",
    );
    return;
  }
  const folder = path.basename(src);
  await execRoot(channel, ctx, container.id, [
    "mkdir",
    "-p",
    `${VSCODE_SERVER_DIR}/extensions`,
  ]);
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "cp",
      src,
      `${container.id}:${VSCODE_SERVER_DIR}/extensions/`,
    ],
    { quiet: true },
  );
  // registry entry: clone the host's, rewrite the location to the
  // container path; minimal entry as fallback
  const hostRegistry = path.join(path.dirname(src), "extensions.json");
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(hostRegistry, "utf8"))
      .filter(
        (e) =>
          e.identifier &&
          e.identifier.id === "ms-vscode-remote.remote-containers",
      )
      .map((e) => ({
        ...e,
        location: {
          $mid: 1,
          path: `${VSCODE_SERVER_DIR}/extensions/${folder}`,
          scheme: "file",
        },
      }));
  } catch {
    /* fall through to the minimal entry */
  }
  if (!entries.length) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(src, "package.json"), "utf8"),
    );
    entries = [
      {
        identifier: { id: "ms-vscode-remote.remote-containers" },
        version: pkg.version,
        location: {
          $mid: 1,
          path: `${VSCODE_SERVER_DIR}/extensions/${folder}`,
          scheme: "file",
        },
        relativeLocation: folder,
      },
    ];
  }
  const tmp = path.join(os.tmpdir(), `rdv-extreg-${container.id}.json`);
  fs.writeFileSync(tmp, JSON.stringify(entries));
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "cp",
      tmp,
      `${container.id}:${VSCODE_SERVER_DIR}/extensions/extensions.json`,
    ],
    { quiet: true },
  );
  fs.unlinkSync(tmp);
  channel.appendLine("Dev Containers extension pre-installed in the daemon");
}

/**
 * Ensure the server daemon runs inside the container. Mirrors the desktop
 * install: flavor server-linux-* (non-web) in bin/<commit>, launched as
 * bin/code-server --start-server with a connection-token-file. Documented
 * deltas from desktop: --host is the container IP (desktop: 127.0.0.1 + a
 * local relay; our bridge connects from the host), fixed port (desktop:
 * 0 + scrape), no --use-host-proxy.
 *
 * Returns { token, commit, user, extensions } — token is the one the
 * daemon actually runs with (read back when it was already running — a
 * reconnect must not mint a new one); the rest feeds
 * installCustomizedExtensions, which runs after waitForPort.
 */
async function ensureDaemon(channel, container, wsPath, ctx, confSource) {
  const readConf =
    confSource || ((ch) => readDevcontainerConfig(ch, wsPath, ctx));
  // Alive = our supervisor's pid, via its pidfile. (A pgrep for a marker
  // string self-matches the checking shell — verified live.)
  const alive = await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "exec",
      container.id,
      "sh",
      "-c",
      `test -f ${IN_CONTAINER_DIR}/serve.pid && kill -0 "$(cat ${IN_CONTAINER_DIR}/serve.pid)" 2>/dev/null && echo yes || echo no`,
    ],
    { quiet: true },
  );
  if (alive.trim() === "yes") {
    const token = (
      await run(
        channel,
        "docker",
        [
          ...dockerArgs(ctx),
          "exec",
          container.id,
          "cat",
          `${IN_CONTAINER_DIR}/tkn`,
        ],
        { quiet: true },
      )
    ).trim();
    // A pidfile proves nothing: an ORPHAN (older install, older token)
    // can hold the port while our supervisor keeps dying on EADDRINUSE.
    // Verify the daemon actually honors the token before reusing it.
    if (await checkDaemon(channel, container.ip, SERVE_PORT, token)) {
      channel.appendLine("daemon already running in container — reusing it");
      // still gather what the post-start extension install needs: a
      // changed devcontainer.json gets its new extensions on reconnect
      const commit = (
        await run(
          channel,
          "docker",
          [
            ...dockerArgs(ctx),
            "exec",
            container.id,
            "sh",
            "-c",
            `ls ${VSCODE_SERVER_DIR}/bin | head -1`,
          ],
          { quiet: true },
        )
      ).trim();
      const user = await containerUser(channel, container, ctx);
      const extensions = customizedExtensions(await readConf(channel));
      return { token, commit, user, extensions };
    }
    channel.appendLine(
      "the port answers with a WRONG daemon (orphan) — killing and reinstalling",
    );
    await killDaemon(channel, container, ctx);
  }

  const token = generateToken();
  const plat = await containerPlatform(channel, container, ctx);
  const { flavor, probedCommit } = await pickServerFlavor(channel, plat);
  const commit = COMMIT || probedCommit;

  channel.appendLine(
    `installing server daemon (${flavor} @ ${commit.slice(0, 8)})`,
  );
  await pushArtifact(
    channel,
    container,
    ctx,
    flavor,
    commit,
    `${VSCODE_SERVER_DIR}/bin/${commit}`,
  );

  // The extensions the devcontainer.json asks for. Desktop passes them to
  // the server LAUNCH — but the agent then installs them synchronously at
  // startup, and a slow gallery stalls the whole extension host (verified:
  // the agent hangs on "Installing extensions…", remote settings never
  // come up). Installed after waitForPort instead (see
  // installCustomizedExtensions), before the window connects.
  const extensions = customizedExtensions(await readConf(channel));
  if (extensions.length) {
    channel.appendLine(
      `customized extensions (async install): ${extensions.join(", ")}`,
    );
  }

  // Token file + machine settings (the container workbench shows up PINK,
  // titled with the container's own name) — written from the host.
  const tokenFile = path.join(os.tmpdir(), `rdv-tkn-${container.id}`);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "cp",
      tokenFile,
      `${container.id}:${IN_CONTAINER_DIR}.tkn-tmp`,
    ],
    { quiet: true },
  );
  fs.unlinkSync(tokenFile);

  const machineSettings = JSON.stringify(
    {
      "workbench.colorCustomizations": {
        "statusBar.background": "#C2185B",
        "statusBar.foreground": "#FFFFFF",
        "statusBarItem.remoteBackground": "#7B1FA2",
        "statusBarItem.remoteForeground": "#FFFFFF",
        "titleBar.activeBackground": "#880E4F",
        "titleBar.activeForeground": "#FFFFFF",
        // the Command Center (the search bar in the title bar): its default
        // colors DERIVE from the titleBar's, and against our dark pink the
        // hover state computed an ugly grey-on-pink (raven). Pin it:
        // readable white text, and active == normal so hover changes nothing.
        "commandCenter.background": "#A31545",
        "commandCenter.foreground": "#FFFFFF",
        "commandCenter.border": "#FFFFFF55",
        "commandCenter.activeBackground": "#A31545",
        "commandCenter.activeForeground": "#FFFFFF",
        "commandCenter.activeBorder": "#FFFFFF55",
        // …and the NEWER agent-status pill (what actually renders in recent
        // builds): painted by agentStatusIndicator.background, which
        // DEFAULTS TO WHITE — white box + inherited white text, raven's
        // "blanc sur blanc" (proven by computed-style dump).
        "agentStatusIndicator.background": "#A31545",
      },
      "window.title": `🐳 \${activeEditorShort}\${separator}\${rootName}\${separator} ${container.name}`,
    },
    null,
    2,
  );
  const settingsFile = path.join(
    os.tmpdir(),
    `rdv-settings-${container.id}.json`,
  );
  fs.writeFileSync(settingsFile, machineSettings, { mode: 0o600 });
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "cp",
      settingsFile,
      `${container.id}:${IN_CONTAINER_DIR}.settings-tmp`,
    ],
    { quiet: true },
  );
  fs.unlinkSync(settingsFile);

  // The daemon runs as the CONTAINER'S OWN USER (never root unless the
  // container itself is root).
  const user = await containerUser(channel, container, ctx);

  // Desktop parity in the container window: the Dev Containers extension
  // lives in the daemon too (done before the chown below so it owns it).
  await installMsExtension(channel, container, ctx);

  // Host docker for the container: push a static docker CLI. The socket is
  // bind-mounted at the default path (buildContainer) — no DOCKER_HOST, no
  // relay. A container created BEFORE the mount existed misses it: say so
  // (the explorer stays empty until the next rebuild), never fake it.
  if (fs.existsSync(DOCKER_SOCK)) {
    await pushDockerCli(channel, container, ctx);
    const hasSock = await run(
      channel,
      "docker",
      [
        ...dockerArgs(ctx),
        "exec",
        container.id,
        "sh",
        "-c",
        "test -S /var/run/docker.sock && echo yes || echo no",
      ],
      { quiet: true },
    );
    if (!hasSock.trim().endsWith("yes")) {
      channel.appendLine(
        "no /var/run/docker.sock in this container (created before the " +
          "socket mount) — Rebuild Container to get host docker inside",
      );
    }
  }

  const supervisor = [
    `mkdir -p ${VSCODE_SERVER_DIR}/data/Machine`,
    `mv ${IN_CONTAINER_DIR}.tkn-tmp ${IN_CONTAINER_DIR}/tkn && chmod 600 ${IN_CONTAINER_DIR}/tkn`,
    `mv ${IN_CONTAINER_DIR}.settings-tmp ${VSCODE_SERVER_DIR}/data/Machine/settings.json`,
    `cat > ${IN_CONTAINER_DIR}/serve.sh <<'EOF'`,
    `#!/bin/sh`,
    `# remote-dev daemon supervisor — restart loop`,
    `echo $$ > ${IN_CONTAINER_DIR}/serve.pid`,
    `# Bind the container's first non-localhost IP, recomputed on every run:`,
    `# the address baked in at spawn time may be stale after a restart.`,
    `IP="$(ip -4 addr show 2>/dev/null | awk '$1=="inet" && $2 !~ /^127\\./ {sub(/\\/.*/, "", $2); print $2; exit}')"`,
    `[ -n "$IP" ] || IP="${container.ip}"   # fallback: IP seen by docker inspect`,
    `export PATH="${IN_CONTAINER_DIR}/bin:$PATH"`,
    `# no DOCKER_HOST: the host's socket is bind-mounted at the default path`,
    `while true; do`,
    `  ${VSCODE_SERVER_DIR}/bin/${commit}/bin/code-server \\`,
    `    --start-server --accept-server-license-terms --force-disable-user-env \\`,
    `    --host "$IP" --port ${SERVE_PORT} \\`,
    `    --connection-token-file ${IN_CONTAINER_DIR}/tkn \\`,
    `    --server-data-dir ${VSCODE_SERVER_DIR} \\`,
    `    --disable-websocket-compression \\`,
    `    >> ${IN_CONTAINER_DIR}/serve-web.log 2>&1`,
    `  sleep 5`,
    `done`,
    `EOF`,
    `chmod +x ${IN_CONTAINER_DIR}/serve.sh`,
    `chown -R ${user} ${IN_CONTAINER_DIR}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
  await execRoot(channel, ctx, container.id, ["sh", "-c", supervisor], {
    quiet: true,
  });
  // start the supervisor AS the container user
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "exec",
      "--user",
      user,
      container.id,
      "sh",
      "-c",
      `nohup ${IN_CONTAINER_DIR}/serve.sh >/dev/null 2>&1 &`,
    ],
    { quiet: true },
  );
  channel.appendLine(
    `daemon supervisor started in ${container.name} (user ${user})`,
  );
  return { token, commit, user, extensions };
}

/**
 * The devcontainer.json's customized extensions, installed with the
 * daemon's own code-server. Timing is everything:
 *  - NOT at launch (a slow gallery stalls the agent's startup, killing
 *    remote settings — verified),
 *  - NOT concurrent with the daemon's first start either (both write the
 *    server data dir; the daemon then never answers in time — verified),
 *  - so: after waitForPort (the daemon is up), before the resolve returns
 *    (the window connects only once the extensions dir is settled —
 *    concurrent writes race the extension host's first scan, verified).
 * A gallery failure degrades the window (missing extensions); it must not
 * kill the whole resolve — logged loudly, not thrown.
 */
async function installCustomizedExtensions(channel, container, daemon, ctx) {
  const { commit, user, extensions } = daemon;
  if (!extensions || !extensions.length || !commit) {
    return;
  }
  const hash = crypto
    .createHash("sha256")
    .update(extensions.join(","))
    .digest("hex")
    .slice(0, 12);
  const marker = `${IN_CONTAINER_DIR}/.ext-${hash}`;
  const have = await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "exec",
      container.id,
      "sh",
      "-c",
      `test -f ${marker} && echo yes || echo no`,
    ],
    { quiet: true },
  );
  if (have.trim() === "yes") {
    return;
  }
  channel.appendLine("installing customized extensions (post-start, sync)");
  const installs = extensions
    .map(
      (e) =>
        `${VSCODE_SERVER_DIR}/bin/${commit}/bin/code-server --install-extension '${e}' --server-data-dir ${VSCODE_SERVER_DIR} --force`,
    )
    .join(" && ");
  try {
    await run(
      channel,
      "docker",
      [
        ...dockerArgs(ctx),
        "exec",
        "--user",
        user,
        container.id,
        "sh",
        "-c",
        `${installs} && touch ${marker}`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    channel.appendLine(
      `customized extensions install failed (degraded window, continuing): ${(e && e.message) || e}`,
    );
  }
}

// ---------------------------------------------------------------------------
// host-side port listeners — raw TCP/UDP, bound on the workbench's IP
// (and loopback) so any client that reaches the workbench reaches them

const forwardListeners = new Map(); // `${ip}:${port}` → true

/** True when `ip` is one of THIS machine's own addresses — the "container"
 *  shares our network namespace (the e2e's fake container; a host-networked
 *  container). Its 127.0.0.1 is our 127.0.0.1, and our front binds are
 *  visible from inside it. */
function isSharedNetns(ip) {
  return Object.values(os.networkInterfaces())
    .flat()
    .some((x) => x && x.address === ip);
}

/**
 * A dev server bound to 127.0.0.1 INSIDE the container is unreachable from
 * the host. Relay the port from inside: <container-ip>:port →
 * 127.0.0.1:port, using the daemon's own node. The relay MUST bind the
 * container's own IP, not 0.0.0.0: a 0.0.0.0 bind collides with the very
 * 127.0.0.1 server it relays (EADDRINUSE) and the relay dies silently.
 * No-op when the bind fails (the server is externally bound — nothing to
 * relay).
 *
 * The relay is a GATE, not a one-shot pipe: it accepts only while the
 * localhost server lives. Server dead → the gate closes (the front bind's
 * watchdog gets refused — death propagates at watchdog speed); server
 * back → the gate RE-OPENS (the bind's heal re-binds — no suicide, no
 * respawn problem, and no restart-length tradeoff: a 30 s dev-server
 * compile survives). A duplicate gate spawned by a re-forward exits on
 * its failed listen; the older one exits when its re-open collides.
 */
async function ensureInContainerRelay(channel, container, ctx, port, expectServer) {
  // ANTI-LOOP: in a shared netns, 127.0.0.1:port can be one of OUR OWN front
  // binds. A relay into it feeds the front back into itself (relay →
  // 127.0.0.1:port → front → relay → …): a connection cascade that exhausts
  // ephemeral ports (EADDRNOTAVAIL — seen live in the e2e: ~75 ambiguous
  // watchdog probes per run, and the plumbing assertion flaked on its own
  // connect). The relay is meaningless in that situation anyway — whatever
  // is on 127.0.0.1:port, the host reaches it directly. Skip it.
  if (isSharedNetns(container.ip) && frontPortsUsed.has(port)) {
    channel.appendLine(
      `relay ${container.ip}:${port}: skipped (shared netns — :${port} is our own front bind, a relay into it loops)`,
    );
    return;
  }
  const script =
    'const net=require("net"),os=require("os");' +
    "const a=Object.values(os.networkInterfaces()).flat()" +
    '.find((x)=>x&&x.family==="IPv4"&&!x.internal);if(!a)process.exit(0);' +
    // DUAL STACK: the localhost server can be IPv4 (127.0.0.1) or
    // IPv6-only (tcp6 `::` — seen live: every IPv4 probe then fails and
    // the watchdog kills the bind while the server runs, raven's 6667).
    // Clients and probes both try v4, then v6.
    'function up(c){' +
    `const u4=net.connect(${port},"127.0.0.1");` +
    'u4.once("connect",()=>{c.pipe(u4).pipe(c);c.on("error",()=>u4.destroy());u4.on("error",()=>c.destroy())});' +
    'u4.once("error",()=>{' +
    `const u6=net.connect(${port},"::1");` +
    'u6.once("connect",()=>{c.pipe(u6).pipe(c);c.on("error",()=>u6.destroy());u6.on("error",()=>c.destroy())});' +
    'u6.once("error",()=>c.destroy())})}' +
    // expectServer=1 (a /forward for a detected candidate): the server is
    // supposed to answer — a relay that never sees it is a ZOMBIE (it won
    // the bind race against the server's death — seen live: it squatted the
    // port for 40 s while the front watchdog probed it happily). 3 strikes
    // and out. expectServer=0 (config forwardPorts): the server may start
    // at ANY time — the relay waits for it forever, like desktop's rows.
    `const EXPECT=${expectServer ? 1 : 0};` +
    'let srv=null,dead=0,closed=true;' +
    'function open(){' +
    'srv=net.createServer(up);' +
    'srv.on("error",()=>process.exit(0));' +
    'srv.on("close",()=>{closed=true});' +
    `srv.listen(${port},a.address,()=>{closed=false})}` +
    'open();' +
    'function alive(){dead=0;if(closed)open()}' +
    'function gone(){if(EXPECT&&++dead>=3&&!closed)srv.close()}' +
    'setInterval(()=>{' +
    `const p=net.connect(${port},"127.0.0.1");` +
    'p.once("connect",()=>{p.end();alive()});' +
    'p.once("error",()=>{' +
    `const p6=net.connect(${port},"::1");` +
    'p6.once("connect",()=>{p6.end();alive()});' +
    'p6.once("error",()=>gone())})' +
    '},2000).unref()';
  channel.appendLine(
    `relay ${container.ip}:${port} → localhost in the container (dual-stack gate, expectServer=${expectServer ? 1 : 0})`,
  );
  await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "exec",
      container.id,
      "sh",
      "-c",
      `NODE_BIN="$(ls ${VSCODE_SERVER_DIR}/bin/*/node 2>/dev/null | head -1)";` +
        `[ -n "$NODE_BIN" ] && nohup "$NODE_BIN" -e '${script}' >/dev/null 2>&1 &`,
    ],
    { quiet: true },
  );
}

function ensureForward(channel, ip, port) {
  const key = `${ip}:${port}`;
  if (forwardListeners.has(key)) {
    return;
  }
  if (!PRIVATE_IP.test(ip) || !(port > 0 && port < 65536)) {
    throw new Error(`refusing to forward ${key} (private ranges only)`);
  }
  forwardListeners.set(key, true);
  // the TCP listener is the allocator's job (ensureForwardPort — next-free-port);
  // here: UDP, best effort (bound wider so the container's replies come back)
  const dgram = require("dgram");
  const sock = dgram.createSocket("udp4");
  let client = null;
  sock.on("message", (msg, rinfo) => {
    if (rinfo.address === ip && client) {
      sock.send(msg, client.port, client.address); // container → last host client
    } else {
      client = rinfo; // host client → container
      sock.send(msg, port, ip);
    }
  });
  sock.on("error", (e) =>
    channel.appendLine(`forward ${key}: udp failed (${e.code || e.message})`),
  );
  sock.bind(port, () => channel.appendLine(`forward ${key} → :${port} (udp)`));
}

// ---------------------------------------------------------------------------
// same-port front binding — THE canonical forwarded address.
// Desktop forwards container port N as localhost:N on the client machine.
// Our client machine is a browser anywhere on earth — nothing can listen
// there. The reachable equivalent of localhost:N is <the workbench's IP>:N,
// SAME port number: one rule, every port, works from any device the front
// door is reachable from. OAuth callbacks (wrangler login, gcloud auth)
// then only need localhost → the workbench's address, port kept.
//
// MULTIPLE CONTAINERS ON THE SAME PORT: only one listener per port can
// exist — like desktop, the allocator assigns the NEXT FREE PORT (N+1,
// N+2…) and the Ports row shows it. Deterministic per (container,port):
// re-forwarding the same container port keeps its assigned port.

const PRIVATE_IP =
  /^(?:10\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/;

// The IP the workbench is served on (run.sh exports the resolved HOST_IP).
// Forwards bind there — and NEVER wider: no env, loopback only.
const FRONT_IP =
  process.env.REMOTE_DEV_FORWARD_IP || process.env.REMOTE_DEV_HOST_IP || "";
const FRONT_LOOPBACK = /^(127\.|::1$)/.test(FRONT_IP);

// ONE record per (container ip, container port): the whole lifecycle of a
// forward — what the workbench asked (want), what it got (front), the live
// servers, the owning container, the heal budget. This used to be SIX maps
// (bindings, servers, used ports, containers, condemned keys, heal
// attempts) — the same record smeared across six indexes, where every
// transition had to update all six in the right order and a missed one
// handed out a corpse port (seen live). frontPortsUsed stays a flat set:
// the allocator's collision check wants O(1), not a record scan.
//
// record: { state, front, servers, container, want, attempts, condemned }
//   state: "bound"   — servers up (or believed up), front assigned
//          "closing" — the watchdog condemned it; close() is in flight and
//                      the unbind finalizes (and maybe heals). A re-forward
//                      in this window must re-bind fresh, never the corpse.
//          "dead"    — no live servers (front undefined, or false = the
//                      cached "nothing bindable nearby" answer)
const forwards = new Map(); // `${ip}:${port}` → record
const frontPortsUsed = new Set(); // assigned front ports, all containers

// --- persistence: the Ports row keeps its address across restarts ---------
// { "forwards": [ { "containerId", "port", "front" } ] } — keyed by
// container ID, never by IP: a recreate (new IP) finds its fronts again.
// The file is a MEMORY, not a snapshot of the live binds: a bind adds or
// updates its entry, nothing else clears it — that is how a stop → start
// hands the row its old address back.
const FORWARDS_FILE =
  process.env.REMOTE_DEV_FORWARDS_FILE ||
  path.join(__dirname, "..", "runtime", "remote-dev-forwards.json");
const persisted = new Map(); // `${containerId}:${port}` → front
let persistedMtime = 0; // the file version we hold (our own writes included)

function loadPersisted() {
  let st = null;
  try {
    st = fs.statSync(FORWARDS_FILE);
  } catch {
    return; // never written yet
  }
  if (st.mtimeMs === persistedMtime) {
    return; // unchanged since our last read/write
  }
  persistedMtime = st.mtimeMs;
  try {
    const doc = JSON.parse(fs.readFileSync(FORWARDS_FILE, "utf8"));
    persisted.clear();
    for (const f of (doc && doc.forwards) || []) {
      if (f && f.containerId && f.port > 0 && f.front > 0) {
        persisted.set(`${f.containerId}:${f.port}`, f.front);
      }
    }
  } catch {
    /* a half-written or hand-edited file is ignored, never fatal */
  }
}
loadPersisted(); // boot: remember what the last run assigned

let persistTimer = null;
/** Debounced write (~500 ms): a flap (watchdog → heal → re-bind) is ONE
 *  write, not one per state. Reloads first — a hand edit made since our
 *  last read is merged into the memory, never clobbered. */
function persistForwards() {
  if (persistTimer) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    loadPersisted(); // pick up a hand edit before serializing over it
    for (const [key, rec] of forwards) {
      if (
        rec.state === "bound" &&
        typeof rec.front === "number" &&
        rec.container &&
        rec.container.id
      ) {
        persisted.set(
          `${rec.container.id}:${key.slice(key.indexOf(":") + 1)}`,
          rec.front,
        );
      }
    }
    const list = [...persisted].map(([k, front]) => {
      const i = k.indexOf(":");
      return {
        containerId: k.slice(0, i),
        port: Number(k.slice(i + 1)),
        front,
      };
    });
    try {
      fs.mkdirSync(path.dirname(FORWARDS_FILE), { recursive: true });
      const tmp = `${FORWARDS_FILE}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ forwards: list }, null, 2)}\n`);
      fs.renameSync(tmp, FORWARDS_FILE); // atomic: readers never see a half file
      persistedMtime = fs.statSync(FORWARDS_FILE).mtimeMs;
    } catch (e) {
      channel.appendLine(
        `forwards persistence failed (non-fatal): ${(e && e.message) || e}`,
      );
    }
  }, 500);
  persistTimer.unref();
}

function tryListen(ip, port, host, frontPort, log, key) {
  return new Promise((resolve) => {
    const tag = `forward ${ip}:${port} (front ${host}:${frontPort})`;
    const socks = new Set(); // live client sockets, for the force-drain
    const srv = net.createServer((client) => {
      socks.add(client);
      client.on("close", () => socks.delete(client));
      const up = net.connect({ host: ip, port });
      client.pipe(up).pipe(client);
      client.on("error", () => up.destroy());
      up.on("error", (e) => {
        // raven's "PAF il disparaît dès que je clique" — this path was
        // SILENT: name it, or a dead upstream looks like a vanished row
        log(`${tag}: upstream connect failed (${e.code || e.message}) — client dropped`);
        client.destroy();
      });
    });
    srv.once("error", () => resolve(null));
    srv.listen(frontPort, host, () => {
      // upstream watchdog: when the container's server dies, free the
      // front port (and the candidate dies with it — live status)
      // upstream watchdog: when the container's server dies, free the
      // front port (and the candidate dies with it — live status). 2 s
      // probes: death is detected in ~6 s, not 15 (raven: "15s trop long").
      // Only strike AFTER the upstream was seen alive once: a pre-forwarded
      // port whose server has not started yet is NOT dead — desktop keeps
      // such rows until a server appears (faster watchdog broke that).
      // Only ECONNREFUSED counts as a strike: a refusal is a dead server.
      // EADDRNOTAVAIL/EHOSTUNREACH/ENETUNREACH/timeouts are AMBIGUOUS
      // (interface renumbering, a docker network churning, a frozen host —
      // seen live in the e2e and on raven's OrbStack): the reconciler's
      // re-point fixes those, no condemnation.
      let dead = 0;
      let seenAlive = false;
      // seed it AT BIND TIME, racelessly: a normal forward (the candidate
      // was just detected, so the server answers now) starts seenAlive=true
      // and deaths are tracked; a pre-forward (config forwardPorts, no
      // server yet) starts false and is never condemned (desktop parity).
      // Without the seed, a server killed before the FIRST 2 s probe would
      // keep seenAlive=false forever and never die (seen in the e2e).
      const seed = net.connect(port, ip);
      seed.once("connect", () => {
        seenAlive = true;
        seed.end();
      });
      seed.once("error", (e) => {
        log(`${tag}: seed failed (${e.code || e.message})`);
      });
      const AMBIGUOUS = /^(EADDRNOTAVAIL|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)$/;
      const dog = setInterval(() => {
        const p = net.connect(port, ip);
        p.setTimeout(4000, () => p.destroy(new Error("ETIMEDOUT")));
        p.once("connect", () => {
          seenAlive = true;
          dead = 0;
          p.end();
        });
        p.once("error", (e) => {
          if (AMBIGUOUS.test(e.code || "")) {
            log(`${tag}: probe ambiguous (${e.code || e.message})`);
            return; // not a death signal — see the reconciler's re-point
          }
          log(`${tag}: probe strike (${e.code || e.message}) dead=${dead + 1}`);
          if (seenAlive && ++dead >= 3) {
            log(`${tag}: upstream dead ×3 (ECONNREFUSED) — closing the bind (watchdog)`);
            clearInterval(dog);
            condemn(key);
            // FORCE-DRAIN: a bare close() waits for lingering connections —
            // a long-lived client (sleep/wake TCP resume) then MASKS the
            // death: the port "works while connected, breaks on
            // disconnect" (raven). Die now, consistently.
            for (const s of socks) {
              s.destroy();
            }
            srv.close();
          }
        });
      }, 2000);
      dog.unref();
      srv.on("close", () => clearInterval(dog));
      resolve(srv);
    });
  });
}

/** The watchdog's mark: the bind died of a dead upstream, NOT of a user
 *  action — the unbind then re-probes before giving up (a host sleep looks
 *  exactly like a dead server until the wake). */
function condemn(key) {
  const rec = forwards.get(key);
  if (rec) {
    rec.condemned = true;
    rec.state = "closing";
  }
}

/** One connect probe with a hard timeout (a frozen network must not hang
 *  the heal — the whole point is distinguishing freeze from death). */
function probeOnce(ip, port, ms = 1500) {
  return new Promise((resolve) => {
    const p = net.connect({ host: ip, port });
    const done = (ok) => {
      p.destroy();
      resolve(ok);
    };
    p.once("connect", () => done(true));
    p.once("error", () => done(false));
    p.setTimeout(ms, () => done(false));
  });
}

/** The honest liveness check for a dead row: probe 127.0.0.1:port from
 *  INSIDE the container — sees both 127.0.0.1-only and 0.0.0.0 servers,
 *  and squats NOTHING (re-raising the relay to probe through it steals
 *  ip:port from a 0.0.0.0 server trying to restart — seen live: the
 *  freeze step's re-listen died EADDRINUSE; nginx would too). */
async function probeInContainer(channel, container, ctx, port) {
  const out = await run(
    channel,
    "docker",
    [
      ...dockerArgs(ctx),
      "exec",
      container.id,
      "sh",
      "-c",
      `NODE_BIN="$(ls ${VSCODE_SERVER_DIR}/bin/*/node 2>/dev/null | head -1)";` +
        `[ -n "$NODE_BIN" ] && "$NODE_BIN" -e '` +
        `const s=require("net").connect(${port},"127.0.0.1");` +
        's.once("connect",()=>process.exit(0));' +
        's.once("error",()=>process.exit(1));' +
        `setTimeout(()=>process.exit(1),1000)' && echo yes || echo no`,
    ],
    { quiet: true },
  ).catch(() => "no");
  return out.trim() === "yes";
}

/** After a watchdog condemnation: freeze or death? Re-probe (with the
 *  container's CURRENT ip — sleep/wake and recreates can move it). Alive:
 *  re-point/re-bind, the Ports row never notices. Dead: stay dead — the
 *  workbench re-forwards when the finder re-detects the server. */
async function heal(channel, key, ip, port, frontPort, container) {
  const rec = forwards.get(key);
  const n = ((rec && rec.attempts) || 0) + 1;
  if (rec) {
    rec.attempts = n;
  }
  if (n > 3) {
    channel.appendLine(`forward ${key}: gave up healing after 3 tries`);
    return;
  }
  let targetIp = ip;
  if (container && container.id) {
    const out = await run(
      channel,
      "docker",
      [
        ...dockerArgs(container.ctx),
        "inspect",
        "-f",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
        container.id,
      ],
      { quiet: true },
    ).catch(() => "");
    const current = out
      .trim()
      .split(/\s+/)
      .find((x) => PRIVATE_IP.test(x));
    if (current && current !== ip) {
      channel.appendLine(
        `forward ${key}: the container moved ${ip} → ${current} ` +
          "(sleep/wake or recreate) — re-pointing",
      );
      targetIp = current;
    }
  }
  // 6 probes (1.5 s apart, 1.5 s timeout) ≈ an 18 s window: a host sleep
  // that froze the network still heals even with the faster (~6 s)
  // condemnation, while a really dead server is confirmed quickly enough.
  for (let i = 0; i < 6; i++) {
    if (await probeOnce(targetIp, port)) {
      channel.appendLine(
        `forward ${key}: the condemnation was a network freeze (host ` +
          "sleep?), not a dead server — re-binding, the row never notices",
      );
      if (rec) {
        rec.attempts = 0;
      }
      const moved = { ...(container || {}), ip: targetIp };
      ensureForward(channel, targetIp, port);
      await ensureForwardPort(
        channel,
        targetIp,
        port,
        frontPort,
        moved.id ? moved : null,
      );
      if (moved.id) {
        // after the allocation: the relay's anti-loop guard reads it
        await ensureInContainerRelay(channel, moved, moved.ctx, port, true);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  channel.appendLine(
    `forward ${key}: upstream is really dead — the bind stays closed (live status)`,
  );
}

async function ensureForwardPort(channel, ip, port, want = 0, container = null) {
  const key = `${ip}:${port}`;
  let rec = forwards.get(key);
  if (!rec) {
    rec = {
      state: "dead",
      front: undefined,
      servers: [],
      container: null,
      want: 0,
      attempts: 0,
      condemned: false,
    };
    forwards.set(key, rec);
  }
  if (container && container.id) {
    rec.container = container;
  }
  rec.want = want;
  const prev = rec.front;
  if (prev !== undefined) {
    // stale-cache guard: the watchdog close()s a dying bind, but 'close'
    // (and the record cleanup) only fires once lingering connections have
    // drained — server.listening flips false the moment close() is CALLED.
    // A re-forward landing in that window must NOT get the dead assignment
    // back (seen in e2e: the rebind raced the drain and was handed the
    // corpse port).
    const dying =
      prev !== false &&
      rec.servers.length > 0 &&
      rec.servers.every((s) => !s.listening);
    if (dying) {
      frontPortsUsed.delete(prev);
      rec.front = undefined;
      rec.servers = [];
      rec.state = "dead";
      channel.appendLine(
        `forward ${key}: cached front :${prev} was mid-close — re-binding fresh`,
      );
      persistForwards();
    } else if (!(want && want !== port) || prev === want) {
      // only an EXPLICIT edit (a different port than the container's) is a
      // re-bind request; an auto re-forward (soft same-port preference) is
      // idempotent — it must NOT churn a healthy bind
      return prev;
    } else {
      // the user edited the local port (desktop's "edit forwarded address"):
      // close the old bind, re-bind exactly what they asked. A cached
      // failure (false) is dropped — the user may have freed the port.
      for (const s of rec.servers) {
        s.close();
      }
      if (prev !== false) {
        frontPortsUsed.delete(prev);
      }
      rec.front = undefined;
      rec.servers = [];
      rec.state = "dead";
      persistForwards();
    }
  }
  // localAddressPort is a PREFERENCE on the auto-forward path (the model
  // passes the container port, hoping for same-port): if it is taken, fall
  // back to the allocator walk — desktop does exactly that. Only an
  // EXPLICIT user edit (a different port) is strict: exact bind or an
  // honest failure, no allocator walk, no cached failure.
  const strict = want && want !== port;
  const walk = Array.from({ length: 50 }, (_, i) => port + i).filter((c) => c < 65536);
  let candidates = strict
    ? [want]
    : want
      ? [want, ...walk.filter((c) => c !== want)]
      : walk;
  if (!strict) {
    // LAST RESORT, port 0 = kernel-assigned: a privileged container port
    // (<1024 — raven's nginx:80) EACCES-es the WHOLE walk on a non-root
    // host (macOS enforces privileged binds), and a fully-colliding walk
    // finds nothing either. Desktop's no-elevation path does exactly this:
    // the row shows the assigned port.
    candidates.push(0);
  }
  // a REMEMBERED front (the persistence file — a previous run, or a hand
  // edit) is preferred before the walk when it is free: the Ports row
  // keeps its address across restarts. PREFERRED means reordered to the
  // front — it is usually inside the walk already, a plain dedupe-insert
  // would leave the walk's order in charge. Never overrides `want` (the
  // model's own ask), never the strict path (an explicit edit is law).
  if (!strict && container && container.id) {
    const remembered = persisted.get(`${container.id}:${port}`);
    if (
      remembered &&
      remembered !== want &&
      remembered > 0 &&
      remembered < 65536 &&
      !frontPortsUsed.has(remembered)
    ) {
      candidates = [
        ...(want ? [want] : []),
        remembered,
        ...candidates.filter((c) => c !== remembered && c !== want),
      ];
    }
  }
  for (const c of candidates) {
    if (frontPortsUsed.has(c)) {
      continue;
    } // another container has it
    const log = (m) => channel.appendLine(m);
    const local = await tryListen(ip, port, "127.0.0.1", c, log, key);
    if (!local) {
      continue;
    } // taken on the host (or by a container server in tests)
    // c=0 → the kernel assigned the port: read it back
    const assigned = local.address().port;
    if (assigned !== c) {
      channel.appendLine(
        `forward ${key}: nothing bindable in ${c === 0 ? "the walk" : `${c}`} — kernel-assigned front :${assigned} (privileged or all taken)`,
      );
    }
    let front = null;
    if (FRONT_IP && !FRONT_LOOPBACK) {
      front = await tryListen(ip, port, FRONT_IP, assigned, log, key);
      if (!front) {
        local.close();
        continue;
      }
    }
    rec.front = assigned;
    rec.lastFront = assigned; // for the reconciler's resurrection (watchdog deaths only — a user-closed row is release()d, never seen again)
    rec.state = "bound";
    rec.condemned = false;
    rec.servers = front ? [local, front] : [local];
    frontPortsUsed.add(assigned);
    persistForwards();
    // when the watchdog kills a bind (upstream dead), FREE the assignment:
    // a later /forward for the same container port must re-bind fresh —
    // a stale entry would resurrect a dead address (raven's dev server
    // restarts hit exactly this: row alive, bind long gone).
    // GUARDED: close() inside a 'close' handler RE-EMITS 'close' — an
    // unguarded unbind spins the event loop forever (seen live: the
    // service accepted requests but never answered them again).
    let closed = false;
    const unbind = () => {
      if (closed) {
        return;
      }
      closed = true;
      // OWNERSHIP: an edit re-bind, the mid-close guard or a release may
      // have detached this generation from the record already — a late
      // 'close' must not clobber a NEWER bind's state.
      if (rec.servers.includes(local) || (front && rec.servers.includes(front))) {
        if (rec.front === assigned) {
          rec.front = undefined;
        }
        rec.servers = rec.servers.filter((s) => s !== local && s !== front);
        rec.state = "dead";
        persistForwards();
      }
      frontPortsUsed.delete(assigned);
      local.close();
      if (front) {
        front.close();
      }
      // a WATCHDOG death (not an edit, not a stop) may be a freeze —
      // re-probe and heal if the server is actually alive
      if (rec.condemned) {
        rec.condemned = false;
        heal(channel, key, ip, port, assigned, rec.container).catch((e) =>
          channel.appendLine(
            `forward ${key}: heal failed (${(e && e.message) || e})`,
          ),
        );
      }
    };
    local.on("close", unbind);
    if (front) {
      front.on("close", unbind);
    }
    const host = FRONT_IP || "127.0.0.1";
    channel.appendLine(
      `forward ${key} → http://${host}:${assigned}` +
        (assigned === port
          ? " (same port, any device)"
          : ` (${port} was not bindable — using :${assigned})`),
    );
    return assigned;
  }
  if (strict) {
    channel.appendLine(
      `forward ${key}: requested front port ${want} is not bindable (in use?)`,
    );
    return false; // not cached — the user may free the port and retry
  }
  channel.appendLine(
    `forward ${key}: no free front port near ${port} — the Ports row keeps the unbound same-port address`,
  );
  rec.front = false;
  rec.state = "dead";
  persistForwards();
  return false;
}

/** Close a record's binds and forget it (stop/recreate, the publish
 *  rescue, the reconciler). NOT a watchdog death: condemned is cleared
 *  first — a user action never triggers a heal. The servers' own 'close'
 *  handlers still fire, but the record is already detached (the ownership
 *  check), so they only finish the OS teardown. */
function release(key) {
  const rec = forwards.get(key);
  if (!rec) {
    return;
  }
  rec.condemned = false;
  const servers = rec.servers;
  rec.servers = [];
  if (typeof rec.front === "number") {
    frontPortsUsed.delete(rec.front);
  }
  rec.front = undefined;
  rec.state = "dead";
  for (const s of servers) {
    s.close();
  }
  forwards.delete(key);
  persistForwards();
}

/** Close our front binds whose ASSIGNED port is `port` — they squat the
 *  very number docker needs for a publish. True when something was freed. */
function releaseBindsOnPort(channel, port) {
  let hit = false;
  for (const [key, rec] of [...forwards]) {
    if (rec.front === port) {
      channel.appendLine(
        `forward ${key}: released (docker needs :${port} for the publish)`,
      );
      release(key);
      hit = true;
    }
  }
  return hit;
}

/** Does a LIVE container currently publish this host port? (distinguishes
 *  a real cross-project conflict from OrbStack's release lag / stale hold) */
async function containerPublishes(channel, port, ctx) {
  try {
    const out = await run(
      channel,
      "docker",
      [
        ...dockerArgs(ctx),
        "ps",
        "--filter",
        `publish=${port}`,
        "--format",
        "{{.Names}}",
      ],
      { quiet: true },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Who listens on a host port (lsof: macOS and Linux) — so a "port is
 *  already allocated" error names the culprit instead of being a dead end.
 *  Also disambiguates the three classic holders: a forward in ANOTHER VS
 *  Code, a stale OrbStack publish (no container running), or a LIVE
 *  container already publishing the port. */
async function squatterOn(channel, port, ctx) {
  let out = "";
  try {
    out = await run(
      channel,
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { quiet: true },
    );
  } catch {
    /* lsof exits 1 on no match — or no lsof on a minimal host */
  }
  const lines = out.trim().split("\n").slice(0, 6).join("\n");
  // a LIVE container publishing it?
  let publishing = "";
  try {
    publishing = (
      await run(
        channel,
        "docker",
        [
          ...dockerArgs(ctx),
          "ps",
          "--filter",
          `publish=${port}`,
          "--format",
          "{{.Names}}",
        ],
        { quiet: true },
      )
    ).trim();
  } catch {
    /* best effort */
  }
  if (publishing) {
    return `container ${publishing} already publishes :${port} — stop it, or change the compose port`;
  }
  if (/Code/.test(lines)) {
    return (
      `${lines}\n→ a forward in ANOTHER VS Code (desktop or a second ` +
      "workbench): close it there (Ports view → right-click → Remove, " +
      "or close that window)"
    );
  }
  if (lines) {
    return (
      `${lines}\n→ no container publishes :${port} — a STALE OrbStack ` +
      "forward: restart OrbStack"
    );
  }
  return "(lsof sees nothing — a stale OrbStack forward with no container; restart OrbStack)";
}

/** Close every front bind of a container (its IP). Called when the
 *  container is stopped or about to be RECREATED (rebuild, forced
 *  recreate): our binds squat the very ports docker will want to publish
 *  ("Bind for 0.0.0.0:8080 failed: port is already allocated" — raven's
 *  recreate died on our own forward). The watchdog would reap them in
 *  ~15 s, but a recreate starts NOW. */
function releaseBindsFor(channel, ip) {
  for (const key of [...forwards.keys()]) {
    if (key.startsWith(`${ip}:`)) {
      channel.appendLine(`forward ${key}: released (container stops/recreates)`);
      release(key);
    }
  }
}

// ---------------------------------------------------------------------------
// the reconciler — drift repair on a timer. The /forward path only sees the
// moment of the request; the world moves between requests (a container
// stopped OUTSIDE the workbench, a restart that moved its IP, a bind whose
// servers vanished without a 'close'). Every 5 s: ONE inspect per known
// container id (never per record), then act on drift ONLY. It NEVER
// resurrects a dead bind: the workbench's tunnel model owns the row
// lifecycle via candidates — a resurrected row would fight it.

const goneStrikes = new Map(); // container id → consecutive "gone" ticks
let reconciling = false; // a slow docker must not stack ticks

function startReconciler() {
  setInterval(() => {
    if (reconciling) {
      return;
    }
    reconciling = true;
    reconcile()
      .catch((e) => channel.appendLine(`reconciler: ${(e && e.message) || e}`))
      .finally(() => {
        reconciling = false;
      });
  }, 5_000).unref();
}

async function reconcile() {
  // group the records by container id first: ONE quiet inspect per id
  const byId = new Map(); // id → { ctx, entries: [key, rec][] }
  for (const [key, rec] of forwards) {
    if (rec.container && rec.container.id) {
      const g = byId.get(rec.container.id) || {
        ctx: rec.container.ctx,
        entries: [],
      };
      g.entries.push([key, rec]);
      byId.set(rec.container.id, g);
    }
  }
  for (const [id, g] of byId) {
    let running = false;
    let ip = "";
    try {
      const out = await run(
        channel,
        "docker",
        [...dockerArgs(g.ctx), "inspect", id],
        { quiet: true },
      );
      const info = (JSON.parse(out) || [])[0] || {};
      running = !!(info.State && info.State.Running);
      const nets =
        (info.NetworkSettings && info.NetworkSettings.Networks) || {};
      ip =
        Object.values(nets)
          .map((n) => n && n.IPAddress)
          .find((x) => PRIVATE_IP.test(x)) || "";
    } catch {
      running = false; // inspect itself failed: the container is gone
    }
    if (!running) {
      // TWO strikes before acting: a recreate has a gone-window between
      // `rm` and `up` — exactly where the publish rescue works. Releasing
      // on the first tick would steal the rescue's job (and its log line).
      const n = (goneStrikes.get(id) || 0) + 1;
      goneStrikes.set(id, n);
      if (n < 2) {
        continue;
      }
      goneStrikes.delete(id);
      for (const [key, rec] of g.entries) {
        if (rec.state === "dead" && rec.servers.length === 0) {
          forwards.delete(key); // inert — forget silently
          continue;
        }
        channel.appendLine(
          `forward ${key}: container gone — released (reconciler)`,
        );
        release(key);
      }
      continue;
    }
    goneStrikes.delete(id);
    for (const [key, rec] of g.entries) {
      const keyIp = key.slice(0, key.indexOf(":"));
      const port = Number(key.slice(key.indexOf(":") + 1));
      if (rec.state === "dead") {
        // RESURRECTION: the watchdog killed this bind on a dead upstream.
        // Desktop keeps such rows forever — connections fail while the
        // server is down, they work again on restart. Re-probe; the
        // server back → re-bind the SAME front: the row revives
        // untouched, however long the restart took (raven's nginx
        // bounce). Only rows that HAD a bind (lastFront): a never-bound
        // failure (a strict edit that missed) must not spring to a walk
        // port. A row the USER closed was release()d — deleted, never
        // seen here. A taken lastFront is retried silently next tick.
        if (rec.lastFront && ip && !frontPortsUsed.has(rec.lastFront)) {
          if (await probeInContainer(channel, rec.container, rec.container.ctx, port)) {
            channel.appendLine(
              `forward ${key}: the server is back — resurrecting front :${rec.lastFront} (reconciler)`,
            );
            rec.attempts = 0;
            const container = { ...rec.container, ip };
            ensureForward(channel, ip, port);
            await ensureForwardPort(channel, ip, port, rec.lastFront, container);
            // after the allocation: the relay's anti-loop guard reads it
            await ensureInContainerRelay(channel, container, container.ctx, port, true);
          }
        }
        continue;
      }
      if (rec.state !== "bound") {
        continue; // closing (the watchdog owns it)
      }
      // drift: the record says bound but nothing listens anymore (a server
      // died without its 'close' reaching us). Close cleanly, mark dead —
      // do NOT re-bind: the upstream's health is unknown and the tunnel
      // model owns the row (see the header comment).
      if (rec.servers.length > 0 && rec.servers.every((s) => !s.listening)) {
        channel.appendLine(
          `forward ${key}: the front servers are gone without a close — released (reconciler)`,
        );
        release(key);
        continue;
      }
      if (ip && ip !== keyIp) {
        // the container MOVED (a restart re-assigned its IP): re-point the
        // SAME front port onto the new IP — the row never changes
        const front = rec.front;
        const container = { ...rec.container, ip };
        channel.appendLine(
          `forward ${key}: the container moved ${keyIp} → ${ip} — re-pointing front :${front} (reconciler)`,
        );
        release(key);
        if (typeof front === "number") {
          ensureForward(channel, ip, port);
          await ensureForwardPort(channel, ip, port, front, container);
          // after the allocation: the relay's anti-loop guard reads it
          await ensureInContainerRelay(channel, container, container.ctx, port, true);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Host docker for the container — NO relay port. The official way (the
// devcontainers "docker-outside-of-docker" feature): bind-mount the host's
// socket into the container at build time (see buildContainer). Only OUR
// container gets it — the old TCP relay (:2375, private ranges) gave host
// docker to anything that could route to the host. The pushed docker CLI
// then just works: the socket sits at the default path, no DOCKER_HOST.

const DOCKER_SOCK =
  process.env.REMOTE_DEV_DOCKER_SOCK || "/var/run/docker.sock";

// ---------------------------------------------------------------------------
// progress — the steps of a resolve, for the browser notification, plus a
// ring buffer of the log lines (desktop shows the build log in a terminal;
// the resolver extension streams it into a "Dev Containers" output channel)

const progressMap = new Map(); // hostPath → { message, at, lines, total, steps, increment }
let activePath = null;

/** Desktop's progress model (their bundle, verbatim): steps "Building
 *  image" → "Starting container" → "Installing server" → "Starting
 *  server", each with increment (100-t)/(6-n+1) — a determinate bar.
 *  We mirror the same titles and the same 20%-per-step curve. */
function setProgress(hostPath, message, increment) {
  const p = progressMap.get(hostPath) || { lines: [], total: 0, steps: [] };
  if (!p.steps) {
    p.steps = [];
  } // logProgress-created entries lack it
  p.message = message;
  if (increment !== undefined) {
    p.increment = increment;
  }
  if (p.steps[p.steps.length - 1] !== message) {
    p.steps.push(message);
  }
  p.at = Date.now();
  progressMap.set(hostPath, p);
  setTimeout(() => {
    const q = progressMap.get(hostPath);
    if (q && q.message === message) {
      progressMap.delete(hostPath);
    }
  }, 15 * 60_000).unref();
}

function logProgress(line) {
  if (!activePath) {
    return;
  }
  const p = progressMap.get(activePath) || {
    message: "",
    at: Date.now(),
    lines: [],
    total: 0,
  };
  for (const l of line.replace(/\r/g, "").split("\n")) {
    if (l.trim()) {
      p.lines.push(l);
      p.total++;
    }
  }
  if (p.lines.length > 500) {
    p.lines.splice(0, p.lines.length - 500);
  }
  progressMap.set(activePath, p);
}

// ---------------------------------------------------------------------------
// the WebSocket bridge — browser WS ↔ raw TCP to the container daemon.
// The workbench writes its own HTTP upgrade + protocol into the managed
// socket; those bytes cross this bridge untouched, exactly like the
// desktop extension's localhost relay.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsAccept(key) {
  return crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}

/** Encode one server→client frame (binary, unmasked). */
function wsFrame(payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x82, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Incremental client→server frame parser (masked frames, fragments). */
function wsParser(onMessage, onClose, onPing) {
  let buf = Buffer.alloc(0);
  let frags = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) {
        return;
      }
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) {
          return;
        }
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) {
          return;
        }
        len = Number(buf.readBigUInt64BE(off));
        off += 8;
      }
      const maskOff = off;
      if (masked) {
        off += 4;
      }
      if (buf.length < off + len) {
        return;
      }
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }
      buf = buf.subarray(off + len);
      if (op === 0x8) {
        onClose();
        return;
      }
      if (op === 0x9) {
        onPing(payload);
        continue;
      }
      if (op === 0xa) {
        continue;
      }
      frags.push(payload);
      if (fin) {
        onMessage(frags.length === 1 ? frags[0] : Buffer.concat(frags));
        frags = [];
      }
    }
  };
}

// IPs the bridge may dial: only containers WE have resolved (discoverIp is
// the funnel). Query-param targets used to be filtered only by PRIVATE_IP —
// a token holder could WS-connect to ANY private address on the LAN (SSRF).
const knownContainerIps = new Set();

function handleBridge(req, socket, head) {
  const url = new URL(req.url, "http://x");
  const ip = url.searchParams.get("ip") || "";
  const port = Number(url.searchParams.get("port") || 0);
  if (
    !PRIVATE_IP.test(ip) ||
    !knownContainerIps.has(ip) ||
    !(port > 0 && port < 65536) ||
    !checkAuth(req)
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const upstream = net.connect({ host: ip, port }, () => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    if (head && head.length) {
      parse(head);
    }
  });
  upstream.on("error", () => {
    socket.destroy();
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  const parse = wsParser(
    (payload) => upstream.write(payload),
    close,
    (ping) => socket.write(wsFrame(ping)),
  );
  socket.on("data", parse);
  socket.on("error", close);
  socket.on("close", () => upstream.destroy());
  upstream.on("data", (d) => {
    if (!socket.destroyed) {
      socket.write(wsFrame(d));
    }
  });
  upstream.on("close", () => {
    if (!socket.destroyed) {
      socket.end(Buffer.from([0x88, 0x00]));
    }
  });
}

// ---------------------------------------------------------------------------
// the HTTP endpoints

// No TCP port of our own: caddy proxies /api/remote-dev/* onto a unix
// socket (REMOTE_DEV_SOCK, set by run.sh). Nothing to scan, nothing to
// expose — the file's directory permissions are the access control, and
// the tkn check below stays the application-level gate. The loopback
// TCP fallback only exists for running the service standalone (debug).
const LISTEN_SOCK = process.env.REMOTE_DEV_SOCK || "";
const LISTEN_PORT = 10002; // fallback only, loopback
const SERVE_PORT = Number(process.env.REMOTE_DEV_SERVE_PORT || 10001);
const TKN_FILE = process.env.REMOTE_DEV_TKN_FILE || "";

const channel = {
  appendLine: (s) => {
    console.log(`[resolve] ${s}`);
    logProgress(s);
  },
  append: (s) => {
    process.stdout.write(s);
    logProgress(s);
  },
};

// ---------------------------------------------------------------------------
// one-time enter links — the REAL token never travels in a URL anymore
// (history, screenshots, shoulder surfing, paste accidents). run.sh prints
// /api/remote-dev/enter?ott=<one-time>: this endpoint burns the OTT, sets
// the real token as a cookie and redirects to a clean "/". The OTT file is
// read PER REQUEST so `./run.sh link` (mint for another device) works
// without a restart.

const OTT_FILE = process.env.REMOTE_DEV_OTT_FILE || "";
const WORKBENCH_SOCK = process.env.REMOTE_DEV_WORKBENCH_SOCK || "";

/** Wait for the workbench to accept connections on its socket (it binds
 *  late in its boot — an instant click on the enter link must not 302
 *  into a 502). Bounded; on timeout the redirect still happens — the
 *  cookie is already set, a reload lands fine. */
function waitForWorkbench(ms) {
  if (!WORKBENCH_SOCK) {
    return Promise.resolve();
  }
  const t0 = Date.now();
  const tick = (resolve) => {
    if (fs.existsSync(WORKBENCH_SOCK)) {
      const s = net.connect(WORKBENCH_SOCK);
      s.once("connect", () => {
        s.end();
        resolve();
      });
      s.once("error", () => retry(resolve));
      return;
    }
    retry(resolve);
  };
  const retry = (resolve) => {
    if (Date.now() - t0 > ms) {
      resolve();
      return;
    }
    setTimeout(() => tick(resolve), 250).unref();
  };
  return new Promise((resolve) => tick(resolve));
}

function readOtts() {
  try {
    return fs
      .readFileSync(OTT_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function handleEnter(req, res, url) {
  const ott = url.searchParams.get("ott") || "";
  const otts = readOtts();
  const hit = otts.find((o) => {
    const a = Buffer.from(o);
    const b = Buffer.from(ott);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!hit) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "this enter link is used or invalid — mint a fresh one: ./run.sh link",
    );
    return;
  }
  // burn it — one time, by design
  try {
    fs.writeFileSync(
      OTT_FILE,
      otts.filter((o) => o !== hit).join("\n") + (otts.length > 1 ? "\n" : ""),
      { mode: 0o600 },
    );
  } catch {
    /* best effort — the link dies with the file anyway */
  }
  let tkn = "";
  try {
    tkn = fs.readFileSync(TKN_FILE, "utf8").trim();
  } catch {
    /* unreadable */
  }
  if (!tkn) {
    res.writeHead(500);
    res.end("no token file on the host");
    return;
  }
  await waitForWorkbench(60_000);
  res.writeHead(302, {
    location: "/",
    "set-cookie": `vscode-tkn=${tkn}; Path=/; Secure; SameSite=Lax`,
    "cache-control": "no-store",
  });
  res.end();
}

function checkAuth(req) {
  let tkn = "";
  try {
    tkn = TKN_FILE ? fs.readFileSync(TKN_FILE, "utf8").trim() : "";
  } catch {
    /* unreadable */
  }
  if (!tkn) {
    return false;
  }
  // exact cookie match, constant-time (a substring match accepts values
  // that merely CONTAIN the token; timingSafeEqual like /enter's OTTs)
  for (const c of String(req.headers.cookie || "").split(";")) {
    const eq = c.indexOf("=");
    if (eq > 0 && c.slice(0, eq).trim() === "vscode-tkn") {
      const a = Buffer.from(c.slice(eq + 1).trim());
      const b = Buffer.from(tkn);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return true;
      }
    }
  }
  try {
    const url = new URL(req.url, "http://x");
    const q = url.searchParams.get("tkn") || "";
    const a = Buffer.from(q);
    const b = Buffer.from(tkn);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function resolveContainer(payload) {
  const wsPath = payload && payload.hostPath;
  const vol = payload && payload.volumeName;
  if (!wsPath && !(payload && payload.containerName) && !vol) {
    return undefined;
  }
  activePath = wsPath || payload.containerName || `volume:${vol}`;
  try {
    return payload.containerName
      ? await resolveAttachedInner(payload)
      : vol
        ? await resolveVolumeInner(payload)
        : await resolveContainerInner(payload, wsPath);
  } finally {
    activePath = null;
  }
}

/**
 * Attach to Running Container — the attached-container+<hex> authority
 * carries {containerName, settings, cwd}. Desktop attaches WITHOUT any
 * build: find the running container by name, install the daemon into it,
 * answer a managed connection. Same here.
 */
async function resolveAttachedInner(payload) {
  const ctx = (payload.settings && payload.settings.context) || undefined;
  const name = payload.containerName;
  channel.appendLine(`attach: container=${name} ctx=${ctx || "(default)"}`);
  setProgress(payload.containerName, `Attaching to ${name}…`);
  const container = await findContainerByName(channel, name, ctx);
  if (!container) {
    await dumpContainers(channel, ctx);
    throw new Error(
      `container "${name}" is not running (see the docker dump above)`,
    );
  }
  if (!container.ip) {
    throw new Error(
      `container "${name}" has no IP (is container networking routable?)`,
    );
  }
  setProgress(payload.containerName, "Installing server…");
  const daemon = await ensureDaemon(channel, container, undefined, ctx);
  setProgress(payload.containerName, "Starting server…");
  await waitForPort(channel, container.ip, SERVE_PORT, 60_000);
  await installCustomizedExtensions(channel, container, daemon, ctx);
  setProgress(payload.containerName, "done");
  return {
    ip: container.ip,
    port: SERVE_PORT,
    connectionToken: daemon.token,
    name: container.name,
  };
}

/** dotfiles flags for `devcontainer up`, from the CLIENT settings (desktop:
 *  the extension reads them client-side; our web resolver does the same and
 *  puts them in the payload) — passed on every up, first build and rebuilds. */
function dotfilesFlags(channel, payload) {
  const dotFlags = [];
  if (payload.dotfiles && payload.dotfiles.repository) {
    dotFlags.push("--dotfiles-repository", payload.dotfiles.repository);
    if (payload.dotfiles.installCommand) {
      dotFlags.push(
        "--dotfiles-install-command",
        payload.dotfiles.installCommand,
      );
    }
    if (payload.dotfiles.targetPath) {
      dotFlags.push("--dotfiles-target-path", payload.dotfiles.targetPath);
    }
    channel.appendLine(
      `dotfiles: ${payload.dotfiles.repository} (client settings)`,
    );
  }
  return dotFlags;
}

async function resolveContainerInner(payload, wsPath) {
  // Both the build and the lookup run in the docker context named in the
  // payload (settings.context, e.g. "orbstack") — the default context
  // sees nothing.
  const ctx = (payload.settings && payload.settings.context) || undefined;
  channel.appendLine(`resolve: hostPath=${wsPath} ctx=${ctx || "(default)"}`);
  setProgress(wsPath, "Looking for the container…");
  const configFile =
    payload.configFile && payload.configFile.scheme === "file"
      ? payload.configFile.fsPath
      : undefined;
  const dotFlags = dotfilesFlags(channel, payload);

  // Missing container → WE build it (on desktop the build is the
  // resolver's job — same here, just on the host). devcontainer up is
  // synchronous: when it returns, the container is up.
  let container = await findContainer(channel, wsPath, ctx);
  if (container) {
    // Rebuild Container was used in the container window — the patched
    // extension left its marker (stock memento path never fires in a
    // browser). The CLI flags are the desktop ones.
    const rebuild = await consumeRebuildMarker(channel, container, ctx);
    if (rebuild) {
      setProgress(wsPath, "Rebuilding the container…");
      // the recreate re-publishes the compose ports — free them FIRST,
      // our forwards squat exactly there
      releaseBindsFor(channel, container.ip);
      await buildContainer(
        channel,
        wsPath,
        configFile,
        ctx,
        (rebuild === "nocache"
          ? ["--remove-existing-container", "--build-no-cache"]
          : ["--remove-existing-container"]
        ).concat(dotFlags),
        { rebindPorts: payload.rebindPorts },
      );
      container = await findContainer(channel, wsPath, ctx);
    }
  } else {
    await buildContainer(channel, wsPath, configFile, ctx, dotFlags, {
      rebindPorts: payload.rebindPorts,
    });
    container = await findContainer(channel, wsPath, ctx);
  }
  if (!container) {
    await dumpContainers(channel, ctx);
    throw new Error(
      "container not found right after a successful build " +
        "— label/context mismatch? (see the docker dump above)",
    );
  }
  if (!container.ip) {
    // Seen live on OrbStack: a first `compose up` can die MID-ATTACH
    // (stderr swallowed by the CLI) leaving the container created but
    // NEVER connected — Running with only `lo` inside, the network's
    // Containers map empty, its IPs leaked. Every later up just
    // "starts" it; compose never re-attaches. The only way out is a
    // fresh create: remove it and up again — the network exists by
    // then, so the attach succeeds.
    channel.appendLine(
      `${container.name} runs WITHOUT a network attachment ` +
        "(compose left it half-created) — removing it and re-creating once",
    );
    releaseBindsFor(channel, container.ip);
    await run(
      channel,
      "docker",
      [...dockerArgs(ctx), "rm", "-f", container.id],
      { quiet: true },
    );
    await buildContainer(channel, wsPath, configFile, ctx, dotFlags, {
      rebindPorts: payload.rebindPorts,
    });
    container = await findContainer(channel, wsPath, ctx);
    if (!container) {
      await dumpContainers(channel, ctx);
      throw new Error(
        "container vanished after a forced recreate (see the docker dump above)",
      );
    }
    if (!container.ip) {
      throw new Error(
        "container has no IP even after a forced recreate " +
          "(docker-level networking broken for this container — inspect it by hand)",
      );
    }
  }

  setProgress(wsPath, "Installing server…", 20);
  const daemon = await ensureDaemon(channel, container, wsPath, ctx);
  setProgress(wsPath, "Starting server…", 20);
  await waitForPort(channel, container.ip, SERVE_PORT, 60_000);
  // the port answers → install the customized extensions BEFORE the
  // window connects (never concurrent with the daemon's first start)
  await installCustomizedExtensions(channel, container, daemon, ctx);
  const conf = await readDevcontainerConfig(channel, wsPath, ctx);
  await runPostAttach(channel, container, conf, ctx);
  await preForwardConfiguredPorts(channel, container, conf, ctx);
  setProgress(wsPath, "done");

  return {
    ip: container.ip,
    port: SERVE_PORT,
    connectionToken: daemon.token,
    // desktop's indicator: "Dev Container: <devcontainer.json name>"
    // (their setWorkspaceName → a per-authority label formatter)
    name: (conf && conf.name) || container.name,
  };
}

/** Clone Repository in Container Volume — the extension created the volume
 *  and cloned the repo; the RESOLVER builds (desktop's post-reload steps).
 *  Same tail as a folder resolve, just sourced from the volume. */
async function resolveVolumeInner(payload) {
  const ctx = (payload.settings && payload.settings.context) || undefined;
  const vol = await resolveVolumeName(channel, payload, ctx);
  const wsKey = `volume:${vol}`;
  const wsFolder = `/workspaces/${vol}`;
  channel.appendLine(
    `resolve: volume=${vol} folder=${payload.folder || "(root)"} ctx=${ctx || "(default)"}`,
  );
  setProgress(wsKey, "Looking for the container…");

  let container = await findContainerByVolume(channel, vol, ctx);
  if (!container) {
    const override = await volumeOverrideConfig(channel, payload, wsFolder, ctx);
    const cli = process.env.REMOTE_DEV_DEVCONTAINER_CLI;
    if (!cli) {
      throw new Error("devcontainer CLI not found (REMOTE_DEV_DEVCONTAINER_CLI unset)");
    }
    const env = ctx ? { DOCKER_CONTEXT: ctx } : {};
    setProgress(wsKey, "Building image…", 20);
    let started = false;
    try {
      await run(
        channel,
        process.execPath,
        [
          cli,
          "up",
          // the CLI chdirs its docker spawns into --workspace-folder, and a
          // volume's /workspaces/<vol> does NOT exist on the host —
          // "spawn docker ENOENT" (reproduced live). Any existing dir does;
          // the CONTAINER workspace comes from the override config.
          "--workspace-folder",
          path.dirname(override),
          "--override-config",
          override,
          "--id-label",
          `vsch.local.volume=${vol}`,
          ...(payload.folder
            ? ["--id-label", `vsch.local.folder=${payload.folder}`]
            : []),
          ...(fs.existsSync(DOCKER_SOCK)
            ? [
                "--mount",
                `type=bind,source=${DOCKER_SOCK},target=/var/run/docker.sock`,
              ]
            : []),
          "--include-configuration",
          "--include-merged-configuration",
          ...dotfilesFlags(channel, payload),
        ],
        {
          env,
          maxBuffer: 64 * 1024 * 1024,
          onData: (d) => {
            if (!started && /up -d|Built|Starting/.test(d.toString())) {
              started = true;
              setProgress(wsKey, "Starting container…", 20);
            }
          },
        },
      );
    } catch (err) {
      await rescueComposeFailure(channel, err, env, ctx, {
        rebindPorts: payload.rebindPorts,
      });
    }
    container = await findContainerByVolume(channel, vol, ctx);
    if (!container) {
      await dumpContainers(channel, ctx);
      throw new Error(
        "volume container not found right after a successful build " +
          "(see the docker dump above)",
      );
    }
  }
  if (!container.ip) {
    throw new Error(
      `volume container ${container.name} has no IP ` +
        "(docker-level networking broken for it — inspect it by hand)",
    );
  }

  setProgress(wsKey, "Installing server…", 20);
  const confSource = (ch) => readDevcontainerConfigInContainer(ch, container, ctx);
  const daemon = await ensureDaemon(channel, container, wsKey, ctx, confSource);
  setProgress(wsKey, "Starting server…", 20);
  await waitForPort(channel, container.ip, SERVE_PORT, 60_000);
  await installCustomizedExtensions(channel, container, daemon, ctx);
  const conf = await confSource(channel);
  await runPostAttach(channel, container, conf, ctx);
  await preForwardConfiguredPorts(channel, container, conf, ctx);
  setProgress(wsKey, "done");

  return {
    ip: container.ip,
    port: SERVE_PORT,
    connectionToken: daemon.token,
    name: (conf && conf.name) || container.name,
  };
}

/**
 * forwardPorts from devcontainer.json: desktop forwards them at attach
 * (they appear as statically forwarded). We can't draw the Ports row
 * before a server exists (it comes from candidate detection, like
 * desktop's auto-forward), but the whole transport is ready the moment
 * the server starts: loopback + workbench-IP listeners, in-container
 * relay for localhost-bound servers.
 */
async function preForwardConfiguredPorts(channel, container, conf, ctx) {
  // desktop forwards BOTH styles (devcontainer spec: forwardPorts and
  // appPort are additive) — each entry can be a port or "host:container"
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const ports = [...list(conf.forwardPorts), ...list(conf.appPort)]
    .map((p) => Number(String(p).split(":")[0]))
    .filter((p) => p > 0 && p < 65536);
  for (const port of new Set(ports)) {
    if (container.published && container.published.has(port)) {
      channel.appendLine(
        `forwardPorts: ${port} already published by docker on :${container.published.get(port)} (nothing to pre-forward)`,
      );
      continue;
    }
    channel.appendLine(
      `forwardPorts: pre-forwarding ${port} (devcontainer.json)`,
    );
    ensureForward(channel, container.ip, port);
    // the front FIRST: the relay's anti-loop guard (shared netns) reads the
    // allocation to know whether 127.0.0.1:port would be one of OUR binds
    await ensureForwardPort(channel, container.ip, port, 0, { ...container, ctx });
    await ensureInContainerRelay(channel, container, ctx, port, false);
  }
}

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // the one-time enter link — PUBLIC on purpose (caddy lets exactly this
  // path through the gate): its whole job is burning the OTT. Every other
  // route below requires the real token.
  if (req.method === "GET" && url.pathname === "/enter") {
    handleEnter(req, res, url).catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        /* already answered */
      }
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/progress") {
    if (!checkAuth(req)) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    const beep = url.searchParams.get("beep");
    if (beep) {
      channel.appendLine(`[shim] ${beep}`);
    }
    const p = progressMap.get(url.searchParams.get("path") || "") || {};
    const from = Number(url.searchParams.get("from") || 0);
    const lines = p.lines || [];
    // the cap (500 lines) trims the FRONT — next must be the MONOTONIC
    // total, not lines.length: once capped, a length-based cursor freezes
    // and consumers slice(from≥cap) read empty forever (seen live: build
    // logs truncating mid-build in 'all' runs, tail lines never arriving)
    const total = p.total || lines.length;
    const base = total - lines.length; // stream index of lines[0]
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        message: p.message,
        lastLine: lines[lines.length - 1],
        lines: lines.slice(Math.max(0, from - base)),
        next: total,
        steps: p.steps || [],
        increment: p.increment,
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/forward") {
    if (!checkAuth(req)) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 65536) {
        req.destroy();
      }
    });
    req.on("end", async () => {
      try {
        // a hand edit of the forwards file applies at the next /forward
        loadPersisted();
        const { hostPath, containerName, volumeName, port, context, frontPort } =
          JSON.parse(body);
        const ctx = context || undefined;
        const container = volumeName
          ? await findContainerByVolume(channel, volumeName, ctx)
          : containerName
            ? await findContainerByName(channel, containerName, ctx)
            : await findContainer(channel, hostPath, ctx);
        if (!container || !container.ip) {
          channel.appendLine(
            `forward ${port}: container not found (${containerName || hostPath}) — refusing, no fake address`,
          );
          res.writeHead(404);
          res.end("container not found");
          return;
        }
        // docker already publishes this container port on the host: it is
        // reachable at <the workbench's IP>:hostPort — our bind would be
        // redundant and would squat the port the next recreate wants
        const publishedHost = container.published && container.published.get(port);
        if (publishedHost) {
          channel.appendLine(
            `forward ${container.ip}:${port} → already published by docker on :${publishedHost} (nothing to bind)`,
          );
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              host: "127.0.0.1",
              port: publishedHost,
              front: publishedHost,
              frontIp: FRONT_IP || "127.0.0.1",
              published: true,
            }),
          );
          return;
        }
        ensureForward(channel, container.ip, port);
        const front = await ensureForwardPort(
          channel,
          container.ip,
          port,
          Math.floor(Number(frontPort)) || 0,
          { ...container, ctx },
        );
        if (!front) {
          res.writeHead(409);
          res.end(
            `no bindable front port for ${port}${frontPort ? ` (${frontPort} requested)` : ""}`,
          );
          return;
        }
        // after the allocation: the relay's anti-loop guard reads it
        await ensureInContainerRelay(channel, container, ctx, port, true);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            host: "127.0.0.1",
            port: front,
            front, // assigned front port (number)
            frontIp: FRONT_IP || "127.0.0.1",
          }),
        );
      } catch (e) {
        channel.appendLine(`forward failed: ${(e && e.message) || e}`);
        res.writeHead(500);
        res.end(String((e && e.message) || e));
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/unforward") {
    // the workbench disposed the tunnel (the row was closed, or the
    // close-half of a local-port edit): release the bind — desktop frees
    // the local port when the row goes away.
    if (!checkAuth(req)) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 65536) {
        req.destroy();
      }
    });
    req.on("end", async () => {
      try {
        const { hostPath, containerName, volumeName, port, context, frontPort } =
          JSON.parse(body);
        const ctx = context || undefined;
        const container = volumeName
          ? await findContainerByVolume(channel, volumeName, ctx)
          : containerName
            ? await findContainerByName(channel, containerName, ctx)
            : await findContainer(channel, hostPath, ctx);
        const key = container && container.ip && `${container.ip}:${port}`;
        const rec = key && forwards.get(key);
        if (rec) {
          // OWNERSHIP: the dispose races the edit's re-forward (the close
          // half and the forward half are both fire-and-forget). Only
          // release if the record's bind is still the one THIS tunnel had —
          // otherwise the /forward already re-bound and this late unforward
          // would kill the NEW bind (seen live: edit → ECONNREFUSED).
          const current = typeof rec.front === "number" ? rec.front : rec.lastFront;
          if (frontPort && current !== frontPort) {
            channel.appendLine(
              `forward ${key}: unforward for :${frontPort} skipped — the record moved to :${current} (the edit's re-forward won the race)`,
            );
          } else {
            channel.appendLine(`forward ${key}: row closed — released (unforward)`);
            release(key);
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      } catch (e) {
        channel.appendLine(`unforward failed: ${(e && e.message) || e}`);
        res.writeHead(500);
        res.end(String((e && e.message) || e));
      }
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/stop-container") {
    // The Remote menu's "Stop Container" (and the explorer's stock stop
    // button): stop, never delete — the next resolve's `up` starts it
    // again without a rebuild, exactly like desktop.
    if (!checkAuth(req)) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 65536) {
        req.destroy();
      }
    });
    req.on("end", async () => {
      try {
        const { hostPath, containerName, context } = JSON.parse(body);
        const ctx = context || undefined;
        const container = containerName
          ? await findContainerByName(channel, containerName, ctx)
          : await findContainer(channel, hostPath, ctx);
        if (!container) {
          res.writeHead(404);
          res.end("container not found");
          return;
        }
        channel.appendLine(
          `stopping container ${container.name} (${container.id.slice(0, 12)})`,
        );
        await run(
          channel,
          "docker",
          [...dockerArgs(ctx), "stop", container.id],
          { quiet: true },
        );
        if (container.ip) {
          releaseBindsFor(channel, container.ip); // stop, release, never squat
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stopped: container.name }));
      } catch (e) {
        res.writeHead(500);
        res.end(String((e && e.message) || e));
      }
    });
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/resolve") {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!checkAuth(req)) {
    res.writeHead(401);
    res.end("unauthorized");
    return;
  }
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 65536) {
      req.destroy();
    }
  });
  req.on("end", async () => {
    try {
      const answer = await resolveContainer(JSON.parse(body));
      if (answer) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      } else {
        res.writeHead(502);
        res.end("resolve failed — see run.sh output");
      }
    } catch (e) {
      channel.appendLine(`resolve failed: ${(e && e.message) || e}`);
      res.writeHead(500);
      res.end(String((e && e.message) || e));
    }
  });
});

// The bridge is an UPGRADE on the same server (caddy's handle_path strips
// the /api/remote-dev prefix, so here it is simply /bridge).
srv.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/bridge")) {
    handleBridge(req, socket, head);
  } else {
    socket.destroy();
  }
});

// the reconciler rides along with the service: the world moves between
// requests (a container stopped outside the workbench, a moved IP, a
// silently dead server) — drift repair runs on a timer, not on demand
startReconciler();

if (LISTEN_SOCK) {
  fs.rmSync(LISTEN_SOCK, { force: true }); // a stale socket file from a crash
  fs.rmSync(LISTEN_SOCK + ".ready", { force: true });
  srv.listen(LISTEN_SOCK, () => {
    console.log(`[resolve] listening on unix ${LISTEN_SOCK}`);
    // tell run.sh the line is OUT — it frames its output right after
    try {
      fs.writeFileSync(LISTEN_SOCK + ".ready", "");
    } catch {
      /* cosmetic */
    }
  });
} else {
  srv.listen(LISTEN_PORT, "127.0.0.1", () =>
    console.log(`[resolve] listening on 127.0.0.1:${LISTEN_PORT} (fallback — set REMOTE_DEV_SOCK)`),
  );
}
