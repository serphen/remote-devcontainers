#!/bin/sh
# run.sh — the only entry point. Install what is missing, then start.
#
#   ./run.sh                          install what is missing, then start
#   ./run.sh install                  steps 1-7 only (no start)
#   ./run.sh start                    devcontainer-orchestrator + caddy + serve-web
#   ./run.sh reinstall_extensions     step 6 only
#   ./run.sh rotate_token             new host token (then restart)
#   ./run.sh cert [ip] [extra-ips…]   (re)mint the TLS cert
#
# What it does, in order:
#   [1/7] jail (kernel sandbox)        — optional, drops permissions
#   [2/7] VS Code cli                  — official Microsoft download
#   [3/7] VS Code server               — the browser workbench
#   [4/7] HTTPS tools (caddy + mkcert) — official downloads, cached
#   [5/7] HTTPS cert                   — one cert, always; TLS is the only door
#   [6/7] Microsoft Dev Containers     — official extension (details in
#                                        scripts/install-devcontainers-extension.py)
#   [7/7] container daemon artifacts   — the server pushed INTO containers,
#                                        pre-downloaded (first container is fast)
#   start: devcontainer-orchestrator (container spawner) + caddy (TLS front door,
#   config generated at runtime/caddy/config/Caddyfile) + serve-web.
#
# Ports, everywhere: 10000 = TLS (caddy) — the ONLY TCP port of the stack.
# serve-web and the orchestrator are unix sockets behind it.
# Idempotent: nothing is ever downloaded twice (runtime/cached_downloads/).
set -eu

HERE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"

# --- your settings ----------------------------------------------------------------
# Everything you may want to change is here. Nowhere else.

# HOST IP — where the browser reaches this Mac.
#   Empty  = auto-detect the internal (100.x) address.
#   Or type it yourself (example):
#REMOTE_DEV_HOST_IP="192.168.8.235"
REMOTE_DEV_HOST_IP="${REMOTE_DEV_HOST_IP:-}"
export REMOTE_DEV_HOST_IP

# Folders the jail may READ and WRITE (absolute paths, space-separated).
# This checkout is always in. Parent folders stay listable (traverse only).
# Everything else in $HOME is invisible. Details: the jail section below.
REMOTE_DEV_ALLOW="${REMOTE_DEV_ALLOW:-}"
export REMOTE_DEV_ALLOW

# JAIL — the macOS kernel sandbox (drops permissions: writes only in
# runtime/ + whitelist, $HOME hidden). Set to 1 to run WITHOUT it:
REMOTE_DEV_NO_JAIL="${REMOTE_DEV_NO_JAIL:-1}"
export REMOTE_DEV_NO_JAIL

# --- paths (everything lives in runtime/) -----------------------------------------
VSCODE_DIR="$HERE/runtime/microsoft/vscode"
CADDY_DIR="$HERE/runtime/caddy"                 # binaries, state, generated config, certs
CERTS_DIR="$CADDY_DIR/certs"
DOWNLOADS_DIR="$HERE/runtime/cached_downloads"  # every download, kept forever
TKN_FILE="$VSCODE_DIR/serve-web.tkn"
OTT_FILE="$VSCODE_DIR/serve-web.ott"   # one-time enter links (burnable)
PLATFORM_MARKER="$VSCODE_DIR/.platform"         # vscode cli/server platform
TOOLS_PLATFORM_MARKER="$HERE/runtime/.platform" # caddy/mkcert platform
DEVCONTAINER_EXTENSION_UUID="93ce222b-5f6f-49b7-9ab1-a0463c6238df"

LOOPBACK_HOST=127.0.0.1
SOCK_DIR="$HERE/runtime/sock"   # every unix socket of the stack lives here
WORKBENCH_SOCK="$SOCK_DIR/remote-dev-workbench.sock"   # serve-web listens here (no TCP port)
CADDY_PORT=10000       # the TLS front door

