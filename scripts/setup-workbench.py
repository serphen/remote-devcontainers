#!/usr/bin/env python3
"""setup-workbench.py — the workbench patches, one call.

Applied to OUR local copy of the server build (runtime/…), never to the
pristine downloads. Idempotent (OK when already applied), loud on anchor
drift (WARN + skip), .bak backup before every write.

1. PROPOSALS (product.json): allowlist our resolver's proposed APIs
   (resolvers, tunnels, tunnelFactory) — configuration, not code.
2. WORKBENCH.JS: stock serve-web strips a foreign vscode-remote authority on
   openFolder (?folder=<path> only) — the container open lands on the host
   and dies ("Workspace does not exist"). Keep the full URI for a foreign
   authority, so the reload URL carries the dev-container+<hex>.
3. RESOLVER EXTENSION: register our web-worker resolver as a STATIC browser
   builtin in workbench.js and drop its files into the build's extensions/
   dir. WHY static: the reloaded window has no remote connection yet — that
   is what resolution must establish — so only the static browser builtins
   exist there.
4. SERVER-MAIN.JS: the window's remoteAuthority. Stock serve-web always
   uses the request's host header — so a ?folder=vscode-remote://<auth>/…
   reload boots as a HOST window and no resolver is ever consulted
   (expectsResolverExtension requires an authority containing "+"). Give
   the window the folder URI's authority instead — desktop openFolder
   semantics: the workbench then resolves it via our builtin resolver.
5. WORKBENCH.JS: register "Close Remote Connection" in web. Stock gates it
   out of the web workbench (SHOW_CLOSE_REMOTE_COMMAND_ID = !isWeb) — but
   it is exactly what leaving a container window needs, and its
   implementation (openWindow remoteAuthority:null) works fine in web.

Usage: setup-workbench.py SERVE_WEB_BUILD_DIR
"""
import json, re, shutil, sys, time
from pathlib import Path

build = Path(sys.argv[1])
HERE = Path(__file__).resolve().parent
SHIM_SRC = HERE / "remote-devcontainers-extension"
SHIM_ID = "remote-devcontainers.resolver"
SHIM_PROPOSALS = ["resolvers", "tunnels", "tunnelFactory"]


def short(p):
    """compact log paths: the basename — the description already says why"""
    return p.name


def backup_write(path, text):
    shutil.copy2(path, path.with_suffix(f".bak-{time.time_ns()}"))
    path.write_text(text)


# --- 1. proposed APIs allowlist for our resolver (product.json) -------------------
pj = build / "product.json"
data = json.loads(pj.read_text())
changed = False
proposals = data.get("extensionEnabledApiProposals") or {}
# purge pre-rename resolver ids: an install patched before the rename keeps
# the old id — its files may still load from a cached workbench.js, and its
# proposed APIs must not stay allowed (raven's broken window after the rename)
OLD_SHIM_IDS = ["remote-dev.dev-container-resolver"]
for old in OLD_SHIM_IDS:
    if old in proposals:
        del proposals[old]
        changed = True
if not set(SHIM_PROPOSALS) <= set(proposals.get(SHIM_ID) or []):
    proposals[SHIM_ID] = sorted(set(proposals.get(SHIM_ID) or []) | set(SHIM_PROPOSALS))
    changed = True
if changed:
    data["extensionEnabledApiProposals"] = proposals
    backup_write(pj, json.dumps(data, indent="\t") + "\n")
    print(f"      PATCH {short(pj)}: resolver proposals allowlist applied")
else:
    print(f"      OK    {short(pj)}: resolver proposals (already applied)")

# --- 2. keep a foreign vscode-remote authority on openFolder (workbench.js) -------
# Anchor on the SEMANTIC CORE, not the surrounding code — minification renames
# locals freely between builds (seen: param o→i, alias X→Po), but property
# names (this.config.remoteAuthority, .scheme, .vscodeRemote) are never
# mangled. In this bundle the shape `this.config.remoteAuthority&&<param>
# .scheme===<alias>.vscodeRemote?` is unique.
js = build / "out/vs/code/browser/workbench/workbench.js"
text = js.read_text()
if ".authority===this.config.remoteAuthority?" in text:
    print(f"      OK    {short(js)}: foreign vscode-remote authority kept on openFolder (already applied)")
