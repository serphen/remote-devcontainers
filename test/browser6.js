#!/usr/bin/env node
/**
 * browser6.js — the command-surface audit. Lands in the container window,
 * opens the command palette and dumps every "Dev Container"/"Remote" entry
 * the extension actually offers there — the empirical answer to "which of
 * the extension's commands have an equivalent in the web UI". Screenshots.
 *
 * Env: E2E_BASE, E2E_TKN, E2E_SHOTS, PPTR.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openContainerWindow(page) {
	await page.goto(`${BASE}/?tkn=${encodeURIComponent(TKN)}`, { waitUntil: 'networkidle2', timeout: 90000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
	await page.evaluate((u) => { location.href = u; },
		`${BASE}/?folder=${encodeURIComponent(FOLDER_URI)}`);
	const deadline = Date.now() + 5 * 60 * 1000;
	for (;;) {
		const title = await page.evaluate(() => document.title);
		if (title.includes('[Dev Container')) { return; }
		if (Date.now() > deadline) { throw new Error('never landed in the container window'); }
		await sleep(2000);
	}
}

/** Palette dump: type the query, then collect every quick-pick row. The
 *  list is virtualized — scroll it to the bottom in steps, dedupe by label. */
async function paletteDump(page, query) {
	await page.keyboard.press('F1');
	await sleep(900);
	await page.keyboard.type(query);
	await sleep(1500);
	const seen = new Map();
	for (let i = 0; i < 30; i++) {
		const rows = await page.evaluate(() =>
			[...document.querySelectorAll('.quick-input-list .monaco-list-row')]
				.map((r) => ({
					label: (r.querySelector('.label-name') || {}).textContent || '',
					detail: (r.querySelector('.label-description') || {}).textContent || '',
				}))
				.filter((r) => r.label));
		const before = seen.size;
		for (const r of rows) { seen.set(r.label, r); }
		await page.keyboard.press('PageDown');
		await sleep(400);
		if (seen.size === before) {
			// one more End to be sure we hit the bottom, then stop if stable
			await page.keyboard.press('End');
			await sleep(400);
			const more = await page.evaluate(() =>
				[...document.querySelectorAll('.quick-input-list .monaco-list-row')]
					.map((r) => (r.querySelector('.label-name') || {}).textContent || ''));
			for (const l of more) { if (l && !seen.has(l)) { seen.set(l, { label: l, detail: '' }); } }
			break;
		}
	}
	await page.keyboard.press('Escape');
	await sleep(600);
	return [...seen.values()];
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
	console.log(`command-surface audit against ${BASE}`);
	await openContainerWindow(page);
	await sleep(5000);   // let the container-side extension finish activating

	const devContainer = await paletteDump(page, 'Dev Container');
	fs.mkdirSync(SHOTS, { recursive: true });
	// re-open for the screenshot with the full list visible
	await page.keyboard.press('F1');
	await sleep(900);
	await page.keyboard.type('Dev Container');
	await sleep(1500);
	await page.screenshot({ path: `${SHOTS}/30-palette-devcontainer.png` });
	await page.keyboard.press('Escape');
	await sleep(600);

	const remote = await paletteDump(page, 'Remote');

	console.log('\n== palette "Dev Container" (container window) ==');
	for (const r of devContainer) { console.log(`  ${r.label}${r.detail ? `  — ${r.detail}` : ''}`); }
	console.log(`\n== palette "Remote" (container window) ==`);
	for (const r of remote) { console.log(`  ${r.label}${r.detail ? `  — ${r.detail}` : ''}`); }
	console.log(`\ncounts: dev-container=${devContainer.length} remote=${remote.length}`);

	// the Remote Explorer views — on desktop they list host containers/
	// volumes via the UI-side extension (host docker). Here the extension
	// runs container-side only: dump what the views actually show.
	async function dumpView(label, file) {
		await page.keyboard.press('F1');
		await sleep(900);
		await page.keyboard.type(label);
		await sleep(1200);
		await page.keyboard.press('Enter');
		await sleep(4000);
		const text = await page.evaluate(() => {
			const side = document.getElementById('workbench.parts.sidebar');
			return side ? side.innerText.replace(/\s+/g, ' ').slice(0, 400) : '(no sidebar)';
		});
		await page.screenshot({ path: `${SHOTS}/${file}.png` });
		console.log(`\n== ${label} ==\n  ${text}`);
		return text;
	}
	const explorerText = await dumpView('Remote Explorer: Focus on Dev Containers View', '31-explorer-containers');
	const volumesText = await dumpView('Remote Explorer: Focus on Dev Volumes View', '32-explorer-volumes');

	fs.writeFileSync(`${SHOTS}/30-palette.json`, JSON.stringify(
		{ devContainer, remote, explorerText, volumesText }, null, 1));
	await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
