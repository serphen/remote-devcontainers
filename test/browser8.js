#!/usr/bin/env node
/**
 * browser8.js — the EXOTIC slow build, end to end (FAKE_BUILD_SECONDS=40,
 * FAKE_EXOTIC=1): a 48s+ build with docker-realistic hostile output (=>
 * progress bars, bare-\r updates, unicode, a 400-char line, 8s of dead
 * silence mid-build), a unicode container name, forwardPorts AND appPort,
 * and one bogus customized extension. Asserts:
 *   1. progress notification + build lines stream DURING the build
 *   2. the 8s silence does not kill the progress flow
 *   3. the window lands, pink, indicator shows the UNICODE name
 *   4. forwardPorts AND appPort are both pre-forwarded (service log)
 *   5. the bogus extension fails SOFT (degraded window, never a dead resolve)
 *   6. terminal + auto-forward still work after the exotic build
 *   7. postAttachCommand ran; reload reconnects
 *
 * Env: E2E_BASE, E2E_TKN, E2E_SHOTS, PPTR, FAKE_STATE.
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

/** The forwarded address for a container port, via the service (idempotent). */
async function forwardPort(port) {
	const r = await fetch(`${BASE}/api/remote-dev/forward`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: `vscode-tkn=${TKN}` },
		body: JSON.stringify({ hostPath: WS, port, context: 'test' }),
	});
	if (!r.ok) { return 0; }
	const f = await r.json();
	return f.front || 0;
}

async function progressLines() {
	const r = await fetch(`${BASE}/api/remote-dev/progress?path=${encodeURIComponent(WS)}&from=0`,
		{ headers: { cookie: `vscode-tkn=${TKN}` } }).catch(() => null);
	return r && r.ok ? ((await r.json()).lines || []) : [];
}

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
	console.log(`exotic slow-build e2e against ${BASE}`);

	await page.goto(`${BASE}/?tkn=${encodeURIComponent(TKN)}`, { waitUntil: 'networkidle2', timeout: 90000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
	await page.evaluate((u) => { location.href = u; },
		`${BASE}/?folder=${encodeURIComponent(FOLDER_URI)}`);

	// 1. notification + streaming during the build
	let notified = false;
	for (let i = 0; i < 90 && !notified; i++) {
		notified = await page.evaluate(() =>
			(document.body ? document.body.innerText : '').includes('Connecting to Dev Container'));
		if (!notified) { await sleep(500); }
	}
	check('progress notification during the exotic build', notified);
	await shot(page, '50-exotic-building');

	let sawLayers = false;
	for (let i = 0; i < 40 && !sawLayers; i++) {
		sawLayers = (await progressLines()).some((l) => l.includes('fake-layer'));
		if (!sawLayers) { await sleep(500); }
	}
	check('build lines stream during the build (hostile output parsed)', sawLayers);

	// 2. the 8s dead silence mid-build does not kill the progress flow:
	// lines keep arriving AFTER the silence window
	const beforeSilence = (await progressLines()).length;
	await sleep(14000);   // crosses the 8s silence
	const afterSilence = (await progressLines()).length;
	console.log(`    ↳ progress lines across the silence: ${beforeSilence} → ${afterSilence}`);
	check('progress survives the 8s dead-silence mid-build', afterSilence > beforeSilence);

	// 3. land + pink + UNICODE name in the indicator
	const deadline = Date.now() + 6 * 60 * 1000;
	let remote = false;
	while (Date.now() < deadline && !remote) {
		remote = await page.evaluate(() => document.title.includes('[Dev Container'));
		if (!remote) { await sleep(2000); }
	}
	check('window lands INSIDE the container after the exotic build', remote);
	let pink = '';
	for (let i = 0; i < 30 && !/194, 24, 91/.test(pink); i++) {
		pink = await page.evaluate(() => {
			const el = document.getElementById('workbench.parts.statusbar');
			return el ? getComputedStyle(el).backgroundColor : '';
		});
		if (!/194, 24, 91/.test(pink)) { await sleep(3000); }
	}
	check('pink container identity', /194, 24, 91/.test(pink));
	const indicator = await page.evaluate(() => {
		const bar = document.getElementById('workbench.parts.statusbar');
		return bar ? bar.innerText : '';
	});
	console.log(`    ↳ indicator: ${indicator.split('\n')[0]}`);
	check('indicator shows the UNICODE container name', indicator.includes('Errö Parfüms 2'));
	await shot(page, '51-exotic-remote');

	// 4. forwardPorts AND appPort both pre-forwarded (the service log tells)
	const lines = await progressLines();
	const pre3963 = lines.some((l) => l.includes('pre-forwarding 3963'));
	const pre3955 = lines.some((l) => l.includes('pre-forwarding 3955'));
	console.log(`    ↳ pre-forwarded: forwardPorts(3963)=${pre3963}, appPort(3955)=${pre3955}`);
	check('forwardPorts AND appPort are both pre-forwarded (desktop)', pre3963 && pre3955);

	// 5. the bogus extension failed SOFT — the window is here, and the
	//    channel tells the degraded story instead of dying
	const degraded = lines.some((l) => l.includes('degraded window'));
	console.log(`    ↳ degraded-mode line present: ${degraded}`);
	check('bogus extension fails soft (degraded window, never a dead resolve)', degraded);

	// 6. terminal + auto-forward after the exotic build
	await page.keyboard.press('Escape');
	await sleep(500);
	await page.keyboard.press('F1');
	await sleep(900);
	await page.keyboard.type('Terminal: Create New Terminal');
	await sleep(1200);
	await page.keyboard.press('Enter');
	await page.waitForSelector('.xterm-rows', { timeout: 30000 });
	await sleep(2500);
	await page.keyboard.type('echo EXOTIC-OK-777');
	await page.keyboard.press('Enter');
	await sleep(2500);
	const termText = await page.evaluate(() => {
		const t = document.querySelector('.xterm-rows');
		return t ? t.innerText : '';
	});
	check('terminal runs commands in the container', termText.includes('EXOTIC-OK-777'));

	await page.keyboard.type('python3 -m http.server 3977 &');
	await page.keyboard.press('Enter');
	await sleep(3000);
	const front3977 = await forwardPort(3977);
	let fwd = 0;
	for (let i = 0; i < 15 && fwd !== 200; i++) {
		await sleep(2000);
		fwd = await fetch(`http://127.0.0.1:${front3977}/`).then((r) => r.status).catch(() => 0);
	}
	check('auto-forward works after the exotic build (bind answers)', fwd === 200);
	try { require('child_process').execSync("pkill -f 'http[.]server 3977' || true"); } catch { /* no match */ }

	// 7. postAttach + reload
	const marker = fs.existsSync('/tmp/remote-dev/attach-marker')
		? fs.readFileSync('/tmp/remote-dev/attach-marker', 'utf8').trim() : '';
	check('postAttachCommand ran on attach', marker === 'ATTACHED-OK');
	await page.evaluate((u) => { location.href = u; }, `${BASE}/?folder=${encodeURIComponent(FOLDER_URI)}`);
	let back = false;
	for (let i = 0; i < 60 && !back; i++) {
		back = (await page.evaluate(() => document.title)).includes('[Dev Container');
		if (!back) { await sleep(1000); }
	}
	check('reload reconnects into the container', back);
	await shot(page, '52-exotic-reconnect');

	await browser.close();
	console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GREEN (exotic slow build)');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
