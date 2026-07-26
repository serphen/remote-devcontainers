// remote-dev: dev-container authority resolver (web worker).
//
// WHY THIS EXTENSION EXISTS: on desktop, the Dev Containers extension
// resolves dev-container+<hex> from the node extension host. A browser
// workbench only consults WEB-WORKER resolvers (verified in the bundle:
// _resolveAuthorityOnExtensionHosts(LocalWebWorker, …)) — so the browser
// needs this half. It mirrors the desktop resolve flow 1:1:
//
//   1. decode the hex payload (hostPath, configFile, settings.context…)
//   2. "Connecting to Dev Container (show log)" progress notification,
//      fed by the host's build steps (desktop shows the same title)
//   3. the host devcontainer-orchestrator builds the container (Microsoft's
//      devcontainer CLI) and starts the standard server daemon in it
//   4. return a ManagedResolvedAuthority: the transport is a WebSocket to
//      the host bridge, which splices bytes to the container daemon —
//      the workbench's own protocol upgrade flows through untouched,
//      auth/reconnect included (exactly like the desktop relay, but
//      browser-reachable).
//
// Port forwarding (the desktop extension provides it via the tunnels
// proposal): our tunnelFactory maps a container port to a same-port TCP
// bind on the workbench's IP, reachable from any browser that reaches
// the workbench.

const vscode = require('vscode');

/** The workbench page's origin. The extension host worker runs from a
 *  blob: URL (location.origin === "null"), so relative fetches die — the
 *  reliable source is the file root the bootstrap leaves on globalThis. */
function pageOrigin() {
	if (globalThis._VSCODE_FILE_ROOT) {
		return new URL(globalThis._VSCODE_FILE_ROOT).origin;
	}
	if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
		return location.origin;
	}
	throw new Error('remote-dev: cannot determine the page origin');
}

/** dev-container+<hex>[@parent] → the payload JSON Microsoft encoded. */
function decodeAuthority(authority) {
	const plus = authority.indexOf('+');
	if (plus < 0) { throw new Error(`malformed dev-container authority: ${authority}`); }
	let hex = authority.slice(plus + 1);
	const at = hex.indexOf('@');
	if (at >= 0) { hex = hex.slice(0, at); }
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) { bytes[i] = parseInt(hex.substr(i * 2, 2), 16); }
	return JSON.parse(new TextDecoder('utf-8').decode(bytes));
}

/** attached-container+<hex>[@parent] → {containerName, settings, cwd}
 *  (Microsoft's codec, seen verbatim in their bundle). */
function decodeAttachedAuthority(authority) {
	const payload = decodeAuthority(authority);
	if (!payload || !payload.containerName) {
		throw new Error(`malformed attached-container authority: ${authority}`);
	}
	return payload;
}

/** The last successful resolve ({payload, ip, port, connectionToken}) —
 *  the tunnel factory needs the container IP and the workspace path. */
let lastAnswer;
let lastPayload;

/** The build's output channel — desktop shows the build log in a
 *  "Dev Containers" terminal; we stream the same lines here. */
let logChannel;

/**
 * POST the payload to the host devcontainer-orchestrator and wait — a first build
 * takes minutes (image pull). Poll /progress meanwhile: mirror the steps
 * into the notification and stream the log lines into the channel.
 */
