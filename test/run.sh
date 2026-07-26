#!/usr/bin/env bash
# test/run.sh — the end-to-end simulation. No docker, no browser:
#
#   /tmp/rdv-test   a fresh copy of the repo, REAL install (run.sh downloads
#                   the linux builds, patches them, starts caddy + serve-web
#                   + devcontainer-orchestrator)
#   fake docker     the "container" is THIS machine (test/fakebin/docker);
#                   the fake devcontainer CLI "builds" instantly — the real
#                   build path is production-verified, what we exercise is
#                   everything around it
#   test/e2e.js     plays the workbench: real shim → managed socket →
#                   bridge → daemon handshake → reconnect → port forwards
#
# Usage: test/run.sh [e2e|browser|browser2|browser3|browser4|browser5|browser6|browser7|browser8|real|all]   (cleans up after itself; logs in /tmp/rdv-test/)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
T=/tmp/rdv-test
MODE="${1:-e2e}"
export FAKE_STATE="$T/state"

cleanup() {
	set +e
	[ ! -f "$T/run.pid" ] || kill "$(cat "$T/run.pid")" 2>/dev/null
	sleep 1
	[ ! -f /tmp/remote-dev/serve.pid ] || kill "$(cat /tmp/remote-dev/serve.pid)" 2>/dev/null
	for p in $(pgrep -f '/tmp/remote-dev/vscode-server'); do kill "$p" 2>/dev/null; done
	# the whole stack under this runtime (serve-web pipeline survives a
	# bare SIGTERM to run.sh otherwise)
	for p in $(pgrep -f "$T/runtime"); do kill "$p" 2>/dev/null; done
	# the resolve service too — it lives under $T/scripts, NOT $T/runtime,
	# and used to survive cleanup
	for p in $(pgrep -f "$T/scripts/devcontainer-orchestrator"); do kill "$p" 2>/dev/null; done
	sudo pkill -f 'dockerd --iptables=false --bridge=non[e]' 2>/dev/null
	# nginx masters spawned by the e2e n-steps (conf in /tmp)
	pkill -f 'rdv-nginx-.*[.]conf' 2>/dev/null || true
	# let dockerd actually DIE before wiping its data dir — a still-shutting-
	# down daemon recreates files and the next start chokes on the half-wipe
	for _ in $(seq 1 15); do
		pgrep -f 'dockerd --iptables=false --bridge=non[e]' >/dev/null || break
		sleep 1
	done
	sudo rm -rf /tmp/rdv-docker-data /tmp/rdv-dockerd.log
	rm -rf /tmp/remote-dev
	[ ! -f "$T/.made-workspaces" ] || sudo rm -rf /workspaces
	if [ "$MODE" = "real" ]; then
		ids="$(docker ps -aq --filter label=devcontainer.local_folder=/tmp/rdv-real/ws 2>/dev/null || true)"
		[ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1 || true
		rm -rf /tmp/rdv-real
	fi
}
trap cleanup EXIT

echo "── prep $T"
pkill -f '/tmp/rdv-test' 2>/dev/null || true
# nginx masters a previous e2e may have left behind (they hold 14100/14101)
pkill -f 'rdv-nginx-.*[.]conf' 2>/dev/null || true
# keep the download cache between runs (minutes of re-downloads otherwise)
[ ! -d "$T/runtime/cached_downloads" ] || mv "$T/runtime/cached_downloads" /tmp/rdv-cache-keep
rm -rf "$T" /tmp/remote-dev
mkdir -p "$T" "$FAKE_STATE" "$T/runtime"
[ ! -d /tmp/rdv-cache-keep ] || mv /tmp/rdv-cache-keep "$T/runtime/cached_downloads"
(cd "$ROOT" && tar cf - --exclude=runtime --exclude=.git --exclude='*.bak-*' .) | (cd "$T" && tar xf -)

# the fake workspace (host side), always — the auto-notification needs
# the .devcontainer in the workspace
mkdir -p /tmp/fake-ws/.devcontainer
echo "# host side of the fake workspace" > /tmp/fake-ws/README.md
echo '{ "image": "mcr.microsoft.com/devcontainers/base:alpine" }' > /tmp/fake-ws/.devcontainer/devcontainer.json

echo "── install + start (background; log: $T/start.log)"
if [ "$MODE" = "real" ]; then
	# real docker, real CLI, real image build (see browser3.js)
	export PATH="$PATH"
	sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
	mkdir -p /tmp/rdv-real/ws/.devcontainer
	cat > /tmp/rdv-real/ws/.devcontainer/devcontainer.json <<'JSON'
{
	"image": "alpine:3.20",
	"postAttachCommand": "echo ATTACHED-OK > /tmp/remote-dev/attach-marker"
}
JSON
	echo "# real workspace" > /tmp/rdv-real/ws/README.md
else
	export PATH="$HERE/fakebin:$PATH"
	export REMOTE_DEV_DEVCONTAINER_CLI="$HERE/fakebin/devcontainer-cli.js"
	# a slow-ish fake build for the progress-UI test
	if [ "$MODE" = "browser3" ]; then export FAKE_BUILD_SECONDS=10;
	elif [ "$MODE" = "browser7" ]; then export FAKE_BUILD_SECONDS=3;
	elif [ "$MODE" = "browser8" ]; then export FAKE_BUILD_SECONDS=40 FAKE_EXOTIC=1;
	elif [ "$MODE" = "all" ]; then export FAKE_BUILD_SECONDS=5; fi
	# e2e also replays the production failure where the CLI's `compose up -d`
	# dies and its stderr is swallowed — the resolver must re-run it directly
	if [ "$MODE" = "e2e" ] || [ "$MODE" = "all" ] || [ "$MODE" = "browser7" ]; then
		export FAKE_UP_FAIL_ONCE=1
		# …and the OrbStack half-created container (Running, never attached
		# to its network) — the resolver must rm + recreate it
		touch "$FAKE_STATE/broken-net"
	fi
	# a local dockerd so the service has a socket to bind-mount (containers
	# can't START here — no CAP_SYS_ADMIN — but the API answers everything
	# else; the pushed CLI in the fake container talks to it directly)
	if ! sudo /usr/bin/docker info >/dev/null 2>&1; then
		sudo dockerd --iptables=false --bridge=none --storage-driver=vfs \
			--data-root /tmp/rdv-docker-data > /tmp/rdv-dockerd.log 2>&1 &
		# vfs init can take well over 20s on a cold data dir — and the
		# resolve service must never start before the socket exists
		for _ in $(seq 1 90); do sudo /usr/bin/docker info >/dev/null 2>&1 && break; sleep 1; done
		sudo /usr/bin/docker info >/dev/null 2>&1 \
			|| { echo "DOCKERD NEVER CAME UP — log:"; sudo tail -20 /tmp/rdv-dockerd.log; exit 1; }
	fi
	export REMOTE_DEV_DOCKER_SOCK=/var/run/docker.sock
	export REMOTE_DEV_FORWARD_IP=127.0.0.1   # same-port front binding (loopback here)
fi
(cd "$T" && exec ./run.sh > "$T/start.log" 2>&1) &
echo $! > "$T/run.pid"

echo "── waiting for the stack…"
for i in $(seq 1 120); do
	grep -q 'resolve\] listening' "$T/start.log" 2>/dev/null && break
	sleep 5
done
grep -q 'resolve\] listening' "$T/start.log" || { echo "STACK NEVER CAME UP — log:"; tail -50 "$T/start.log"; exit 1; }
grep -q 'caddy failed' "$T/start.log" && { echo "CADDY FAILED — log:"; tail -30 "$T/start.log"; exit 1; }
sleep 2
TKN="$(cat "$T/runtime/microsoft/vscode/serve-web.tkn")"
CA="$T/runtime/caddy/certs/ca/rootCA.pem"
[ -f "$CA" ] || CA="$(find "$T/runtime" -name rootCA.pem | head -1)"

if [ "$MODE" = "e2e" ] || [ "$MODE" = "all" ]; then
	echo "── e2e"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_RUNTIME="$T/runtime" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/e2e.js"
fi

if [ "$MODE" = "browser" ] || [ "$MODE" = "all" ]; then
	echo "── browser"
	# the folder the workbench will open INSIDE the daemon (this machine
	# plays the container, so it just needs to exist here)
	if [ ! -d /workspaces/remote-dev/empty-test-devcontainer ]; then
		sudo mkdir -p /workspaces/remote-dev/empty-test-devcontainer/.devcontainer
		sudo chown -R "$(id -u):$(id -g)" /workspaces
		touch "$T/.made-workspaces"
		echo "# fake workspace" > /workspaces/remote-dev/empty-test-devcontainer/README.md
		echo '{ "image": "mcr.microsoft.com/devcontainers/base:alpine" }' \
			> /workspaces/remote-dev/empty-test-devcontainer/.devcontainer/devcontainer.json
	fi

	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser.js"
fi

if [ "$MODE" = "browser5" ]; then
	echo "── browser5 (proposal lifecycle)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser5.js"
fi

if [ "$MODE" = "browser4" ]; then
	echo "── browser4 (real entry: notification → click)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser4.js"
fi

if [ "$MODE" = "browser6" ]; then
	echo "── browser6 (command-surface audit)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser6.js"
fi

if [ "$MODE" = "browser7" ]; then
	echo "── browser7 (docker flows, slow + failing, then command execution)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser7.js"
fi

if [ "$MODE" = "browsercc" ]; then
	echo "── browsercc (command center theme dump)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browsercc.js"
fi

if [ "$MODE" = "browser2" ] || [ "$MODE" = "all" ]; then
	echo "── browser2 (desktop parity)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser2.js"
fi

if [ "$MODE" = "browser3" ] || [ "$MODE" = "all" ]; then
	echo "── browser3 (slow build UI)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser3.js"
fi

if [ "$MODE" = "browser8" ]; then
	echo "── browser8 (exotic slow build: unicode name, hostile output, bogus extension)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser8.js"
fi

if [ "$MODE" = "browser9" ]; then
	echo "── browser9 (palette gauntlet: every entry executed, effect asserted)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser9.js"
fi

if [ "$MODE" = "real" ]; then
	echo "── browser3 (real docker, real build)"
	E2E_BASE="https://127.0.0.1:10000" E2E_TKN="$TKN" E2E_SHOTS="$T/shots" \
		PPTR="${PPTR:-/tmp/rdv-pptr/node_modules/puppeteer-core}" \
		NODE_EXTRA_CA_CERTS="$CA" \
		node "$HERE/browser3.js"
fi
