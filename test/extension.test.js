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

function activate({ segments, workspace = '' } = {}) {
    vscode.__reset();
    vscode.__setSettings({
        segments, alignment: 'right', priority: 100, refreshInterval: 3600,
    });
    vscode.__setWorkspace(workspace);
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-ext-'));
    const context = {
        subscriptions: [],
        globalStorageUri: { fsPath: storage },
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

test('activate creates one status-bar item per configured segment', () => {
    const run = activate({ segments: ['claude', 'second one', 'third'] });
    try {
        assert.equal(vscode.__items.length, 3);
        assert.deepEqual(vscode.__items.map((i) => i.text), ['claude', 'second one', 'third']);
        // Priority descends along the list, so they read left to right in order.
        assert.deepEqual(vscode.__items.map((i) => i.priority), [100, 99, 98]);
        assert.ok(vscode.__items.every((i) => i.command === 'claudeStatusline.dashboard'));
    } finally { run.dispose(); }
});

test('with no segments configured the bar falls back to the built-in four', () => {
    const run = activate({ segments: undefined });
    try {
        assert.equal(vscode.__items.length, seg.DEFAULT_SEGMENTS.length);
    } finally { run.dispose(); }
});

test('a segment whose placeholders have nothing to say hides itself', () => {
    // No workspace, so there is no session: every session-scoped field is empty.
    const run = activate({ segments: ['ctx {ctx}', 'literal text'] });
    try {
        const [dynamic, literal] = vscode.__items;
        assert.equal(dynamic.visible, false, 'nothing to report, so nothing is shown');
        assert.equal(literal.visible, true, 'text with no placeholders is the user\'s own decoration');
    } finally { run.dispose(); }
});

test('changing the configuration rebuilds the items without a reload', () => {
    const run = activate({ segments: ['one'] });
    try {
        assert.equal(vscode.__items.length, 1);
        const first = vscode.__items[0];

        vscode.__setSettings({ segments: ['a', 'b'], alignment: 'left', priority: 50, refreshInterval: 3600 });
        vscode.__changeConfiguration();

        assert.equal(first.disposed, true, 'the old item is disposed, not left behind');
        assert.equal(vscode.__items.length, 2);
        assert.deepEqual(vscode.__items.map((i) => i.text), ['a', 'b']);
        assert.equal(vscode.__items[0].alignment, vscode.StatusBarAlignment.Left);
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

        const provider = vscode.__views.get('claudeStatusline.workflows');
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

        const provider = vscode.__views.get('claudeStatusline.workflows');
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

        const provider = vscode.__views.get('claudeStatusline.workflows');
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