async function callResolve(payload, progress) {
	// -1 = first poll starts at the END of the service's backlog: the
	// channel must hold THIS resolve's log only (desktop shows the current
	// build's log, not every build the host ever ran — verified live: old
	// builds leaked into the channel).
	let offset = -1;
	// Rolling tail of build lines. Desktop's "Dev Container is building"
	// notification shows the LAST LINES when its chevron expands — a bare
	// one-line message (what a naive report does) shows nothing useful.
	const tail = [];
	let lastStep;   // increment is CUMULATIVE — report it once per step change
	const tick = () =>
		fetch(pageOrigin() + '/api/remote-dev/progress?path='
			+ encodeURIComponent(payload.hostPath || payload.containerName || '')
			+ '&from=' + Math.max(offset, 0))
			.then((r) => (r.ok ? r.json() : undefined))
			.then((p) => {
				if (!p) { return; }
				if (offset < 0) { offset = p.next; return; }   // skip the backlog
				if (p.lines && p.lines.length) {
					for (const l of p.lines) { logChannel.appendLine(l); tail.push(l); }
					if (tail.length > 8) { tail.splice(0, tail.length - 8); }
					offset = p.next;
				}
				// desktop: the step TITLE (+ its increment, their determinate
				// bar) at each step change; the current build line(s) between
				const report = {};
				if (p.message && p.message !== lastStep) {
					lastStep = p.message;
					report.message = p.message;
					if (typeof p.increment === 'number') { report.increment = p.increment; }
				} else {
					const message = tail.length ? tail.join('\n') : (p.lastLine || p.message);
					if (message) { report.message = message; }
				}
				if (report.message || report.increment !== undefined) { progress.report(report); }
				return p;
			})
			.catch(() => { /* best effort */ });
	tick();   // NOW: the backlog skip must land before this resolve's lines
	const poll = setInterval(tick, 1000);
	try {
		const resp = await fetch(pageOrigin() + '/api/remote-dev/resolve', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!resp.ok) { throw new Error((await resp.text()) || `HTTP ${resp.status}`); }
		const answer = await resp.json();
		// drain: the tail lines (postAttach, the daemon-reuse note, the done
		// step) can land just AFTER the resolve answer — a single flush
		// races them (seen live: the build log missed its tail). Tick until
		// the service says done, or the log is stable (an error path never
		// says done), bounded at ~10 s.
		let lastNext = -1;
		let stable = 0;
		for (let i = 0; i < 20; i++) {
			const p = await tick();
			if (p && p.message === "done") { break; }
			if (p && p.next === lastNext) {
				if (++stable >= 2) { break; }
			} else {
				stable = 0;
				if (p) { lastNext = p.next; }
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		return answer;
	} finally {
		clearInterval(poll);
	}
}

/**
 * One managed connection to the container daemon, through the host
 * bridge. The workbench calls this once per protocol socket (Management,
 * ExtensionHost, reconnects…). The object below is the proposed API's
 * ManagedMessagePassing: send/end + onDidReceiveMessage/onDidClose/onDidEnd.
 */
function openManagedSocket(answer) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${pageOrigin().replace(/^http/, 'ws')}/api/remote-dev/bridge?ip=${answer.ip}&port=${answer.port}`);
		ws.binaryType = 'arraybuffer';
		const onMessage = new vscode.EventEmitter();
		const onClose = new vscode.EventEmitter();
		const onEnd = new vscode.EventEmitter();
		let settled = false;
		ws.onopen = () => {
			settled = true;
			resolve({
				send: (data) => ws.send(data),
				end: () => ws.close(),
				onDidReceiveMessage: onMessage.event,
				onDidClose: onClose.event,
				onDidEnd: onEnd.event,
			});
		};
		ws.onmessage = (e) => onMessage.fire(new Uint8Array(e.data));
		ws.onerror = () => {
			beep('bridge WebSocket failed');
			const err = new Error('remote-dev: bridge WebSocket failed');
			if (!settled) { settled = true; reject(err); }
			onClose.fire(err);
		};
		ws.onclose = () => {
			if (!settled) { settled = true; reject(new Error('remote-dev: bridge WebSocket closed before opening')); }
			onEnd.fire();
			onClose.fire(undefined);
		};
	});
}

function beep(msg) {
	try { fetch(`${pageOrigin()}/api/remote-dev/progress?path=x&beep=${encodeURIComponent(msg)}`).catch(() => {}); } catch (e) { /* ignore */ }
}

async function resolve(authority) {
	try {
		beep('resolveAuthority ' + authority.slice(0, 30));
		// attached-container+<hex> carries {containerName} (Attach to Running
		// Container); dev-container+<hex> carries the workspace payload
		const payload = authority.startsWith('attached-container+')
			? decodeAttachedAuthority(authority)
			: decodeAuthority(authority);
		// dotfiles: desktop reads them from the CLIENT settings — the
		// browser IS the client here, same keys
		try {
			const c = vscode.workspace.getConfiguration();
			const repository = c.get('dev.containers.dotfiles.repository')
				|| c.get('remote.containers.dotfiles.repository');
			if (repository) {
				payload.dotfiles = {
					repository,
					installCommand: c.get('dev.containers.dotfiles.installCommand')
						|| c.get('remote.containers.dotfiles.installCommand'),
					targetPath: c.get('dev.containers.dotfiles.targetPath')
						|| c.get('remote.containers.dotfiles.targetPath'),
				};
			}
		} catch { /* best effort */ }
		const runResolveWith = (p) => vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			// desktop shows the same title, with the same command link
			title: '[Connecting to Dev Container (show log)](command:remote-dev.showDevContainerLog)',
			cancellable: false,
		}, (progress) => callResolve(p, progress));
		let answer;
		try {
			answer = await runResolveWith(payload);
		} catch (e) {
			answer = await maybeStopHolderAndRetry(e, payload, runResolveWith);
		}
		beep(`resolved ${answer.ip}:${answer.port}`);
		// desktop parity: the extension sets this context key from its own
		// resolver path (which never runs in a browser) — "Reopen Folder
		// Locally" hides without it.
		vscode.commands.executeCommand('setContext', 'canReopenLocally', true);
		// desktop's bottom-left indicator: "Dev Container: <config name>"
		// (their setWorkspaceName — a per-authority label formatter that
		// beats the wildcard "Dev Container" one)
		try {
			vscode.workspace.registerResourceLabelFormatter({
				scheme: 'vscode-remote',
				authority,
				formatting: {
					label: '${path}',
					separator: '/',
					tildify: true,
					workspaceSuffix: answer.name ? `Dev Container: ${answer.name}` : 'Dev Container',
				},
			});
			beep(`label: Dev Container: ${answer.name || '(unnamed)'}`);
		} catch (e) {
			beep(`label formatter failed: ${(e && e.message) || e}`);
		}
		lastAnswer = answer;
		lastPayload = payload;
		return {
			makeConnection: () => openManagedSocket(answer),
			connectionToken: answer.connectionToken,
		};
	} catch (e) {
		beep('RESOLVE FAILED: ' + String((e && e.message) || e));
		throw e;
	}
}

function activate() {
	console.log('[remote-dev] resolver activated');
	// Reopen Folder Locally needs canReopenLocally (their when-clause).
	// After a rebuild the window can RECONNECT without a fresh
	// resolveAuthority — resolve() never runs there and the command would
	// vanish from the remote menu (seen live in 'all' runs). Set it in
	// every container window, deterministic.
	if (vscode.env && /^(dev-container|attached-container)$/.test(vscode.env.remoteName || '')) {
		vscode.commands.executeCommand('setContext', 'canReopenLocally', true);
	}
	logChannel = vscode.window.createOutputChannel('Dev Containers');
	vscode.commands.registerCommand('remote-dev.showDevContainerLog', () => logChannel.show(true));
	// "Stop Container" — stop, never delete; the next resolve's `up` starts
	// it again without a rebuild (desktop's explorer stop button parity).
	// Lives in the pink remote-indicator menu, next to Close Remote
	// Connection.
	vscode.commands.registerCommand('remote-dev.stopContainer', async () => {
		if (!lastPayload) { return; }
		try {
			const r = await fetch(pageOrigin() + '/api/remote-dev/stop-container', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					hostPath: lastPayload.hostPath,
					containerName: lastPayload.containerName,
					context: lastPayload.settings && lastPayload.settings.context,
				}),
			});
			if (!r.ok) { throw new Error((await r.text()) || `HTTP ${r.status}`); }
			vscode.window.showInformationMessage(
				'Container stopped — reopen the folder to start it again.');
		} catch (e) {
			vscode.window.showErrorMessage(`Stop container failed: ${(e && e.message) || e}`);
		}
	});

	// Port forwarding, browser edition. TWO surfaces, because the bundles
	// differ in what they honor:
	//  a) tunnelFactory on the RESOLVER object — the ext host picks it up
	//     after a successful resolve (setTunnelFactory in the resolver flow)
	//  b) vscode.workspace.registerTunnelProvider — the documented proposed
	//     API; if the bundle exposes it, register there too (first provider
	//     wins, ours is the only one)
	// Anti-loop: the allocator's own listeners are listening ports the
	// container's candidate finder can SEE (in tests the container IS the
	// host — seen live: 3900→3901→3902… infinite forwarding). Desktop's
	// tunnelModel excludes already-forwarded ports; we do the same for our
	// assigned front ports.
	const suppressPorts = new Set();
	const provideTunnel = async (tunnelOptions) => {
		beep(`provideTunnel called: ${JSON.stringify(tunnelOptions && tunnelOptions.remoteAddress)}`);
		if (!lastAnswer) { return undefined; }
		const port = tunnelOptions.remoteAddress.port;
		// The canonical forwarded address: <the workbench's IP>:SAME-PORT —
		// desktop's localhost:N, reachable from any device the workbench is
		// reachable from. A user-edited local port (localAddressPort) is
		// honored like desktop. NO fake fallback: if the host cannot bind,
		// throwing marks the tunnel failed instead of showing a dead
		// address (a row without a bind — raven's nc-refused).
		const r = await fetch(pageOrigin() + '/api/remote-dev/forward', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				hostPath: lastPayload && lastPayload.hostPath,
				containerName: lastPayload && lastPayload.containerName,
				volumeName: lastPayload && lastPayload.volumeName,
				port,
				frontPort: tunnelOptions.localAddressPort,
				context: lastPayload && lastPayload.settings && lastPayload.settings.context,
			}),
		});
		if (!r.ok) {
			const detail = await r.text().catch(() => '');
			throw new Error(`remote-dev: cannot forward port ${port} (${r.status}${detail ? `: ${detail}` : ''}) — see the Remote-Dev channel`);
		}
		const f = await r.json();
		if (!f.front || !f.frontIp) { throw new Error(`remote-dev: no bindable front port for ${port}`); }
		suppressPorts.add(f.front);   // our listener, not a user server
		// desktop look: bare host:port — the workbench adds http:// on open.
		// The OBJECT form matters: MainThreadTunnelService only derives
		// tunnelLocalPort from {host,port} — a string leaves it undefined,
		// which sets portChangable=false and HIDES "Change Local Address
		// Port" from the Ports context menu (found by DOM dump: the menu
		// simply never listed it).
		const localAddress = { host: f.frontIp, port: f.front };
		beep(`provideTunnel → ${f.frontIp}:${f.front}`);
		const disposeEmitter = new vscode.EventEmitter();
		let disposed = false;
		return {
			remoteAddress: tunnelOptions.remoteAddress,
			localAddress,
			public: false,
			onDidDispose: disposeEmitter.event,
			dispose: () => {
				if (disposed) { return; }
				disposed = true;
				// a REAL dispose: the no-op left the tunnel in the workbench's
				// map — retainOrCreateTunnel then handed the OLD tunnel back
				// on the next forward (raven: "editing the local port stays
				// on the old one"). Fire the event, and release the host
				// bind like desktop closing a row frees the local port.
				disposeEmitter.fire();
				disposeEmitter.dispose();
				suppressPorts.delete(f.front);
				fetch(pageOrigin() + '/api/remote-dev/unforward', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						hostPath: lastPayload && lastPayload.hostPath,
						containerName: lastPayload && lastPayload.containerName,
						volumeName: lastPayload && lastPayload.volumeName,
						port,
						// the bind THIS tunnel held: the orchestrator releases
						// only if the record is still exactly that — the edit's
						// re-forward may win the race, and it must survive
						frontPort: f.front,
						context: lastPayload && lastPayload.settings && lastPayload.settings.context,
					}),
				}).catch(() => {});
			},
		};
	};
	if (typeof vscode.workspace.registerTunnelProvider === 'function') {
		try {
			vscode.workspace.registerTunnelProvider({ provideTunnel }, {});
			beep('registerTunnelProvider: registered');
		} catch (e) {
			beep(`registerTunnelProvider FAILED: ${(e && e.message) || e}`);
		}
	} else {
		beep('registerTunnelProvider MISSING from the workspace API');
	}

	vscode.workspace.registerRemoteAuthorityResolver('dev-container', {
		resolve,
		// (a) the resolver-property form — read by setTunnelFactory in the
		// worker's resolver flow after a successful resolve (some bundles;
		// points at the same provideTunnel either way)
		tunnelFactory: provideTunnel,
		showCandidatePort: (host, port, detail) => {
			const d = String(detail || '');
			// OUR own processes, by IDENTITY (their cmdline path): the gate
			// relay and the daemon run on the daemon's node under
			// /tmp/remote-dev/vscode-server; the host orchestrator is
			// devcontainer-orchestrator.js. Always suppressed — never a row,
			// never a duplicate (raven: "certains ports deux fois").
			if (/remote-dev\/vscode-server|devcontainer-orchestrator/.test(d)) {
				return false;
			}
			// then the number-based anti-loop, ONLY for our shared-netns test
			// env (in a real container our host binds are invisible anyway):
			// suppress the number ONLY when no user-process detail names a
			// real server. NEVER a broad token: net.createServer also matches
			// a USER's `node -e` test server (raven: "ça détecte pas").
			if (!suppressPorts.has(port)) { return true; }
			beep(`showCandidatePort ${host}:${port} detail=${JSON.stringify(d)}`);
			// on one of OUR numbers: an unidentified candidate (no detail —
			// the shared-netns test env, where the finder can't map our
			// listeners) is probably ours → suppress. ANY user-process
			// detail = a real server on the same number (front == port is
			// the common case) → keep it visible, never the old number-wide
			// kill (raven's disappearing rows).
			return d !== '';
		},
	});
	// Attach to Running Container — same resolve, the service's attach path
	// (find by name, no build ever)
	vscode.workspace.registerRemoteAuthorityResolver('attached-container', {
		resolve,
		tunnelFactory: provideTunnel,
		showCandidatePort: (host, port, detail) => {
			const d = String(detail || '');
			if (/remote-dev\/vscode-server|devcontainer-orchestrator/.test(d)) {
				return false;
			}
			if (!suppressPorts.has(port)) { return true; }
			beep(`showCandidatePort ${host}:${port} detail=${JSON.stringify(d)}`);
			// on one of OUR numbers: an unidentified candidate (no detail —
			// the shared-netns test env, where the finder can't map our
			// listeners) is probably ours → suppress. ANY user-process
			// detail = a real server on the same number (front == port is
			// the common case) → keep it visible, never the old number-wide
			// kill (raven's disappearing rows).
			return d !== '';
		},
	});
}

exports.activate = activate;

/** A build/recreate died on "container X already publishes :PORT" — the two
 *  containers cannot share a host port (raven's hack vs scb_remote_vscode).
 *  Offer the two real ways out, right there: stop the holder, or rebind THIS
 *  project to ephemeral ports (a /tmp override — the user's compose file is
 *  never edited). Anything else rethrows. */
async function maybeStopHolderAndRetry(err, payload, runResolveWith) {
	const msg = String((err && err.message) || err);
	const m = msg.match(/container (\S+) already publishes :(\d+)/);
	if (!m) { throw err; }
	const [, holder, port] = m;
	const stop = `Stop ${holder} and retry`;
	const rebind = 'Rebind this project to free ports';
	const choice = await vscode.window.showErrorMessage(
		`Port ${port} is already published by "${holder}" — two containers cannot share a host port.`,
		{ modal: true },
		stop,
		rebind,
		'Cancel',
	);
	if (choice === stop) {
		beep(`port ${port}: the user chose to stop ${holder}`);
		const r = await fetch(`${pageOrigin()}/api/remote-dev/stop-container`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				containerName: holder,
				context: payload.settings && payload.settings.context,
			}),
		});
		if (!r.ok) {
			throw new Error(`could not stop ${holder} (${r.status}) — port ${port} is still held`);
		}
		beep(`${holder} stopped — retrying the resolve`);
		return runResolveWith(payload);
	}
	if (choice === rebind) {
		beep(`port ${port}: the user chose ephemeral ports for this project`);
		return runResolveWith({ ...payload, rebindPorts: true });
	}
	throw err;
}
