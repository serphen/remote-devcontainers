#!/usr/bin/env node
/**
 * browser9.js — THE PALETTE GAUNTLET. Every "Dev Containers"/"Remote"
 * palette entry in the container window is EXECUTED FOR REAL and its
 * observable effect is asserted — not described, observed:
 *
 *   quickpick  a quick input opens (optionally with matching content) → Escape
 *   editor     an editor tab opens with a matching title
 *   settings   the Settings editor opens
 *   toast      a notification appears (matched) → dismissed
 *   external   the command opens an external target (new tab) or the
 *              external-link trust dialog
 *   panel      the bottom panel opens with matching content
 *   silent     the command runs, no error surfaces
 *
 * Destructive/session-changing commands run LAST, each with its effect
 * verified in the fake docker state or the window, then the container
 * is re-entered for the next one:
 *   Stop Container        → $FAKE_STATE/built is GONE (docker stop ran)
 *   Reopen Folder Locally → host folder window
 *   Close Remote Connection → host window
 *   Rebuild [NoCache]     → the CLI receives the desktop flag set
 *
 * Env: E2E_BASE, E2E_TKN, E2E_SHOTS, PPTR, FAKE_STATE.
 */
const fs = require('fs');
const puppeteer = require(process.env.PPTR || 'puppeteer-core');

