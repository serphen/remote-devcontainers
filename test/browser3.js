#!/usr/bin/env node
/**
 * browser3.js — the slow-build UI, end to end. The fake CLI takes
 * FAKE_BUILD_SECONDS (~10s) to "build", streaming layer lines — the same
 * path a real image pull takes. Asserts:
 *   1. the progress notification DURING the build (desktop parity)
 *   2. build lines streaming from the service WHILE it builds
 *   3. window lands in the container, pink identity
 *   4. the "(show log)" link opens the Dev Containers channel with the log
 *   5. postAttachCommand ran (marker, written by the fake container)
 *   6. reload → native reconnect
 *
 * Env: E2E_BASE, E2E_TKN, E2E_SHOTS, PPTR.
 */
const fs = require('fs');
const puppeteer = require(process.env.PPTR || 'puppeteer-core');

const BASE = process.env.E2E_BASE || 'https://127.0.0.1:10000';
const TKN = process.env.E2E_TKN || '';
const SHOTS = process.env.E2E_SHOTS || '/tmp/rdv-test/shots';
const WS = '/tmp/fake-ws';

const PAYLOAD = {
	hostPath: WS,
	localDocker: false,
	settings: { context: 'test' },
	configFile: {
		$mid: 1,
		fsPath: `${WS}/.devcontainer/devcontainer.json`,
		path: `${WS}/.devcontainer/devcontainer.json`,
		scheme: 'file',
	},
};
const hex = Buffer.from(JSON.stringify(PAYLOAD), 'utf8').toString('hex');
const FOLDER_URI = `vscode-remote://dev-container+${hex}/workspaces/remote-dev/empty-test-devcontainer`;