else:
    m = re.search(
        r"this\.config\.remoteAuthority"
        r"&&([A-Za-z_$][\w$]*)\.scheme===[A-Za-z_$][\w$]*\.vscodeRemote\?",
        text)
    if not m:
        print(f"      WARN  {short(js)}: anchor not found — openFolder authority fix NOT applied "
              f"(build changed?)", file=sys.stderr)
    else:
        p = m.group(1)
        patched = (m.group(0)[:-1]
                   + f"&&{p}.authority===this.config.remoteAuthority?")
        backup_write(js, text.replace(m.group(0), patched, 1))
        text = js.read_text()  # re-read: step 3 patches the same file
        print(f"      PATCH {short(js)}: foreign vscode-remote authority kept on openFolder")

# --- 3. the resolver extension as a STATIC browser builtin -------------------------
# The reloaded window (vscode-remote://dev-container+<hex>) has no remote
# connection yet — that is what resolution must establish — so the worker
# extension host there only has the STATIC browser builtins baked into
# workbench.js plus IndexedDB extensions. An extension delivered by the
# remote scan does not exist in that window. Insert ours into the array:
#   if(o.isBuilt)l=[{extensionPath:"<id>",packageJSON:{…}},…]
# The code is served from the build's extensions/ dir (route verified long
# ago): the folder drop below + this registration.

# 3a. drop the files (fresh copy every run — no staleness)
dest = build / "extensions" / SHIM_ID
if dest.exists():
    shutil.rmtree(dest)
shutil.copytree(SHIM_SRC, dest)
print(f"      OK    {short(dest)}: resolver extension files dropped")
for old in OLD_SHIM_IDS:
    old_dir = build / "extensions" / old
    if old_dir.exists():
        shutil.rmtree(old_dir)
        print(f"      PATCH {short(old_dir)}: pre-rename resolver purged")

