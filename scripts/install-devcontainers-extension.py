#!/usr/bin/env python3
"""install-devcontainers-extension.py — install the Microsoft Dev Containers extension.

WHY THIS EXISTS, step by step:

1. The OFFICIAL Microsoft Dev Containers extension runs the entire container
   pipeline on the server (that is where Docker lives). But its manifest
   declares extensionKind ["ui"] = "run on the client", and VS Code refuses
   to install a ui-kind extension on a server. So we flip ONE manifest field
   to ["workspace"] = "run on the server". Data-only: the official bundle
   itself is never touched. Verified by re-reading: a silent no-flip means
   the extension NEVER activates server-side.

2. extensions.json is REGENERATED after each install. WHY: that file is the
   server's registry of installed extensions — a folder without a correct
   entry is ignored at startup.

Usage:
  install-devcontainers-extension.py ms VSIX VSCODE_DIR DEVCONTAINER_EXTENSION_UUID
  install-devcontainers-extension.py regen VSCODE_DIR DEVCONTAINER_EXTENSION_UUID
"""
import gzip, glob, io, json, os, shutil, sys, tempfile, time, zipfile

cmd = sys.argv[1]

# Rebuild Container, browser edition. Stock behavior: the command fires an
# event whose listener writes a memento that the extension's OWN resolver
# later reads — but that resolver never runs in a browser (web-worker
# resolvers only), so the signal would die. Write a marker file in the
# container instead; our devcontainer-orchestrator consumes it at the next resolve
# and passes the exact desktop flags to the devcontainer CLI
# (--remove-existing-container / --build-no-cache).
REBUILD_MARKERS = [
    ('registerCommand("remote-containers.rebuildContainer",async()=>{', '1'),
    ('registerCommand("remote-containers.rebuildContainerNoCache",async()=>{', 'nocache'),
]

def patch_rebuild_markers(ext_root):
    bundle = os.path.join(ext_root, 'dist', 'extension', 'extension.js')
    if not os.path.isfile(bundle):
        print(f"      ! WARN: {bundle} missing — Rebuild will only reload", file=sys.stderr)
        return
    text = open(bundle).read()
    for anchor, mode in REBUILD_MARKERS:
        inject = anchor + 'try{require("fs").writeFileSync("/tmp/remote-dev/rebuild","' + mode + '")}catch(e){}'
        if inject in text:
            continue
        if anchor not in text:
            print(f"      ! WARN: rebuild anchor not found ({mode}) — Rebuild will only reload",
                  file=sys.stderr)
            continue
        text = text.replace(anchor, inject, 1)
    open(bundle, 'w').write(text)

# "Reopen Folder Locally" in web, three fixes in one:
#  - the workspace URI inside the container's extension host is file://…
#    (the URI transformer strips the remote scheme), so the stock
#    `I.scheme === "vscode-remote"` guard silently never fires;
#  - the authority the handler needs is readable via env.remoteAuthority;
#  - and forceLocalWindow (remoteAuthority:null — the same "go local"
#    mechanism Close Remote Connection uses) makes openFolder navigate the
#    same window instead of a blank popup.
# Anchors are STRUCTURE regexes (command-id string + property names, which
# minifiers never rename) — no minified variable is ever guessed.
import re as _re

