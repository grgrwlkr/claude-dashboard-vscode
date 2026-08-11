const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ix = require('../indexer');

const T0 = Date.parse('2026-08-08T10:00:00Z');

function rec(over = {}, usage = {}) {
    return JSON.stringify({
        timestamp: new Date(T0).toISOString(),
        gitBranch: 'main',
        message: {
            model: 'claude-opus-5',
            usage: { input_tokens: 0, output_tokens: 1e6, ...usage },
        },
        ...over,
    });
}

// A scratch tree shaped like ~/.claude/projects, including the subagent and
// workflow layout, so path parsing is exercised the way it runs for real.
function tree(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-tree-'));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-store-'));
    const slug = '-Users-x-Develop-demo';
    const write = (rel, lines) => {
        const full = path.join(root, slug, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, lines.join('\n') + '\n');
        return full;
    };
    try { return fn({ root, store, slug, write }); } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(store, { recursive: true, force: true });
    }
}

test('describeFile reads the relationship encoded in the path', () => {
    const base = path.join(ix.PROJECTS, '-Users-x-Develop-demo');
    const main = ix.describeFile(path.join(base, 'sess-1.jsonl'));
    assert.equal(main.kind, 'main');
    assert.equal(main.sessionId, 'sess-1');

    const agent = ix.describeFile(path.join(base, 'sess-1', 'subagents', 'agent-abc.jsonl'));
    assert.equal(agent.kind, 'agent');
    assert.equal(agent.sessionId, 'sess-1');
    assert.equal(agent.agentId, 'abc');
    assert.equal(agent.workflowId, '');

    const wf = ix.describeFile(path.join(base, 'sess-1', 'subagents', 'workflows', 'wf_9', 'agent-xyz.jsonl'));
    assert.equal(wf.kind, 'workflow');
    assert.equal(wf.workflowId, 'wf_9');
    assert.equal(wf.agentId, 'xyz');
    assert.equal(wf.sessionId, 'sess-1');
});

test('projectName takes the readable tail of a slug', () => {
    assert.equal(ix.projectName('-Users-x-Develop-rust-service'), 'service');
    assert.equal(ix.projectName(''), '');
});

test('indexFile aggregates by day, model, branch and skill', () => tree(({ write }) => {
    const file = write('sess-1.jsonl', [
        rec(),
        rec({ attributionSkill: 'lint-vault' }),
        'junk line the parser must survive',
    ]);
    const agg = ix.indexFile(file);
    assert.equal(agg.sessions[0].msgs, 2);
    assert.equal(agg.sessions[0].cost, 50); // two requests of 1M output on Opus 5
    assert.equal(Object.keys(agg.days).length, 1);
    assert.equal(agg.models['claude-opus-5'].msgs, 2);
    assert.equal(agg.branches.main.msgs, 2);
    assert.equal(agg.skills['lint-vault'].msgs, 1);
    assert.equal(agg.sessions[0].models[0], 'claude-opus-5');
}));

test('indexFile ignores a transcript with no usage records', () => tree(({ write }) => {
    const file = write('empty.jsonl', [JSON.stringify({ timestamp: new Date(T0).toISOString(), type: 'user' })]);
    assert.equal(ix.indexFile(file), null);
}));

test('refreshIndex reuses unchanged files and re-reads only what grew', () => tree(({ root, store, write }) => {
    write('sess-1.jsonl', [rec()]);
    write(path.join('sess-1', 'subagents', 'agent-a.jsonl'), [rec()]);

    const first = ix.refreshIndex(store, { root });
    assert.equal(first.stats.total, 2);
    assert.equal(first.stats.parsed, 2);
    assert.equal(first.stats.reused, 0);

    const second = ix.refreshIndex(store, { root });
    assert.equal(second.stats.parsed, 0);
    assert.equal(second.stats.reused, 2);

    // Appending to one transcript must re-read that one and nothing else.
    fs.appendFileSync(path.join(root, '-Users-x-Develop-demo', 'sess-1.jsonl'), rec() + '\n');
    const third = ix.refreshIndex(store, { root });
    assert.equal(third.stats.parsed, 1);
    assert.equal(third.stats.reused, 1);
    assert.equal(ix.summarize(third.index).sessions.find((s) => s.kind === 'main').msgs, 2);
}));

test('a deleted transcript leaves the index instead of haunting the totals', () => tree(({ root, store, write }) => {
    const file = write('sess-1.jsonl', [rec()]);
    write('sess-2.jsonl', [rec()]);
    assert.equal(ix.summarize(ix.refreshIndex(store, { root }).index).sessions.length, 2);

    fs.rmSync(file);
    const after = ix.refreshIndex(store, { root });
    assert.equal(after.stats.removed, 1);
    assert.equal(ix.summarize(after.index).sessions.length, 1);
}));

test('summarize folds per-file aggregates and sorts sessions newest first', () => tree(({ root, store, write }) => {
    write('old.jsonl', [rec({ timestamp: new Date(T0 - 86400000).toISOString() })]);
    write('new.jsonl', [rec()]);
    const total = ix.summarize(ix.refreshIndex(store, { root }).index);
    assert.equal(total.sessions[0].id, 'new');
    assert.equal(total.models['claude-opus-5'].msgs, 2);
    assert.equal(Object.keys(total.days).length, 2);
    assert.equal(total.projects.demo.msgs, 2);
}));