# 3b. register in the static array (semantic anchor — minification renames
# the locals between builds: seen `o/l` then `i/c`; the property names are
# never mangled). First PURGE any pre-rename entry: an install patched
# before the rename would otherwise register BOTH resolvers.
def purge_static_entry(text, ext_id):
    marker = '{extensionPath:"' + ext_id + '",packageJSON:'
    i = text.find(marker)
    if i < 0:
        return text, False
    depth = 0
    end = -1
    for j in range(i, len(text)):
        c = text[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                end = j + 1
                break
    if end < 0:
        return text, False
    entry = text[i:end]
    if text.startswith(entry + ",", i):
        return text[:i] + text[end + 1:], True
    if i > 0 and text[i - 1] == ",":
        return text[:i - 1] + text[end:], True
    return text[:i] + text[end:], True

purged_any = False
for old in OLD_SHIM_IDS:
    text, did = purge_static_entry(text, old)
    purged_any = purged_any or did
if purged_any:
    backup_write(js, text)
    print(f"      PATCH {short(js)}: pre-rename resolver entry purged from the static builtins")

ANCHOR_RE = re.compile(r"if\([A-Za-z_$][\w$]*\.isBuilt\)[A-Za-z_$][\w$]*=\[\{extensionPath:")
marker = f'extensionPath:"{SHIM_ID}"'
m = ANCHOR_RE.search(text)
if marker in text:
    print(f"      OK    {short(js)}: {SHIM_ID} already a static browser builtin")
elif not m:
    print(f"      WARN  {short(js)}: static builtin anchor not found — {SHIM_ID} NOT "
          f"registered (the reloaded window will have no resolver)", file=sys.stderr)
else:
    pkg = json.loads((SHIM_SRC / "package.json").read_text())
    entry = marker + ",packageJSON:" + json.dumps(pkg, separators=(",", ":")) + "}"
    patched = m.group(0)[:-len('{extensionPath:')] + "{" + entry + ",{extensionPath:"
    backup_write(js, text.replace(m.group(0), patched, 1))
    print(f"      PATCH {short(js)}: {SHIM_ID} registered as a static browser builtin")
    print("      ↳ hard-reload the browser tab — workbench.js is cached for a year")

# --- 4. the window's remoteAuthority comes from a vscode-remote folder (server-main.js)
# Stock _handleRoot sets remoteAuthority to the request's HOST HEADER, always
# — a ?folder=vscode-remote://<auth>/… reload then boots as a host window
# and no resolver is consulted (the workbench only looks for one when the
# authority contains "+"). Semantic anchors: the _handleRoot signature gives
# the request param's name (locals are renamed between builds); the
# `remoteAuthority:<local>,serverBasePath:` pair is the config write.
srv = build / "out/server-main.js"
stext = srv.read_text()
MARKER = "rdvFolderAuthority"
if MARKER in stext:
    print(f"      OK    {short(srv)}: folder authority drives the window (already applied)")
else:
    root_m = re.search(r"_handleRoot\(([$\w]+),[$\w]+,[$\w]+\)", stext)
    ra_m = re.search(r"remoteAuthority:([$\w]+),serverBasePath:", stext)
    if not root_m or not ra_m:
        print(f"      WARN  {short(srv)}: _handleRoot/remoteAuthority anchor not found — "
              f"folder-authority patch NOT applied (build changed?)", file=sys.stderr)
    else:
        req = root_m.group(1)
        iife = ("(function(){var " + MARKER + ";try{" + MARKER
                + "=new URL(" + req + '.url,"http://x").searchParams.get("folder");'
                + 'if(' + MARKER + '&&' + MARKER + '.indexOf("vscode-remote://")===0)'
                + "return " + MARKER + ".slice(16).split(\"/\")[0]}catch(e){}return "
                + ra_m.group(1) + "})()")
        patched = stext.replace(ra_m.group(0),
                                "remoteAuthority:" + iife + ",serverBasePath:", 1)
        backup_write(srv, patched)
        print(f"      PATCH {short(srv)}: window remoteAuthority taken from a vscode-remote folder")

# --- 5. register "Close Remote Connection" in web (workbench.js) ------------------
# Stock gates the command out of the web workbench entirely
# (`SHOW_CLOSE_REMOTE_COMMAND_ID = !isWeb`) — without it there is no way to
# LEAVE a container window, desktop-parity-wise. Its implementation
# (hostService.openWindow remoteAuthority:null) is web-safe.
text = js.read_text()
if "SHOW_CLOSE_REMOTE_COMMAND_ID=!0" in text:
    print(f"      OK    {short(js)}: Close Remote Connection registered in web (already applied)")
else:
    m5 = re.search(r"SHOW_CLOSE_REMOTE_COMMAND_ID=![A-Za-z_$][\w$]*", text)
    if not m5:
        print(f"      WARN  {short(js)}: SHOW_CLOSE_REMOTE_COMMAND_ID anchor not found — "
              f"Close Remote Connection NOT registered", file=sys.stderr)
    else:
        backup_write(js, text.replace(m5.group(0), "SHOW_CLOSE_REMOTE_COMMAND_ID=!0", 1))
        print(f"      PATCH {short(js)}: Close Remote Connection registered in web")

# --- 6. let the remote indicator show the actual remote (workbench.js) --------
# serve-web's bootstrap FORCES a default windowIndicator {label:"$(remote)",
# tooltip:"VS Code Web"}, and updateRemoteStatusIndicator renders it with an
# early return — the connected-remote branch (labelService.getHostLabel → the
# extension's "Dev Container" formatter, exactly desktop's text) never runs.
# A container window then shows a bare icon, identical to a host window.
# Drop the forced default: with no windowIndicator configured, the
# remoteAuthority branch renders the desktop label.
text = js.read_text()
if '??{label:"$(remote)",tooltip:' not in text:
    print(f"      OK    {short(js)}: forced windowIndicator default gone (already applied)")
else:
    m6 = re.search(r'\?\?\{label:"\$\(remote\)",tooltip:`[^`]*`\}', text)
    if not m6:
        print(f"      WARN  {short(js)}: windowIndicator anchor not found — remote "
              f"indicator label NOT fixed (build changed?)", file=sys.stderr)
    else:
        backup_write(js, text.replace(m6.group(0), "??void 0", 1))
        print(f"      PATCH {short(js)}: remote indicator shows the remote label (no forced windowIndicator)")
