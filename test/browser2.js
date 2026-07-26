#!/usr/bin/env node
/**
 * browser2.js — the desktop-parity deep dive, in a real browser (after
 * browser.js proves the entry). Drives the actual UX surface:
 *
 *   1. trust the workspace (desktop asks the same)
 *   2. a terminal IN THE CONTAINER (real shell, real output)
 *   3. port forwarding: server in the container → the same-port bind on
 *      the workbench's IP answers, Ports view lists it — and the desktop
 *      edit flow (select row → Change Local Address Port → the new
 *      address answers a raw TCP client)
 *   4. reload the window → native reconnect into the container
 *   5. Close Remote Connection → back to a host window
 *   6. reopen the container (daemon reuse — fast path)
 *   7. Rebuild Container → the CLI gets the desktop rebuild flags
 *   8. Reopen Folder Locally → back to the host folder
 *
 * Env: E2E_BASE, E2E_TKN, E2E_SHOTS, PPTR, FAKE_STATE.
 */
const fs = require('fs');
const puppeteer = require(process.env.PPTR || 'puppeteer-core');

const BASE = process.env.E2E_BASE || 'https://127.0.0.1:10000';
const TKN = process.env.E2E_TKN || '';
const SHOTS = process.env.E2E_SHOTS || '/tmp/rdv-test/shots';
const FAKE_STATE = process.env.FAKE_STATE || '/tmp/rdv-test/state';

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

/** The forwarded address for a container port: the service's same-port
 *  bind on the workbench's IP (loopback in tests). Idempotent — returns
 *  the assignment provideTunnel already got, or makes it now. */
async function forwardPort(port) {
	const r = await fetch(`${BASE}/api/remote-dev/forward`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: `vscode-tkn=${TKN}` },
		body: JSON.stringify({ hostPath: PAYLOAD.hostPath, port, context: 'test' }),
	});
	if (!r.ok) { return port; }
	const f = await r.json();
	return f.front || port;
}

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

async function palette(page, label) {
	await page.keyboard.press('F1');
	await sleep(700);
	await page.keyboard.type(label);
	await sleep(900);
	await page.keyboard.press('Enter');
}

/** The desktop way: the remote indicator menu (pink status bar button).
 *  el.click() does nothing there — a real mouse click opens the quick
 *  input, which is then filterable by typing. The menu can be EMPTY right
 *  after a reload (contributions still loading) — retry a few times. */
async function remoteMenu(page, itemText) {
	const box = await page.evaluate(() => {
		const bar = document.getElementById('workbench.parts.statusbar');
		const el = bar && bar.querySelector('.statusbar-item');
		if (!el) { return null; }
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	});
	if (!box) { return false; }
	for (let attempt = 0; attempt < 6; attempt++) {
		await page.mouse.click(box.x, box.y);
		await sleep(1200);
		await page.keyboard.type(itemText);
		await sleep(1200);
		const found = await page.evaluate((wanted) =>
			[...document.querySelectorAll('.quick-input-list .label-name, .quick-input-list .monaco-highlighted-label')]
				.some((e) => (e.textContent || '').includes(wanted)), itemText);
		if (found) { await page.keyboard.press('Enter'); await sleep(1500); return true; }
		const count = await page.evaluate(() =>
			document.querySelectorAll('.quick-input-list .monaco-list-row').length);
		await page.keyboard.press('Escape');
		await sleep(800);
		if (count > 0) {
			const items = await page.evaluate(() => '(non-empty but no match)');
			console.log(`    ↳ remote menu: no "${itemText}" in a non-empty menu`);
			return false;
		}
		// empty menu — contributions still loading; retry
	}
	console.log('    ↳ remote menu stayed empty after retries');
	return false;
}

