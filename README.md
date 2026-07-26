# remote-devcontainers

_A non-commercial add-on for Microsoft VS Code to access Dev Containers from the Web - not affiliated with or endorsed by Microsoft._

> **Status: shared as-is.** I built this for my own use and I'm sharing it
> in case it's helpful to someone. I have my own things going on, so I do
> not plan any updates - but feel free to fork it.

For people who blindly install tons of node packages, vibe code in yolo
mode with the focus of a little bird, or just love Docker, Microsoft
created Dev Containers to give every project its own environment - and
that isolation is exactly what you want.

But Dev Containers only work on the computer where VS Code is installed.
You can't reopen your container from another laptop, or from a tablet.

**remote-devcontainers is an add-on for Microsoft VS Code that makes your
dev containers reachable from any browser** - so you can vibe code from
the beach, a wedding, or your bed. It's official VS Code + Microsoft's
official Dev Containers extension, and on top installs an add-on that
ensures that everything related to dev containers runs on your machine at
home; the browser is just a screen.

```
BEFORE (stock VS Code)

┌─ your Mac ──────────────────────────────┐
│ ┌───────────────────────────────────────┐ │
│ │ official VS Code                      │ │
│ ├───────────────────────────────────────┤ │
│ │ the Dev Containers extension          │ │
│ ├───────────────────────────────────────┤ │
│ │ your containers (Docker)              │ │
│ └───────────────────────────────────────┘ │
│                                           │
│  you can only work from this machine      │
└───────────────────────────────────────────┘

AFTER (with the add-on)

┌─ any browser (iPad, laptop) ──────────────┐
│ ┌───────────────────────────────────────┐ │
│ │ official VS Code, in the browser      │ │
│ ├───────────────────────────────────────┤ │
│ │ our remote-devcontainers-extension    │ │
│ └───────────────────────────────────────┘ │
└────────────────────┬──────────────────────┘
                     │ HTTPS connection
┌────────────────────▼──────────────────────┐
│ your Mac / always-on box                  │
│ ┌───────────────────────────────────────┐ │
│ │ official VS Code (serve-web)          │ │
│ ├───────────────────────────────────────┤ │
│ │ official Dev Containers extension     │ │
│ ├───────────────────────────────────────┤ │
│ │ our devcontainer-orchestrator         │ │
│ ├───────────────────────────────────────┤ │
│ │ your containers (Docker, your files)  │ │
│ └───────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

**When Dev Containers runs an action, it doesn't run on the iPad - it runs
on the computer at home, where VS Code is.**

And since everything runs at home, **your containers can keep running when you
close the tab**. Your iPad can sleep, your laptop
can close, the build, the dev server and the agent keep going at home.
Each container window has its own unique URL, so **bookmark it and come
back later** - hours later works too (the token cookie stays on your
device; on a new device, mint a fresh link with `./run.sh link`).

## How it works

1. `run.sh` installs the official VS Code and the official Dev Containers
   extension. Enables Dev Containers on Web.
2. But when Dev Containers needs something on the Web, it doesn't know
   whom to speak to - Microsoft's resolver only exists on the desktop. So
   there is a new extension that says *"you can ask me"*. There is no
   trick: VS Code has an **official API** where an extension registers
   what it can handle, and `remote-devcontainers-extension` claims
   `dev-container+<hex>` - the same mechanism Microsoft's resolver uses
   on the desktop.
3. When you do an action, that extension asks the machine hosting Docker,
   through the `devcontainer-orchestrator`: *"boot this container, stream
   me the logs, forward this port."* A completely separate pipeline from
   Microsoft's.

## Install

```bash
./run.sh          # downloads, cert, starts everything (idempotent)
```

Open the **one-time enter link** it prints. The link burns itself and sets
the token as a cookie - the real token never appears in a URL.
`./run.sh link` mints another one.

**To try it:** open the `empty-test-devcontainer/` folder from this repo in
the workbench - the Dev Containers extension will offer **Reopen in
Container**, and the add-on takes it from there.

**Which IP it serves on.** By default everything listens on `127.0.0.1`
(or your LAN IP if one is detected). To choose the address yourself - e.g.
to reach the workbench from another device on your network:

```bash
REMOTE_DEV_HOST_IP=192.168.1.42 ./run.sh   # your machine's IP, then open
                                           # https://192.168.1.42:10000/…
```

The TLS cert is minted for that address; `./run.sh cert <ip>` re-mints it
if the IP changes later.

Chrome will warn you about the certificate (the TLS CA is generated
locally, so `127.0.0.1` is "not trusted") - **this is normal and optional
to fix**: the traffic is encrypted either way, and only your own machine
holds the CA. If the warning bothers you, install and trust
`runtime/caddy/certs/ca/rootCA.pem` once - on an iPad: AirDrop it, install
the profile, then Settings → General → About → Certificate Trust.

**A word on exposure.** In theory you could expose port `10000` to the
internet and it would be fine - caddy checks the token on every single
request. But it's not a good idea: when a container opens a port, that
port opens on the IP of the host machine you set up - reachable by that
whole network. The better way: run a VPN like **Tailscale or WireGuard**
and serve on your VPN IP (`REMOTE_DEV_HOST_IP=<your VPN IP>`) - your
devices only, nothing public.

## Commands

| command | what |
|---|---|
| `./run.sh` | install what is missing, then start |
| `./run.sh link` | mint a one-time enter link |
| `./run.sh rotate_token` | new token - kills old tabs and every outstanding enter link |
| `./run.sh cert <ip>` | re-mint the TLS cert |
| `./run.sh reinstall_extensions` | reinstall the Microsoft extension |
| Ctrl-C | stops everything |

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Legal notice

- remote-devcontainers installs the **official VS Code** (downloaded from
  Microsoft) and Microsoft's **official Dev Containers extension** (from
  Microsoft's website), and activates it. Alongside, it installs our
  own extension and add-on: the `remote-devcontainers-extension` and the
  `devcontainer-orchestrator` - original work.
- **This repository contains no Microsoft code**, and nothing Microsoft is
  ever included in this project: the software is downloaded by you, from
  Microsoft, under Microsoft's licenses.
- It is **not a fork and not a redistribution** of VS Code.
- There is no trick to it: the add-on simply **registers a resolver for the
  `dev-container+<hex>` authority through VS Code's official extension
  point** - the same mechanism Microsoft's own resolver uses on the
  desktop, offered in the browser where Microsoft doesn't provide one.
- The few small adjustments the installer applies so those official parts
  work with a browser stay **on your machine only** and are never
  distributed.
- Visual Studio Code, VS Code and vscode.dev are trademarks of the
  Microsoft group of companies; this project is not affiliated with,
  endorsed by, or sponsored by Microsoft.
- Developed with an aim of interoperability, for non-commercial purposes,
  and to encourage more users to use Microsoft VS Code software.
  License: `LICENSE`.
