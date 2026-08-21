const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sys = require('../system');

// A scratch tree shaped like ~/.claude, so every reader is exercised against
// the real layout rather than a mock of it.
function tree(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-sys-'));
    const write = (rel, body) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body));
        return full;
    };
    const mkdir = (rel) => {
        const full = path.join(root, rel);
        fs.mkdirSync(full, { recursive: true });
        return full;
    };
    try { return fn({ root, write, mkdir }); } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('settings resolve down the chain and the first file with a key wins', () => tree(({ root, write }) => {
    write('settings.json', { model: 'claude-opus-5', effortLevel: 'xhigh', env: { A: '1' } });
    write('settings.local.json', { model: 'claude-fable-5', env: { B: '2' } });
    const s = sys.settingsOf('', root);
    assert.equal(s.values.model.value, 'claude-fable-5'); // local wins
    assert.equal(s.values.effortLevel.value, 'xhigh');    // only the global has it
    assert.deepEqual(s.env, { A: '1', B: '2' });
}));

test('hooks are flattened with the event, matcher and origin of each', () => tree(({ root, write }) => {
    write('settings.json', {
        hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/bin/guard.sh' }] }],
            Stop: [{ hooks: [{ type: 'prompt', prompt: 'check the work' }] }],
        },
    });
    const hooks = sys.hooksOf('', root);
    assert.equal(hooks.length, 2);
    assert.deepEqual(hooks.map((h) => [h.event, h.matcher]), [['PreToolUse', 'Bash'], ['Stop', '*']]);
    assert.equal(hooks[1].command, 'check the work');
}));

test('permissions carry the mode and the file they came from', () => tree(({ root, write }) => {
    write('settings.json', { permissions: { allow: ['Bash(git status)'], deny: ['Read(./.env)'] } });
    const perms = sys.permissionsOf('', root);
    assert.deepEqual(perms.map((p) => p.mode).sort(), ['allow', 'deny']);
    assert.ok(perms[0].from.endsWith('settings.json'));
}));

test('MCP servers are listed per scope, and no command line is echoed whole', () => {
    const config = {
        mcpServers: { qmd: { command: '/opt/homebrew/bin/npx', args: ['-y', 'qmd', '--token', 'SECRET'] } },
        projects: { '/repo': { mcpServers: { local: { type: 'http', url: 'https://example.com/mcp?key=SECRET' } } } },
    };
    const rows = sys.mcpServers(config);
    assert.equal(rows.length, 2);
    const user = rows.find((r) => r.scope === 'user');
    assert.equal(user.name, 'qmd');
    assert.equal(user.command, 'npx');
    const project = rows.find((r) => r.scope === 'project');
    assert.equal(project.transport, 'http');
    assert.equal(project.command, 'example.com');
    assert.ok(!JSON.stringify(rows).includes('SECRET'), 'no argument or query string may be carried through');
});

test('plugins are read from the newest copy on disk, and a broken reference shows', () => tree(({ root, write, mkdir }) => {
    write('settings.json', { enabledPlugins: { 'super@official': true, 'ghost@official': true } });
    mkdir('plugins/cache/official/super/1.0.0/skills/old-skill');
    mkdir('plugins/cache/official/super/2.0.0/skills/brainstorming');
    mkdir('plugins/cache/official/super/2.0.0/skills/writing-plans');
    write('plugins/cache/official/super/2.0.0/agents/critic.md', '# critic');
    write('plugins/cache/official/super/2.0.0/commands/plan.md', '# plan');
    write('plugins/cache/official/super/2.0.0/.mcp.json', { mcpServers: { helper: {} } });
    mkdir('plugins/cache/temp_subdir_123.clone/junk');

    const rows = sys.plugins(root);
    const sup = rows.find((p) => p.name === 'super');
    assert.equal(sup.version, '2.0.0'); // by version, not by mtime
    assert.equal(sup.copies, 2);
    assert.deepEqual(sup.components.skills.sort(), ['brainstorming', 'writing-plans']);
    assert.deepEqual(sup.components.agents, ['critic']);
    assert.deepEqual(sup.components.mcp, ['helper']);
    assert.equal(sup.enabled, true);

    const ghost = rows.find((p) => p.name === 'ghost');
    assert.equal(ghost.missing, true, 'enabled but absent from the cache');
    assert.ok(!rows.some((p) => p.name.startsWith('temp_subdir')), 'clones are not plugins');
}));

test('jobs report state, tokens and the scratch they leave behind', () => tree(({ root, write }) => {
    write('jobs/aaa/state.json', {
        name: 'research', state: 'done', tokens: 1234, cliVersion: '2.1.226',
        cwd: '/repo', sessionId: 'sess-1', updatedAt: '2026-08-08T10:00:00Z',
    });
    write('jobs/aaa/tmp/big.log', 'x'.repeat(5000));
    write('jobs/bbb/nothing.json', {});
    const rows = sys.jobs(root);
    assert.equal(rows.length, 1, 'a directory without state.json is not a job');
    assert.equal(rows[0].state, 'done');
    assert.equal(rows[0].tokens, 1234);
    assert.ok(rows[0].tmpBytes >= 5000);
    assert.ok(rows[0].bytes >= rows[0].tmpBytes);
}));

