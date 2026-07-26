#!/usr/bin/env node
/**
 * e2e.js — browserless end-to-end simulation of the desktop flow.
 *
 * Plays the workbench against the REAL stack (caddy → devcontainer-orchestrator →
 * fake-docker "container" on this machine → real server daemon):
 *
 *   1. auth guards (401/403 where expected)
 *   2. the REAL resolver extension (scripts/remote-devcontainers-extension) with a
 *      stubbed vscode API — resolveAuthority end to end (fake build, REAL
 *      daemon download/install/launch)
 *   3. the workbench's managed-socket dance: protocol upgrade through the
 *      bridge (101), auth control, connectionType — exactly the bytes the
 *      workbench sends (Dnn + 13-byte protocol frames)
 *   4. reconnect (reconnection=true, same reconnectionToken)
 *   5. the caddy fwd route (Ports view URLs)
 *   6. patch effects in the server build (shim registered, allowlist,
 *      bootstrap gone)
 *
 * Env: E2E_BASE (default https://127.0.0.1:10000), E2E_TKN (front-door token).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const BASE = process.env.E2E_BASE || 'https://127.0.0.1:10000';
const TKN = process.env.E2E_TKN || '';
const RUNTIME = process.env.E2E_RUNTIME || '/tmp/rdv-test/runtime';
const COOKIE = `vscode-tkn=${TKN}`;

let failures = 0;
async function step(name, fn) {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failures++;
		console.error(`  ✗ ${name}\n    ${(e && e.stack) || e}`);
	}
}

// --- tiny helpers -------------------------------------------------------------

function req(method, p, { body, cookie = true } = {}) {
	return fetch(new URL(p, BASE), {
		method,
		headers: {
			...(cookie ? { cookie: COOKIE } : {}),
			...(body ? { 'content-type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

// 13-byte protocol frame: type(1) id(4) ack(4) dataLen(4) + data
function frame(type, id, ack, data) {
	const h = Buffer.alloc(13);
	h.writeUInt8(type, 0); h.writeUInt32BE(id, 1); h.writeUInt32BE(ack, 5); h.writeUInt32BE(data.length, 9);
	return Buffer.concat([h, data]);
}

/** A one-shot GET with NO connection reuse: undici's keep-alive pool holds
 *  the front-bind pipes open — a "dead" bind then still answers (pool
 *  reuse) and the test servers' close() never completes (EADDRINUSE on
 *  re-listen). Both were seen for real. */
function fetchOnce(url) {
	return new Promise((resolve, reject) => {
		const q = http.get(url, { agent: false }, (res) => {
			let d = '';
			res.on('data', (c) => { d += c; });
			res.on('end', () => resolve({ status: res.statusCode, text: d, headers: res.headers }));
		});
		q.on('error', reject);
	});
}

// --- nginx (n1-n5): a REAL external server as the upstream -------------------
// Driven with a minimal conf per port; absent → the n-steps skip cleanly.
const NGINX = fs.existsSync('/usr/sbin/nginx') ? '/usr/sbin/nginx' : '';
const nState = { front1: 0, front3: 0 }; // assignments shared across the n-steps

function nginxConf(port) {
	const conf = `/tmp/rdv-nginx-${port}.conf`;
	// the temp paths must point at /tmp: the compiled-in defaults live
	// under /var/lib/nginx, which a non-root e2e cannot create
	fs.writeFileSync(conf,
		`pid /tmp/rdv-nginx-${port}.pid;\nerror_log /tmp/rdv-nginx-${port}.err emerg;\n` +
		`events{}\nhttp {\n\taccess_log off;\n` +
		`\tclient_body_temp_path /tmp/rdv-nginx-${port}-body;\n\tproxy_temp_path /tmp/rdv-nginx-${port}-proxy;\n` +
		`\tfastcgi_temp_path /tmp/rdv-nginx-${port}-fastcgi;\n\tuwsgi_temp_path /tmp/rdv-nginx-${port}-uwsgi;\n` +
		`\tscgi_temp_path /tmp/rdv-nginx-${port}-scgi;\n` +
		`\tserver {\n\t\tlisten 127.0.0.1:${port};\n\t}\n}\n`);
	return conf;
}
function nginxStart(port) {
	require('child_process').execFileSync(NGINX, ['-c', nginxConf(port)]);
}
function nginxStop(port) {
	try {
		require('child_process').execFileSync(NGINX, ['-c', nginxConf(port), '-s', 'stop']);
	} catch {
		try { require('child_process').execSync(`pkill -f 'rdv-nginx-${port}[.]conf' || true`); } catch { /* already gone */ }
	}
}

/** The service's channel lines so far. Lines logged BETWEEN requests (the
 *  watchdog, the heal, the reconciler) exist only on the service's STDOUT
 *  — the /progress buffer is resolve-scoped (activePath resets after each
 *  resolve). The harness tees the whole stack to start.log. */
function channelText() {
	try { return fs.readFileSync(`${RUNTIME}/../start.log`, 'utf8'); } catch { return ''; }
}

/** Incremental frame reader over a managed connection. */
function frameReader(conn) {
	let buf = Buffer.alloc(0);
	const waiters = [];
	conn.onDidReceiveMessage((chunk) => {
		buf = Buffer.concat([buf, Buffer.from(chunk)]);
		pump();
	});
	function pump() {
		for (;;) {
			if (buf.length < 13) { return; }
			const len = buf.readUInt32BE(9);
			if (buf.length < 13 + len) { return; }
			const msg = { type: buf.readUInt8(0), id: buf.readUInt32BE(1), ack: buf.readUInt32BE(5), data: buf.subarray(13, 13 + len) };
			buf = buf.subarray(13 + len);
			const w = waiters.shift();
			if (w) { w(msg); }
		}
	}
	return () => new Promise((r) => waiters.push(r));
}

/** Raw byte reader (pre-framing: the HTTP upgrade response). */
function byteReader(conn) {
	let buf = Buffer.alloc(0);
	const waiters = [];
	conn.onDidReceiveMessage((chunk) => {
		buf = Buffer.concat([buf, Buffer.from(chunk)]);
		for (const w of waiters.splice(0)) { w(buf); }
	});
	return {
		async until(needle, timeoutMs = 15000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const i = buf.indexOf(needle);
				if (i >= 0) { const out = buf.subarray(0, i + needle.length); buf = buf.subarray(i + needle.length); return out; }
				if (Date.now() > deadline) { throw new Error(`timeout waiting for ${JSON.stringify(needle)} — got: ${buf.toString('latin1').slice(0, 300)}`); }
				await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
			}
		},
		rest: () => buf,
	};
}

// --- the workbench's upgrade request (Dnn in workbench.js) --------------------
function upgradeRequest(reconnectionToken, reconnecting) {
	const key = crypto.randomBytes(16).toString('base64');
	return Buffer.from(
		`GET ws://localhost/?reconnectionToken=${reconnectionToken}&reconnection=${reconnecting ? 'true' : 'false'}&skipWebSocketFrames=true HTTP/1.1\r\n`
		+ 'Connection: Upgrade\r\n'
		+ 'Upgrade: websocket\r\n'
		+ `Sec-WebSocket-Key: ${key}\r\n\r\n`);
}

// --- load the REAL resolver extension with a stubbed vscode API ---------------
function loadShim() {
	class EventEmitter {
		constructor() { this.ls = []; }
		get event() { return (cb) => { this.ls.push(cb); return { dispose() {} }; }; }
		fire(x) { for (const l of this.ls) { l(x); } }
		dispose() {}
	}
	let captured;
	const capturedFormatters = [];
	const channelSink = [];   // every line the extension writes to its channel
	const errorMessages = []; // every showErrorMessage call (args)
	let promptChoice;         // what the "user" clicks in prompts
	const vscode = {
		EventEmitter,
		ProgressLocation: { Notification: 15 },
		window: {
			withProgress: (_opts, cb) => cb({ report() {} }),
			createOutputChannel: () => ({ appendLine: (l) => channelSink.push(l), show() {} }),
			showInformationMessage: () => Promise.resolve(),
			showErrorMessage: (...args) => { errorMessages.push(args); return Promise.resolve(promptChoice); },
		},
		commands: { executeCommand: () => Promise.resolve(), registerCommand: () => ({ dispose() {} }) },
		workspace: {
			registerRemoteAuthorityResolver: (_scheme, r) => { captured = r; },
			registerResourceLabelFormatter: (f) => { capturedFormatters.push(f); return { dispose() {} }; },
			getConfiguration: () => ({
				get: (k) => (k === 'dev.containers.dotfiles.repository'
					|| k === 'remote.containers.dotfiles.repository'
					? 'https://example.com/dotfiles.git' : undefined),
			}),
		},
	};
	const src = fs.readFileSync(path.join(__dirname, '../scripts/remote-devcontainers-extension/extension.js'), 'utf8');
	const module_ = { exports: {} };
	new Function('require', 'module', 'exports', src)(
		(name) => (name === 'vscode' ? vscode : require(name)), module_, module_.exports);
	module_.exports.activate();
	if (!captured) { throw new Error('the shim did not register a resolver'); }
	return {
		resolver: captured,
		channelSink,
		getFormatters: () => capturedFormatters,
		errorMessages,
		setPromptChoice: (c) => { promptChoice = c; },
	};
}

// --- the test sequence ---------------------------------------------------------

const PAYLOAD = {
	hostPath: '/tmp/fake-ws',
	localDocker: false,
	settings: { context: 'test' },
	configFile: {
		$mid: 1,
		fsPath: '/tmp/fake-ws/.devcontainer/devcontainer.json',
		path: '/tmp/fake-ws/.devcontainer/devcontainer.json',
		scheme: 'file',
	},
};

