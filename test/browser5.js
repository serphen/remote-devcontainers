#!/usr/bin/env node
/**
 * browser5.js — the bottom-right proposal, lifecycle-complete, like desktop:
 *   1. open a folder with .devcontainer → the toast appears, with the
 *      desktop text and the desktop buttons
 *   2. "Don't Show Again..." once-only behavior: after dismissing/entering,
 *      reopening the folder does NOT re-propose
 *   3. the Reset command re-enables the proposal
 *   4. clicking Reopen in Container still lands in the container
 *
 * Env: E2E_BASE, E2E_TKN, E2E_SHOTS, PPTR.
 */
const fs = require('fs');
const puppeteer = require(process.env.PPTR || 'puppeteer-core');

const BASE = process.env.E2E_BASE || 'https://127.0.0.1:10000';
const TKN = process.env.E2E_TKN || '';
const SHOTS = process.env.E2E_SHOTS || '/tmp/rdv-test/shots';
const WS = '/tmp/fake-ws';
const hex = Buffer.from(JSON.stringify({
	hostPath: WS, localDocker: false, settings: { context: 'test' },
	configFile: { $mid: 1, fsPath: `${WS}/.devcontainer/devcontainer.json`, path: `${WS}/.devcontainer/devcontainer.json`, scheme: 'file' },
}), 'utf8').toString('hex');
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

async function openFolder(page) {
	if (!page.url().includes('10000')) {
		await page.goto(`${BASE}/?tkn=${encodeURIComponent(TKN)}&folder=${encodeURIComponent(WS)}`,
			{ waitUntil: 'networkidle2', timeout: 90000 });
	} else {
		try {
			await page.evaluate((u) => { location.href = u; },
				`${BASE}/?folder=${encodeURIComponent(WS)}`);
		} catch (e) { /* the frame may already be mid-navigation — wait it out */ }
	}
	await page.waitForSelector('.monaco-workbench', { timeout: 90000 });
	await sleep(4000);
}

async function proposalText(page) {
	for (let i = 0; i < 30; i++) {
		const t = await page.evaluate(() => {
			const els = [...document.querySelectorAll('.notification-toast, .notifications-toasts')];
			return els.map((e) => e.innerText).join('\n');
		});
		if (t.includes('Dev Container configuration file')) { return t; }
		await sleep(1000);
	}
	return '';
}

(async () => {
	const browser = await puppeteer.launch({
		browser: 'firefox', executablePath: process.env.E2E_CHROMIUM || '/usr/bin/firefox-esr',
		protocol: 'webDriverBiDi', headless: true, args: ['--no-sandbox'],
		acceptInsecureCerts: true, defaultViewport: { width: 1400, height: 900 },
	});
	const page = await browser.newPage();
	console.log(`proposal-lifecycle e2e against ${BASE}`);

	// ── 1. the toast: desktop text + desktop buttons ───────────────────────
	await openFolder(page);
	const text = await proposalText(page);
	console.log(`    ↳ toast: ${text.replace(/\n/g, ' | ').slice(0, 200)}`);
	check('toast: "Folder contains a Dev Container configuration file"', text.includes('Folder contains a Dev Container configuration file'));
	check('toast: "Reopen folder to develop in a container" + learn more',
		text.includes('develop in a container'));
	const buttons = await page.evaluate(() =>
		[...document.querySelectorAll('.notification-toast a, .notification-toast button, .notification-toast .monaco-button')]
			.map((e) => (e.innerText || '').trim()).filter(Boolean));
	console.log(`    ↳ buttons: ${JSON.stringify(buttons)}`);
	check('toast: [Reopen in Container] button (desktop)', buttons.some((b) => b === 'Reopen in Container'));
	check("toast: [Don't Show Again...] button (desktop)", buttons.some((b) => b.includes("Show Again")));
	await shot(page, '40-proposal');

	// ── 2. enter the container via the toast, close, reopen: no re-toast ───
	await page.evaluate(() => {
		const el = [...document.querySelectorAll('a,button,.monaco-button')]
			.find((e) => (e.innerText || '').trim() === 'Reopen in Container');
		if (el) { el.click(); }
	});
	await sleep(3000);
	await page.evaluate(() => {
		const b = [...document.querySelectorAll('.monaco-button,button')]
			.find((e) => (e.innerText || '').includes('Trust Folder & Continue'));
		if (b) { b.click(); }
	});
	let remote = false;
	for (let i = 0; i < 60 && !remote; i++) {
		remote = (await page.evaluate(() => document.title)).includes('[Dev Container');
		if (!remote) { await sleep(1000); }
	}
	check('toast → container window', remote);

	// close remote connection via the remote indicator menu
	await sleep(4000);
	const box = await page.evaluate(() => {
		const bar = document.getElementById('workbench.parts.statusbar');
		const el = bar && bar.querySelector('.statusbar-item');
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	});
	await page.mouse.click(box.x, box.y);
	await sleep(1200);
	await page.keyboard.type('Close Remote Connection');
	await sleep(1000);
	await page.keyboard.press('Enter');
	await sleep(5000);

	// desktop behavior: the toast fires EVERY time until the user picks
	// "Don't Show Again…" — verify it re-fires, then dismiss for this
	// folder, verify it stays silent, then the Reset brings it back.
	await openFolder(page);
	const text2 = await proposalText(page);
	check('toast re-fires on reopen until dismissed (desktop behavior)', !!text2);

	const dismissed = await page.evaluate(() => {
		const el = [...document.querySelectorAll('a,button,.monaco-button')]
			.find((e) => (e.innerText || '').includes("Don't Show Again"));
		if (el) { el.click(); return true; }
		return false;
	});
	console.log(`    ↳ clicked "Don't Show Again…": ${dismissed}`);
	await sleep(1500);
	const scoped = await page.evaluate(() => {
		const items = [...document.querySelectorAll('a,button,.monaco-button')];
		const it = items.find((e) => /^(current folder|any folder|this folder|this workspace)$/i.test((e.innerText || '').trim()));
		if (it) { it.click(); return (it.innerText || '').trim(); }
		return items.map((e) => (e.innerText || '').trim()).filter(Boolean).join(',');
	});
	console.log(`    ↳ scope picked: ${scoped}`);
	await sleep(1500);
	await shot(page, '41-dismissed');

	await openFolder(page);
	const text3 = await proposalText(page);
	check('silent after "Don\'t Show Again" (desktop behavior)', !text3);

	// the Reset command re-enables it (visible in the palette only now)
	await page.keyboard.press('F1');
	await sleep(900);
	await page.keyboard.type('Notification Reset');
	await sleep(1200);
	// the re-toast below is the proof the Reset ran (the palette label
	// itself varies; do not assert on it)
	await page.keyboard.press('Enter');
	await sleep(1500);

	await openFolder(page);
	const text4 = await proposalText(page);
	check('toast re-appears after Reset', text4.includes('Folder contains a Dev Container configuration file'));
	await shot(page, '42-after-reset');

	await browser.close();
	console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GREEN (proposal lifecycle)');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