async function clickButtonByText(page, texts) {
	return page.evaluate((candidates) => {
		const els = [...document.querySelectorAll('a,button,.monaco-button')];
		const el = els.find((e) => candidates.some((t) => (e.innerText || '').trim().includes(t)));
		if (el) { el.click(); return (el.innerText || '').trim().slice(0, 60); }
		return null;
	}, texts);
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

	console.log(`parity e2e against ${BASE}`);
	await openContainerWindow(page);
	check('lands in the container window', true);

	// ── 0b. what the bottom-left remote indicator actually shows ────────────
	await sleep(3000);
	const indicator = await page.evaluate(() => {
		const el = document.querySelector('[id="status.host"]');
		const meta = document.getElementById('vscode-workbench-web-configuration');
		let cfgAuthority;
		try { cfgAuthority = JSON.parse(meta.getAttribute('data-settings')).remoteAuthority; }
		catch (e) { cfgAuthority = `ERR ${e.message}`; }
		return el ? {
			text: (el.textContent || '').trim(),
			aria: el.getAttribute('aria-label') || '',
			cfgAuthority,
		} : { cfgAuthority };
	});
	console.log(`    ↳ remote indicator: ${JSON.stringify(indicator)}`);
	check('remote indicator shows the container name (desktop: "Dev Container: <name>")',
		!!indicator && typeof indicator.text === 'string'
		&& indicator.text.includes('Dev Container: Fake Test Container'));

	// ── 1. trust the workspace (the desktop asks the same) ─────────────────
	await sleep(3000);
	await clickButtonByText(page, ['Manage']);
	await sleep(1500);
	const trusted = await page.evaluate(() => {
		const b = [...document.querySelectorAll('.monaco-button,button')]
			.find((e) => (e.innerText || '').trim() === 'Trust');
		if (b) { b.click(); return true; }
		return false;
	});
	await sleep(1500);
	await page.keyboard.press('Escape');   // close the trust editor tab
	await sleep(1500);
	const stillRestricted = await page.evaluate(() =>
		document.body.innerText.includes('Restricted Mode is intended'));
	console.log(`    ↳ trust button: ${trusted}, restricted banner gone: ${!stillRestricted}`);
	check('workspace trusted (terminal allowed)', trusted && !stillRestricted);

	// ── 2. a terminal in the container ─────────────────────────────────────
	await palette(page, 'Terminal: Create New Terminal');
	await page.waitForSelector('.xterm-rows', { timeout: 30000 });
	await sleep(2500);
	await page.keyboard.type('echo PARITY-OK-12345');
	await page.keyboard.press('Enter');
	let termText = '';
	for (let i = 0; i < 15 && !termText.includes('PARITY-OK-12345'); i++) {
		await sleep(1000);
		termText = await page.evaluate(() =>
			(document.querySelector('.xterm-rows') || {}).innerText || '');
	}
	console.log(`    ↳ terminal says: ${(termText.match(/PARITY[^\n]*/) || ['?'])[0]}`);
	check('terminal runs commands in the container', termText.includes('PARITY-OK-12345'));
	await shot(page, '10-terminal');

	// ── 3. port forwarding ─────────────────────────────────────────────────
	await page.keyboard.type('python3 -m http.server 3899 &');
	await page.keyboard.press('Enter');
	await sleep(3000);
	const front3899 = await forwardPort(3899);
	let fwd = { status: 0 };
	for (let i = 0; i < 15 && fwd.status !== 200; i++) {
		await sleep(2000);
		fwd = await fetch(`http://127.0.0.1:${front3899}/`)
			.then((r) => ({ status: r.status })).catch(() => ({ status: 0 }));
	}
	check('front same-port bind answers the container server', fwd.status === 200);
	const portsRow = await page.evaluate(() => {
		const panel = document.getElementById('workbench.parts.panel');
		return panel ? panel.innerText.includes('3899') : false;
	});
	console.log(`    ↳ panel contains 3899 before opening Ports view: ${portsRow}`);
	await shot(page, '11-ports');

	// ── 3b. the Ports view UI itself (desktop: row + forwarded address) ─────
	await palette(page, 'Ports: Focus on Ports View');
	await sleep(2500);
	const portsPanel = await page.evaluate(() => {
		const panel = document.getElementById('workbench.parts.panel');
		return panel ? panel.innerText : '';
	});
	console.log(`    ↳ ports panel: ${portsPanel.replace(/\s+/g, ' ').slice(0, 140)}`);
	// the row shows the remote port (3899) and a forwarded address: either
	// the same-port front URL or the next free port (allocator — in tests
	// the fake container squats 3899)
	const rowOk = portsPanel.includes('3899')
		&& /127\.0\.0\.1:\d{4}/.test(portsPanel);
	check('Ports view row shows port + forwarded address (desktop columns)', rowOk);
	await shot(page, '11b-portsview');

	// ── 3c. the auto-forward toast (desktop: "…running on port N is available")
	// N is the FORWARDED port — the allocator may have incremented it
	let toast = false;
	for (let i = 0; i < 10 && !toast; i++) {
		await sleep(2000);
		toast = await page.evaluate(() => /\d{4} is available/.test(document.body.innerText));
	}
	console.log(`    ↳ auto-forward toast: ${toast}`);
	check('auto-forward toast (desktop) fired', toast);

	// ── 3d. the status is LIVE: kill the server → bind AND row die ─────────
	// (bracket trick: a bare pattern would match this very shell's cmdline
	// and SIGTERM the test — seen for real)
	try { require('child_process').execSync("pkill -f 'http[.]server 3899' || true"); } catch { /* no match */ }
	let deadRoute = false;
	let deadRow = false;
	for (let i = 0; i < 15 && !(deadRoute && deadRow); i++) {
		await sleep(2000);
		const st = await fetch(`http://127.0.0.1:${front3899}/`)
			.then((r) => r.status).catch(() => 0);
		deadRoute = st !== 200;
		deadRow = await page.evaluate(() => {
			const panel = document.getElementById('workbench.parts.panel');
			return panel ? !panel.innerText.includes('3899') : false;
		});
	}
	console.log(`    ↳ after kill: bind dead: ${deadRoute}, row gone: ${deadRow}`);
	check('status is live: server death closes the bind AND the Ports row', deadRoute && deadRow);

	// ── 3e. MANUAL forward (desktop: the "Forward a Port" command) ──────────
	await palette(page, 'Terminal: Create New Terminal');
	await page.waitForSelector('.xterm-rows', { timeout: 30000 });
	await sleep(2500);
	await page.keyboard.type('python3 -m http.server 3901 &');
	await page.keyboard.press('Enter');
	await sleep(3000);
	await palette(page, 'Forward a Port');
	await sleep(1500);
	await page.keyboard.type('3901');
	await sleep(800);
	await page.keyboard.press('Enter');
	const front3901 = await forwardPort(3901);
	let manual = false;
	for (let i = 0; i < 15 && !manual; i++) {
		await sleep(2000);
		const st = await fetch(`http://127.0.0.1:${front3901}/`)
			.then((r) => r.status).catch(() => 0);
		manual = st === 200;
	}
	console.log(`    ↳ manual forward bind: ${manual}`);
	check('manual "Forward a Port" works (desktop command)', manual);
	try { require('child_process').execSync("pkill -f 'http[.]server 3901' || true"); } catch { /* no match */ }

	// ── 3f. the REAL user sequence: toast FIRST, Ports tab opened AFTER ─────
	// (raven's report: the toast fired but the tab looked empty. The row must
	// be in the model the moment the toast exists, and the address the UI
	// shows must actually answer. Port 3950: far from the allocator's recent
	// assignments — a front bind for 3901 squats 3902+, that bit us once.
	// Fresh terminal: after a palette flow the focus is NOT the terminal —
	// typing blind there dies silently, that bit us too.)
	await palette(page, 'Terminal: Create New Terminal');
	await page.waitForSelector('.xterm-rows', { timeout: 30000 });
	await sleep(2500);
	await page.keyboard.type('python3 -m http.server 3950 &');
	await page.keyboard.press('Enter');
	await sleep(3000);
	const srvUp = await fetch('http://127.0.0.1:3950/').then((r) => r.status).catch(() => 0);
	console.log(`    ↳ the 3950 server itself answers: ${srvUp}`);
	check('the 3950 server actually started (typed into the terminal)', srvUp === 200);
	let toast2 = false;
	for (let i = 0; i < 15 && !toast2; i++) {
		await sleep(2000);
		toast2 = await page.evaluate(() => /3950 is available/.test(document.body.innerText));
	}
	console.log(`    ↳ toast fired before any Ports focus: ${toast2}`);
	check('auto-forward toast fires without the Ports view ever focused', toast2);
	await palette(page, 'Ports: Focus on Ports View');
	let row2 = '';
	for (let i = 0; i < 6 && !row2; i++) {
		await sleep(1000);
		row2 = await page.evaluate(() => {
			const panel = document.getElementById('workbench.parts.panel');
			const m = panel ? panel.innerText.match(/3950\s+127\.0\.0\.1:(\d+)/) : null;
			return m ? m[1] : '';
		});
	}
	console.log(`    ↳ row present immediately after focus, address port: ${row2 || 'NONE'}`);
	check('Ports row is there the moment the toast exists (no stale/empty view)', row2 !== '');
	const uiAnswer = row2
		? await fetch(`http://127.0.0.1:${row2}/`).then((r) => r.status).catch(() => 0) : 0;
	check('the address the UI shows actually answers (full loop)', uiAnswer === 200);
	try { require('child_process').execSync("pkill -f 'http[.]server 3950' || true"); } catch { /* no match */ }

	// ── 3g. EDIT the forwarded port THROUGH THE UI, then tap it raw ──────────
	// (desktop: select the row → "Change Local Address Port" → inline edit.
	// raven: "change it in the UI, check it appears, and tap it with nc".)
	await palette(page, 'Terminal: Create New Terminal');
	await page.waitForSelector('.xterm-rows', { timeout: 30000 });
	await sleep(2500);
	await page.keyboard.type('python3 -m http.server 3960 &');
	await page.keyboard.press('Enter');
	await sleep(3000);
	await palette(page, 'Ports: Focus on Ports View');
	let row3960 = false;
	for (let i = 0; i < 10 && !row3960; i++) {
		await sleep(2000);
		row3960 = await page.evaluate(() => {
			const panel = document.getElementById('workbench.parts.panel');
			return panel ? panel.innerText.includes('3960') : false;
		});
	}
	check('row for the 3960 server appears in the Ports view', row3960);
	// the desktop gesture: RIGHT-CLICK the row → context menu → "Change Local
	// Address Port". Find the row by CONTENT, not by a guessed class (three
	// blind runs: .monaco-tl-row is a tree, .monaco-table-tr doesn't match
	// this build either) — take the leaf holding "3960", climb to its
	// role=row ancestor, and DUMP the structure so the next failure is legible
	const found = await page.evaluate(() => {
		const panel = document.getElementById('workbench.parts.panel');
		if (!panel) { return null; }
		const leaf = [...panel.querySelectorAll('*')]
			.find((e) => e.children.length === 0 && (e.textContent || '').trim() === '3960');
		if (!leaf) { return { leaf: false, sample: panel.innerHTML.slice(0, 800) }; }
		const row = leaf.closest('[role="row"]')
			|| leaf.closest('[class*="-tr"]') || leaf.parentElement;
		const r = (row || leaf).getBoundingClientRect();
		return {
			leaf: true,
			leafTag: `${leaf.tagName}.${leaf.className}`,
			rowTag: row ? `${row.tagName}.${row.className}` : null,
			x: r.x + r.width / 2, y: r.y + r.height / 2,
		};
	});
	console.log(`    ↳ 3960 row: ${JSON.stringify(found)}`);
	if (found && found.leaf) { await page.mouse.click(found.x, found.y, { button: 'right' }); }
	await sleep(1200);
	const menu = await page.evaluate(() => {
		const view = document.querySelector('.context-view');
		const open = !!(view && view.offsetHeight > 0);
		const items = open
			? [...view.querySelectorAll('.action-label')].map((e) => (e.textContent || '').trim())
			: [];
		let at = null;
		if (open) {
			const it = [...view.querySelectorAll('.action-item')]
				.find((e) => (e.textContent || '').includes('Change Local Address Port'));
			if (it) {
				const r = it.getBoundingClientRect();
				at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
			}
		}
		return { open, items, at };
	});
	console.log(`    ↳ context menu: open=${menu.open} items=${JSON.stringify(menu.items)}`);
	// a REAL mouse click — VS Code's menu widget runs actions on genuine
	// mouse events; a synthetic dispatchEvent leaves the menu just hanging
	// open (seen live on the debug screenshot)
	if (menu.at) { await page.mouse.click(menu.at.x, menu.at.y); }
	// hunt the inline editor — with diagnostics: what the panel holds each
	// second, plus an intermediate screenshot if it never shows
	let editBox = false;
	for (let i = 0; i < 12 && !editBox; i++) {
		await sleep(1000);
		const diag = await page.evaluate(() => {
			const panel = document.getElementById('workbench.parts.panel');
			const inputs = panel ? [...panel.querySelectorAll('input')].map((b) => b.className) : [];
			const qp = document.querySelector('.quick-input-widget');
			const qpOpen = !!(qp && qp.offsetHeight > 0);
			if (qpOpen) {
				const rows = [...qp.querySelectorAll('.monaco-list-row')];
				const r = rows.find((x) => (x.innerText || '').includes('3960'));
				if (r) { r.click(); }
			}
			const box = panel && panel.querySelector('.monaco-inputbox input, input.input');
			if (box) { box.focus(); box.select(); return { editBox: true, inputs }; }
			return { editBox: false, inputs, qpOpen };
		});
		if (i === 3 || i === 8) {
			console.log(`    ↳ 3g debug[${i}]: ${JSON.stringify(diag)}`);
			await shot(page, `11c-debug-${i}`);
		}
		editBox = diag.editBox;
	}
	console.log(`    ↳ inline edit box on the row: ${editBox}`);
	check('"Change Local Address Port" opens the inline editor (desktop command)', editBox);
	if (editBox) {
		await page.keyboard.type('3966');
		await sleep(500);
		await page.keyboard.press('Enter');
	}
	let edited = false;
	for (let i = 0; i < 10 && !edited; i++) {
		await sleep(2000);
		edited = await page.evaluate(() => {
			const panel = document.getElementById('workbench.parts.panel');
			const text = panel ? panel.innerText.replace(/\s+/g, ' ') : '';
			return /3960 127\.0\.0\.1:3966/.test(text);
		});
	}
	await shot(page, '11c-portsview-edited');
	check('the Ports row now shows the edited address (127.0.0.1:3966)', edited);
	// nc-style: a RAW TCP socket, not fetch — tap the edited address
	let raw = '';
	try {
		raw = await new Promise((resolve, reject) => {
			const s = require('net').connect(3966, '127.0.0.1', () => s.write('GET / HTTP/1.0\r\n\r\n'));
			let d = '';
			s.on('data', (c) => { d += c; s.end(); resolve(d); });
			s.on('error', reject);
			setTimeout(() => reject(new Error('timeout on 3966')), 5000);
		});
	} catch (e) { raw = String((e && e.message) || e); }
	console.log(`    ↳ raw socket on 3966: ${raw.slice(0, 60).replace(/\s+/g, ' ')}`);
	check('raw TCP client (nc-style) reaches the container server via the edited port', raw.includes('200'));
	try { require('child_process').execSync("pkill -f 'http[.]server 3960' || true"); } catch { /* no match */ }

	// ── 4. reload → native reconnect ───────────────────────────────────────
	const t0 = Date.now();
	await page.evaluate((u) => { location.href = u; }, `${BASE}/?folder=${encodeURIComponent(FOLDER_URI)}`);
	let back = false;
	for (let i = 0; i < 60 && !back; i++) {
		back = (await page.evaluate(() => document.title)).includes('[Dev Container');
		if (!back) { await sleep(1000); }
	}
	console.log(`    ↳ reconnect took ~${Math.round((Date.now() - t0) / 1000)}s`);
	check('reload reconnects into the container', back);

	// ── 5. Close Remote Connection ─────────────────────────────────────────
	await sleep(4000);
	const closed = await remoteMenu(page, 'Close Remote Connection');
	console.log(`    ↳ remote menu "Close Remote Connection": ${closed}`);
	let local = false;
	for (let i = 0; i < 45 && !local; i++) {
		const title = await page.evaluate(() => document.title);
		local = title.length > 0 && !title.includes('[Dev Container');
		await sleep(1000);
	}
	check('Close Remote Connection leaves the container', closed && local);
	await shot(page, '12-closed');

	// ── 6. reopen (daemon reuse — should be quick) ─────────────────────────
	const t1 = Date.now();
	await page.evaluate((u) => { location.href = u; }, `${BASE}/?folder=${encodeURIComponent(FOLDER_URI)}`);
	back = false;
	for (let i = 0; i < 90 && !back; i++) {
		back = (await page.evaluate(() => document.title)).includes('[Dev Container');
		if (!back) { await sleep(1000); }
	}
	console.log(`    ↳ reopen took ~${Math.round((Date.now() - t1) / 1000)}s (daemon reused)`);
	check('reopen reuses the running daemon', back);

	// ── 7. Rebuild Container ───────────────────────────────────────────────
	await sleep(4000);
	const before = fs.existsSync(`${FAKE_STATE}/cli-args.log`)
		? fs.readFileSync(`${FAKE_STATE}/cli-args.log`, 'utf8') : '';
	await palette(page, 'Rebuild Container');
	let rebuilt = false;
	for (let i = 0; i < 30 && !rebuilt; i++) {
		await sleep(1000);
		const now = fs.existsSync(`${FAKE_STATE}/cli-args.log`)
			? fs.readFileSync(`${FAKE_STATE}/cli-args.log`, 'utf8') : '';
		rebuilt = now.length > before.length && now.includes('--remove-existing-container');
	}
	check('Rebuild Container passes the desktop rebuild flags', rebuilt);
	back = false;
	for (let i = 0; i < 90 && !back; i++) {
		back = (await page.evaluate(() => document.title)).includes('[Dev Container');
		if (!back) { await sleep(1000); }
	}
	check('window comes back after the rebuild', back);
	await shot(page, '13-rebuilt');

	// ── 8. Reopen Folder Locally ───────────────────────────────────────────
	// Same remote indicator menu as Close Remote Connection (group
	// remote_30_dev-container_2_actions in the extension's contributions).
	const reopened = await remoteMenu(page, 'Reopen Folder Locally');
	console.log(`    ↳ remote menu "Reopen Folder Locally": ${reopened}`);
	let hostTitle = '';
	for (let i = 0; i < 45; i++) {
		hostTitle = await page.evaluate(() => document.title);
		if (!hostTitle.includes('[Dev Container') && hostTitle.includes('fake-ws')) { break; }
		await sleep(1000);
	}
	console.log(`    ↳ host title: ${hostTitle.slice(0, 70)}`);
	check('Reopen Folder Locally lands on the host folder',
		hostTitle.includes('fake-ws') && !hostTitle.includes('[Dev Container'));
	await shot(page, '14-local');

	await browser.close();
	console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GREEN (parity)');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
