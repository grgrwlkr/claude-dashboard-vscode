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
process.env.CLAUDE_STATUSLINE_PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-empty-'));

const vscode = require('./vscode-stub.js');
const ext = require('../extension');
const seg = require('../segments');

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

// A run directory laid out the way the client lays one out, so the fast tick can
// be driven straight instead of waiting out its ten-second interval.
function fakeRun(root, { runId = 'wf_test', session = 'sess-1', snapshot = false } = {}) {
    const base = path.join(root, '-fake-project', session);
    const runDir = path.join(base, 'subagents', 'workflows', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'a1' })}\n`);
    fs.writeFileSync(path.join(runDir, 'agent-a1.jsonl'),
        `${JSON.stringify({ type: 'user', message: { content: 'do the thing' } })}\n`
        + `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [] } })}\n`);
    if (snapshot) {
        fs.mkdirSync(path.join(base, 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(base, 'workflows', `${runId}.json`), '{}');
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
            // this tick's, so these numbers have to survive the refresh.
            agents: [{ agentId: 'a1', state: 'running', tokens: 5000, cost: 1.25 }],
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
        assert.equal(state.workflows.length, 1, 'the tree reads the same list');
    } finally {
        run.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the fast tick retires a run whose snapshot has landed', () => {
    const run = activate({ segments: ['{wfAgents}'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-wf-'));
    try {
        const state = run.context.claudeState;
        // No jsonPath: a running run has none, since the scan that fills it is
        // exactly what this tick must not do.
        const going = {
            runId: 'wf_over', name: 'over', state: 'running', jsonPath: '',
            runDir: fakeRun(root, { runId: 'wf_over', snapshot: true }), startedAt: Date.now(),
            phases: [], agents: [], totals: { agents: 1, done: 0, cost: 0 },
        };
        state.data.workflows = { runs: [going], active: [going] };

        ext.__collectWorkflowsFast(state);

        assert.equal(state.data.workflows.runs[0].state, 'finished');
        assert.deepEqual(state.data.workflows.active, [], 'and it stops being one of the running ones');
    } finally {
        run.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// The landmine this task exists to defuse: both maps are keyed by topic, so a
// topic a field can carry but neither map knows is not a missing tooltip — it
// is a throw inside render() that hides every item in the bar, not just its own.
test('every topic a segment can carry has a tooltip and a colour source', () => {
    const run = activate({ segments: ['{weekly}'] });
    try {
        const state = run.context.claudeState;
        for (const topic of seg.TOPICS) {
            // A field of that topic with something to say, so render() is forced
            // down the path that looks the topic up in both maps.
            state.registry = { probe: { topic, doc: '', get: () => 'x' } };
            state.segments = ['{probe}'];
            ext.__render(state);
            assert.equal(vscode.__items[0].text, 'x', `topic ${topic} draws`);
        }
    } finally { run.dispose(); }
});