test('live reads sessions, IDE locks and daemon workers — and never the auth token', () => tree(({ root, write }) => {
    write('sessions/a.json', { sessionId: 'a', pid: process.pid, cwd: '/repo', status: 'busy', entrypoint: 'cli' });
    write('sessions/dead.json', { sessionId: 'dead', pid: 999999, cwd: '/repo' });
    write('ide/1234.lock', {
        pid: process.pid, ideName: 'Visual Studio Code', transport: 'ws',
        workspaceFolders: ['/repo'], authToken: 'SECRET-TOKEN',
    });
    write('daemon/roster.json', {
        supervisorPid: process.pid,
        workers: { w1: { pid: process.pid, sessionId: 's1', cwd: '/repo', cliVersion: '2.1.226' } },
    });
    const l = sys.live(root);
    assert.equal(l.sessions.length, 2);
    assert.equal(l.sessions.filter((s) => s.alive).length, 1);
    assert.equal(l.ide[0].name, 'Visual Studio Code');
    assert.equal(l.daemon.workers[0].sessionId, 's1');
    assert.ok(!JSON.stringify(l).includes('SECRET-TOKEN'), 'the IDE auth token must never be read out');
}));

test('tasks surface what is still open, newest session first', () => tree(({ root, write }) => {
    write('tasks/sess-1/1.json', { id: '1', subject: 'write the parser', status: 'completed' });
    write('tasks/sess-1/2.json', { id: '2', subject: 'test the parser', status: 'in_progress' });
    write('tasks/sess-1/.lock', '');
    const rows = sys.tasks(root, { 'sess-1': 'demo' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total, 2);
    assert.equal(rows[0].done, 1);
    assert.deepEqual(rows[0].open, ['test the parser']);
    assert.equal(rows[0].project, 'demo');
}));

test('disk names the leftovers rather than only the totals', () => tree(({ root, write }) => {
    write('jobs/aaa/state.json', { name: 'wasm experiment', state: 'stopped' });
    write('jobs/aaa/tmp/huge.bin', 'x'.repeat(60e6));
    write('plugins/cache/temp_subdir_1.clone/a.bin', 'x'.repeat(1000));
    write('plugins/cache/temp_subdir_2.clone/a.bin', 'x'.repeat(1000));
    write('projects/keep.jsonl', 'x'.repeat(100));
    const d = sys.disk(root);
    assert.ok(d.total > 60e6);
    assert.equal(d.dirs[0].name, 'jobs');
    assert.equal(d.dirs.find((x) => x.name === 'projects').kind, 'keep');
    assert.equal(d.dirs.find((x) => x.name === 'plugins').kind, 'regenerable');
    assert.equal(d.hogs[0].path, 'jobs/aaa/tmp');
    assert.match(d.hogs[0].note, /wasm experiment/);
    assert.equal(d.hogs[1].bytes, 2000);

    // Every row carries the directory it is about, so the page can offer to open
    // it. A wildcard row has no single directory of its own and points at the
    // one holding them all.
    assert.equal(d.dirs.find((x) => x.name === 'projects').path, `${root}/projects`);
    assert.equal(d.hogs[0].abs, `${root}/jobs/aaa/tmp`);
    assert.equal(d.hogs[1].abs, `${root}/plugins/cache`);
    assert.ok(d.dirs.every((x) => x.path.startsWith(root)), 'nothing points outside ~/.claude');
    assert.ok(d.hogs.every((x) => x.abs.startsWith(root)));
}));

test('context budget prices the instruction layer in tokens', () => tree(({ root, write }) => {
    write('CLAUDE.md', 'x'.repeat(4000));
    write('rules/machine.md', 'x'.repeat(2000));
    write('rules/notes.txt', 'x'.repeat(9000)); // not markdown: not loaded
    const project = path.join(root, 'proj');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'x'.repeat(400));

    const c = sys.contextBudget(root, [project]);
    assert.equal(c.globalTokens, 1500); // 6000 chars over four per token
    assert.equal(c.files.length, 3);
    assert.equal(c.files[0].scope, 'global');
    assert.ok(c.files.some((f) => f.scope === 'project'));
}));

test('changelog is cut at the version already running', () => tree(({ root, write }) => {
    write('cache/changelog.md', [
        '# Changelog', '', '## 2.1.226', '- newest thing', '',
        '## 2.1.225', '- another thing', '', '## 2.1.224', '- old thing', '',
    ].join('\n'));
    const all = sys.changelog(root);
    assert.equal(all.length, 3);
    assert.deepEqual(all[0], { version: '2.1.226', entries: ['newest thing'] });
    const newer = sys.changelog(root, '2.1.224');
    assert.deepEqual(newer.map((r) => r.version), ['2.1.226', '2.1.225']);
    assert.equal(sys.changelog(root, '2.1.226').length, 0);
}));

