#!/usr/bin/env node
/**
 * browser.js — the REAL browser layer, driven headless (puppeteer-core +
 * system chromium). This is the part e2e.js cannot cover: the actual
 * workbench loading the static-builtin resolver, firing the authority
 * resolution on the dev-container reload, and landing INSIDE the
 * container window.
 *
 * Plays the desktop flow exactly: open the master, then navigate to the
 * ?folder=vscode-remote://dev-container+<hex> URL (what Microsoft's
 * extension does on Reopen in Container), then watch.
 *
 * Asserts, with screenshots at every stage (E2E_SHOTS):
 *   - the master workbench loads
 *   - the resolver activates ([remote-dev] console lines)
 *   - the "Connecting to Dev Container" notification shows
 *   - the window ends up REMOTE (folder loaded, no "Workspace does not
 *     exist", no resolve error) — the desktop outcome
 *
 * Env: E2E_BASE, E2E_TKN, E2E_SHOTS, PPTR (puppeteer-core module dir).
 */
const fs = require('fs');
const puppeteer = require(process.env.PPTR || 'puppeteer-core');

const BASE = process.env.E2E_BASE || 'https://127.0.0.1:10000';
const TKN = process.env.E2E_TKN || '';
const SHOTS = process.env.E2E_SHOTS || '/tmp/rdv-test/shots';

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
const hex = Buffer.from(JSON.stringify(PAYLOAD), 'utf8').toString('hex');
const FOLDER_URI = `vscode-remote://dev-container+${hex}/workspaces/remote-dev/empty-test-devcontainer`;

let failures = 0;
const seen = [];
function check(name, ok) {
	console.log(`  ${ok ? '✓' : '✗'} ${name}`);
	if (!ok) { failures++; }
}

async function shot(page, name) {
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
	console.log(`    ↳ screenshot ${name}.png`);
}

(async () => {
	const isFirefox = (process.env.E2E_BROWSER || 'firefox') === 'firefox';
	const browser = await puppeteer.launch({
		browser: isFirefox ? 'firefox' : 'chrome',
		executablePath: process.env.E2E_CHROMIUM
			|| (isFirefox ? '/usr/bin/firefox-esr' : '/usr/bin/chromium'),
		protocol: isFirefox ? 'webDriverBiDi' : 'cdp',
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors',
			'--disable-crash-reporter', '--no-crashpad', '--disable-breakpad',
			'--disable-dev-shm-usage', '--window-size=1400,900'],
		acceptInsecureCerts: true,
		ignoreHTTPSErrors: true,
		defaultViewport: { width: 1400, height: 900 },
	});
	const page = await browser.newPage();
	page.on('console', (m) => {
		const t = m.text();
		seen.push(t);
		if (t.includes('remote-dev') || t.toLowerCase().includes('resolver')
			|| t.includes('dev-container')) {
			console.log(`    [browser] ${t.slice(0, 250)}`);
		}
	});
	page.on('pageerror', (e) => console.log(`    [pageerror] ${String(e).slice(0, 250)}`));

	console.log(`browser e2e against ${BASE}`);
	await page.goto(`${BASE}/?tkn=${encodeURIComponent(TKN)}`, { waitUntil: 'networkidle2', timeout: 90000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
	check('master workbench loads', true);
	await shot(page, '01-master');

	// exactly what Microsoft's extension does on Reopen in Container: an
	// in-page navigation (a BiDi page.goto gets NS_BINDING_ABORTED from the
	// workbench's beforeunload veto — a location change behaves like the
	// real openFolder)
	await page.evaluate((url) => { location.href = url; },
		`${BASE}/?folder=${encodeURIComponent(FOLDER_URI)}`);

	// the resolver should fire: the desktop progress notification shows
	// (worker console lines do not reach the page console under BiDi — the
	// notification text is the observable signal)
	let resolving = false;
	for (let i = 0; i < 60 && !resolving; i++) {
		resolving = await page.evaluate(() =>
			document.body.innerText.includes('Connecting to Dev Container')
			|| document.title.includes('[Dev Container'));
		if (!resolving) { await new Promise((r) => setTimeout(r, 1000)); }
	}
	check('authority resolution fires (desktop notification / remote title)', resolving);
	await shot(page, '02-resolving');

	// then the outcome: remote window, or a failure mode we can read
	const deadline = Date.now() + 10 * 60 * 1000; // a first build can be long
	let outcome = 'timeout';
	while (Date.now() < deadline) {
		outcome = await page.evaluate(() => {
			const text = document.body.innerText;
			if (text.includes('Workspace does not exist')) { return 'dead-workspace'; }
			if (/cannot resolve authority|no remote extension installed/i.test(text)) { return 'dead-resolver'; }
			if (document.title.includes('[Dev Container')
				&& text.includes('README.md')
				&& document.querySelector('.monaco-workbench')) { return 'remote'; }
			return 'booting';
		});
		if (outcome === 'remote' || outcome.startsWith('dead')) { break; }
		await new Promise((r) => setTimeout(r, 3000));
	}
	console.log(`    → outcome: ${outcome}`);
	await shot(page, '03-outcome');
	check('window lands INSIDE the container (desktop outcome)', outcome === 'remote');

	if (outcome === 'remote') {
		// the pink identity from the container's machine settings — it lands
		// a few seconds after the connection (remote settings via the
		// container's extension host), so poll for it
		let pink = '';
		for (let i = 0; i < 30; i++) {
			pink = await page.evaluate(() => {
				const el = document.getElementById('workbench.parts.statusbar')
					|| document.querySelector('.part.statusbar');
				return el ? getComputedStyle(el).backgroundColor : '';
			});
			if (/194, 24, 91|123, 31, 162|136, 14, 79/.test(pink)) { break; }
			await new Promise((r) => setTimeout(r, 3000));
		}
		console.log(`    → statusbar color: ${pink}`);
		check('pink container identity', /194, 24, 91|123, 31, 162|136, 14, 79/.test(pink));
		await shot(page, '04-pink');
	}

	if (failures) {
		console.log('\n── relevant console lines:');
		for (const t of seen.filter((t) => /remote-dev|resolve|dev-container|error/i.test(t)).slice(-30)) {
			console.log(`    ${t.slice(0, 300)}`);
		}
	}
	await browser.close();
	console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GREEN (browser)');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