def patch_reopen_locally(ext_root):
    bundle = os.path.join(ext_root, 'dist', 'extension', 'extension.js')
    if not os.path.isfile(bundle):
        return
    text = open(bundle).read()
    if 'forceLocalWindow' in text:
        return
    head = _re.search(
        r'registerCommand\("remote-containers\.reopenLocally",async\(\)=>\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.workspace\.workspaceFolders,([A-Za-z_$][\w$]*)=',
        text)
    if not head:
        print("      ! WARN: reopenLocally handler anchor not found — "
              "Reopen Locally will not navigate", file=sys.stderr)
        return
    api, folder_var = head.group(2), head.group(3)
    # 1. accept the file:// workspace URI next to vscode-remote
    text, n1 = _re.subn(
        r'if\(' + folder_var + r'&&' + folder_var + r'\.scheme==="vscode-remote"\)',
        'if(' + folder_var + '&&(' + folder_var + '.scheme==="vscode-remote"||'
            + folder_var + '.scheme==="file"))',
        text, count=1)
    # 2. decode the authority from env.remoteAuthority first
    text, n2 = _re.subn(
        r'let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(' + folder_var + r'\.authority\);',
        'let \\1=\\2(' + api + '.env.remoteAuthority||' + folder_var + '.authority);',
        text, count=1)
    # 3. forceLocalWindow so openFolder goes local in the same window
    text, n3 = _re.subn(
        r'\.Uri\.file\(([A-Za-z_$][\w$]*)\.hostPath\),([A-Za-z_$][\w$]*)=\{forceReuseWindow:!0\}',
        '.Uri.file(\\1.hostPath),\\2={forceReuseWindow:!0,forceLocalWindow:!0}',
        text, count=1)
    if n1 + n2 + n3 < 3:
        print(f"      ! WARN: reopenLocally partial patch ({n1},{n2},{n3})",
              file=sys.stderr)
    open(bundle, 'w').write(text)

# The extension gates its local-window features on `!remoteName` — but on
# a serve-web master remoteName is the host:port authority (never empty),
# so "Reopen in Container" and friends never show there. A serve-web host
# window IS local for our purposes: make the clauses pass for host:port
# authorities (desktop behavior unchanged: remoteName empty → !remoteName).
def patch_remote_name_gates(ext_root):
    pkg_path = os.path.join(ext_root, 'package.json')
    text = open(pkg_path).read()
    old = '!remoteName &&'
    new = '(!remoteName || remoteName =~ /^[^:]+:[0-9]+$/) &&'
    if old in text:
        text = text.replace(old, new)
        open(pkg_path, 'w').write(text)

# The automatic "Folder contains a Dev Container configuration file"
# notification (Dz) returns early unless remoteName is
# undefined/wsl/ssh-remote/tunnel — never true on a serve-web master.
# Regex anchor: string literals only, the api var is captured.
DZ_RE = _re.compile(
    r'\[void 0,"wsl","ssh-remote","tunnel"\]\.indexOf\(([A-Za-z_$][\w$]*)\.env\.remoteName\)===-1')

def patch_reopen_notification(ext_root):
    bundle = os.path.join(ext_root, 'dist', 'extension', 'extension.js')
    if not os.path.isfile(bundle):
        return
    text = open(bundle).read()
    if '&&!(/:[0-9]+$/.test(' in text:
        return
    m = DZ_RE.search(text)
    if not m:
        print("      ! WARN: Dz guard anchor not found — the auto reopen "
              "notification will not fire on the master", file=sys.stderr)
        return
    text = text.replace(m.group(0), m.group(0)
        + f'&&!(/:[0-9]+$/.test({m.group(1)}.env.remoteName||""))', 1)
    open(bundle, 'w').write(text)

# The extension wraps a promise that resolves on its FIRST resolver call
# and shows "Dev Containers waiting for connection request" after 10s
# without one. In a browser its resolver is never consulted (web-worker
# resolvers only), so the notification would spin forever in every
# container window. Our resolver shim does the resolving instead — this
# notification is pure noise here. The anchor is the whole function's
# STRUCTURE (string literals + call shapes, no guessed minified names);
# the function name is captured and preserved.
PG_RE = _re.compile(
    r'function ([A-Za-z_$][\w$]*)\(e\)\{[A-Za-z_$][\w$]*\(\)&&\(async\(\)=>await Promise\.race\(\[e,'
    r'new Promise\([A-Za-z_$][\w$]*=>setTimeout\(\(\)=>[A-Za-z_$][\w$]*\("timeout"\),1e4\)\)\]\)'
    r'==="timeout"&&await [A-Za-z_$][\w$]*\.window\.withProgress\(\{.{0,500}?,async\(\)=>e\)\)\(\)\}')