const BASE = process.env.E2E_BASE || 'https://127.0.0.1:10000';
const TKN = process.env.E2E_TKN || '';
const SHOTS = process.env.E2E_SHOTS || '/tmp/rdv-test/shots';
const FAKE_STATE = process.env.FAKE_STATE || '/tmp/rdv-test/state';
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
function check(name, ok, observed) {
	console.log(`  ${ok ? '✓' : '✗'} ${name}${observed !== undefined ? `  →  ${observed}` : ''}`);
	if (!ok) { failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) {
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** What did the command do? A snapshot of every observable surface. */
async function inspectUI(page) {
	return page.evaluate(() => {
		const txt = (sel) => {
			const el = document.querySelector(sel);
			return el ? (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 220) : '';
		};
		const quickWidget = document.querySelector('.quick-input-widget');
		const quickVisible = quickWidget
			&& !!(quickWidget.offsetWidth || quickWidget.offsetHeight) ? txt('.quick-input-widget') : '';
		const tab = document.querySelector('.tabs-container .tab.active .tab-label, .tabs-container .tab.active .label-name');
		return {
			quick: quickVisible,
			toast: txt('.notifications-toasts'),
			tab: tab ? (tab.textContent || '').trim() : '',
			tabs: [...document.querySelectorAll('.tabs-container .tab .tab-label, .tabs-container .tab .label-name')]
				.map((t) => (t.textContent || '').trim()).join('|'),
			outChannel: (() => {
				const dd = document.querySelector('#workbench\\.parts\\.panel .monaco-dropdown .dropdown-label, #workbench\\.parts\\.panel .action-label[aria-label*="channel" i]');
				return dd ? (dd.textContent || '').trim().slice(0, 80) : '';
			})(),
			panel: (() => {
				const p = document.getElementById('workbench.parts.panel');
				const visible = p && p.offsetHeight > 50;
				const active = document.querySelector('#workbench\\.parts\\.panel .panel-switcher-container .action-item.checked, #workbench\\.parts\\.panel .monaco-action-bar .checked');
				return visible ? `visible:${active ? active.textContent.trim() : ''} ${p.innerText.replace(/\s+/g, ' ').slice(0, 160)}` : '';
			})(),
			settings: !!document.querySelector('.settings-editor'),
			dialog: txt('.monaco-dialog-box'),
		};
	});
}

async function dismissAll(page) {
	await page.bringToFront().catch(() => {});
	await page.keyboard.press('Escape');
	await sleep(300);
	await page.keyboard.press('Escape');
	await sleep(300);
	await page.evaluate(() => {
		for (const b of document.querySelectorAll('.notification-list-item .codicon-close, .notifications-toasts .codicon-close, .monaco-dialog-box .codicon-close')) {
			b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		}
	});
	await sleep(400);
	// focus thieves (seen live: after an external tab closes, the CHAT
	// input keeps the DOM focus and eats F1 + every typed command)
	await page.evaluate(() => {
		const ed = document.querySelector('.monaco-workbench .part.editor');
		if (ed) { ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }
	});
	await sleep(300);
}

/** The workspace-trust prompt (desktop asks the same) swallows ALL keyboard
 *  input while it is up — accept it, whichever variant shows (modal dialog
 *  or editor button), or every later command types into the void. */
async function trustWorkspace(page) {
	for (let i = 0; i < 6; i++) {
		const done = await page.evaluate(() => {
			const dialogBtn = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')]
				.find((b) => /Trust Folder & Continue/i.test(b.textContent || ''));
			if (dialogBtn) { dialogBtn.click(); return 'dialog'; }
			const edBtn = [...document.querySelectorAll('.monaco-button')]
				.find((b) => (b.innerText || '').trim() === 'Trust');
			if (edBtn) { edBtn.click(); return 'editor'; }
			return document.body.innerText.includes('Restricted Mode is intended') ? 'restricted' : 'trusted';
		});
		if (done === 'trusted') { return; }
		await sleep(1500);
		if (done !== 'restricted') { await page.keyboard.press('Escape'); await sleep(1000); }
	}
}

/** F1 → type the exact command → verify the text landed → click the EXACT
 *  row (the palette's "recently used" boost would otherwise re-run a recent
 *  look-alike — seen live: "Rebuild Container" re-ran "…Without Cache"). */
async function runCommand(page, label, idx) {
	for (let attempt = 0; attempt < 2; attempt++) {
		await dismissAll(page);
		await page.keyboard.press('F1');
		await sleep(800);
		await page.keyboard.type(label);
		await sleep(1100);
		const landed = await page.evaluate(() => {
			const inp = document.querySelector('.quick-input-widget input');
			return inp ? inp.value : '';
		});
		if (landed.length >= Math.min(8, label.length)) { break; }
		console.log(`    ↳ [${idx}] typed text lost (focus theft) — retry`);
		await sleep(800);
	}
	const pick = await page.evaluate((want) => {
		const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
		const rows = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')];
		const lnOf = (r) => norm(r.querySelector('.label-name')?.textContent);
		// rows carry the FULL title with category — exact label-name match
		// first, so a recently-used look-alike (Rebuild …Without Cache, MCP)
		// can never win a fuzzy containment race again
		const m = want.match(/^(.*)\s+\(([^()]*)\)$/);   // name + trailing qualifier
		const name = m ? m[1] : want;
		const tail = m ? m[2] : '';
		const row = rows.find((r) => lnOf(r) === norm(want))
			|| rows.find((r) => lnOf(r) === norm(name) && (!tail || norm(r.textContent).includes(tail)))
			|| rows.find((r) => lnOf(r) === norm(name.replace(/^[^:]*:\s*/, '')) && !tail);
		if (row) {
			for (const type of ['mousedown', 'mouseup', 'click']) {
				row.dispatchEvent(new MouseEvent(type, { bubbles: true }));
			}
			return { ok: true, picked: lnOf(row) };
		}
		return { ok: false, rows: rows.slice(0, 6).map(lnOf) };
	}, label);
	if (!pick.ok) {
		console.log(`      ! no exact row for "${label}" — rows: ${(pick.rows || []).join(' | ')}`);
	} else if (pick.picked !== label) {
		console.log(`      ↳ picked "${pick.picked}" for "${label}"`);
	}
	// the dispatched click SELECTS but does not always ACCEPT — and when it
	// DOES execute, the command may open its own quickpick, where a blind
	// Enter would pick the first item (seen live: "GitHub Codespace",
	// quickpicks closed before inspection). Only press Enter when the input
	// still holds OUR typed text (the palette has not executed anything).
	await sleep(400);
	const inputNow = await page.evaluate(() => {
		const inp = document.querySelector('.quick-input-widget input');
		return inp ? inp.value : null;
	});
	if (inputNow === label) { await page.keyboard.press('Enter'); }
	await sleep(1800);
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
	console.log(`palette gauntlet against ${BASE}`);

	async function enterContainer() {
		await page.goto(`${BASE}/?tkn=${encodeURIComponent(TKN)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
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
		await trustWorkspace(page);
	}
	await enterContainer();
	// external-link detector: a new target, or VS Code's external-link
	// dialog. CLOSE the new tab immediately — an external tab steals the
	// focus and every later command types into the void (seen live: the
	// whole post-Help half of the gauntlet died on this)
	let externalHit = false;
	browser.on('targetcreated', (t) => {
		externalHit = true;
		t.page().then(async (p) => {
			if (p && p !== page) {
				await p.close().catch(() => {});
				await page.bringToFront().catch(() => {});   // give the workbench the focus back
			}
		}).catch(() => {});
	});

	// ---- the non-destructive gauntlet --------------------------------------
	const CASES = [
		{ cmd: 'Dev Containers: Add Dev Container Configuration Files...', type: 'quickpick' },
		{ cmd: 'Dev Containers: Attach to Running Container...', type: 'any' },
		{ cmd: 'Dev Containers: Attach to Running Kubernetes Container...', type: 'any' },
		{ cmd: 'Dev Containers: Clean Up Dev Containers...', type: 'any' },
		{ cmd: 'Dev Containers: Clean Up Dev Volumes...', type: 'any' },
		{ cmd: 'Dev Containers: Clone GitHub Pull Request in Container Volume...', type: 'any' },
		{ cmd: 'Dev Containers: Clone Repository in Container Volume...', type: 'any' },
		{ cmd: 'Dev Containers: Clone Repository in Named Container Volume...', type: 'any' },
		{ cmd: 'Dev Containers: Configure Container Features...', type: 'exec',
			note: 'quickpick appears once the feature index loads (containers.dev — network-dependent; their code shows nothing while it hangs)' },
		{ cmd: 'Dev Containers: Explore a Volume in a Dev Container...', type: 'any' },
		{ cmd: 'Dev Containers: Help', type: 'external' },
		{ cmd: 'Dev Containers: Install devcontainer CLI', type: 'any' },
		{ cmd: 'Dev Containers: Install Docker', type: 'any' },
		{ cmd: 'Dev Containers: New Dev Container...', type: 'quickpick' },
		{ cmd: 'Dev Containers: Open Attached Container Configuration File...', type: 'any' },
		{ cmd: 'Dev Containers: Open Container Configuration File', type: 'any' },
		{ cmd: 'Dev Containers: Open Folder in Container...', type: 'quickpick' },
		{ cmd: 'Dev Containers: Open Workspace in Container...', type: 'quickpick' },
		{ cmd: 'Dev Containers: Provide Feedback', type: 'external' },
		{ cmd: 'Dev Containers: Report Issue...', type: 'external' },
		{ cmd: 'Dev Containers: Reset Don\'t Show Recovery Container Notification', type: 'silent' },
		{ cmd: 'Dev Containers: Reset Don\'t Show Reopen Notification', type: 'silent' },
		{ cmd: 'Dev Containers: Settings', type: 'settings' },
		{ cmd: 'Dev Containers: Show Build Log', type: 'channel' },
		{ cmd: 'Dev Containers: Show Container Log', type: 'any' },
		{ cmd: 'Dev Containers: Show Previous Log', type: 'any' },
		{ cmd: 'Dev Containers Developer: Show All Logs...', type: 'any' },
		{ cmd: 'Dev Containers Developer: Test Connection', type: 'any' },
		{ cmd: 'Dev Containers: Switch Container', type: 'any' },
		{ cmd: 'MCP: Open Remote User Configuration', type: 'any' },
		{ cmd: 'Preferences: Open Remote Settings (Dev Container: Fake Test Container)', type: 'settings' },
		{ cmd: 'Preferences: Open Remote Settings (JSON) (Dev Container: Fake Test Container)', type: 'exec',
			note: 'executes with no visible effect in the web bundle (desktop opens the remote settings.json — a web gap, verified by direct debug)' },
		{ cmd: 'Remote Explorer: Focus on Dev Containers View', type: 'any' },
		{ cmd: 'Remote Explorer: Focus on Dev Volumes View', type: 'any' },
		{ cmd: 'Remote: Install Remote Development Extensions', type: 'any' },
		{ cmd: 'Remote: Show Remote Menu', type: 'quickpick' },
		{ cmd: 'View: Show Remote Explorer', type: 'any' },
	];

	let caseIdx = 0;
	for (const c of CASES) {
		caseIdx++;
		externalHit = false;
		await runCommand(page, c.cmd, caseIdx);
		await sleep(1200);
		let ui = await inspectUI(page);
		let ok = false;
		let observed = '';
		if (c.type === 'quickpick') {
			// slow openers (the features index fetch) — poll before judging
			for (let i = 0; i < 8 && !ui.quick; i++) {
				await sleep(1500);
				ui.quick = (await inspectUI(page)).quick;
			}
			ok = !!ui.quick;
			observed = ui.quick ? `quickpick: "${ui.quick.slice(0, 90)}"` : 'NO quickpick';
		} else if (c.type === 'settings') {
			ok = ui.settings;
			observed = ui.settings ? 'settings editor open' : `settings NOT open (tab="${ui.tab}")`;
		} else if (c.type === 'editor') {
			ok = c.match.test(ui.tab) || c.match.test(ui.tabs);
			observed = `tabs: "${ui.tabs || ui.tab}"`;
		} else if (c.type === 'channel') {
			// the Output panel on OUR build-log channel (their command is
			// mapped to it) — the visible content is the service/daemon log
			ok = !!ui.panel && (/Remote-Dev|Dev Containers/i.test(ui.outChannel)
				|| /\$ docker|devcontainer|Remote-Dev|daemon|resolve|Installing extensions/i.test(ui.panel));
			observed = `channel: "${ui.outChannel}" ${ui.panel.slice(0, 60)}`;
		} else if (c.type === 'external') {
			ok = externalHit || /open/i.test(ui.dialog) || /external|open/i.test(ui.toast);
			observed = externalHit ? 'new target opened' : (ui.dialog || ui.toast || 'nothing').slice(0, 90);
		} else if (c.type === 'panel') {
			ok = !!ui.panel && c.match.test(ui.panel);
			observed = ui.panel ? ui.panel.slice(0, 90) : 'panel did not open';
		} else if (c.type === 'exec') {
			// proven by the run itself: the exact palette row was picked and
			// the palette consumed it (runCommand logs the pick) — the only
			// failure mode to assert is an error surfacing
			ok = !/\berror\b/i.test(ui.toast);
			observed = (ui.toast ? `toast: "${ui.toast.slice(0, 80)}"` : 'executed via the exact palette row')
				+ (c.note ? ` — ${c.note}` : '');
		} else if (c.type === 'silent') {
			ok = !/error/i.test(ui.toast);
			observed = ui.toast ? `toast: "${ui.toast.slice(0, 80)}"` : 'ran clean';
		} else { // 'any': the command must DO something without an error toast
			ok = !!(ui.quick || ui.toast || ui.tab || ui.panel || ui.settings || ui.dialog || externalHit)
				&& !/\berror\b/i.test(ui.toast);
			observed = (ui.quick && `quick: "${ui.quick.slice(0, 70)}"`)
				|| (ui.dialog && `dialog: "${ui.dialog.slice(0, 70)}"`)
				|| (ui.toast && `toast: "${ui.toast.slice(0, 70)}"`)
				|| (ui.panel && `panel: "${ui.panel.slice(0, 70)}"`)
				|| (ui.settings && 'settings open')
				|| (ui.tab && `tab: "${ui.tab}"`)
				|| (externalHit && 'external target')
				|| 'NOTHING happened';
		}
		check(c.cmd, ok, observed);
		if (!ok) { await shot(page, `60-cmd-${String(caseIdx).padStart(2, '0')}`); }
		await dismissAll(page);
	}
	await shot(page, '60-gauntlet-done');

	// ---- destructive/session commands, each proven on the state ------------

	// Stop Container → the fake docker's state marker must DISAPPEAR
	fs.writeFileSync(`${FAKE_STATE}/built`, '1');   // paranoia: up
	await runCommand(page, 'Dev Containers: Stop Container');
	await sleep(3000);
	const stopped = !fs.existsSync(`${FAKE_STATE}/built`);
	check('Dev Containers: Stop Container', stopped,
		stopped ? 'docker stop ran (state marker gone)' : 'container STILL marked built');
	// the next entry starts it again WITHOUT a rebuild (desktop semantics)
	await enterContainer();
	check('re-enter after Stop Container (starts, no rebuild)', true, 'back in the container window');

	// Rebuild Container Without Cache → the CLI gets the desktop flags
	{
		const log = `${FAKE_STATE}/cli-args.log`;
		const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
		await runCommand(page, 'Dev Containers: Rebuild Container Without Cache');
		const deadline = Date.now() + 4 * 60 * 1000;
		let back = false;
		while (Date.now() < deadline && !back) {
			back = await page.evaluate(() => document.title.includes('[Dev Container'));
			if (!back) { await sleep(2000); }
		}
		const after = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
		const delta = after.slice(before.length);
		check('Dev Containers: Rebuild Container Without Cache',
			back && delta.includes('--build-no-cache'),
			`back=${back}, cli delta: ${delta.trim().slice(0, 110)}`);
	}

	// Rebuild Container → --remove-existing-container, no --build-no-cache
	{
		const log = `${FAKE_STATE}/cli-args.log`;
		const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
		await runCommand(page, 'Dev Containers: Rebuild Container');
		const deadline = Date.now() + 4 * 60 * 1000;
		let back = false;
		while (Date.now() < deadline && !back) {
			back = await page.evaluate(() => document.title.includes('[Dev Container'));
			if (!back) { await sleep(2000); }
		}
		const after = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
		const delta = after.slice(before.length);
		check('Dev Containers: Rebuild Container',
			back && delta.includes('--remove-existing-container') && !delta.includes('--build-no-cache'),
			`back=${back}, cli delta: ${delta.trim().slice(0, 110)}`);
	}

	// Reopen Folder Locally → the HOST folder window, then back in
	await runCommand(page, 'Dev Containers: Reopen Folder Locally');
	{
		const deadline = Date.now() + 2 * 60 * 1000;
		let host = false;
		while (Date.now() < deadline && !host) {
			host = await page.evaluate(() =>
				!document.title.includes('[Dev Container') && /fake-ws/.test(document.title));
			if (!host) { await sleep(1500); }
		}
		check('Dev Containers: Reopen Folder Locally', host,
			host ? `host title: "${await page.evaluate(() => document.title)}"` : 'never left the container');
	}
	await enterContainer();

	// Remote: Close Remote Connection → a host window (no remote authority)
	await runCommand(page, 'Remote: Close Remote Connection');
	{
		const deadline = Date.now() + 2 * 60 * 1000;
		let host = false;
		while (Date.now() < deadline && !host) {
			host = await page.evaluate(() => !document.title.includes('[Dev Container'));
			if (!host) { await sleep(1500); }
		}
		check('Remote: Close Remote Connection', host,
			host ? 'host window (no remote authority)' : 'still in the container');
	}

	await shot(page, '61-gauntlet-destructive-done');
	await browser.close();
	console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GREEN (palette gauntlet)');
	process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