async function main() {
	console.log(`e2e against ${BASE}`);

	await step('guards: /resolve without cookie → 401', async () => {
		const r = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD, cookie: false });
		assert.strictEqual(r.status, 401);
	});

	await step('guards: /progress without cookie → 401', async () => {
		const r = await fetch(new URL('/api/remote-dev/progress?path=x', BASE));
		assert.strictEqual(r.status, 401);
	});

	await step('enter link: one-time token → cookie → clean URL, replay is dead', async () => {
		// run.sh start() mints at least one OTT (the printed enter links)
		const ottFile = `${RUNTIME}/microsoft/vscode/serve-web.ott`;
		const ott = fs.readFileSync(ottFile, 'utf8').split('\n').filter(Boolean)[0];
		assert.ok(ott, 'an enter link was minted at start');
		const r = await fetch(new URL(`/api/remote-dev/enter?ott=${ott}`, BASE),
			{ redirect: 'manual' });
		assert.strictEqual(r.status, 302, `expected a redirect, got ${r.status}`);
		assert.strictEqual(r.headers.get('location'), '/', 'redirects to the CLEAN url');
		const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
		assert.strictEqual(cookie, `vscode-tkn=${TKN}`,
			'the cookie carries the REAL token (never the URL again)');
		// burned: the same link can never be replayed
		const r2 = await fetch(new URL(`/api/remote-dev/enter?ott=${ott}`, BASE),
			{ redirect: 'manual' });
		assert.strictEqual(r2.status, 401, 'the OTT is one-time');
		// and the cookie alone opens the caddy gate
		const r3 = await fetch(new URL('/api/remote-dev/progress?path=x', BASE),
			{ headers: { cookie } });
		assert.strictEqual(r3.status, 200, 'the enter-link cookie opens the gate');
	});

	// cookie + tkn-query auth for the shim in node (the browser sends the
	// cookie itself; node's WebSocket cannot set headers — the service also
	// accepts ?tkn=, which is what this exercises)
	const realFetch = globalThis.fetch;
	globalThis.fetch = (u, o = {}) => realFetch(new URL(u, BASE), {
		...o,
		headers: { ...o.headers, cookie: COOKIE },
	});
	const RealWS = globalThis.WebSocket;
	globalThis.WebSocket = class extends RealWS {
		constructor(url, ...rest) {
			super(String(url) + (String(url).includes('?') ? '&' : '?') + 'tkn=' + encodeURIComponent(TKN), ...rest);
		}
	};
	globalThis.location = { origin: BASE };

	const shim = loadShim();
	let authority;
	await step('shim: resolveAuthority end to end (fake build, REAL daemon)', async () => {
		const hex = Buffer.from(JSON.stringify(PAYLOAD), 'utf8').toString('hex');
		authority = await shim.resolver.resolve(`dev-container+${hex}`);
		assert.strictEqual(typeof authority.makeConnection, 'function', 'managed authority shape');
		assert.ok(/^[0-9A-Za-z_-]+$/.test(authority.connectionToken), 'connectionToken charset');
		console.log(`    → daemon at the container IP, token ${authority.connectionToken.slice(0, 8)}…`);
	});

	await step('rescue: the CLI\'s swallowed `compose up -d` failure is re-run directly', async () => {
		// FAKE_UP_FAIL_ONCE made the first `up` die the way production did
		// (generic CLI wrapper error, docker stderr hidden). The resolve
		// still succeeded above — proof the direct re-run healed it. The
		// re-run is the ONLY thing that ever invokes `docker compose` here
		// (the fake CLI never calls docker), so its trace in the docker log
		// is the assertion.
		const dockerLog = fs.readFileSync(`${process.env.FAKE_STATE}/docker-args.log`, 'utf8');
		assert.ok(/docker compose .*up -d/.test(dockerLog),
			`direct compose re-run missing from:\n${dockerLog}`);
		assert.ok(dockerLog.includes('--force-recreate'),
			'the re-run must force a full converge (a plain up just starts the half-created container)');
		const cliLog = fs.readFileSync(`${process.env.FAKE_STATE}/cli-args.log`, 'utf8');
		assert.ok(fs.existsSync(`${process.env.FAKE_STATE}/up-failed`), 'the failure was injected');
		assert.ok(cliLog.includes('up --workspace-folder'), 'CLI up attempted');
	});

	await step('rescue: container IP found despite the post-start network lag', async () => {
		// the fake docker answered the first post-build inspect OrbStack-style
		// (Running, Networks={}); without the retry the resolve above would
		// have died with 'container has no IP'
		assert.ok(fs.existsSync(`${process.env.FAKE_STATE}/inspect-lag`), 'lag was injected');
	});

	await step('rescue: half-created container (never network-attached) healed via rm + recreate', async () => {
		// broken-net made every inspect answer Running + Networks={} — the
		// exact OrbStack state from production (container with only `lo`,
		// network's Containers map empty). The resolve above still found an
		// IP, which is only possible through the rm + fresh up heal.
		const dockerLog = fs.readFileSync(`${process.env.FAKE_STATE}/docker-args.log`, 'utf8');
		assert.ok(/docker (?:--context \S+ )?rm -f/.test(dockerLog), `rm -f missing from:\n${dockerLog}`);
		assert.ok(!fs.existsSync(`${process.env.FAKE_STATE}/broken-net`), 'broken-net cleared by the heal');
	});

	await step('rescue: /progress carries the rescue lines (the UI channel reads them)', async () => {
		const r = await req('GET', `/api/remote-dev/progress?path=${encodeURIComponent(PAYLOAD.hostPath)}&from=0`);
		assert.strictEqual(r.status, 200);
		const p = await r.json();
		const text = (p.lines || []).join('\n');
		for (const phrase of ['re-running its last command',
			'WITHOUT a network attachment', 're-creating once']) {
			assert.ok(text.includes(phrase), `missing from /progress: ${phrase}`);
		}
	});

	await step('rescue: the extension channel shows the same lines (what the user sees)', async () => {
		// the resolve above streamed /progress into the extension's output
		// channel — the user-facing surface. Same phrases must be there.
		const text = shim.channelSink.join('\n');
		console.log(`    ↳ extension channel holds ${shim.channelSink.length} lines`);
		for (const phrase of ['re-running its last command',
			'WITHOUT a network attachment', 're-creating once']) {
			assert.ok(text.includes(phrase), `missing from the extension channel: ${phrase}`);
		}
	});

	const daemonCommit = JSON.parse(fs.readFileSync(
		fs.globSync('/tmp/remote-dev/vscode-server/bin/*/product.json')[0], 'utf8')).commit;

	async function handshake(reconnectionToken, reconnecting) {
		const conn = await authority.makeConnection();
		const bytes = byteReader(conn);
		conn.send(upgradeRequest(reconnectionToken, reconnecting));
		const head = await bytes.until('\r\n\r\n');
		assert.ok(head.toString('latin1').startsWith('HTTP/1.1 101'), `upgrade answered 101 (got ${head})`);
		return conn;
	}

	await step('attach: attached-container+<hex> resolves into the running container', async () => {		// Microsoft's codec: attached-container+<hex(JSON{containerName})> —
		// Attach to Running Container must find it by name (never build) and
		// reuse the daemon the first resolve installed
		const payload = { containerName: 'fakecontainer', settings: { context: 'test' } };
		const hex = Buffer.from(JSON.stringify(payload), 'utf8').toString('hex');
		const answer = await shim.resolver.resolve(`attached-container+${hex}`);
		assert.strictEqual(typeof answer.makeConnection, 'function', 'managed authority shape');
		assert.ok(/^[0-9A-Za-z_-]+$/.test(answer.connectionToken), 'connectionToken charset');
		const dockerLog = fs.readFileSync(`${process.env.FAKE_STATE}/docker-args.log`, 'utf8');
		assert.ok(dockerLog.includes('name=fakecontainer'), 'lookup by container name');
		assert.ok(!dockerLog.split('name=fakecontainer')[1].includes('devcontainer up'),
			'attach never builds');
	});

	await step('robustness: malformed authority rejects fast, never hangs', async () => {
		const deadline = Date.now() + 10_000;
		let rejected = false;
		try {
			await shim.resolver.resolve('dev-container+zzzz-not-hex');
		} catch {
			rejected = true;
		}
		assert.ok(rejected, 'malformed authority must reject');
		assert.ok(Date.now() < deadline, 'rejection took >10s (hang?)');
	});

	await step('robustness: garbage /resolve payload → clean 502, not a crash', async () => {
		const r = await req('POST', '/api/remote-dev/resolve', { body: { nonsense: true } });
		assert.strictEqual(r.status, 502, `expected 502, got ${r.status}`);
	});

	await step('robustness: bridge without auth → refused or unseen', async () => {
		// a plain GET is not an upgrade — 404 (no route) is also a refusal
		const r = await fetch(new URL('/api/remote-dev/bridge?ip=192.168.97.2&port=10001', BASE));
		assert.ok([401, 403, 404].includes(r.status), `expected 401/403/404, got ${r.status}`);
	});

	await step('robustness: bridge to a non-resolved private IP → 403 (no SSRF)', async () => {
		// the bridge dials query-param targets: only containers WE resolved.
		// PRIVATE_IP alone would make it a LAN proxy for any token holder.
		const res = await new Promise((resolve, reject) => {
			const q = require('https').request({
				hostname: '127.0.0.1', port: 10000,
				path: '/api/remote-dev/bridge?ip=10.255.255.1&port=10001',
				headers: {
					cookie: COOKIE, connection: 'Upgrade', upgrade: 'websocket',
					'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
				},
			}, resolve);
			q.on('error', reject);
			q.end();
		});
		assert.strictEqual(res.statusCode, 403, `expected 403, got ${res.statusCode}`);
	});

	await step('robustness: /forward refuses an out-of-range port', async () => {
		const r = await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 99999, context: 'test' },
		});
		assert.ok(r.status === 400 || r.status === 500, `expected 400/500, got ${r.status}`);
	});

	await step('robustness: two parallel resolves of the same payload both land', async () => {
		const [a, b] = await Promise.all([
			req('POST', '/api/remote-dev/resolve', { body: PAYLOAD }).then((r) => r.status),
			req('POST', '/api/remote-dev/resolve', { body: PAYLOAD }).then((r) => r.status),
		]);
		assert.strictEqual(a, 200, `first resolve: ${a}`);
		assert.strictEqual(b, 200, `second resolve: ${b}`);
	});

	await step('flow: the call sequence matches the desktop skeleton, line by line', async () => {
		// The desktop resolver's pipeline (their bundle, dist/extension):
		// find container → build if missing → re-find → arch/libc probes →
		// server install → token → user probe → MS extension → launch →
		// customized extensions → postAttach. docker-args.log has EVERY
		// docker call in true order — walk the desktop milestones in order.
		const dockerLog = fs.readFileSync(`${process.env.FAKE_STATE}/docker-args.log`, 'utf8');
		const cliLog = fs.readFileSync(`${process.env.FAKE_STATE}/cli-args.log`, 'utf8');
		const skeleton = [
			'ps --filter label=devcontainer.local_folder',   // locate (their resolver does it too)
			'ps --filter label=devcontainer.local_folder',   // re-find after the build
			'inspect',                                       // IP (their containerProperties)
			'uname -m',                                      // arch probe
			'ldd --version',                                 // libc probe (musl vs glibc — theirs too)
			'vscode-server/bin/',                            // server dest bin/<commit> (their piece 09/10)
			'artifact.tgz',                                  // the server artifact pushed
			'tar xzf',                                       // extracted in place
			'tkn-tmp',                                       // the connection token (their token write)
			'Config.User',                                   // the container's user probe
			'ms-vscode-remote.remote-containers',            // their extension into the daemon
			'extensions.json',                               // …registered
			'nohup /tmp/remote-dev/serve.sh',                // launch (their shellServer launch)
			"--install-extension 'dbaeumer.vscode-eslint'",  // customizations.vscode.extensions
			'echo ATTACHED-OK',                              // postAttachCommand, last
		];
		let at = -1;
		for (const mark of skeleton) {
			const p = dockerLog.indexOf(mark, at + 1);
			assert.ok(p > at, `milestone missing or out of order: "${mark}"`);
			at = p;
		}
		// the build itself is Microsoft's CLI (the desktop engine)
		assert.ok(cliLog.includes('up --workspace-folder'), 'the build ran through the CLI');
		// desktop passes these on every up (their config tracking)
		assert.ok(cliLog.includes('--include-configuration'), '--include-configuration (desktop flag)');
		assert.ok(cliLog.includes('--include-merged-configuration'), '--include-merged-configuration (desktop flag)');
	});

	await step('flow: the UI steps are the desktop ones, in order (their titles verbatim)', async () => {
		// their bundle: "Building image" → "Starting container" →
		// "Installing server" → "Starting server" (rue={2..5}). The UI must
		// show exactly these, in this order.
		const r = await req('GET', `/api/remote-dev/progress?path=${encodeURIComponent(PAYLOAD.hostPath)}&from=0`);
		const steps = ((await r.json()).steps || []);
		for (const expected of ['Building image', 'Starting container', 'Installing server', 'Starting server']) {
			const idx = steps.findIndex((s) => s.startsWith(expected));
			assert.ok(idx >= 0, `UI step missing: "${expected}" (steps seen: ${JSON.stringify(steps)})`);
			steps.splice(0, idx + 1);
		}
	});

	await step('label: the indicator gets the container name, like desktop', async () => {
		// desktop: setWorkspaceName registers a per-authority formatter with
		// "Dev Container: <devcontainer.json name>" — beats the wildcard one
		const f = shim.getFormatters()
			.find((x) => x.authority.startsWith('dev-container+'));
		assert.ok(f, `no dev-container formatter in ${JSON.stringify(shim.getFormatters())}`);
		assert.strictEqual(f.formatting.workspaceSuffix, 'Dev Container: Fake Test Container',
			`workspaceSuffix should carry the config name, got ${f.formatting.workspaceSuffix}`);
	});

	await step('protocol: upgrade through bridge → 101, auth → sign, connectionType', async () => {
		const conn = await handshake('e2e-token-1', false);
		const next = frameReader(conn);
		conn.send(frame(2, 0, 0, Buffer.from(JSON.stringify({
			type: 'auth', auth: authority.connectionToken, data: crypto.randomBytes(16).toString('base64'),
		}))));
		const sign = await next();
		const signJson = JSON.parse(sign.data.toString('utf8'));
		assert.strictEqual(signJson.type, 'sign', `expected sign, got ${signJson.type} (${signJson.reason || ''})`);
		// the server also accepts the connection token itself as signedData
		// (its documented branch for clients that cannot vsda-sign).
		conn.send(frame(2, 0, 0, Buffer.from(JSON.stringify({
			type: 'connectionType', commit: daemonCommit, signedData: authority.connectionToken, desiredConnectionType: 1,
		}))));
		// accepted = anything but an error control within a few seconds
		const verdict = await Promise.race([
			next().then((m) => ({ m })),
			new Promise((r) => setTimeout(() => r({ timeout: true }), 5000)),
		]);
		if (verdict.m) {
			const j = JSON.parse(verdict.m.data.toString('utf8'));
			assert.notStrictEqual(j.type, 'error', `connectionType refused: ${j.reason}`);
			console.log(`    → first server message: ${j.type}`);
		}
		conn.end();
	});

	await step('protocol: reconnect with the same reconnectionToken → 101, no error', async () => {
		const conn = await handshake('e2e-token-1', true);
		const next = frameReader(conn);
		const verdict = await Promise.race([
			next().then((m) => ({ m })),
			new Promise((r) => setTimeout(() => r({ timeout: true }), 3000)),
		]);
		if (verdict.m) {
			const j = JSON.parse(verdict.m.data.toString('utf8'));
			assert.notStrictEqual(j.type, 'error', `reattach refused: ${j.reason}`);
		}
		conn.end();
	});

	await step('phase 3: ms extension pre-installed in the daemon (with rebuild patch)', async () => {
		const extDir = fs.globSync('/tmp/remote-dev/vscode-server/extensions/ms-vscode-remote.remote-containers-*/')[0].replace(/\/?$/, '/');
		assert.ok(extDir, 'extension folder present in the daemon');
		assert.ok(fs.existsSync(`${extDir}package.json`), 'package.json present');
		const registry = JSON.parse(fs.readFileSync('/tmp/remote-dev/vscode-server/extensions/extensions.json', 'utf8'));
		assert.ok(registry.some((e) => e.identifier && e.identifier.id === 'ms-vscode-remote.remote-containers'),
			'registry entry');
		const dist = fs.readFileSync(`${extDir}dist/extension/extension.js`, 'utf8');
		assert.ok(dist.includes('/tmp/remote-dev/rebuild'), 'rebuild marker patch present in the bundle');
		const pkg = JSON.parse(fs.readFileSync(`${extDir}package.json`, 'utf8'));
		assert.deepStrictEqual(pkg.extensionKind, ['workspace'], 'flipped extensionKind');
	});

	await step('phase 3: customized extensions installed async (never blocking startup)', async () => {
		const serve = fs.readFileSync('/tmp/remote-dev/serve.sh', 'utf8');
		assert.ok(!serve.includes('--install-extension'), 'launch args stay clean (sync install hangs the agent)');
		// the async installer runs in background — poll for its marker/result
		const deadline = Date.now() + 60000;
		let found = false;
		while (Date.now() < deadline && !found) {
			found = fs.existsSync('/tmp/remote-dev/vscode-server/extensions/dbaeumer.vscode-eslint-3.0.34')
				|| fs.globSync('/tmp/remote-dev/vscode-server/extensions/dbaeumer.vscode-eslint-*').length > 0
				|| fs.globSync('/tmp/remote-dev/.ext-*').length > 0;
			if (!found) { await new Promise((r) => setTimeout(r, 2000)); }
		}
		assert.ok(found, 'dbaeumer.vscode-eslint installed by the background installer');
	});

	await step('phase 3: rebuild marker → CLI rebuild flags (desktop semantics)', async () => {
		fs.writeFileSync('/tmp/remote-dev/rebuild', '1');
		const r = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD });
		assert.strictEqual(r.status, 200, await r.text());
		const cliLog = fs.readFileSync(`${process.env.FAKE_STATE}/cli-args.log`, 'utf8');
		assert.ok(cliLog.includes('up --workspace-folder /tmp/fake-ws --remove-existing-container'),
			'--remove-existing-container passed to the CLI');
		assert.ok(!fs.existsSync('/tmp/remote-dev/rebuild'), 'marker consumed');
	});

	await step('phase 3: rebuild marker nocache → desktop no-cache flags', async () => {
		fs.writeFileSync('/tmp/remote-dev/rebuild', 'nocache');
		const r = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD });
		assert.strictEqual(r.status, 200, await r.text());
		const cliLog = fs.readFileSync(`${process.env.FAKE_STATE}/cli-args.log`, 'utf8');
		// the LAST `up` line (read-configuration runs after the build — don't
		// just read the tail of the log)
		const ups = cliLog.trim().split('\n').filter((l) => l.startsWith('up '));
		const nocacheUp = ups[ups.length - 1] || '';
		assert.ok(nocacheUp.includes('--remove-existing-container') && nocacheUp.includes('--build-no-cache'),
			`nocache flags missing from: ${nocacheUp}`);
		assert.ok(!fs.existsSync('/tmp/remote-dev/rebuild'), 'marker consumed');
	});

	await step('rescue: recreate dying on OUR squatted bind → released, retried, healed (raven\'s 8080)', async () => {
		// production shape: the workbench forwarded a port, the next recreate
		// re-publishes it, docker dies with "port is already allocated" and
		// the CLI hides all of it. The rescue must release OUR bind on the
		// named port and retry — not leave the user with a dead window.
		const net = require('net');
		const r = await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 13130, context: 'test' },
		});
		const f = await r.json();
		assert.strictEqual(r.status, 200, JSON.stringify(f));
		assert.strictEqual(f.front, 13130, `front should be the free same port: ${JSON.stringify(f)}`);
		const held = await new Promise((resolve) => {
			const s = net.connect(13130, '127.0.0.1', () => { s.destroy(); resolve(true); });
			s.on('error', () => resolve(false));
			setTimeout(() => { s.destroy(); resolve(false); }, 3000);
		});
		assert.ok(held, 'the service holds 13130 before the recreate');
		// arm the one-shot failures and make the container vanish (a rebuild
		// path would release binds UPFRONT — this tests the rescue path)
		fs.writeFileSync(`${process.env.FAKE_STATE}/up-fail-armed`, '1');
		fs.writeFileSync(`${process.env.FAKE_STATE}/compose-port-fail`, '13130');
		fs.rmSync(`${process.env.FAKE_STATE}/built`, { force: true });
		const rr = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD });
		assert.strictEqual(rr.status, 200, await rr.text());
		assert.ok(!fs.existsSync(`${process.env.FAKE_STATE}/compose-port-fail`),
			'the injected compose failure fired (and was retried past)');
		const freed = await new Promise((resolve) => {
			const s = net.connect(13130, '127.0.0.1', () => { s.destroy(); resolve(false); });
			s.on('error', () => resolve(true));
			setTimeout(() => { s.destroy(); resolve(false); }, 3000);
		});
		assert.ok(freed, 'our bind on 13130 was released for the recreate');
		const p = await (await req('GET', `/api/remote-dev/progress?path=${encodeURIComponent(PAYLOAD.hostPath)}&from=0`)).json();
		assert.ok((p.lines || []).join('\n').includes('squatted by OUR forward'),
			'the channel narrates the release (what the user sees)');
	});

	await step('rescue: recreate dying on an EXTERNAL squatter → the error NAMES it', async () => {
		// a bare "port is already allocated" is a dead end ("je suis censé
		// faire quoi avec ça") — the thrown error must say WHO holds the port
		const net2 = require('net');
		const squatter = net2.createServer(() => {});
		await new Promise((r) => squatter.listen(13132, '127.0.0.1', r));
		try {
			fs.writeFileSync(`${process.env.FAKE_STATE}/up-fail-armed`, '1');
			fs.writeFileSync(`${process.env.FAKE_STATE}/compose-port-fail`, '13132:2');
			fs.rmSync(`${process.env.FAKE_STATE}/built`, { force: true });
			const rr = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD });
			const text = await rr.text();
			assert.ok(rr.status !== 200, `the resolve must fail (got ${rr.status})`);
			assert.ok(text.includes('port 13132 is held by'),
				`the error names the holder, got:\n${text.slice(-400)}`);
		} finally {
			squatter.close();
		}
		// leave a healthy container for the following steps
		const heal = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD });
		assert.strictEqual(heal.status, 200, await heal.text());
	});

	await step('rescue: OrbStack release lag (self-squat on recreate) → wait + retry heals', async () => {
		// raven: "le container se squatte en bootant deux fois?" — OrbStack's
		// proxy can hold the publish briefly after the old container dies.
		// TRANSIENT: no container publishes → the rescue must wait and retry,
		// NOT fail with a named holder. The error is emitted in its IPv6 form
		// ("Bind for :::PORT") — docker reports either family (seen live:
		// 0.0.0.0 one day, ::: the next, on the same recreate)
		fs.writeFileSync(`${process.env.FAKE_STATE}/up-fail-armed`, '1');
		fs.writeFileSync(`${process.env.FAKE_STATE}/compose-port-fail`, '13134:1:v6');
		fs.rmSync(`${process.env.FAKE_STATE}/built`, { force: true });
		const rr = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD });
		assert.strictEqual(rr.status, 200, await rr.text());
		const p = await (await req('GET', `/api/remote-dev/progress?path=${encodeURIComponent(PAYLOAD.hostPath)}&from=0`)).json();
		assert.ok((p.lines || []).join('\n').includes('release lag'),
			'the channel narrates the release-lag retry');
	});

	await step('port held by another container → prompt offers Stop-and-retry, and it works', async () => {
		// raven's hack vs scb_remote_vscode: the recreate dies on "container
		// X already publishes :PORT". The shim must OFFER to stop the holder
		// and retry — not just fail with a named error (his ask: "une UI
		// pour demander quoi faire").
		fs.writeFileSync(`${process.env.FAKE_STATE}/up-fail-armed`, '1');
		fs.writeFileSync(`${process.env.FAKE_STATE}/compose-port-fail`, '13136:2');
		fs.writeFileSync(`${process.env.FAKE_STATE}/publish-holder`, '1');
		fs.rmSync(`${process.env.FAKE_STATE}/built`, { force: true });
		shim.setPromptChoice('Stop holdercontainer and retry');
		const hex = Buffer.from(JSON.stringify(PAYLOAD), 'utf8').toString('hex');
		const authority = await shim.resolver.resolve(`dev-container+${hex}`);
		assert.ok(authority && authority.connectionToken,
			'the resolve landed after the holder was stopped');
		const prompts = shim.errorMessages.map((a) => String(a[0]));
		assert.ok(prompts.some((p) => p.includes('13136') && p.includes('holdercontainer')),
			`the prompt names the port and the holder: ${JSON.stringify(prompts)}`);
		const dockerLog = fs.readFileSync(`${process.env.FAKE_STATE}/docker-args.log`, 'utf8');
		assert.ok(/docker (?:--context \S+ )?stop/.test(dockerLog),
			'the holder was stopped through docker stop');
		shim.setPromptChoice(undefined);
	});

	await step('port held by another container → "Rebind to free ports" heals via a /tmp override', async () => {
		// the OTHER way out (raven: "rebind le NOUVEAU container en patchant
		// tous les ports d'un coup, dans un /tmp"): the shim offers it, the
		// orchestrator generates an ephemeral-ports override from `compose
		// config` and retries the up with it — the user's compose is never
		// edited. (up-fail-always: the shim's retry must also fail once, so
		// the rescue runs with the flag.)
		fs.writeFileSync(`${process.env.FAKE_STATE}/up-fail-always`, '1');
		fs.writeFileSync(`${process.env.FAKE_STATE}/compose-port-fail`, '13136:2');
		fs.writeFileSync(`${process.env.FAKE_STATE}/publish-holder`, '1');
		fs.rmSync(`${process.env.FAKE_STATE}/built`, { force: true });
		shim.setPromptChoice('Rebind this project to free ports');
		try {
			const hex = Buffer.from(JSON.stringify(PAYLOAD), 'utf8').toString('hex');
			const authority = await shim.resolver.resolve(`dev-container+${hex}`);
			assert.ok(authority && authority.connectionToken,
				'the resolve landed with ephemeral ports');
		} finally {
			fs.rmSync(`${process.env.FAKE_STATE}/up-fail-always`, { force: true });
			fs.rmSync(`${process.env.FAKE_STATE}/publish-holder`, { force: true });
			shim.setPromptChoice(undefined);
		}
		const dockerLog = fs.readFileSync(`${process.env.FAKE_STATE}/docker-args.log`, 'utf8');
		assert.ok(/compose .*rdv-ephemeral-[^ ]+\.yml .*up -d/.test(dockerLog),
			'the compose up ran with the generated /tmp override');
		const prompts = shim.errorMessages.map((a) => String(a[0]));
		assert.ok(prompts.some((p) => p.includes('13136') && p.includes('holdercontainer')),
			'the prompt named the port and the holder');
	});

	await step('clone in volume: volumeName payload → build from the volume (override-config)', async () => {
		// "Dev Containers: Clone Repository in Container Volume" reloads with
		// {volumeName: "__UNIQUE__", folder, cloneInfo} — NO hostPath, and the
		// volume name is a MARKER, looked up by labels (raven's log: docker
		// rejected "__UNIQUE__" as a name, then the CLI died with "spawn
		// docker ENOENT" — its spawns chdir into the workspace folder, which
		// a volume does not have on the host).
		fs.writeFileSync(`${process.env.FAKE_STATE}/vol-devcontainer.json`,
			'{"image": "alpine", "name": "Vol Repo"}');
		const r = await req('POST', '/api/remote-dev/resolve', {
			body: { volumeName: '__UNIQUE__', folder: 'test-vol', settings: { context: 'test' } },
		});
		if (r.status !== 200) {
			assert.fail(`volume resolve failed (${r.status}): ${await r.text()}`);
		}
		const answer = await r.json();
		assert.ok(answer.ip && answer.connectionToken, `answer shape: ${JSON.stringify(answer)}`);
		assert.ok(answer.name, 'a name for the indicator');
		const cliLog = fs.readFileSync(`${process.env.FAKE_STATE}/cli-args.log`, 'utf8');
		assert.ok(cliLog.includes('--override-config'),
			`override-config missing from the CLI args:\n${cliLog}`);
		assert.ok(cliLog.includes('--id-label vsch.local.volume=test-vol'),
			'the RESOLVED volume name (not __UNIQUE__) is the label');
		assert.ok(!cliLog.includes('--workspace-folder /workspaces/'),
			'the workspace-folder flag is a host-existing dir, not the volume path');
		assert.ok(cliLog.includes('--mount type=bind,source='),
			'the docker socket is mounted for volume containers too');
	});

	await step('phase 3: docker bridge — the host socket is bind-mounted (no relay port)', async () => {
		// the build mounts the host's docker socket into the container — the
		// official docker-outside-of-docker way; no TCP relay anywhere
		const cliLog = fs.readFileSync(`${process.env.FAKE_STATE}/cli-args.log`, 'utf8');
		assert.ok(cliLog.includes(`--mount type=bind,source=${RUNTIME}/sock/docker.sock,target=/var/run/docker.sock`),
			`socket mount missing from the CLI args:\n${cliLog}`);
		// the daemon env needs NO DOCKER_HOST: the socket sits at the default path
		const serve = fs.readFileSync('/tmp/remote-dev/serve.sh', 'utf8');
		assert.ok(!serve.includes('export DOCKER_HOST='), 'no DOCKER_HOST relay in serve.sh');
		assert.ok(serve.includes('export PATH='), 'PATH export in serve.sh');
		// the pushed CLI really talks to the socket (fake container = this
		// machine, so run it straight — default path, no env)
		const out = require('child_process').execSync(
			'/tmp/remote-dev/bin/docker info --format "{{.ServerVersion}}"')
			.toString().trim();
		assert.ok(out.length > 0, 'pushed docker CLI answered via the socket');
		console.log(`    → docker ${out} via the bind-mounted socket`);
	});

	await step('phase 3: dotfiles from the client settings reach the CLI', async () => {
		// the e2e stub's getConfiguration answers a repository — the payload
		// must carry it and the CLI must get the desktop flags on `up`
		const cliLog = fs.readFileSync(`${process.env.FAKE_STATE}/cli-args.log`, 'utf8');
		assert.ok(cliLog.includes('--dotfiles-repository https://example.com/dotfiles.git'),
			`dotfiles flags missing from:\n${cliLog}`);
	});

	await step('phase 3: forwardPorts from the config is pre-forwarded (listeners plumbed)', async () => {
		// the fake config asks for 3963. The fake container IS this machine
		// (shared netns): 127.0.0.1:3963 inside it is OUR OWN front bind, so
		// the in-container relay is SKIPPED on purpose — relaying into our
		// own front loops (relay → 127.0.0.1:3963 → front → relay → …), a
		// cascade that exhausts ephemeral ports (seen live: ~75 EADDRNOTAVAIL
		// watchdog probes per run, and this very assertion flaked on its own
		// connect). Assert the plumbing: the host listener accepts, and the
		// log shows the pre-forward plus the anti-loop skip.
		const net = require('net');
		const accepts = (host) => new Promise((resolve) => {
			const s = net.connect(3963, host, () => { s.destroy(); resolve(true); });
			s.on('error', () => resolve(false));
			setTimeout(() => { s.destroy(); resolve(false); }, 3000);
		});
		assert.ok(await accepts('127.0.0.1'), 'host listener on 127.0.0.1:3963');
		const r = await req('GET', `/api/remote-dev/progress?path=${encodeURIComponent(PAYLOAD.hostPath)}&from=0`);
		const text = ((await r.json()).lines || []).join('\n');
		assert.ok(text.includes('forwardPorts: pre-forwarding 3963'), 'pre-forward logged');
		assert.ok(text.includes(':3963: skipped (shared netns'),
			'the anti-loop skip is logged (a relay into our own front bind loops)');
	});

	await step('phase 3: /forward gives a raw host listener (tcp)', async () => {
		const net = require('net');
		const srv = net.createServer((c) => { c.end('FWD-TCP-OK'); });
		await new Promise((r) => srv.listen(13100, '0.0.0.0', r));
		try {
			const r = await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13100, context: 'test' },
			});
			const f = await r.json();
			assert.strictEqual(r.status, 200, JSON.stringify(f));
			// the fake container IS this machine: its server already holds
			// 13100, so the allocator takes the NEXT FREE PORT (like desktop)
			assert.ok(typeof f.front === 'number' && f.front >= 13100,
				`expected an assigned front port ≥ 13100, got ${JSON.stringify(f)}`);
			const answer = await new Promise((resolve, reject) => {
				const s = require('net').connect(f.front, '127.0.0.1', () => {});
				let data = '';
				s.on('data', (d) => { data += d; resolve(data); });
				s.on('error', reject);
				setTimeout(() => reject(new Error('timeout on the host listener')), 5000);
			});
			assert.ok(answer.includes('FWD-TCP-OK'), `got ${answer} on front port ${f.front}`);
		} finally {
			srv.close();
		}
	});

	await step('phase 3: port allocator — next free port on collision, idempotent per container', async () => {
		const net = require('net');
		// collision source: 13105 is the "container" server, 13106 is squatted
		const srv = net.createServer((c) => { c.end('INCREMENT-OK'); });
		const squatter = net.createServer(() => {});
		await new Promise((r) => srv.listen(13105, '0.0.0.0', r));
		await new Promise((r) => squatter.listen(13106, '127.0.0.1', r));
		try {
			const r = await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13105, context: 'test' },
			});
			const f = await r.json();
			assert.strictEqual(f.front, 13107, `allocator should skip 13105 (server) and 13106 (squatter): ${JSON.stringify(f)}`);
			// idempotent: same container port → same assignment
			const r2 = await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13105, context: 'test' },
			});
			const f2 = await r2.json();
			assert.strictEqual(f2.front, 13107, 're-forward keeps the assigned port');
			const answer = await new Promise((resolve, reject) => {
				const s = net.connect(13107, '127.0.0.1', () => {});
				let data = '';
				s.on('data', (d) => { data += d; resolve(data); });
				s.on('error', reject);
				setTimeout(() => reject(new Error('timeout on 13107')), 5000);
			});
			assert.ok(answer.includes('INCREMENT-OK'), `got ${answer}`);
			// anti-loop: our own front listener must NOT be forwarded itself
			// (in a shared netns the container's candidate finder can see it —
			// without this filter it forwards 3900→3901→3902… forever). The
			// suppression is recorded by provideTunnel — drive it first. It is
			// by PROCESS SIGNATURE, never by number: front == port is the
			// common case, and number-based suppression killed the user's real
			// rows on every finder rescan (raven: "ports disappear").
			await shim.resolver.tunnelFactory({ remoteAddress: { host: '127.0.0.1', port: 13105 } });
			const p3 = await shim.resolver.showCandidatePort('127.0.0.1', 13107,
				'node /tmp/rdv-test/scripts/devcontainer-orchestrator.js');
			assert.strictEqual(p3, false, 'our own front listener is suppressed as a candidate');
			const p4 = await shim.resolver.showCandidatePort('127.0.0.1', 13105);
			assert.strictEqual(p4, true, 'a real server port stays a candidate');
			const p5 = await shim.resolver.showCandidatePort('127.0.0.1', 13107,
				'python3 -m http.server 13107');
			assert.strictEqual(p5, true, 'a USER server on a number we also bound stays visible (front==port)');
			const p6 = await shim.resolver.showCandidatePort('127.0.0.1', 13107, '');
			assert.strictEqual(p6, false, 'empty detail on one of OUR numbers is suppressed (the anti-loop)');
			// the signature must be PRECISE (raven: "detected, then gone when I
			// open the Ports tab"): a user server whose path merely CONTAINS
			// "remote-dev" is not ours — it stays visible
			const p7 = await shim.resolver.showCandidatePort('127.0.0.1', 13107,
				'node /workspaces/scb_remote_vscode/remote-dev/server.js');
			assert.strictEqual(p7, true, 'a user server with "remote-dev" in its PATH stays visible');
			// …while the container's own daemon (its management port) IS suppressed
			const p8 = await shim.resolver.showCandidatePort('127.0.0.1', 13107,
				'/tmp/remote-dev/vscode-server/bin/abc123/node /tmp/remote-dev/vscode-server/bin/abc123/out/server-main.js --start-server');
			assert.strictEqual(p8, false, 'the daemon management port is suppressed');
			// raven's "ça détecte pas": a USER node one-liner using
			// net.createServer (the classic test-server shape) is NOT our
			// relay — it must stay visible
			const p9 = await shim.resolver.showCandidatePort('127.0.0.1', 13107,
				'node -e require("net").createServer(c=>c.end("hi")).listen(13107)');
			assert.strictEqual(p9, true, 'a user node -e net.createServer server stays visible (was eaten by the old signature)');
			// and OUR gate relay's exact shape (the daemon's node) is suppressed
			const p10 = await shim.resolver.showCandidatePort('127.0.0.1', 13107,
				'/tmp/remote-dev/vscode-server/bin/abc123/node -e const net=require("net"),os=require("os");…net.createServer…');
			assert.strictEqual(p10, false, 'the gate relay (daemon node + -e script) is suppressed');
		} finally {
			srv.close();
			squatter.close();
		}
	});

	await step('phase 3: allocator last resort — the whole walk fails → kernel-assigned port (raven\'s nginx:80)', async () => {
		// raven's nginx: the container port was 80, the walk (80…129) is ALL
		// privileged on a non-root macOS host → every bind EACCES → no front →
		// the row never appeared ("nginx pas détecté"). Desktop's no-elevation
		// path assigns a kernel port instead; so do we. Tested
		// privilege-independently: squat the ENTIRE walk (50 ports), the
		// fallback must still produce a working row OUTSIDE the walked range.
		const net = require('net');
		const base = 13160;
		const squatters = [];
		for (let i = 0; i < 50; i++) {
			const s = net.createServer(() => {});
			await new Promise((r) => s.listen(base + i, '127.0.0.1', r));
			squatters.push(s);
		}
		try {
			const r = await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: base, context: 'test' },
			});
			const f = await r.json();
			assert.strictEqual(r.status, 200, `the fallback must answer 200, got ${r.status}: ${JSON.stringify(f)}`);
			assert.ok(typeof f.front === 'number' && (f.front < base || f.front > base + 49),
				`front ${f.front} must be OUTSIDE the squatted walk ${base}..${base + 49}`);
			// and the row WORKS: the front proxies to the container port (the
			// relay binds the container IP — only loopback was squatted — and
			// lands on the walk's first squatter, which accepts)
			const ok = await new Promise((resolve) => {
				const s = net.connect(f.front, '127.0.0.1', () => { s.destroy(); resolve(true); });
				s.on('error', () => resolve(false));
				setTimeout(() => { s.destroy(); resolve(false); }, 3000);
			});
			assert.ok(ok, `kernel-assigned front :${f.front} accepts and proxies`);
		} finally {
			for (const s of squatters) { s.close(); }
		}
	});

	await step('phase 3: user-edited local port (localAddressPort) honored, honest failure', async () => {
		// desktop: editing the forwarded address re-binds EXACTLY the asked
		// port; an unbindable one fails — never a fake row (raven: "quand je
		// modifie un port ca le prend pas en compte" + nc-refused rows)
		const net = require('net');
		const srv = http.createServer((_q, r) => { r.writeHead(200); r.end('EDIT-OK'); });
		const squatter = net.createServer(() => {});
		await new Promise((r) => srv.listen(13115, '0.0.0.0', r));
		await new Promise((r) => squatter.listen(13120, '127.0.0.1', r));
		try {
			const f = await (await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13115, frontPort: 13121, context: 'test' },
			})).json();
			assert.strictEqual(f.front, 13121, `the requested front port is used: ${JSON.stringify(f)}`);
			assert.strictEqual((await fetchOnce('http://127.0.0.1:13121/')).text, 'EDIT-OK');
			// editing the port: the old bind closes, the new one answers
			const f3 = await (await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13115, frontPort: 13125, context: 'test' },
			})).json();
			assert.strictEqual(f3.front, 13125, `the edit re-binds as asked: ${JSON.stringify(f3)}`);
			assert.strictEqual((await fetchOnce('http://127.0.0.1:13125/')).text, 'EDIT-OK');
			const old = await fetchOnce('http://127.0.0.1:13121/').then(() => 'alive').catch(() => 'dead');
			assert.strictEqual(old, 'dead', 'the old bind closes when the port is edited');
			// a taken requested port fails honestly (no fake success)
			const r2 = await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13116, frontPort: 13120, context: 'test' },
			});
			assert.strictEqual(r2.status, 409, `a taken requested port must fail honestly: ${r2.status}`);
		} finally {
			srv.close();
			squatter.close();
		}
	});

	await step('docker-published port: never squatted, answered as-is (raven\'s 8080)', async () => {
		// the fake container publishes 8080 (compose `ports:`): our forward
		// must NOT bind it — docker's publish already answers there, and a
		// bind of ours would make the NEXT recreate fail ("port is already
		// allocated" — what raven hit on erroparfums2)
		const fr = await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 8080, context: 'test' },
		});
		const f = await fr.json();
		assert.strictEqual(fr.status, 200, JSON.stringify(f));
		assert.strictEqual(f.published, true, `published passthrough: ${JSON.stringify(f)}`);
		assert.strictEqual(f.front, 8080);
		// and crucially WE did not bind it: no docker publish exists in the
		// fake env, so the port must be FREE
		const st = await fetchOnce('http://127.0.0.1:8080/').then(() => 'alive').catch(() => 'free');
		assert.strictEqual(st, 'free', 'no same-port bind on a docker-published port');
	});

	await step('front bind: the workbench-IP listener proxies to the container port', async () => {
		const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end('FWD-OK'); });
		await new Promise((r) => srv.listen(13000, '0.0.0.0', r));
		try {
			// 13000 is squatted by the "container" server itself (tests share
			// the netns) — the allocator hands the NEXT free port
			const fr = await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13000, context: 'test' },
			});
			const f = await fr.json();
			assert.strictEqual(fr.status, 200, JSON.stringify(f));
			assert.ok(f.front > 13000, `allocator should skip the squatted 13000: ${JSON.stringify(f)}`);
			const r = await fetch(`http://127.0.0.1:${f.front}/hello.txt`);
			assert.strictEqual(r.status, 200);
			assert.strictEqual(await r.text(), 'FWD-OK');
		} finally {
			srv.close();
		}
	});

	await step('front bind: reaches a server bound to the container\'s OWN localhost (in-container relay)', async () => {
		// 127.0.0.1-only server: the container IP refuses it, so the front
		// bind only answers through the in-container relay — which must bind
		// the container IP (a 0.0.0.0 bind would collide with this very
		// server and die silently; that was the bug).
		const srv = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/plain' }); r.end('FWD-LOCAL-OK'); });
		await new Promise((r) => srv.listen(13103, '127.0.0.1', r));
		try {
			const fr = await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13103, context: 'test' },
			});
			const f = await fr.json();
			assert.strictEqual(fr.status, 200, JSON.stringify(f));
			assert.ok(f.front > 13103, `allocator should skip the squatted 13103: ${JSON.stringify(f)}`);
			let text = '';
			for (let i = 0; i < 12 && text !== 'FWD-LOCAL-OK'; i++) {
				await new Promise((r) => setTimeout(r, 1000));
				text = await fetch(`http://127.0.0.1:${f.front}/`)
					.then((r) => (r.ok ? r.text() : '')).catch(() => '');
			}
			assert.strictEqual(text, 'FWD-LOCAL-OK');
		} finally {
			srv.close();
		}
	});

	await step('front bind: a watchdog-killed bind frees its assignment (re-forward re-binds)', async () => {
		// raven's real-world flow: the dev server restarts → the watchdog
		// closes the bind → the NEXT /forward must bind fresh, not return
		// the stale (dead) assignment.
		const net = require('net');
		const mk = () => http.createServer((_q, r) => { r.writeHead(200); r.end('REBIND-OK'); });
		let srv = mk();
		await new Promise((res, rej) => { srv.once('error', rej); srv.listen(13110, '0.0.0.0', res); });
		const f1 = await (await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 13110, context: 'test' },
		})).json();
		assert.ok(f1.front > 13110, `allocator skips the squatted 13110: ${JSON.stringify(f1)}`);
		assert.strictEqual((await fetchOnce(`http://127.0.0.1:${f1.front}/`)).text, 'REBIND-OK');
		// kill the upstream FOR REAL: close() alone waits for lingering
		// connections (the bind's pipes), and while it waits the kernel
		// socket keeps accepting handshakes — the watchdog's probes then
		// "succeed" against a zombie and the bind is never freed (seen live)
		srv.closeAllConnections();
		await new Promise((r) => srv.close(r));
		let dead = false;
		for (let i = 0; i < 20 && !dead; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			// ONLY ECONNREFUSED proves the bind died: while the bind lives
			// with a dead upstream the pipe just resets (ECONNRESET) —
			// mistaking that for death returned the STALE assignment (seen live)
			dead = await fetchOnce(`http://127.0.0.1:${f1.front}/`)
				.then(() => false)
				.catch((e) => e.code === 'ECONNREFUSED');
		}
		assert.ok(dead, 'the watchdog closes the bind once the upstream is gone');
		const f2 = await (await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 13110, context: 'test' },
		})).json();
		// the assignment was freed: the fresh bind LISTENS. A stale entry
		// would return the old (dead) assignment — connection refused. (The
		// upstream-answers flow is proven by the two 'front bind' steps; in
		// the shared test netns re-listening the fake upstream on 13110 races
		// the in-container relay squatting it — that flakiness was a test
		// artifact, twice.)
		assert.ok(f2.front, `a fresh assignment is made: ${JSON.stringify(f2)}`);
		const alive = await new Promise((res) => {
			const s = net.connect(f2.front, '127.0.0.1', () => { s.end(); res(true); });
			s.once('error', () => res(false));
			setTimeout(() => { s.destroy(); res(false); }, 3000);
		});
		assert.ok(alive, `the re-forwarded bind is live on ${f2.front} (a stale assignment would be dead)`);
	});

	await step('front bind: client disconnect does NOT kill it — server death does, restart heals', async () => {
		// raven: "quand je me déconnecte ça casse le port forwarding". Two
		// different deaths: OUR bind must not care about a client leaving
		// (per-connection teardown only) — but a dev server that EXITS when
		// its last client goes takes the whole chain down BY DESIGN (live
		// status), and the chain MUST heal on the server's restart.
		const net = require('net');
		let srv = http.createServer((_q, r) => { r.writeHead(200); r.end('DISCO-OK'); });
		await new Promise((res, rej) => { srv.once('error', rej); srv.listen(13141, '0.0.0.0', res); });
		const f1 = await (await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 13141, context: 'test' },
		})).json();
		assert.strictEqual((await fetchOnce(`http://127.0.0.1:${f1.front}/`)).text, 'DISCO-OK');
		// fetchOnce's socket is now closed — the "disconnect". Bind survives:
		assert.strictEqual((await fetchOnce(`http://127.0.0.1:${f1.front}/`)).text, 'DISCO-OK',
			'a client disconnect must not close the forward');
		// the dev server DIES (raven's shape) → the watchdog closes the bind
		srv.closeAllConnections();
		await new Promise((r) => srv.close(r));
		let dead = false;
		for (let i = 0; i < 20 && !dead; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			dead = await fetchOnce(`http://127.0.0.1:${f1.front}/`)
				.then(() => false).catch((e) => e.code === 'ECONNREFUSED');
		}
		assert.ok(dead, 'server death closes the bind (live status)');
		// the server RESTARTS — the workbench re-forwards when the finder
		// re-detects the candidate (simulated by the same POST) → healed
		srv = http.createServer((_q, r) => { r.writeHead(200); r.end('HEALED'); });
		await new Promise((res, rej) => { srv.once('error', rej); srv.listen(13141, '0.0.0.0', res); });
		const f2 = await (await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 13141, context: 'test' },
		})).json();
		assert.ok(f2.front, `fresh assignment after the restart: ${JSON.stringify(f2)}`);
		assert.strictEqual((await fetchOnce(`http://127.0.0.1:${f2.front}/`)).text, 'HEALED',
			'the restarted server answers through a fresh bind');
		srv.closeAllConnections();
		await new Promise((r) => srv.close(r));
	});

	await step('front bind: a restart BEYOND the heal window resurrects the row (same front, reconciler)', async () => {
		// raven's nginx bounce: the server stays down longer than the
		// watchdog + heal window — desktop keeps the row forever and it
		// works again on restart. Our reconciler re-probes dead records
		// from inside the container and re-binds the SAME front — no
		// re-forward, the row just revives.
		const net = require('net');
		// the relay destroys its upstream when its chain dies — a bare
		// c.end() handler then takes ECONNRESET and crashes the SUITE
		const quiet = (answer) => (c) => { c.on('error', () => {}); c.end(answer); };
		let srv = net.createServer(quiet('RESURRECT-1'));
		await new Promise((r) => srv.listen(13170, '127.0.0.1', r));
		const f1 = await (await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 13170, context: 'test' },
		})).json();
		assert.ok(f1.front, `bound: ${JSON.stringify(f1)}`);
		// the server dies and stays dead: the watchdog condemns, the heal
		// gives up (~18 s of probes) — the bind must be GONE
		await new Promise((r) => srv.close(r));
		let dead = false;
		for (let i = 0; i < 30 && !dead; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			dead = await new Promise((resolve) => {
				const s = net.connect(f1.front, '127.0.0.1', () => { s.destroy(); resolve(false); });
				s.on('error', () => resolve(true));
			});
		}
		assert.ok(dead, 'the watchdog killed the bind while the server was down');
		await new Promise((r) => setTimeout(r, 20000)); // let the heal exhaust its probes
		// the server comes back — NO re-forward from anyone: the reconciler
		// must re-raise the relay and re-bind the SAME front by itself
		srv = net.createServer(quiet('RESURRECT-2'));
		await new Promise((r) => srv.listen(13170, '127.0.0.1', r));
		let answer = '';
		for (let i = 0; i < 20 && answer !== 'RESURRECT-2'; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			answer = await new Promise((resolve) => {
				const s = net.connect(f1.front, '127.0.0.1', () => {});
				s.on('data', (d) => resolve(String(d)));
				s.on('error', () => resolve(''));
				setTimeout(() => { s.destroy(); resolve(''); }, 1500);
			});
		}
		assert.strictEqual(answer, 'RESURRECT-2',
			`the SAME front :${f1.front} proxies the restarted server (reconciler resurrection)`);
		await new Promise((r) => srv.close(r));
	});

	await step('dispose: closing the row releases the bind (raven: local-port edit stayed on the old port)', async () => {
		// our dispose was a NO-OP: the workbench kept the dead tunnel in its
		// map and retainOrCreateTunnel handed the OLD tunnel back on the
		// edit's re-forward. Now dispose fires + /unforward releases the
		// bind — the edit's close half frees the port, its forward half
		// binds fresh.
		const net = require('net');
		const srv = net.createServer((c) => { c.on('error', () => {}); c.end('DISPOSE-OK'); });
		await new Promise((r) => srv.listen(13175, '127.0.0.1', r));
		try {
			const t = await shim.resolver.tunnelFactory({ remoteAddress: { host: '127.0.0.1', port: 13175 } });
			assert.ok(t && t.localAddress && t.localAddress.port,
				`tunnel vended: ${JSON.stringify(t && t.localAddress)}`);
			const front = t.localAddress.port;
			// poll: the in-container relay needs a few hundred ms to boot
			let answer = '';
			for (let i = 0; i < 10 && answer !== 'DISPOSE-OK'; i++) {
				await new Promise((r) => setTimeout(r, 500));
				answer = await new Promise((resolve) => {
					const s = net.connect(front, '127.0.0.1', () => {});
					s.on('data', (d) => resolve(String(d)));
					s.on('error', () => resolve(''));
					setTimeout(() => { s.destroy(); resolve(''); }, 1000);
				});
			}
			assert.strictEqual(answer, 'DISPOSE-OK', 'the front proxies before dispose');
			t.dispose();
			let dead = false;
			for (let i = 0; i < 10 && !dead; i++) {
				await new Promise((r) => setTimeout(r, 500));
				dead = await new Promise((resolve) => {
					const s = net.connect(front, '127.0.0.1', () => { s.destroy(); resolve(false); });
					s.on('error', () => resolve(true));
				});
			}
			assert.ok(dead, 'the front refuses after dispose (the bind was released)');
			// the edit's forward half: re-bind EXACTLY the asked local port
			const t2 = await shim.resolver.tunnelFactory({
				remoteAddress: { host: '127.0.0.1', port: 13175 },
				localAddressPort: front,
			});
			assert.ok(t2 && t2.localAddress && t2.localAddress.port === front,
				`the re-forward binds the asked port ${front}: ${JSON.stringify(t2 && t2.localAddress)}`);
			t2.dispose();
			// the race (browser2's edit flow): the close half and the forward
			// half are both fire-and-forget — a LATE unforward naming the OLD
			// bind must not kill the record's NEW bind
			const r3 = await req('POST', '/api/remote-dev/forward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13175, context: 'test', frontPort: front + 1 },
			});
			const f3 = await r3.json();
			assert.strictEqual(f3.front, front + 1, `strict re-bind on :${front + 1}: ${JSON.stringify(f3)}`);
			await req('POST', '/api/remote-dev/unforward', {
				body: { hostPath: PAYLOAD.hostPath, port: 13175, context: 'test', frontPort: front },
			});
			const alive = await new Promise((resolve) => {
				const s = net.connect(f3.front, '127.0.0.1', () => { s.destroy(); resolve(true); });
				s.on('error', () => resolve(false));
				setTimeout(() => { s.destroy(); resolve(false); }, 2000);
			});
			assert.ok(alive, "a stale unforward must not kill the record's new bind");
		} finally {
			srv.close();
		}
	});

	await step('front bind: a network freeze (host sleep) self-heals — no re-forward needed', async () => {
		// raven's "ça marche connecté, ça casse à la déconnexion": the Mac
		// sleeps, the watchdog's probes freeze, the bind is condemned — but
		// the server is FINE. After the wake, the heal must re-bind on its
		// own: no /forward, no row change, the same front port answers.
		const net = require('net');
		let srv = http.createServer((_q, r) => { r.writeHead(200); r.end('FROZEN'); });
		await new Promise((res, rej) => { srv.once('error', rej); srv.listen(13146, '0.0.0.0', res); });
		const f = await (await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 13146, context: 'test' },
		})).json();
		assert.strictEqual((await fetchOnce(`http://127.0.0.1:${f.front}/`)).text, 'FROZEN');
		// the "sleep": the server vanishes long enough for the watchdog to
		// condemn (~15 s), then comes back — the wake
		srv.closeAllConnections();
		await new Promise((r) => srv.close(r));
		setTimeout(() => {
			srv = http.createServer((_q, r) => { r.writeHead(200); r.end('AWAKE'); });
			// a stray squatter must fail the STEP (healed stays ''), never
			// crash the whole suite with an unhandled 'error'
			srv.once('error', (e) => console.log(`    → freeze re-listen failed: ${e.code || e.message}`));
			srv.listen(13146, '0.0.0.0');
		}, 17000).unref();
		let healed = '';
		for (let i = 0; i < 30 && healed !== 'AWAKE'; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			healed = await fetchOnce(`http://127.0.0.1:${f.front}/`)
				.then((x) => x.text).catch(() => '');
		}
		assert.strictEqual(healed, 'AWAKE',
			'the bind healed itself after the freeze (no re-forward, same front port)');
		srv.closeAllConnections();
		await new Promise((r) => srv.close(r));
	});

	await step('patch effects: shim builtin, allowlist, no bootstrap', async () => {
		const build = fs.globSync(`${RUNTIME}/microsoft/vscode/cli/serve-web/*/`)[0].replace(/\/?$/, '/');
		const wb = fs.readFileSync(`${build}out/vs/code/browser/workbench/workbench.js`, 'utf8');
		assert.ok(wb.includes('extensionPath:"remote-devcontainers.resolver"'), 'shim registered in workbench.js');
		const pj = JSON.parse(fs.readFileSync(`${build}product.json`, 'utf8'));
		const props = (pj.extensionEnabledApiProposals || {})['remote-devcontainers.resolver'] || [];
		for (const p of ['resolvers', 'tunnels', 'tunnelFactory']) { assert.ok(props.includes(p), `proposal ${p}`); }
		assert.ok(fs.existsSync(`${build}extensions/remote-devcontainers.resolver/extension.js`), 'shim files dropped');
		const html = fs.readFileSync(`${build}out/vs/code/browser/workbench/workbench.html`, 'utf8');
		assert.ok(!html.includes('remote-dev: container redirect bootstrap'), 'bootstrap gone');
		const srv = fs.readFileSync(`${build}out/server-main.js`, 'utf8');
		assert.ok(srv.includes('rdvFolderAuthority'), 'folder authority drives the window (server-main patch)');
		assert.ok(!wb.includes('??{label:"$(remote)",tooltip:'),
			'forced windowIndicator default gone (remote indicator shows the remote label)');
	});

	await step('patch effects: a pre-rename install is PURGED (old resolver id)', async () => {
		// the rename remote-dev.dev-container-resolver → remote-devcontainers.resolver
		// left every patched install with BOTH ids (raven's broken window):
		// a cached workbench.js can load the old shim whose proposals are no
		// longer allowlisted, and two resolvers register for dev-container.
		// Plant the old shape, re-run the setup, assert the purge.
		const build = fs.globSync(`${RUNTIME}/microsoft/vscode/cli/serve-web/*/`)[0].replace(/\/?$/, '/');
		const wbPath = `${build}out/vs/code/browser/workbench/workbench.js`;
		const oldId = 'remote-dev.dev-container-resolver';
		fs.writeFileSync(wbPath, fs.readFileSync(wbPath, 'utf8')
			.replace('[{extensionPath:"remote-devcontainers.resolver"',
				`[{extensionPath:"${oldId}",packageJSON:{"name":"old"}},{extensionPath:"remote-devcontainers.resolver"`));
		fs.mkdirSync(`${build}extensions/${oldId}`, { recursive: true });
		fs.writeFileSync(`${build}extensions/${oldId}/extension.js`, '// stale');
		const pjPath = `${build}product.json`;
		const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
		pj.extensionEnabledApiProposals[oldId] = ['resolvers'];
		fs.writeFileSync(pjPath, JSON.stringify(pj));
		require('child_process').execFileSync('python3',
			[`${__dirname}/../scripts/setup-workbench.py`, build]);
		const wb2 = fs.readFileSync(wbPath, 'utf8');
		assert.ok(!wb2.includes(`extensionPath:"${oldId}"`), 'the old static entry is purged');
		assert.ok(wb2.includes('extensionPath:"remote-devcontainers.resolver"'), 'the current id survives the purge');
		assert.ok(!fs.existsSync(`${build}extensions/${oldId}`), 'the old extension dir is removed');
		const pj2 = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
		assert.ok(!(oldId in (pj2.extensionEnabledApiProposals || {})), 'the old allowlist key is removed');
	});

	await step('stop: /stop-container stops it (never deletes), releases our binds, reopening starts it again', async () => {
		// desktop parity: the explorer's stop button — the container goes
		// down, and the next resolve starts it WITHOUT a rebuild (fast `up`)
		const f = await (await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 13130, context: 'test' },
		})).json();
		assert.ok(f.front, `a bind exists before the stop: ${JSON.stringify(f)}`);
		const r = await req('POST', '/api/remote-dev/stop-container', {
			body: { hostPath: PAYLOAD.hostPath, context: 'test' },
		});
		assert.strictEqual(r.status, 200, await r.text());
		const dockerLog = fs.readFileSync(`${process.env.FAKE_STATE}/docker-args.log`, 'utf8');
		assert.ok(/docker (?:--context \S+ )?stop /.test(dockerLog), 'docker stop called (not rm)');
		assert.ok(!fs.existsSync(`${process.env.FAKE_STATE}/built`), 'container is down');
		// the stop RELEASED our binds: the recreate can re-publish those
		// ports immediately (the watchdog's ~15 s would be too late)
		const still = await fetchOnce(`http://127.0.0.1:${f.front}/`).then(() => 'alive').catch(() => 'released');
		assert.strictEqual(still, 'released', 'front binds are released at stop, not at watchdog leisure');

		const before = fs.readFileSync(`${process.env.FAKE_STATE}/cli-args.log`, 'utf8');
		const r2 = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD });
		assert.strictEqual(r2.status, 200, await r2.text());
		const after = fs.readFileSync(`${process.env.FAKE_STATE}/cli-args.log`, 'utf8');
		const newUps = after.slice(before.length).trim().split('\n')
			.filter((l) => l.startsWith('up ') && !l.includes('--remove-existing-container'));
		assert.ok(newUps.length >= 1, `reopen should START the container (plain up), got:\n${after.slice(before.length)}`);
	});

	// --- n1-n5: the forward layer against a REAL external server (nginx) -----
	// nginx squats the very port the "container" serves: the allocator, the
	// watchdog/heal, the reconciler and the persistence file are all
	// exercised against a server that is not a fixture of ours. Skipped
	// cleanly when nginx is absent.

	await step('n1: nginx squats the container port — allocator takes the next free, front proxies nginx', async () => {
		if (!NGINX) { console.log('    → no nginx at /usr/sbin/nginx — skipped'); return; }
		nginxStart(14100);
		const r = await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 14100, context: 'test' },
		});
		const f = await r.json();
		assert.strictEqual(r.status, 200, JSON.stringify(f));
		assert.ok(typeof f.front === 'number' && f.front > 14100,
			`14100 is squatted by nginx — the allocator must move: ${JSON.stringify(f)}`);
		nState.front1 = f.front;
		// through the in-container relay → the 127.0.0.1-only nginx
		let got = null;
		for (let i = 0; i < 15 && !(got && /nginx/i.test(got.headers.server || '')); i++) {
			await new Promise((r2) => setTimeout(r2, 1000));
			got = await fetchOnce(`http://127.0.0.1:${f.front}/`).catch(() => null);
		}
		assert.ok(got && /nginx/i.test(got.headers.server || ''),
			`front :${f.front} should answer with an nginx Server header, got ${got && got.status}/${got && got.headers.server}`);
	});

	await step('n2: nginx stops — the watchdog kills the bind, the heal confirms dead (live status)', async () => {
		if (!NGINX) { console.log('    → no nginx at /usr/sbin/nginx — skipped'); return; }
		nginxStop(14100);
		// the relay gate closes (~15 s) → 3 failed watchdog probes (~15 s) →
		// condemn + force-drain: the front refuses within ~40 s
		let dead = false;
		for (let i = 0; i < 25 && !dead; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			dead = await fetchOnce(`http://127.0.0.1:${nState.front1}/`)
				.then(() => false).catch((e) => e.code === 'ECONNREFUSED');
		}
		assert.ok(dead, `front :${nState.front1} refuses within ~40 s of nginx stopping`);
		// the channel narrates it: the watchdog line, then the heal verdict
		let lines = '';
		for (let i = 0; i < 10 && !lines.includes('really dead'); i++) {
			await new Promise((r) => setTimeout(r, 2000));
			lines = channelText();
		}
		assert.ok(lines.includes('upstream dead ×3'), 'the watchdog line is logged');
		assert.ok(lines.includes('upstream is really dead'), 'the heal verdict: stays dead (live status)');
	});

	await step('n3: nginx on a NEW port (the user "changed the port") — fresh bind, front proxies nginx', async () => {
		if (!NGINX) { console.log('    → no nginx at /usr/sbin/nginx — skipped'); return; }
		nginxStart(14101);
		const r = await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 14101, context: 'test' },
		});
		const f = await r.json();
		assert.strictEqual(r.status, 200, JSON.stringify(f));
		assert.ok(typeof f.front === 'number' && f.front > 14101,
			`14101 is squatted by nginx — the allocator must move: ${JSON.stringify(f)}`);
		nState.front3 = f.front;
		let got = null;
		for (let i = 0; i < 15 && !(got && /nginx/i.test(got.headers.server || '')); i++) {
			await new Promise((r2) => setTimeout(r2, 1000));
			got = await fetchOnce(`http://127.0.0.1:${f.front}/`).catch(() => null);
		}
		assert.ok(got && /nginx/i.test(got.headers.server || ''),
			`front :${f.front} should answer with an nginx Server header, got ${got && got.status}/${got && got.headers.server}`);
	});

	await step('n4: reconciler — the container vanishes outside the workbench, its binds are released', async () => {
		if (!NGINX) { console.log('    → no nginx at /usr/sbin/nginx — skipped'); return; }
		try {
			// a `docker rm -f` the workbench never asked for: only the
			// reconciler's inspect can notice (the fake answers Running=false
			// once the built marker is gone). TWO gone-strikes = ~2 ticks.
			fs.rmSync(`${process.env.FAKE_STATE}/built`, { force: true });
			let dead = false;
			for (let i = 0; i < 17 && !dead; i++) {
				await new Promise((r) => setTimeout(r, 2000));
				dead = await fetchOnce(`http://127.0.0.1:${nState.front3}/`)
					.then(() => false).catch((e) => e.code === 'ECONNREFUSED');
			}
			assert.ok(dead, `front :${nState.front3} refuses within ~2 reconciler ticks`);
			const lines = channelText();
			assert.ok(lines.includes('container gone — released (reconciler)'),
				'the reconciler line is logged');
		} finally {
			nginxStop(14101); // n5 forwards with NO upstream on purpose
		}
	});

	await step('n5: persistence — the forwards file is written, and a hand edit wins the next bind', async () => {
		if (!NGINX) { console.log('    → no nginx at /usr/sbin/nginx — skipped'); return; }
		const FILE = `${RUNTIME}/remote-dev-forwards.json`;
		// n4 removed the container — bring it back (a plain reopen)
		const rr = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD });
		assert.strictEqual(rr.status, 200, await rr.text());
		const f1 = await (await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 14100, context: 'test' },
		})).json();
		assert.ok(f1.front, `a bind exists: ${JSON.stringify(f1)}`);
		// the file: written (debounced), schema {forwards:[{containerId,port,front}]}
		let doc = null;
		for (let i = 0; i < 12 && !(doc && Array.isArray(doc.forwards) && doc.forwards.some((x) => x && x.port === 14100)); i++) {
			await new Promise((r) => setTimeout(r, 500));
			try { doc = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { doc = null; }
		}
		assert.ok(doc && Array.isArray(doc.forwards), `the forwards file exists with the schema: ${FILE}`);
		const rec = doc.forwards.find((x) => x && x.port === 14100);
		assert.ok(rec && rec.containerId && rec.front === f1.front,
			`the record matches the live bind: ${JSON.stringify(rec)}`);
		// a HAND EDIT (front +3) must win the NEXT allocation: the file is
		// reloaded (mtime) before /forward, and the debounced writer merges
		// external edits instead of clobbering them
		doc.forwards = doc.forwards.map((x) => (x && x.port === 14100 ? { ...x, front: x.front + 3 } : x));
		await new Promise((r) => setTimeout(r, 1200)); // let any pending write flush first
		fs.writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
		// release the live bind (a stop), reopen, re-forward: the allocator
		// must prefer the edited front over the walk
		const sr = await req('POST', '/api/remote-dev/stop-container', {
			body: { hostPath: PAYLOAD.hostPath, context: 'test' },
		});
		assert.strictEqual(sr.status, 200, await sr.text());
		await new Promise((r) => setTimeout(r, 1500)); // the release's own write merges the edit
		const rr2 = await req('POST', '/api/remote-dev/resolve', { body: PAYLOAD });
		assert.strictEqual(rr2.status, 200, await rr2.text());
		const f2 = await (await req('POST', '/api/remote-dev/forward', {
			body: { hostPath: PAYLOAD.hostPath, port: 14100, context: 'test' },
		})).json();
		assert.strictEqual(f2.front, f1.front + 3,
			`the edited front is preferred: ${JSON.stringify(f2)} (was ${f1.front})`);
	});

	console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GREEN');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