test('the prompt log yields counts and dates, never a prompt', () => tree(({ root, write }) => {
    const at = Date.parse('2026-08-08T10:00:00Z');
    write('history.jsonl', [
        JSON.stringify({ display: 'a very private prompt', project: '/repo/demo', timestamp: at }),
        JSON.stringify({ display: 'another', project: '/repo/demo', timestamp: at, pastedContents: { 1: {} } }),
        'torn line',
    ].join('\n'));
    const log = sys.promptLog(root);
    assert.equal(log.count, 2);
    assert.equal(log.pasted, 1);
    assert.equal(log.byProject.demo, 2);
    assert.equal(Object.keys(log.byDay).length, 1);
    assert.ok(!JSON.stringify(log).includes('private'), 'prompt text must not survive the read');
}));

test('a missing tree yields empty answers rather than throwing', () => {
    const nowhere = '/nope/not-a-claude-dir';
    assert.deepEqual(sys.hooksOf('', nowhere), []);
    assert.deepEqual(sys.plugins(nowhere, {}), []);
    assert.deepEqual(sys.jobs(nowhere), []);
    assert.deepEqual(sys.tasks(nowhere), []);
    assert.deepEqual(sys.changelog(nowhere), []);
    assert.equal(sys.promptLog(nowhere), null);
    assert.equal(sys.live(nowhere).daemon.supervisorPid, 0);
    assert.equal(sys.disk(nowhere).total, 0);
});

// Custom output styles. The client names a style by its frontmatter `name` and
// falls back to the file name, so the two have to be told apart: the file here
// is `terse.md` and the style is "Proactive & concise", and it is the second
// that goes into `--settings`.
test('an output style is named by its frontmatter, not by its file', () => tree(({ root, write }) => {
    write('output-styles/terse.md', [
        '---',
        'name: Proactive & concise',
        'description: Result first, no preamble',
        'keep-coding-instructions: true',
        '---',
        '',
        'Lead with the result.',
    ].join('\n'));
    const [style] = sys.outputStyles(root);
    assert.equal(style.name, 'Proactive & concise');
    assert.equal(style.description, 'Result first, no preamble');
    assert.equal(style.keepCoding, true);
}));

// The frontmatter is optional in practice — a file that is only instructions is
// still a style, and the client calls it by its file name.
test('a style with no frontmatter is named by its file and keeps no coding instructions', () => tree(({ root, write }) => {
    write('output-styles/data-analyst.md', 'You are a data analyst.\n');
    const [style] = sys.outputStyles(root);
    assert.equal(style.name, 'data-analyst');
    assert.equal(style.description, '');
    assert.equal(style.keepCoding, false);
}));

// Degrade, never guess: no directory is not an error, and neither is a file
// that is not a style. Only `.md` counts, and the order is stable so the panel
// does not reshuffle between renders.
test('output styles skip what is not a style and survive a missing directory', () => tree(({ root, write, mkdir }) => {
    assert.deepEqual(sys.outputStyles(root), []);
    mkdir('output-styles');
    assert.deepEqual(sys.outputStyles(root), []);
    write('output-styles/README.txt', 'not a style');
    write('output-styles/zebra.md', '---\nname: Zebra\n---\nz');
    write('output-styles/alpha.md', '---\nname: Alpha\n---\na');
    assert.deepEqual(sys.outputStyles(root).map((s) => s.name), ['Alpha', 'Zebra']);
}));

// A `---` inside the body is not a second frontmatter block: the parser reads
// the opening block only, or a horizontal rule would swallow the instructions.
test('only the leading frontmatter block is parsed', () => tree(({ root, write }) => {
    write('output-styles/x.md', [
        '---', 'name: Real', '---', '', 'Body text.', '', '---', '', 'name: Not this', '',
    ].join('\n'));
    const [style] = sys.outputStyles(root);
    assert.equal(style.name, 'Real');
}));

// The page reads one snapshot rather than calling each reader itself, so a
// reader that is not in it is a reader the dashboard cannot see.
test('the snapshot carries the output styles', () => tree(({ root, write }) => {
    write('output-styles/mine.md', '---\nname: Mine\n---\nbody');
    const snap = sys.snapshot({ root, withDisk: false });
    assert.deepEqual(snap.outputStyles.map((s) => s.name), ['Mine']);
}));

// Frontmatter is YAML, and YAML quotes are delimiters rather than characters of
// the value. The client parses it properly, so a name kept with its quotes here
// would never match the name the client is matching against.
test('a quoted frontmatter value loses its quotes, as YAML does', () => tree(({ root, write }) => {
    write('output-styles/q.md', '---\nname: "My style"\ndescription: \'Terse, and quoted\'\n---\nbody');
    const [style] = sys.outputStyles(root);
    assert.equal(style.name, 'My style');
    assert.equal(style.description, 'Terse, and quoted');
}));