# --- output helpers ----------------------------------------------------------------
tag()  { printf '\n[%s] %s\n' "$1" "$2"; }
ok()   { printf '      ✓ %s\n' "$*"; }
down() { printf '      ↓ %s\n' "$*"; }
note() { printf '      %s\n' "$*"; }
skip() { printf '      – %s\n' "$*"; }
fail() { printf '      ✗ %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*" >&2; }
die()  { printf '[✗] %s\n' "$*" >&2; exit 1; }

ready_item() { printf '  %s %s\n' "$1" "$2"; }
url_frame_top()    { printf '\n  ═══════════════════════════════════════════════════════════════════\n'; }
url_frame_bottom() { printf '  ═══════════════════════════════════════════════════════════════════\n\n'; }

# provenance tags — what runs here is either untouched-official, patched
# official, or ours. Color only on a TTY (logs stay clean).
if [ -t 1 ]; then
	C_OFFICIAL=$(printf '\033[32m'); C_PATCH=$(printf '\033[33m'); C_OURS=$(printf '\033[35m'); C_RESET=$(printf '\033[0m')
else
	C_OFFICIAL=; C_PATCH=; C_OURS=; C_RESET=
fi
tag_official() { printf '  %s[OFFICIAL]%s %s\n' "$C_OFFICIAL" "$C_RESET" "$*"; }
tag_patch()    { printf '  %s[PATCH]%s %s\n'    "$C_PATCH"    "$C_RESET" "$*"; }
tag_ours()     { printf '  %s[OURS]%s %s\n'     "$C_OURS"     "$C_RESET" "$*"; }

# dl "label — domain (official)" curl … — a download with the destination
# shown after: requested host, connected IP, final effective URL.
dl() {
	down "$1"; shift
	printf '\n'
	"$@" -w '      ↳ %{url.host}  (%{remote_ip})\n      ↳ %{url_effective}\n'
	rc=$?
	printf '\n'
	return $rc
}

# --- platform ----------------------------------------------------------------------
# Sets: clip (CLI flavor), srvp (server flavor), tos/tarch (caddy+mkcert).
detect_platform() {
	case "$(uname -s)-$(uname -m)" in
		Darwin-arm64)              clip="cli-darwin-arm64";  srvp="server-darwin-arm64-web";  tos="darwin"; tarch="arm64" ;;
		Darwin-x86_64)             clip="cli-darwin-x64";    srvp="server-darwin-x64-web";    tos="darwin"; tarch="amd64" ;;
		Linux-aarch64|Linux-arm64) clip="cli-linux-arm64";   srvp="server-linux-arm64-web";   tos="linux";  tarch="arm64" ;;
		Linux-x86_64)              clip="cli-linux-x64";     srvp="server-linux-x64-web";     tos="linux";  tarch="amd64" ;;
		*) die "unsupported platform $(uname -s)-$(uname -m)" ;;
	esac
}

# --- this machine's internal IP (100.64.0.0/10, never wildcard) --------------------
find_internal_ip() {
	{ ifconfig 2>/dev/null || ip -4 addr show 2>/dev/null; } \
		| awk '$1=="inet" && $2 ~ /^100\./ {
			sub(/\/.*/, "", $2);
			split($2, o, ".");
			if (o[2] >= 64 && o[2] <= 127 && !(o[2]==115 && o[3]>=92 && o[3]<=93)) { print $2; exit }
		  }'
}

# The IP everything is served on: configured, else internal, else loopback.
pick_host_ip() {
	ip="${REMOTE_DEV_HOST_IP:-}"
	[ -n "$ip" ] || ip="$(find_internal_ip || true)"
	[ -n "$ip" ] || ip="$LOOPBACK_HOST"
	printf '%s' "$ip"
}

