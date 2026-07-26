#!/usr/bin/env node
// fake devcontainer CLI for the e2e simulation: "builds" by dropping the
// state marker the fake docker reads, answers read-configuration with a
// devcontainer.json asking for one customized extension and a
// postAttachCommand. FAKE_BUILD_SECONDS slows the build down (progress-UI
// tests). Every invocation's args are logged for assertions.
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_STATE + '/cli-args.log', args.join(' ') + '\n');

async function main() {
	if (args[0] === 'read-configuration') {
		const configuration = process.env.FAKE_EXOTIC === '1'
			? {
				// the exotic fixture: unicode name, both port styles, a remote
				// user, and ONE BOGUS extension (its install must fail soft —
				// degraded window, never a dead resolve)
				name: 'Errö Parfüms 2 🐳 日本',
				customizations: { vscode: { extensions: ['dbaeumer.vscode-eslint', 'nonexistent.bogus-ext-42'] } },
				remoteUser: 'node',
				postAttachCommand: 'echo ATTACHED-OK > /tmp/remote-dev/attach-marker',
				forwardPorts: [3963],
				appPort: [3955],
			}
			: {
				name: 'Fake Test Container',
				customizations: { vscode: { extensions: ['dbaeumer.vscode-eslint'] } },
				postAttachCommand: 'echo ATTACHED-OK > /tmp/remote-dev/attach-marker',
				forwardPorts: [3963],
			};
		console.log(JSON.stringify({ configuration }));
		return;
	}
	const wait = Number(process.env.FAKE_BUILD_SECONDS || 0);
	if (wait > 0) {
		for (let s = 1; s <= wait; s++) {
			if (process.env.FAKE_EXOTIC === '1') {
				// hostile-but-real docker output: => progress bars, bare-\r
				// updates glued to the next line, unicode, one 400-char line,
				// and 8s of DEAD SILENCE mid-build (the UI must not look dead)
				if (s === Math.floor(wait / 2)) {
					await new Promise((r) => setTimeout(r, 8000));
				}
				const long = s === wait - 1 ? ' ' + 'x'.repeat(400) : '';
				console.log(`[fake] #${s} ${s}/${wait} => => pulling fs layer fake-layer-${s} 日本語 🐳${long}`);
				process.stdout.write(`[fake] #${s} downloading ${'#'.repeat(s % 10)}\r`);
			} else {
				console.log(`[fake] #${s} Step ${s}/${wait} : pulling fs layer fake-layer-${s}`);
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
	// FAKE_UP_FAIL_ONCE (env, first up), $FAKE_STATE/up-fail-armed (file,
	// one-shot, armable mid-test) or $FAKE_STATE/up-fail-always (persistent
	// until removed — the shim's own retry must fail a SECOND time so the
	// rescue runs with the user's choice): reproduce the production
	// failure — the CLI's `compose up -d` dies and the CLI reports only its
	// generic wrapper error, swallowing docker's stderr. The
	// devcontainer-orchestrator must re-run the logged docker command
	// directly (which the fake docker answers).
	const armed = process.env.FAKE_STATE + '/up-fail-armed';
	const always = process.env.FAKE_STATE + '/up-fail-always';
	if ((process.env.FAKE_UP_FAIL_ONCE === '1'
		&& !fs.existsSync(process.env.FAKE_STATE + '/up-failed'))
		|| fs.existsSync(armed) || fs.existsSync(always)) {
		fs.writeFileSync(process.env.FAKE_STATE + '/up-failed', '1');
		fs.rmSync(armed, { force: true });
		console.log('[fake] Image fake_devcontainer-app Built');
		console.log('[fake] Start: Run: docker compose --project-name fake_devcontainer -f /tmp/fake/compose.yml up -d');
		console.error('Error: Command failed: docker compose --project-name fake_devcontainer -f /tmp/fake/compose.yml up -d');
		console.log('{"outcome":"error","message":"Command failed: docker compose … up -d","description":"An error occurred starting Docker Compose up."}');
		process.exit(1);
	}
	fs.writeFileSync(process.env.FAKE_STATE + '/built', '1');
	// a volume build (clone-in-volume) gets its own marker: the volume ps
	// filter only answers once it exists
	if (args.join(' ').includes('vsch.local.volume')) {
		fs.writeFileSync(process.env.FAKE_STATE + '/vol-built', '1');
	}
	// mirror the real CLI's output (production logs): the step-transition
	// marker the progress UI watches for
	console.log('[fake] Image fake_devcontainer-app Built');
	console.log('[fake] devcontainer up — container marked built');
	console.log('{"outcome":"success","containerId":"f4k3c0nt41n3r"}');
}
main();