let failures = 0;
function check(name, ok) {
	console.log(`  ${ok ? '✓' : '✗'} ${name}`);
	if (!ok) { failures++; }
}
async function shot(page, name) {
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
	console.log(`    ↳ screenshot ${name}.png`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
	const browser = await puppeteer.launch({
		browser: 'firefox',
		executablePath: process.env.E2E_CHROMIUM || '/usr/bin/firefox-esr',
		protocol: 'webDriverBiDi',
		headless: true,
		args: ['--no-sandbox'],
		acceptInsecureCerts: true,
		defaultViewport: { width: 1400, height: 900 },
	});
	const page = await browser.newPage();
	console.log(`slow-build e2e against ${BASE}`);

	// In the 'all' run the container is ALREADY UP from the earlier suites —
	// without a build there is no build UI to watch (and stale progress lines
	// from a previous suite would lie). Force one via the rebuild marker,
	// exactly what the in-container "Rebuild Container" writes.
	if (process.env.FAKE_STATE && fs.existsSync(`${process.env.FAKE_STATE}/built`)) {
		fs.writeFileSync('/tmp/remote-dev/rebuild', '1');
		console.log('    ↳ container already up — rebuild marker planted (a build is forced)');
	}

	await page.goto(`${BASE}/?tkn=${encodeURIComponent(TKN)}`, { waitUntil: 'networkidle2', timeout: 90000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 90000 });

	await page.evaluate((u) => { location.href = u; },
		`${BASE}/?folder=${encodeURIComponent(FOLDER_URI)}`);

	// 1. notification during the build
	let notified = false;
	for (let i = 0; i < 60 && !notified; i++) {
		notified = await page.evaluate(() =>
			(document.body ? document.body.innerText : '').includes('Connecting to Dev Container'));
		if (!notified) { await sleep(500); }
	}
	check('progress notification during the build (desktop parity)', notified);
	await shot(page, '20-building');

	// 2. build lines streaming WHILE it builds
	let sawLayers = false, sawStep = '';
	for (let i = 0; i < 30 && !sawLayers; i++) {
		const r = await fetch(`${BASE}/api/remote-dev/progress?path=${encodeURIComponent(WS)}&from=0`,
			{ headers: { cookie: `vscode-tkn=${TKN}` } }).catch(() => null);
		if (r && r.ok) {
			const p = await r.json();
			sawStep = (p.message || '');
			sawLayers = (p.lines || []).some((l) => l.includes('fake-layer'));
		}
		if (sawLayers) { break; }
		await sleep(500);
	}
	console.log(`    ↳ step: "${sawStep.slice(0, 60)}", layer lines: ${sawLayers}`);
	check('build lines stream from the service during the build', sawLayers);

	// 2b. the notification message carries the LAST LINES at once — desktop's
	// chevron expands to the recent build history, not a bare one-liner.
	// The message is only in the DOM once the chevron expands (like a user),
	// and the render lands a beat after the click — count on the next poll.
	// (runs BEFORE the transitions check: the notification closes at resolve
	// end, the chevron must be read mid-build)
	let multiLine = 0;
	for (let i = 0; i < 24 && multiLine < 2; i++) {
		multiLine = await page.evaluate(() => {
			let n = 0;
			for (const item of document.querySelectorAll('.notification-list-item')) {
				const expand = item.querySelector('.codicon-chevron-down');
				if (expand) { expand.click(); }
				n += ((item.textContent || '').match(/fake-layer/g) || []).length;
			}
			return n;
		});
		if (multiLine >= 2) { break; }
		await sleep(500);
	}
	console.log(`    ↳ layer lines in the notification at once: ${multiLine}`);
	check('notification shows the last build lines (chevron content, desktop)', multiLine >= 2);

	// 2c. the UI steps transition exactly like desktop (their titles):
	// Building image → Starting container → Installing server → Starting server
	let stepsOk = false;
	for (let i = 0; i < 60 && !stepsOk; i++) {
		const r = await fetch(`${BASE}/api/remote-dev/progress?path=${encodeURIComponent(WS)}&from=0`,
			{ headers: { cookie: `vscode-tkn=${TKN}` } }).catch(() => null);
		if (r && r.ok) {
			const steps = ((await r.json()).steps || []).join('>');
			stepsOk = /Building image…?>Starting container…?>Installing server…?>Starting server…?/.test(steps);
		}
		if (!stepsOk) { await sleep(1000); }
	}
	check('UI steps transition like desktop (Building image → Starting container → Installing server → Starting server)', stepsOk);

	// 3. land + pink
	const deadline = Date.now() + 5 * 60 * 1000;
	let remote = false;
	while (Date.now() < deadline && !remote) {
		remote = await page.evaluate(() => document.title.includes('[Dev Container'));
		if (!remote) { await sleep(2000); }
	}
	check('window lands INSIDE the container after the slow build', remote);
	let pink = '';
	for (let i = 0; i < 30 && !/194, 24, 91/.test(pink); i++) {
		pink = await page.evaluate(() => {
			const el = document.getElementById('workbench.parts.statusbar');
			return el ? getComputedStyle(el).backgroundColor : '';
		});
		if (!/194, 24, 91/.test(pink)) { await sleep(3000); }
	}
	console.log(`    → statusbar color: ${pink}`);
	check('pink container identity', /194, 24, 91/.test(pink));
	await shot(page, '21-remote');

	// 4. the Dev Containers channel holds the build log — LINE BY LINE, in
	//    order. The titled command opens our channel directly (the channel
	//    picker is flaky under BiDi). Two scroll-free checks:
	//    (a) the visible tail holds the resolve's END lines, in order;
	//    (b) the output panel's own filter box isolates the fake-layer
	//        lines, rendered in document order — exactly how a user finds
	//        a line in a long log. Reference: the lines of THIS build
	//        (/progress is cumulative across suites — take them since the
	//        last 'resolve: hostPath').
	// Neutralize focus thieves first (seen live: the chat panel + a GitHub
	// device-login notification ate F1 and the typed command went INTO the
	// chat). Escape, dismiss notifications, click the editor area.
	await page.keyboard.press('Escape');
	await sleep(500);
	await page.evaluate(() => {
		for (const b of document.querySelectorAll('.notification-list-item .codicon-close, .notifications-toasts .codicon-close')) {
			b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		}
	});
	await sleep(500);
	await page.evaluate(() => {
		const ed = document.querySelector('.monaco-workbench .part.editor');
		if (ed) { ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }
	});
	await sleep(500);
	await page.keyboard.press('F1');
	await sleep(900);
	await page.keyboard.type('Dev Containers: Show Build Log');
	await sleep(1200);
	await page.keyboard.press('Enter');
	// robust: the palette command occasionally misses under BiDi — verify
	// the output view actually opened (its filter input exists), retry once
	let channelOpen = false;
	for (let attempt = 0; attempt < 2 && !channelOpen; attempt++) {
		if (attempt) {
			await page.keyboard.press('F1');
			await sleep(900);
			await page.keyboard.type('Dev Containers: Show Build Log');
			await sleep(1200);
			await page.keyboard.press('Enter');
		}
		for (let i = 0; i < 10 && !channelOpen; i++) {
			await sleep(1000);
			channelOpen = await page.evaluate(() =>
				[...document.querySelectorAll('#workbench\\.parts\\.panel input')]
					.some((inp) => (inp.placeholder || '').includes('Filter')));
		}
	}
	console.log(`    ↳ build log channel open: ${channelOpen}`);

	// innerText only ever holds the VISIBLE screenful (monaco virtualization)
	// — so every content check goes through the output panel's own filter
	// box, which renders matching lines wherever they are in the document.
	async function filterLines(phrase) {
		// set the filter via the native setter, NOT keyboard.type: a stolen
		// focus leaves the panel showing the unfiltered first screenful
		// (seen live: the check read the log's TOP — layers 1,2 — and
		// missed every tail line, looking exactly like missing lines)
		await page.evaluate((p) => {
			const input = [...document.querySelectorAll('#workbench\\.parts\\.panel input')]
				.find((i) => (i.placeholder || '').includes('Filter'));
			if (input) {
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, p || '');
				input.dispatchEvent(new Event('input', { bubbles: true }));
			}
		}, phrase);
		await sleep(2200);
		return page.evaluate(() => {
			const panel = document.getElementById('workbench.parts.panel');
			return panel ? panel.innerText.split('\n') : [];
		});
	}

	// (a) the resolve's END lines are in the document. Rendered text uses
	// non-breaking spaces in places — match with flexible whitespace.
	// Daemon fresh-install says 'daemon supervisor started', reuse says
	// 'daemon already running' — both are this resolve's tail; postAttach
	// runs on every resolve.
	const flex = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
	const sup = (await filterLines('daemon')).some((l) =>
		flex('daemon supervisor started').test(l) || flex('daemon already running').test(l));
	const att = (await filterLines('postAttachCommand')).some((l) => flex('postAttachCommand').test(l));
	console.log(`    ↳ tail lines present: daemon=${sup}, postAttach=${att}`);

	// (b) the fake-layer lines, LINE BY LINE in order: the filtered view
	// renders document order — the layer numbers must run 1..N, complete
	const shownLines = (await filterLines('fake-layer')).filter((l) => l.includes('fake-layer'));
	const nums = shownLines.map((l) => Number((l.match(/fake-layer-(\d+)/) || [])[1]));
	const progress = await fetch(`${BASE}/api/remote-dev/progress?path=${encodeURIComponent(WS)}&from=0`,
		{ headers: { cookie: `vscode-tkn=${TKN}` } }).then((r) => r.json());
	const allLines = progress.lines || [];
	const startIdx = allLines.reduce((acc, l, i) => (l.indexOf('resolve: hostPath') === 0 ? i : acc), 0);
	const expectedNums = allLines.slice(startIdx)
		.map((l) => Number((l.match(/fake-layer-(\d+)/) || [])[1]))
		.filter((n) => n > 0);
	const inOrder = nums.length === expectedNums.length && nums.every((n, i) => n === expectedNums[i]);
	console.log(`    ↳ channel layers: [${nums.join(',')}] vs expected [${expectedNums.join(',')}]`);
	check('channel holds the build log line by line, in order (desktop parity)',
		sup && att && expectedNums.length > 0 && inOrder);
	await shot(page, '22-buildlog');

	// 5. postAttachCommand ran (the fake container is this machine)
	const marker = fs.existsSync('/tmp/remote-dev/attach-marker')
		? fs.readFileSync('/tmp/remote-dev/attach-marker', 'utf8').trim() : '';
	console.log(`    ↳ attach marker: ${marker}`);
	check('postAttachCommand ran on attach', marker === 'ATTACHED-OK');

	// 6. reload → reconnect
	await page.evaluate((u) => { location.href = u; }, `${BASE}/?folder=${encodeURIComponent(FOLDER_URI)}`);
	let back = false;
	for (let i = 0; i < 60 && !back; i++) {
		back = (await page.evaluate(() => document.title)).includes('[Dev Container');
		if (!back) { await sleep(1000); }
	}
	check('reload reconnects into the container', back);

	await browser.close();
	console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GREEN (slow build)');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