# --- jail (macOS kernel sandbox, sandbox-exec) --------------------------------------
# read  — $HOME is hidden, except the whitelist (settings, top) and its
#         parent folders (listing only).
# write — the whitelist, temp dirs, ptys, docker.sock. Nothing else.
# run.sh re-execs itself inside the sandbox; the [1/7] line is printed only
# by the instance that can report a result (never twice).
jail_profile() {
	dir_rules=""
	anc_rules=""
	for dir in "$HERE" $REMOTE_DEV_ALLOW; do
		case "$dir" in
			"$HOME"/*)
				dir_rules="$dir_rules
(subpath \"$dir\")"
				a="$dir"
				while [ "$a" != "$HOME" ]; do
					a="${a%/*}"
					anc_rules="$anc_rules
(literal \"$a\")"
				done
				;;
		esac
	done
	cat <<SBPEOF
(version 1)
(allow default)
(deny file-read*
	(subpath "$HOME"))
(allow file-read*$anc_rules)
(allow file-read*$dir_rules)
(deny file-write*)
(allow file-write*$dir_rules
	(subpath "/tmp")
	(subpath "/private/tmp")
	(subpath "${TMPDIR:-/var/folders}")
	(literal "/dev/null")
	(literal "/dev/ptmx")
	(regex #"^/dev/ttys[0-9]+$")
	(literal "/private/var/run/docker.sock"))
SBPEOF
}

if [ -n "$REMOTE_DEV_NO_JAIL" ]; then
	tag 1/7 "jail — drop permissions (kernel sandbox)"
	skip "disabled by config (REMOTE_DEV_NO_JAIL=1) — runs UNRESTRICTED"
elif [ -z "${REMOTE_DEV_JAILED:-}" ]; then
	if command -v sandbox-exec >/dev/null 2>&1; then
		REMOTE_DEV_JAILED=1
		export REMOTE_DEV_JAILED
		exec sandbox-exec -p "$(jail_profile)" "$0" "$@"
	else
		tag 1/7 "jail — drop permissions (kernel sandbox)"
		skip "inactive: sandbox-exec does not exist on this OS — runs UNRESTRICTED"
	fi
else
	tag 1/7 "jail — drop permissions (kernel sandbox)"
	if (echo x > "$HOME/.remote-dev-jail-test") 2>/dev/null; then
		rm -f "$HOME/.remote-dev-jail-test"
		fail "a write outside runtime succeeded — jail ineffective"
	else
		ok "active: writes allowed only in runtime/ + whitelist; \$HOME hidden"
	fi
fi

mkdir -p "$VSCODE_DIR/srv" "$VSCODE_DIR/cli"

# --- step 2: VS Code cli (official Microsoft) ---------------------------------------
# Wrong platform (runtime copied from another machine)? Wiped. Re-downloaded.
install_cli() {
	detect_platform
	archive="$DOWNLOADS_DIR/vscode-$clip.tgz"
	if [ -e "$VSCODE_DIR/code" ] && [ "$(cat "$PLATFORM_MARKER" 2>/dev/null)" != "$clip $srvp" ]; then
		note "runtime is for another platform ($(cat "$PLATFORM_MARKER" 2>/dev/null || echo unknown)) — wiping binaries"
		rm -rf "$VSCODE_DIR/code" "$VSCODE_DIR/cli/serve-web"
	fi
	if [ -x "$VSCODE_DIR/code" ]; then ok "present ($clip)"; return 0; fi
	mkdir -p "$VSCODE_DIR" "$DOWNLOADS_DIR"
	if [ -f "$archive" ]; then
		ok "already downloaded — unpacking runtime/cached_downloads/vscode-$clip.tgz"
	else
		dl "VS Code CLI ($clip) — update.code.visualstudio.com (official Microsoft)" \
			curl -fSL "https://update.code.visualstudio.com/latest/$clip/stable" -o "$archive.part"
		mv "$archive.part" "$archive"
	fi
	tar xzf "$archive" -C "$VSCODE_DIR"
	echo "$clip $srvp" > "$PLATFORM_MARKER"
}

# --- step 3: VS Code server (the browser workbench) ---------------------------------
# Flavor: server-<platform>-web. The "-web" part matters: it has the browser
# workbench. Checked after extraction (product.json + workbench.html).
install_server() {
	detect_platform
	if [ -n "$(ls "$VSCODE_DIR/cli/serve-web"/*/product.json 2>/dev/null)" ] \
		&& [ "$(cat "$PLATFORM_MARKER" 2>/dev/null)" = "$clip $srvp" ]; then
		ok "present ($srvp)"; return 0
	fi
	if [ -n "$(ls "$VSCODE_DIR/cli/serve-web"/*/product.json 2>/dev/null)" ]; then
		note "server build is for another platform — wiping"
		rm -rf "$VSCODE_DIR/cli/serve-web"
	fi
	commit="$(curl -sf --max-time 30 "https://update.code.visualstudio.com/api/commits/stable/$srvp" \
		| python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
	archive="$DOWNLOADS_DIR/vscode-$srvp-$commit.tgz"
	mkdir -p "$VSCODE_DIR/cli/serve-web/$commit" "$DOWNLOADS_DIR"
	if [ -f "$archive" ]; then
		ok "already downloaded — unpacking runtime/cached_downloads/vscode-$srvp-$(printf '%s' "$commit" | cut -c1-8).tgz"
	else
		dl "VS Code server $srvp @ $(printf '%s' "$commit" | cut -c1-8) — update.code.visualstudio.com (official Microsoft)" \
			curl -fSL --max-time 300 "https://update.code.visualstudio.com/commit:$commit/$srvp/stable" -o "$archive.part"
		mv "$archive.part" "$archive"
	fi
	tar xzf "$archive" -C "$VSCODE_DIR/cli/serve-web/$commit" --strip-components=1
	[ -f "$VSCODE_DIR/cli/serve-web/$commit/product.json" ] \
		|| die "server extraction failed (no product.json)"
	ls "$VSCODE_DIR/cli/serve-web/$commit/out/vs/code/browser/workbench/workbench.html" >/dev/null 2>&1 \
		|| die "wrong server flavor (no web workbench) — expected $srvp"
}