test('an index written by an older version is discarded, not misread', () => tree(({ store }) => {
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'index.json'), JSON.stringify({ version: 0, files: { x: {} } }));
    const loaded = ix.loadIndex(store);
    assert.equal(loaded.version, ix.INDEX_VERSION);
    assert.deepEqual(loaded.files, {});
}));

test('a reply is attributed to its model, effort, entrypoint and speed together', () => tree(({ write }) => {
    const file = write('sess-1.jsonl', [
        rec({ effort: 'xhigh', entrypoint: 'cli' }),
        rec({ effort: 'low', entrypoint: 'cli' }),
        rec({ entrypoint: 'sdk-py' }, { speed: 'fast' }),
    ]);
    const agg = ix.indexFile(file);
    assert.equal(agg.efforts[ix.effortKey('claude-opus-5', 'xhigh')].msgs, 1);
    assert.equal(agg.efforts[ix.effortKey('claude-opus-5', 'low')].msgs, 1);
    // An SDK session reports no effort at all — that is a fact worth keeping,
    // not a hole to fill with the session's own tier.
    assert.equal(agg.efforts[ix.effortKey('claude-opus-5', '')].msgs, 1);
    assert.equal(agg.entrypoints.cli.msgs, 2);
    assert.equal(agg.entrypoints['sdk-py'].msgs, 1);
    assert.equal(agg.speeds.fast.msgs, 1);
    assert.deepEqual(agg.sessions[0].efforts.sort(), ['low', 'xhigh']);
}));

test('a cache write is split by TTL all the way into the aggregate', () => tree(({ write }) => {
    const file = write('sess-1.jsonl', [rec({}, {
        output_tokens: 0,
        cache_read_input_tokens: 1e6,
        cache_creation_input_tokens: 1e6,
        cache_creation: { ephemeral_1h_input_tokens: 6e5, ephemeral_5m_input_tokens: 4e5 },
    })]);
    const b = ix.indexFile(file).models['claude-opus-5'];
    assert.equal(b.cw1h, 6e5);
    assert.equal(b.cw5m, 4e5);
    assert.equal(b.cw1h + b.cw5m, b.cacheWrite);
    // 0.6M at 2x $5 + 0.4M at 1.25x $5 + 1M read at 0.1x $5
    assert.ok(Math.abs(b.cost - (6 + 2.5 + 0.5)) < 1e-9);
    assert.equal(b.saved, 4.5); // what those reads would have cost as fresh input
}));

test('tool calls are counted and a failed result is blamed on the right tool', () => tree(({ write }) => {
    const call = (id, name) => JSON.stringify({
        timestamp: new Date(T0).toISOString(),
        message: {
            model: 'claude-opus-5',
            usage: { input_tokens: 0, output_tokens: 1 },
            content: [{ type: 'tool_use', id, name }],
        },
    });
    const result = (id, isError, over = {}) => JSON.stringify({
        type: 'user',
        timestamp: new Date(T0).toISOString(),
        message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
        ...over,
    });

    const file = write('sess-1.jsonl', [
        call('t1', 'Bash'), result('t1', true),
        call('t2', 'Bash'), result('t2', false),
        call('t3', 'Read'), result('t3', false, { toolDenialKind: 'user-rejected' }),
        JSON.stringify({
            timestamp: new Date(T0).toISOString(),
            message: {
                model: 'claude-opus-5',
                usage: { input_tokens: 0, output_tokens: 1 },
                content: [{ type: 'server_tool_use', id: 's1', name: 'advisor' }],
            },
        }),
    ]);
    const agg = ix.indexFile(file);
    assert.equal(agg.tools.Bash.calls, 2);
    assert.equal(agg.tools.Bash.errors, 1);
    assert.equal(agg.tools.Read.denials, 1);
    assert.equal(agg.tools.advisor.calls, 1);
    assert.equal(agg.friction.toolErrors, 1);
    assert.equal(agg.friction.denials['user-rejected'], 1);
    assert.equal(agg.sessions[0].tools, 4);
    assert.equal(agg.sessions[0].errors, 1);
}));

test('compaction is recorded with the context it threw away', () => tree(({ write }) => {
    const file = write('sess-1.jsonl', [
        rec(),
        JSON.stringify({
            timestamp: new Date(T0).toISOString(),
            compactMetadata: {
                trigger: 'auto', preTokens: 500000, postTokens: 20000,
                cumulativeDroppedTokens: 480000, durationMs: 120000,
            },
        }),
        JSON.stringify({ timestamp: new Date(T0).toISOString(), interruptedByShutdown: true, message: { usage: null } }),
    ]);
    const f = ix.indexFile(file).friction;
    assert.equal(f.compactions.auto, 1);
    assert.equal(f.droppedTokens, 480000);
    assert.equal(f.compactMs, 120000);
    assert.equal(f.shutdowns, 1);
}));

