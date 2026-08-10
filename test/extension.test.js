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

function activate({ segments, workspace = '', settings = {} } = {}) {
    vscode.__reset();
    vscode.__setSettings({
        segments, alignment: 'right', priority: 100, refreshInterval: 3600, ...settings,
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
    const real = { refreshUsage: u.refreshUsage, touchStamp: u.touchStamp };
    let requests = 0;
    u.refreshUsage = async () => { requests++; return false; };
    u.touchStamp = () => true;
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

// The default bar is written twice: once in segments.js, once in the manifest
// where the settings UI reads it. A user who never sets the key gets the
// module's copy; one who clicks "reset to default" in VS Code gets the
// manifest's. They have to be the same list.
test('the manifest ships the same default bar as the module', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const declared = manifest.contributes.configuration.properties['claudeStatusline.segments'].default;
    assert.deepEqual(declared, seg.DEFAULT_SEGMENTS);
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
            { kind: 'meters', rows: [{ label: '7d', value: '52%', pct: 52, note: 'Thu 13.08' }] },
            { kind: 'table', rows: [['from cache', '99%']] },
        ],
    });

    const lines = md.split('\n');
    const row = lines.find((line) => line.startsWith('| 7d '));
    assert.ok(row.includes(`\`${u.bar(52, 0)}\``), `the meter is not the bar: ${row}`);

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

// The tooltip and the Now tab are two renderings of one list of sections. The
// wording used to live in extension.js alone; a tab that copied it would have
// been free to drift the moment either side changed.
test('the Now tab and the tooltips are cut from the same sections', async () => {
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
                if (block.kind === 'meters') {
                    for (const row of block.rows) {
                        for (const cell of [row.label, row.value, row.note]) {
                            if (!cell) continue;
                            assert.ok(html.includes(db.esc(cell)), `"${cell}" is in the tooltip but not on the page`);
                        }
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
    } finally { if (panel) panel.dispose(); run.dispose(); }
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

// The settings tab shipped blank: every palette value a dash, every preview
// "hidden", while the bar two inches below was full of numbers. The page read
// the state through a property parked on the ExtensionContext, which the stub
// happily carried and the editor did not. Freezing the context here reproduces
// that exactly — the state has to reach the page some other way.
test('the dashboard reads live numbers even when the context refuses new properties', async () => {
    vscode.__reset();
    vscode.__setSettings({ segments: ['{weekly}'], alignment: 'right', priority: 100, refreshInterval: 3600 });
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-frozen-'));
    const context = Object.freeze({ subscriptions: [], globalStorageUri: { fsPath: storage } });

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