def patch_connection_wait(ext_root):
    bundle = os.path.join(ext_root, 'dist', 'extension', 'extension.js')
    if not os.path.isfile(bundle):
        return
    text = open(bundle).read()
    m = PG_RE.search(text)
    if not m:
        if 'Dev Containers waiting for connection request' in text and 'no-op' not in text:
            print("      ! WARN: PG anchor not found — 'waiting for connection "
                  "request' will spin in container windows", file=sys.stderr)
        return
    # neutralize: same name, empty body — callers keep working
    name = m.group(1)
    text = (text[:m.start()]
            + f'function {name}(e){{/* remote-dev: no-op — the resolver shim answers */}}'
            + text[m.end():])
    open(bundle, 'w').write(text)

def install_folder(src, ext_dir, flip=False, label=None):
    pkg_path = os.path.join(src, 'package.json')
    pkg = json.load(open(pkg_path))
    flipped = False
    if flip:
        # see docstring, point 1: "ui" refuses server installs, "workspace"
        # runs on the server where Docker is. Verified by re-reading: a
        # silent no-flip means the extension NEVER activates server-side.
        pkg['extensionKind'] = ['workspace']
        json.dump(pkg, open(pkg_path, 'w'), separators=(',', ':'))
        check = json.load(open(pkg_path))
        if check.get('extensionKind') != ['workspace']:
            sys.exit(f"      ✗ FATAL: extensionKind flip failed for "
                     f"{pkg['publisher']}.{pkg['name']}: {check.get('extensionKind')}")
        flipped = True
    folder = f"{pkg['publisher']}.{pkg['name']}-{pkg['version']}"
    dest = os.path.join(ext_dir, folder)
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(src, dest)
    if flip:
        patch_rebuild_markers(dest)
        patch_reopen_locally(dest)
        patch_connection_wait(dest)
        patch_reopen_notification(dest)
        patch_remote_name_gates(dest)
    # our extensions are shown by their source folder name; id in parens
    shown = f"{label} ({pkg['publisher']}.{pkg['name']})" if label \
        else f"{pkg['publisher']}.{pkg['name']}"
    print(f"      ✓ {shown} {pkg['version']}"
          + (" (extensionKind flipped to workspace, verified)" if flipped else ""))

def regenerate_registry(ext_dir, devcontainer_uuid=None):
    entries = []
    for folder in sorted(os.listdir(ext_dir)):
        pj = os.path.join(ext_dir, folder, 'package.json')
        if not os.path.isfile(pj):
            continue
        pkg = json.load(open(pj))
        ext_id = f"{pkg['publisher']}.{pkg['name']}"
        uuid = devcontainer_uuid if ext_id == 'ms-vscode-remote.remote-containers' else None
        entries.append({
            "identifier": {"id": ext_id, "uuid": uuid},
            "version": pkg['version'],
            "location": {"$mid": 1, "path": os.path.join(ext_dir, folder), "scheme": "file"},
            "relativeLocation": folder,
            "metadata": {"isApplicationScoped": False, "installedTimestamp": int(time.time()*1000),
                         "source": "gallery" if uuid else "vsix", "updated": False,
                         "private": False, "isPreReleaseVersion": False, "hasPreReleaseVersion": False},
        })
    json.dump(entries, open(os.path.join(ext_dir, 'extensions.json'), 'w'))
    print(f"      ✓ extensions.json regenerated ({len(entries)} entries)")

if cmd == 'ms':
    vsix, vscode_dir, devcontainer_uuid = sys.argv[2:5]
    ext_dir = os.path.join(vscode_dir, 'srv', 'extensions')
    raw = open(vsix, 'rb').read()
    if raw[:2] == b'\x1f\x8b':          # marketplace sometimes serves it gzipped
        raw = gzip.decompress(raw)
    tmp = tempfile.mkdtemp()
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        z.extractall(tmp)
    install_folder(os.path.join(tmp, 'extension'), ext_dir, flip=True)
    regenerate_registry(ext_dir, devcontainer_uuid)
elif cmd == 'regen':
    vscode_dir, devcontainer_uuid = sys.argv[2:4]
    regenerate_registry(os.path.join(vscode_dir, 'srv', 'extensions'), devcontainer_uuid)
else:
    sys.exit(__doc__)
