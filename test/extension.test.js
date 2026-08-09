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
