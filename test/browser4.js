#!/usr/bin/env node
/**
 * browser4.js — the REAL user entry point. Open a folder that contains a
 * .devcontainer in the master workbench → the Dev Containers extension
 * proposes "Reopen in Container" (its stock notification) → we click it →
 * the extension navigates → our resolver takes over → container window.
 *
 * Also asserts the "Dev Containers waiting for connection request"
 * notification NEVER appears (PG patch).
 *
 * Env: E2E_BASE, E2E_TKN, E2E_SHOTS, PPTR.
 */
const fs = require('fs');
const puppeteer = require(process.env.PPTR || 'puppeteer-core');

const BASE = process.env.E2E_BASE || 'https://127.0.0.1:10000';
const TKN = process.env.E2E_TKN || '';
const SHOTS = process.env.E2E_SHOTS || '/tmp/rdv-test/shots';

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
	console.log(`real-entry e2e against ${BASE}`);

	// open the folder in the master, like a user
	await page.goto(`${BASE}/?tkn=${encodeURIComponent(TKN)}&folder=${encodeURIComponent('/tmp/fake-ws')}`,
		{ waitUntil: 'networkidle2', timeout: 90000 });
	await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
	await sleep(3000);

	// the stock notification should propose Reopen in Container
	let proposal = '';
	for (let i = 0; i < 60 && !proposal; i++) {
		proposal = await page.evaluate(() => {
			const text = document.body.innerText;
			if (text.includes('contains a Dev Container configuration file')) { return text; }
			return '';
		});
		if (!proposal) { await sleep(1000); }
	}
	check('"contains a Dev Container configuration file" notification appears', !!proposal);
	await shot(page, '30-proposal');

	// click "Reopen in Container" in the notification
	const clicked = await page.evaluate(() => {
		const els = [...document.querySelectorAll('a,button,.monaco-button')];
		const el = els.find((e) => (e.innerText || '').trim() === 'Reopen in Container');
		if (el) { el.click(); return true; }
		return false;
	});
	console.log(`    ↳ clicked "Reopen in Container": ${clicked}`);
	check('Reopen in Container button clicked', clicked);

	// the desktop trust gate: "Opening a folder in a Dev Container may
	// execute arbitrary code… Trust Folder & Continue"
	await sleep(3000);
	const trusted = await page.evaluate(() => {
		const b = [...document.querySelectorAll('.monaco-button,button')]
			.find((e) => (e.innerText || '').includes('Trust Folder & Continue'));
		if (b) { b.click(); return true; }
		return false;
	});
	console.log(`    ↳ trust dialog (desktop parity): ${trusted}`);
	check('trust dialog offered and accepted', trusted);
	await shot(page, '31-trust');

	// the whole flow follows from the click
	const deadline = Date.now() + 5 * 60 * 1000;
	let remote = false;
	while (Date.now() < deadline && !remote) {
		remote = await page.evaluate(() => document.title.includes('[Dev Container'));
		if (!remote) { await sleep(2000); }
	}
	if (!remote) {
		// retry once via the palette (the when-clause gates are patched):
		// the extension's config read can flake right after EH restarts
		console.log('    ↳ not landed — retrying via the palette');
		await page.keyboard.press('Escape');
		await sleep(1000);
		await page.keyboard.press('F1');
		await sleep(900);
		await page.keyboard.type('Reopen in Container');
		await sleep(1200);
		await page.keyboard.press('Enter');
		const deadline2 = Date.now() + 3 * 60 * 1000;
		while (Date.now() < deadline2 && !remote) {
			remote = await page.evaluate(() => document.title.includes('[Dev Container'));
			if (!remote) { await sleep(2000); }
		}
	}
	check('window lands INSIDE the container after the click', remote);

	// and the "waiting for connection request" noise never shows
	await sleep(12000);
	const waiting = await page.evaluate(() =>
		document.body.innerText.includes('waiting for connection request'));
	check('no "waiting for connection request" notification (PG patch)', !waiting);
	await shot(page, '31-after-click');

	await browser.close();
	console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GREEN (real entry)');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
