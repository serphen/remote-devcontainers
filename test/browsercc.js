#!/usr/bin/env node
/**
 * browsercc.js — the Command Center (title-bar search pill) under the pink
 * container theme: dumps the COMPUTED styles (not guesses) of the pill and
 * its content, plus a zoomed screenshot. raven: "le texte est blanc sur
 * blanc".
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
	await page.goto(`${BASE}/?tkn=${encodeURIComponent(TKN)}`, { waitUntil: 'networkidle2', timeout: 90000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
	await page.evaluate((u) => { location.href = u; },
		`${BASE}/?folder=${encodeURIComponent(FOLDER_URI)}`);
	const deadline = Date.now() + 5 * 60 * 1000;
	for (;;) {
		const title = await page.evaluate(() => document.title);
		if (title.includes('[Dev Container')) { break; }
		if (Date.now() > deadline) { throw new Error('never landed in the container window'); }
		await sleep(2000);
	}
	await sleep(4000);

	const dump = await page.evaluate(() => {
		const pick = (el) => {
			if (!el) { return null; }
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return {
				cls: String(el.className).slice(0, 90),
				bg: cs.backgroundColor,
				color: cs.color,
				borderColor: cs.borderColor,
				box: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
			};
		};
		const out = {};
		for (const sel of [
			'.command-center',
			'.command-center-center',
			'.command-center-quick-pick',
			'.command-center-quick-pick .search-label',
			'.agent-status-pill',
			'.agent-status-input-area',
			'.agent-status-label',
			'.window-title',
			'.titlebar-center',
		]) {
			out[sel] = pick(document.querySelector(sel));
		}
		return out;
	});
	console.log(JSON.stringify(dump, null, 1));
	// regression assertion (raven's "blanc sur blanc"): the agent-status
	// input area must NOT render white-on-white
	const area = dump['.agent-status-input-area'];
	const ok = area
		&& area.bg === 'rgb(163, 21, 69)'   // the pink theme's pinned #A31545
		&& area.color === 'rgb(255, 255, 255)';
	console.log(`  ${ok ? '✓' : '✗'} agent-status input area is pink with white text (got bg=${area && area.bg}, color=${area && area.color})`);
	if (!ok) { process.exitCode = 1; }

	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/cc-full.png` });
	const tb = await page.evaluate(() => {
		const el = document.getElementById('workbench.parts.titlebar');
		const r = el ? el.getBoundingClientRect() : null;
		return r ? { x: r.x, y: r.y, width: r.width, height: Math.max(r.height, 40) } : null;
	});
	if (tb) {
		await page.screenshot({ path: `${SHOTS}/cc-zoom.png`, clip: { x: tb.x, y: tb.y, width: tb.width, height: tb.height } });
	}
	console.log(`    ↳ screenshots cc-full.png / cc-zoom.png in ${SHOTS}`);
	await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