# --- step 3b: container daemon artifacts (the server that goes INTO containers) ---
# Pre-downloaded at install time so the FIRST container never waits on a
# Microsoft download: the devcontainer-orchestrator pushes these into containers
# from this very cache (pushArtifact), pinned to the host build's commit.
# Flavor probing mirrors the service's pickServerFlavor (alpine naming has
# drifted: first candidate the API validates wins).
install_container_artifacts() {
	commit="$(basename "$(ls -d "$VSCODE_DIR"/cli/serve-web/*/ 2>/dev/null | head -1)")"
	[ -n "$commit" ] || die "no serve-web build found"
	case "$(uname -m)" in
		arm64|aarch64) ;;
		*) note "container artifacts: prefetch is arm64-only (other arches download lazily, still cached)"; return 0 ;;
	esac
	mkdir -p "$DOWNLOADS_DIR"
	flavors="server-linux-arm64"
	# alpine naming has drifted — but only probe the API when we must
	# DOWNLOAD: a cached archive for this commit already tells us the
	# name. The probe is an HTTPS round-trip to Microsoft on EVERY start
	# (raven: "ça rame un peu" — that was this, not the downloads).
	alpine_archive="$(ls "$DOWNLOADS_DIR"/vscode-server-alpine-arm64-"$commit".tgz \
		"$DOWNLOADS_DIR"/vscode-server-linux-alpine-arm64-"$commit".tgz 2>/dev/null | head -1)"
	if [ -n "$alpine_archive" ]; then
		flavors="$flavors $(basename "$alpine_archive" | sed "s/^vscode-//; s/-$commit\.tgz$//")"
	else
		for cand in server-alpine-arm64 server-linux-alpine-arm64; do
			n="$(curl -sf --max-time 30 "https://update.code.visualstudio.com/api/commits/stable/$cand" \
				| python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)' 2>/dev/null || echo 0)"
			if [ "$n" != "0" ]; then flavors="$flavors $cand"; break; fi
		done
	fi
	for flavor in $flavors; do
		archive="$DOWNLOADS_DIR/vscode-$flavor-$commit.tgz"
		if [ -f "$archive" ]; then
			ok "already downloaded — runtime/cached_downloads/vscode-$flavor-$(printf '%s' "$commit" | cut -c1-8).tgz"
			continue
		fi
		dl "container daemon $flavor @ $(printf '%s' "$commit" | cut -c1-8) — update.code.visualstudio.com (official Microsoft)" \
			curl -fSL --max-time 300 "https://update.code.visualstudio.com/commit:$commit/$flavor/stable" -o "$archive.part"
		mv "$archive.part" "$archive"
	done

	# the static docker CLI that goes INTO containers (with the bind-mounted
	# host socket, the container-side Dev Containers explorer drives the
	# host's docker, like desktop's UI-side extension)
	case "$(uname -m)" in
		arm64|aarch64)
			cli_archive="$DOWNLOADS_DIR/docker-cli-linux-arm64.tgz"
			if [ -f "$cli_archive" ]; then
				ok "already downloaded — runtime/cached_downloads/docker-cli-linux-arm64.tgz"
			else
				dl "docker CLI 27.3.1 (linux/arm64, static) — download.docker.com (official Docker)" \
					curl -fSL --max-time 300 "https://download.docker.com/linux/static/stable/aarch64/docker-27.3.1.tgz" -o "$cli_archive.part"
				mv "$cli_archive.part" "$cli_archive"
			fi
			;;
	esac
}

# --- step 4: HTTPS tools (caddy + mkcert into runtime/caddy/) --------------------
install_tools() {
	detect_platform
	if [ -x "$CADDY_DIR/caddy" ] && [ -x "$CADDY_DIR/mkcert" ] \
		&& [ "$(cat "$TOOLS_PLATFORM_MARKER" 2>/dev/null)" = "$tos $tarch" ]; then
		ok "present (caddy, mkcert)"
		return 0
	fi
	rm -f "$CADDY_DIR/caddy" "$CADDY_DIR/mkcert" "$TOOLS_PLATFORM_MARKER"
	mkdir -p "$CADDY_DIR" "$DOWNLOADS_DIR"
	caddy_cache="$DOWNLOADS_DIR/caddy-$tos-$tarch"
	if [ -f "$caddy_cache" ]; then
		ok "caddy already downloaded — using runtime/cached_downloads/caddy-$tos-$tarch"
	else
		dl "caddy ($tos-$tarch) — caddyserver.com (official Caddy)" \
			curl -fSL "https://caddyserver.com/api/download?os=$tos&arch=$tarch" \
			-o "$caddy_cache.part"
		mv "$caddy_cache.part" "$caddy_cache"
	fi
	cp "$caddy_cache" "$CADDY_DIR/caddy"
	chmod +x "$CADDY_DIR/caddy"
	# Any cached mkcert for this platform wins — zero network needed.
	mkcert_cache="$(ls "$DOWNLOADS_DIR"/mkcert-*-"$tos"-"$tarch" 2>/dev/null | sort | tail -1 || true)"
	if [ -z "$mkcert_cache" ]; then
		# api.github.com rate-limits by IP — fall back to the /latest redirect.
		tag_name="$(curl -sf --max-time 30 https://api.github.com/repos/FiloSottile/mkcert/releases/latest \
			| python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])' 2>/dev/null || true)"
		if [ -z "$tag_name" ]; then
			note "api.github.com unreachable or rate-limited — resolving version via github.com redirect"
			tag_name="$(curl -sfI --max-time 30 https://github.com/FiloSottile/mkcert/releases/latest \
				| sed -n 's|^[Ll]ocation: .*/releases/tag/||p' | tr -d '\r' | head -1 || true)"
		fi
		[ -n "$tag_name" ] || die "cannot resolve mkcert's latest version (api.github.com + redirect both failed)"
		mkcert_cache="$DOWNLOADS_DIR/mkcert-$tag_name-$tos-$tarch"
		dl "mkcert — github.com/FiloSottile/mkcert (official release)" \
			curl -fSL "https://github.com/FiloSottile/mkcert/releases/download/$tag_name/mkcert-$tag_name-$tos-$tarch" \
			-o "$mkcert_cache.part"
		mv "$mkcert_cache.part" "$mkcert_cache"
	else
		ok "mkcert already downloaded — using runtime/cached_downloads/$(basename "$mkcert_cache")"
	fi
	cp "$mkcert_cache" "$CADDY_DIR/mkcert"
	chmod +x "$CADDY_DIR/mkcert"
	echo "$tos $tarch" > "$TOOLS_PLATFORM_MARKER"
	ok "installed into runtime/caddy/"
}

# --- step 5: the TLS cert (one, always) -------------------------------------------
make_cert() {
	ip="${1:-}"
	if [ -n "$ip" ]; then shift; else ip="$(pick_host_ip)"; fi
	mkdir -p "$CERTS_DIR"
	CAROOT="$CERTS_DIR/ca" "$CADDY_DIR/mkcert" \
		-cert-file "$CERTS_DIR/$ip.pem" -key-file "$CERTS_DIR/$ip-key.pem" "$ip" "$@"
	ok "cert for $ip → runtime/caddy/certs/"
	note "CA (non-secret): runtime/caddy/certs/ca/rootCA.pem"
	note "iPad, once: AirDrop rootCA.pem → install profile → Settings → General"
	note "  → About → Certificate Trust Settings → enable full trust"
}

ensure_cert() {
	ip="$(pick_host_ip)"
	[ -f "$CERTS_DIR/$ip.pem" ] && { ok "present for $ip"; return 0; }
	make_cert "$ip"
}

# --- step 6: Microsoft Dev Containers (official) ------------------------------------
install_ms_extension() {
	mkdir -p "$DOWNLOADS_DIR"
	vsix="$DOWNLOADS_DIR/ms-vscode-remote.remote-containers-latest.vsix"
	if [ -f "$vsix" ]; then
		ok "already downloaded — using runtime/cached_downloads/ms-vscode-remote.remote-containers-latest.vsix"
	else
		dl "Microsoft Dev Containers extension — marketplace.visualstudio.com (official Microsoft)" \
			curl -fSL 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-vscode-remote/vsextensions/remote-containers/latest/vspackage' -o "$vsix.part"
		mv "$vsix.part" "$vsix"
	fi
	python3 "$HERE/scripts/install-devcontainers-extension.py" ms "$vsix" "$VSCODE_DIR" "$DEVCONTAINER_EXTENSION_UUID"
}

# --- caddy (the TLS front door) ----------------------------------------------------
# Config is GENERATED here, written to runtime/caddy/config/Caddyfile.
#   https://<mac>:10000/                                → host serve-web
#   https://<mac>:10000/api/remote-dev/*                → devcontainer-orchestrator (unix socket)
# Forwarded container ports are NOT routed here: they are same-port TCP
# binds on the workbench's own IP (devcontainer-orchestrator's ensureForwardPort).
write_caddyfile() {
	mkdir -p "$CADDY_DIR/config" "$CADDY_DIR/data"
	cat > "$CADDY_DIR/config/Caddyfile" <<'EOF'
{
	# certs come from mkcert files, not ACME — no CA to talk to
	auto_https disable_redirects
	# no admin API (default :2019): a local process must not reconfigure
	# the front door. run.sh stops caddy by signal (pkill on our binary).
	admin off
}

https://{$MAC_HOST}:10000 {
	# listen on the internal IP only — never on LAN/wildcard
	bind {$MAC_HOST}
	tls {$TLS_CERT} {$TLS_KEY}

	# ONE gate for every request: the token (query on the first landing,
	# cookie once serve-web has set it). serve-web and the orchestrator
	# still check it themselves — defense in depth — but nothing
	# unauthenticated ever reaches a backend now. The ONLY public path is
	# /api/remote-dev/enter (the one-time enter link — it burns its OTT).
	@noToken not expression {http.request.uri.query.tkn} == "{$REMOTE_DEV_TKN}" || {http.request.cookie.vscode-tkn} == "{$REMOTE_DEV_TKN}" || {http.request.uri.path} == "/api/remote-dev/enter"
	respond @noToken 401

	# The resolve API + the WebSocket bridge — the resolver extension's
	# transport. Standalone service on a UNIX SOCKET (no TCP port at all —
	# scripts/devcontainer-orchestrator.js); it checks the vscode-tkn cookie
	# itself. handle_path strips the prefix.
	# NOTE the slash AFTER "unix": it is NOT part of the socket syntax —
	# caddy's placeholder expansion eats one slash, so unix{$VAR} would
	# dial a RELATIVE path (502, verified live). unix/{$VAR} lands the
	# absolute path exactly.
	handle_path /api/remote-dev/* {
		reverse_proxy unix/{$REMOTE_DEV_SOCK}
	}

	# Everything else → the host computer's own serve-web,
	# on its unix socket too — no TCP port anywhere.
	handle {
		reverse_proxy unix/{$WORKBENCH_SOCK}
	}
}
EOF
}

caddy_stop() {
	[ -f "$CADDY_DIR/.started-by-run" ] || return 0   # not ours — leave it alone
	# pkill, not `caddy stop`: the admin API it uses is DISABLED (admin off —
	# a local process must not be able to reconfigure the front door)
	pkill -f "$CADDY_DIR/caddy" 2>/dev/null || true
	rm -f "$CADDY_DIR/.started-by-run"
}

caddy_start() {
	ip="$1"
	if [ ! -f "$CERTS_DIR/$ip.pem" ]; then
		ready_item "–" "TLS    off (no cert — run ./run.sh cert)"
		return 0
	fi
	if curl -sk --max-time 2 -o /dev/null "https://$ip:$CADDY_PORT/"; then
		ready_item "✓" "caddy already running"
		return 0
	fi
	# our marker exists but nothing answers on THIS ip → a stale daemon of
	# ours (previous IP/config) is still around. Stop it before starting.
	[ ! -f "$CADDY_DIR/.started-by-run" ] || caddy_stop
	[ -x "$CADDY_DIR/caddy" ] || { warn "caddy missing — run ./run.sh install"; return 1; }
	write_caddyfile
	# NOT out=$(caddy start …): the daemon inherits the substitution's pipe
	# and holds it open for its whole life — the call would never return.
	# A plain log file can stay open by the daemon without blocking us.
	log="$CADDY_DIR/last-start.log"
	if MAC_HOST="$ip" TLS_CERT="$CERTS_DIR/$ip.pem" TLS_KEY="$CERTS_DIR/$ip-key.pem" \
		REMOTE_DEV_SOCK="${REMOTE_DEV_SOCK:-$HERE/runtime/sock/remote-dev-api.sock}" \
		REMOTE_DEV_TKN="$(cat "$TKN_FILE")" \
		WORKBENCH_SOCK="$WORKBENCH_SOCK" \
		XDG_CONFIG_HOME="$CADDY_DIR/config" XDG_DATA_HOME="$CADDY_DIR/data" \
		"$CADDY_DIR/caddy" start --config "$CADDY_DIR/config/Caddyfile" --adapter caddyfile >"$log" 2>&1; then
		touch "$CADDY_DIR/.started-by-run"
		ready_item "✓" "caddy up"
	else
		warn "caddy failed to start — off (HTTP still works)"
		tail -n 3 "$log" | sed 's/^/      caddy: /'
		note "port busy? an orphan caddy survives a runtime wipe — kill it: lsof -ti :$CADDY_PORT | xargs kill"
		return 1
	fi
}

# --- serve-web --------------------------------------------------------------------
generate_token() {
	{ openssl rand -hex 24 2>/dev/null \
		|| python3 -c 'import secrets;print(secrets.token_hex(24))' \
		|| head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; } > "$TKN_FILE"
	chmod 600 "$TKN_FILE"
}

# one-time enter links: the printed URL carries a BURNABLE token, never the
# real one — /api/remote-dev/enter exchanges it for the cookie and a clean
# "/". The real token stops appearing in URLs, history and screenshots.
mint_ott() {
	ott="$(openssl rand -hex 24 2>/dev/null \
		|| python3 -c 'import secrets;print(secrets.token_hex(24))' \
		|| head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
	touch "$OTT_FILE"
	chmod 600 "$OTT_FILE"
	printf '%s\n' "$ott" >> "$OTT_FILE"
	printf '%s' "$ott"
}
enter_url() { # <ip>
	printf 'https://%s:%s/api/remote-dev/enter?ott=%s' "$1" "$CADDY_PORT" "$(mint_ott)"
}

# serve-web prints a "Web UI available on <socket>" line that only clutters
# the frame. Drop that one, keep everything else — INCLUDING Microsoft's
# license terms banner: the ToS warning stays visible at every boot.
filter_banner() {
	grep -vE 'Web UI available'
}

start() {
	[ -f "$TKN_FILE" ] || generate_token
	# patch OUR copy of the server build (see scripts/setup-workbench.py):
	# blue host identity, foreign vscode-remote authority kept on openFolder,
	# and the container redirect bootstrap in workbench.html.
	tag_patch "workbench patches (scripts/setup-workbench.py)"
	for b in "$VSCODE_DIR"/cli/serve-web/*/; do
		[ -f "$b/product.json" ] || continue
		python3 "$HERE/scripts/setup-workbench.py" "$b" || true
	done
	# the resolve service authenticates against this
	export REMOTE_DEV_TKN_FILE="$TKN_FILE"
	export REMOTE_DEV_OTT_FILE="$OTT_FILE"
	# /enter holds its redirect until the workbench answers (instant clicks
	# during the serve-web boot never see a 502)
	export REMOTE_DEV_WORKBENCH_SOCK="$WORKBENCH_SOCK"
	# Microsoft's own container engine, bundled inside the Dev Containers
	# extension: the devcontainer-orchestrator runs the build with it when the
	# container is missing (on desktop the build is the resolver's job —
	# a browser workbench can never run that resolver).
	export REMOTE_DEV_DEVCONTAINER_CLI="${REMOTE_DEV_DEVCONTAINER_CLI:-$(ls "$VSCODE_DIR"/srv/extensions/ms-vscode-remote.remote-containers-*/dist/spec-node/devContainersSpecCLI.js 2>/dev/null | head -1)}"
	# the host build's commit + the download cache: the devcontainer-orchestrator pins
	# the container CLI to the same version and pre-seeds the server build,
	# so a new container never downloads anything itself.
	export REMOTE_DEV_COMMIT="$(basename "$(ls -d "$VSCODE_DIR"/cli/serve-web/*/ 2>/dev/null | head -1)")"
	export REMOTE_DEV_CACHE_DIR="$DOWNLOADS_DIR"
	# the flipped Microsoft extension: the devcontainer-orchestrator also pushes it
	# into each container's daemon, so the container window has the Dev
	# Containers commands (Rebuild, Reopen Locally…) like on desktop.
	export REMOTE_DEV_MS_EXTENSION_DIR="$(ls -d "$VSCODE_DIR"/srv/extensions/ms-vscode-remote.remote-containers-* 2>/dev/null | head -1)"
	# the front door's listen IP: configured, else internal, else loopback.
	# Picked BEFORE the service starts: forwarded ports bind on this same
	# address — the rule is "wherever the client reaches the workbench".
	HOST_IP="$(pick_host_ip)"
	export REMOTE_DEV_HOST_IP="$HOST_IP"
	if [ "$HOST_IP" = "$LOOPBACK_HOST" ]; then
		note "no internal IP — serving on $LOOPBACK_HOST (loopback, this machine only)"
	fi
	# the resolve service: the redirect bootstrap's host-side endpoint.
	# Standalone on purpose — an in-extension listener dies with the
	# window that hosts it, exactly when the redirect needs it.
	# NO TCP port of its own: caddy proxies onto this unix socket.
	mkdir -p "$SOCK_DIR"
	API_SOCK="$SOCK_DIR/remote-dev-api.sock"
	export REMOTE_DEV_SOCK="$API_SOCK"
	# the docker socket joins the sock dir too — as a SYMLINK to the real
	# one; the orchestrator bind-mounts THIS path into containers (the
	# daemon resolves the link). REMOTE_DEV_DOCKER_SOCK may override the
	# real socket's location (tests do).
	REAL_DOCKER_SOCK="${REMOTE_DEV_DOCKER_SOCK:-/var/run/docker.sock}"
	if [ -S "$REAL_DOCKER_SOCK" ]; then
		ln -sf "$REAL_DOCKER_SOCK" "$SOCK_DIR/docker.sock"
		export REMOTE_DEV_DOCKER_SOCK="$SOCK_DIR/docker.sock"
		# and route ALL docker traffic through it too: the orchestrator's
		# CLI calls (and the devcontainer CLI, its child) honor DOCKER_HOST
		# — one dir, one path, retargeting docker = retargeting one link.
		# An explicit --context still wins over DOCKER_HOST (docker's rule).
		export DOCKER_HOST="unix://$SOCK_DIR/docker.sock"
	fi
	tag_ours "devcontainer-orchestrator (scripts/devcontainer-orchestrator.js)"
	NODE_BIN="$(ls "$VSCODE_DIR"/cli/serve-web/*/node | head -1)"
	"$NODE_BIN" "$HERE/scripts/devcontainer-orchestrator.js" &
	RESOLVE_PID=$!
	# the orchestrator is up when its .ready marker exists — written AFTER
	# its "listening" log line, so that line lands BEFORE the frame
	for _ in $(seq 1 50); do [ -f "$API_SOCK.ready" ] && break; sleep 0.1; done
	export VSCODE_CLI_DATA_DIR="$VSCODE_DIR/cli"
	mkdir -p "$VSCODE_DIR/tmp"
	TMPDIR="/tmp/rdv-$(echo "$HERE" | cksum | awk '{print $1}')"
	export TMPDIR
	mkdir -p "$TMPDIR"
	# ONE enter link per start, printed twice (the frame + the bare last
	# line): the same one-time link, not two different ones
	BOOT_URL="https://$HOST_IP:$CADDY_PORT/api/remote-dev/enter?ott=$(mint_ott)"
	printf '[ready]\n'
	url_frame_top
	# TLS is the ONLY way in: serve-web listens on a unix socket — never
	# the network. caddy is the door.
	tag_ours "caddy — the TLS front door (the only TCP port)"
	caddy_start "$HOST_IP" || true
	# THE link: a ONE-TIME enter link — it burns on first use, sets the
	# token as a cookie and lands on a clean "/". The real token never
	# appears in a URL (history, screenshots, paste accidents).
	if [ -f "$CERTS_DIR/$HOST_IP.pem" ]; then
		ready_item "➜" "$BOOT_URL"
		note "one-time link — burns on first use; ./run.sh link mints another"
	fi
	url_frame_bottom
	trap 'kill "$RESOLVE_PID" 2>/dev/null; rm -f "$API_SOCK" "$API_SOCK.ready" "$WORKBENCH_SOCK" "$SOCK_DIR/docker.sock"; caddy_stop >/dev/null 2>&1 || true' EXIT INT TERM
	# debug knob: REMOTE_DEV_LOG=trace ./run.sh — forwarded to serve-web,
	# which also sets the browser workbench's log level (developmentOptions)
	LOG_ARGS=""
	[ -z "${REMOTE_DEV_LOG:-}" ] || LOG_ARGS="--log $REMOTE_DEV_LOG"
	# TLS is the ONLY way in: serve-web listens on a unix socket (no TCP
	# port at all) — caddy is the door.
	tag_ours "VS Code serve-web — official build + our patches"
	rm -f "$WORKBENCH_SOCK"
	# the SAME enter link again, BARE, INSTANTLY — no waiting for the
	# workbench: /enter itself holds the redirect until serve-web is up,
	# so an immediate click never sees a 502
	printf '\n%s\n' "$BOOT_URL"
	"$VSCODE_DIR/code" serve-web --socket-path "$WORKBENCH_SOCK" \
		--connection-token-file "$TKN_FILE" \
		--server-data-dir "$VSCODE_DIR/srv" --cli-data-dir "$VSCODE_DIR/cli" $LOG_ARGS 2>&1 | filter_banner
}

install() {
	# Step 2-3 — put VS Code here.
	# The official Microsoft CLI + server build. Nothing modified.
	tag 2/7 "VS Code cli";                              tag_official "Microsoft, unmodified"; install_cli
	tag 3/7 "VS Code server (the browser workbench)";   tag_official "Microsoft, unmodified"; install_server

	# Step 4-5 — put HTTPS in front.
	# So the token never travels in cleartext.
	# And mostly: browsers only unlock everything a workbench
	# needs (webviews, secrets, crypto) on valid HTTPS.
	tag 4/7 "HTTPS tools (caddy + mkcert)";             tag_official "caddyserver.com + mkcert, unmodified"; install_tools
	tag 5/7 "HTTPS cert (one, always — TLS should be used)"; tag_ours "generated locally by mkcert"; ensure_cert

	# Step 6 — the official Microsoft Dev Containers extension.
	# It owns the whole container pipeline (build, start, mount).
	# Our only additions are the devcontainer-orchestrator and the workbench
	# patches — no extensions of ours anymore.
	tag 6/7 "extension — Microsoft Dev Containers";     tag_official "official extension"; install_ms_extension

	# The daemon that will run INSIDE containers (server-linux/alpine-arm64
	# @ the host commit) — downloaded now, so the first container never waits
	# on Microsoft. Cached forever like everything else.
	tag 7/7 "container daemon artifacts (pre-download)"; tag_official "Microsoft + Docker, unmodified"; install_container_artifacts
}

case "${1:-}" in
	"")                    install; start ;;
	install)               install ;;
	start)                 start ;;
	reinstall_extensions)
		tag 6/7 "extension — Microsoft Dev Containers (official)"; install_ms_extension
		;;
	rotate_token)
		generate_token
		: > "$OTT_FILE"   # outstanding enter links die with the old token
		printf '[✓] token rotated\n'
		ready_item "➜" "$(enter_url "$(pick_host_ip)")"
		note "(restart serve-web if it is running; update your bookmarks)"
		;;
	link)
		printf '[✓] one-time enter link (burns on first use):\n'
		ready_item "➜" "$(enter_url "$(pick_host_ip)")"
		;;
	cert)                  shift; make_cert "$@" ;;
	*) echo "usage: ./run.sh [install|start|link|reinstall_extensions|rotate_token|cert [ip] [extra-ips…]]" >&2; exit 2 ;;
esac