test('a session takes the last title written, and a typed one wins', () => tree(({ write }) => {
    const file = write('sess-1.jsonl', [
        rec(),
        JSON.stringify({ type: 'ai-title', sessionId: 'sess-1', aiTitle: 'What the model called it' }),
        JSON.stringify({ type: 'custom-title', sessionId: 'sess-1', customTitle: 'What I called it' }),
    ]);
    assert.equal(ix.indexFile(file).sessions[0].title, 'What I called it');
}));

test('summarize folds the new dimensions and the friction counters', () => tree(({ root, store, write }) => {
    write('a.jsonl', [rec({ effort: 'xhigh', entrypoint: 'cli' })]);
    write('b.jsonl', [
        rec({ effort: 'xhigh', entrypoint: 'claude-vscode' }),
        JSON.stringify({
            timestamp: new Date(T0).toISOString(),
            compactMetadata: { trigger: 'manual', cumulativeDroppedTokens: 1000 },
        }),
    ]);
    const total = ix.summarize(ix.refreshIndex(store, { root }).index);
    assert.equal(total.efforts[ix.effortKey('claude-opus-5', 'xhigh')].msgs, 2);
    assert.equal(total.entrypoints.cli.msgs, 1);
    assert.equal(total.entrypoints['claude-vscode'].msgs, 1);
    assert.equal(total.friction.compactions.manual, 1);
    assert.equal(total.friction.droppedTokens, 1000);
}));

test('the line prefilter skips tool traffic but not a record that matters', () => {
    assert.ok(ix.INTERESTING.test('{"message":{"usage":{"input_tokens":1}}}'));
    assert.ok(ix.INTERESTING.test('{"type":"user","toolDenialKind":"user-rejected"}'));
    assert.ok(ix.INTERESTING.test('{"content":[{"type":"tool_result","is_error":true}]}'));
    assert.ok(ix.INTERESTING.test('{"type":"ai-title","aiTitle":"x"}'));
    assert.ok(ix.INTERESTING.test('{"compactMetadata":{"trigger":"auto"}}'));
    // The bulk of a transcript: a successful tool result carrying a file.
    assert.ok(!ix.INTERESTING.test('{"type":"user","toolUseResult":{"stdout":"ok","interrupted":false}}'));
    assert.ok(!ix.INTERESTING.test('{"type":"system","hookErrors":[],"level":"suggestion"}'));
});

test('dayKey uses local dates, so a day boundary is the user\'s midnight', () => {
    const noon = new Date(2026, 7, 8, 12, 0, 0).getTime();
    assert.equal(ix.dayKey(noon), '2026-08-08');
    const almostMidnight = new Date(2026, 7, 8, 23, 59, 0).getTime();
    assert.equal(ix.dayKey(almostMidnight), '2026-08-08');
});

// The index is 5.6 MB on this machine and parsing it is ~40 ms, while the file
// changes only when the dashboard rebuilds it. A caller on a repeating tick asks
// for it by name and gets the previous parse back until the file itself moves —
// deciding that here rather than in extension.js, which touches no disk.
test('freshIndex parses index.json again only when the file has moved', () => tree(({ store }) => {
    const first = ix.freshIndex(store);
    assert.deepEqual(first.files, {}, 'nothing built yet reads as an empty index');
    first.__mark = 'kept';
    assert.equal(ix.freshIndex(store).__mark, 'kept', 'the same parse comes back');

    ix.saveIndex(store, { version: ix.INDEX_VERSION, files: {} });
    const second = ix.freshIndex(store);
    assert.equal(second.__mark, undefined, 'a file that moved is parsed again');
    second.__mark = 'again';
    assert.equal(ix.freshIndex(store).__mark, 'again');
}));

// The word cloud answers "what do you write", and on a machine driven in
// Russian it answered with `users`, `develop` and `toolu`. Three separate
// causes, one test: machine turns are not typed, a path is not a word, and a
// pasted file must not outvote a sentence by repetition.
test('the word tally counts typed prose, once per prompt', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const turn = (source, text) => JSON.stringify({
        type: 'user', promptSource: source, timestamp: '2026-08-11T00:00:00Z',
        message: { content: [{ type: 'text', text }] },
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-words-'));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-store-'));
    try {
        fs.mkdirSync(path.join(dir, 'proj'));
        fs.writeFileSync(path.join(dir, 'proj', 's.jsonl'), [
            turn('typed', 'сделай пожалуйста таблицу сегодня'),
            turn('sdk', 'notification summary completed background'),
            turn('typed', '/Users/x/Develop/project/file.md толькотекст'),
            turn('typed', 'const const const const const прозаслово'),
        ].join('\n'));

        const { index } = ix.refreshIndex(store, { root: dir });
        const words = ix.summarize(index).prompts.words || {};
        assert.equal(words.notification, undefined, 'a program is not you');
        assert.equal(words.develop, undefined, 'a path segment is not a word');
        assert.equal(words.const, 1, 'five repetitions in one prompt are one prompt');
        assert.equal(words['пожалуйста'], 1);
        assert.equal(words['толькотекст'], 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(store, { recursive: true, force: true });
    }
});
