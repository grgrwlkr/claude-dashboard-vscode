// A machine that is not this one: no `~/.claude` at all. That is what the first
// minute after installing from the marketplace looks like for anyone who has
// never run Claude Code, and for anyone whose Claude Code lives somewhere this
// extension does not look. Nothing may throw, nothing may show a wrong number,
// and the dashboard must still open and say why it is empty.
//
// HOME is set before anything is required, because every module resolves its
// paths once at load time — a test that reassigns it later tests nothing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-cold-home-'));
process.env.HOME = EMPTY_HOME;
delete process.env.CLAUDE_STATUSLINE_PROJECTS;

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const stubPath = require.resolve('./vscode-stub.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
    if (request === 'vscode') return stubPath;
    return resolve.call(this, request, ...rest);
};

const vscode = require('./vscode-stub.js');
const ext = require('../extension');
const u = require('../usage');
const s = require('../session');
const sys = require('../system');

test.after(() => fs.rmSync(EMPTY_HOME, { recursive: true, force: true }));

function activate() {
    vscode.__reset();
    vscode.__setSettings({
        segments: undefined, alignment: 'right', priority: 100, refreshInterval: 3600,
        // The network is off here on purpose: this test is about the disk being
        // empty, and a request whose answer depends on the machine running the
        // suite is not a test of anything.
        fetchLimits: false,
    });
    vscode.__setWorkspace('');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-cold-'));
    const context = { subscriptions: [], globalStorageUri: { fsPath: storage } };
    ext.activate(context);
    return {
        dispose: () => {
            for (const d of context.subscriptions) d.dispose();
            fs.rmSync(storage, { recursive: true, force: true });
        },
    };
}

test('the readers answer emptily rather than throwing when there is no ~/.claude', () => {
    assert.equal(u.readCache(Math.floor(Date.now() / 1000)), null);
    assert.equal(u.mtime(u.CACHE), 0);
    assert.equal(s.findOwnSession(''), null);
    assert.deepEqual(sys.live().sessions, []);
    assert.deepEqual(sys.tasks(), []);
});

test('every status-bar item hides itself instead of showing a zero', () => {
    const run = activate();
    try {
        assert.ok(vscode.__items.length > 0, 'the items are created either way');
        assert.deepEqual(vscode.__items.map((i) => i.visible), vscode.__items.map(() => false));
        assert.deepEqual(vscode.__items.map((i) => i.text), vscode.__items.map(() => ''));
        assert.deepEqual(vscode.__errors, []);
    } finally { run.dispose(); }
});

test('the dashboard opens on an empty machine and says why it is empty', async () => {
    const run = activate();
    try {
        await vscode.__commands.get('claudeStatusline.dashboard')();
        assert.equal(vscode.__panels.length, 1);
        const html = vscode.__panels[0].webview.html;
        assert.ok(html.length > 1000, 'a page is rendered, not an error');
        assert.match(html, /class="empty"/);
        // The one thing a newcomer must not see is a confident zero where a
        // reading should be.
        assert.doesNotMatch(html, /\$0\.00 all-time/);
        assert.deepEqual(vscode.__errors, []);
    } finally { run.dispose(); }
});
