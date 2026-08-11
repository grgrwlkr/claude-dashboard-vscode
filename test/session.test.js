const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('../session');
const { costOf, ratesFor, fmtCost } = require('../pricing');

const NOW = Date.parse('2026-08-08T12:00:00Z');

function rec(over = {}) {
    return {
        timestamp: new Date(NOW).toISOString(),
        message: {
            model: 'claude-opus-5',
            usage: {
                input_tokens: 2,
                output_tokens: 700,
                cache_read_input_tokens: 200000,
                cache_creation_input_tokens: 1000,
            },
        },
        effort: 'xhigh',
        advisorModel: 'claude-fable-5',
        gitBranch: 'main',
        ...over,
    };
}

test('slugFor encodes a path the way the client does', () => {
    assert.equal(s.slugFor('/Users/x/Develop/second-brain'), '-Users-x-Develop-second-brain');
    // Underscores become hyphens too — an easy detail to get wrong.
    assert.equal(s.slugFor('/Users/x/Develop/backend-service'), '-Users-x-Develop-rust-service');
});

test('contextOf sums context from all three parts of usage', () => {
    const ctx = s.contextOf(rec());
    assert.equal(ctx.tokens, 2 + 200000 + 1000);
    assert.equal(ctx.window, 1e6);
    assert.equal(ctx.pct, 20);
    assert.equal(ctx.cachePct, 99);
    assert.equal(ctx.effort, 'xhigh');
    assert.equal(ctx.advisor, 'claude-fable-5');
    assert.equal(ctx.estimated, false);
});

test('contextOf survives a missing record', () => {
    assert.equal(s.contextOf(null), null);
});

test('thinking is read from the setting, never from the last reply', () => {
    // A reply that is a tool call carries no thinking block even while the model
    // is thinking on every turn, so the transcript cannot answer this — and
    // reading it there reported "off" for almost every agentic answer.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-set-'));
    const claude = path.join(dir, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    try {
        // Nothing configured: thinking is on, the way the client ships.
        assert.equal(s.settingsOf(dir).thinking, true);

        fs.writeFileSync(path.join(claude, 'settings.json'),
            JSON.stringify({ alwaysThinkingEnabled: false, showThinkingSummaries: false }));
        const off = s.settingsOf(dir);
        assert.equal(off.thinking, false, 'false is an answer, not a missing value');
        assert.equal(off.thinkingSummaries, false);

        // The nearer file wins, including when it says true over a global false.
        fs.writeFileSync(path.join(claude, 'settings.local.json'),
            JSON.stringify({ alwaysThinkingEnabled: true }));
        const local = s.settingsOf(dir);
        assert.equal(local.thinking, true);
        assert.equal(local.thinkingSummaries, false, 'the key it does not state is left to the file below');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('windowFor: a million on current models, 200k on Haiku, suffix forces it', () => {
    assert.deepEqual(s.windowFor('claude-opus-5'), { tokens: 1e6, estimated: false });
    assert.deepEqual(s.windowFor('claude-sonnet-5'), { tokens: 1e6, estimated: false });
    assert.deepEqual(s.windowFor('claude-fable-5'), { tokens: 1e6, estimated: false });
    assert.deepEqual(s.windowFor('claude-haiku-4-5'), { tokens: 200000, estimated: false });
    assert.deepEqual(s.windowFor('claude-opus-5[1m]'), { tokens: 1e6, estimated: false });
    // An unknown model gets 200k and a flag saying the window was guessed.
    assert.deepEqual(s.windowFor('some-proxy-model'), { tokens: 200000, estimated: true });
});

test('costOf prices all four rates separately', () => {
    // 1M input + 1M output on Opus 5 = $5 + $25.
    assert.equal(costOf('claude-opus-5', { input_tokens: 1e6, output_tokens: 1e6 }), 30);
    // A cache write costs 1.25x input; a read is ten times cheaper.
    assert.equal(costOf('claude-opus-5', { cache_creation_input_tokens: 1e6 }), 6.25);
    assert.equal(costOf('claude-opus-5', { cache_read_input_tokens: 1e6 }), 0.5);
    assert.equal(costOf('claude-opus-5', null), 0);
});

test('costOf knows the different model rates', () => {
    assert.equal(costOf('claude-fable-5', { input_tokens: 1e6 }), 10);
    assert.equal(costOf('claude-sonnet-5', { input_tokens: 1e6 }), 3);
    assert.equal(costOf('claude-haiku-4-5', { input_tokens: 1e6 }), 1);
});

test('an unknown model is priced at Opus rates and flagged as unknown', () => {
    assert.equal(ratesFor('claude-opus-5').known, true);
    assert.equal(ratesFor('gpt-whatever').known, false);
    assert.equal(costOf('gpt-whatever', { input_tokens: 1e6 }), 5);
});

test('the [1m] and -fast suffixes do not change the rate', () => {
    assert.equal(ratesFor('claude-opus-5[1m]').known, true);
    assert.equal(costOf('claude-opus-5[1m]', { input_tokens: 1e6 }), 5);
    assert.equal(costOf('claude-opus-5-fast', { input_tokens: 1e6 }), 5);
});

test('fmtCost does not show $0.00 on sub-cent amounts', () => {
    assert.equal(fmtCost(0), '$0');
    assert.equal(fmtCost(0.004), '<$0.01');
    assert.equal(fmtCost(12.399), '$12.40');
});

test("costSince drops yesterday's records from the same file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    const yesterday = new Date(NOW - 30 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, [
        JSON.stringify(rec({ timestamp: yesterday })),
        JSON.stringify(rec()),
        'not json — a junk line the parser has to survive',
        '',
    ].join('\n'));

    const one = costOf('claude-opus-5', rec().message.usage);
    assert.ok(Math.abs(s.costSince(file, NOW - 3600 * 1000) - one) < 1e-9);
    assert.ok(Math.abs(s.costOfSession(file) - one * 2) < 1e-9);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('readTail skips subagent records and takes the most recent one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    const older = new Date(NOW - 60000).toISOString();
    const sub = rec({ agentId: 'agent_1' });
    sub.message.usage.cache_read_input_tokens = 999999;
    fs.writeFileSync(file, [
        JSON.stringify(rec({ timestamp: older })),
        JSON.stringify(rec()),
        JSON.stringify(sub),
        JSON.stringify(rec({ isSidechain: true })),
    ].join('\n') + '\n');

    const last = s.readTail(file);
    assert.equal(last.agentId, undefined);
    assert.equal(last.isSidechain, undefined);
    assert.equal(s.contextOf(last).tokens, 201002);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('readTail returns null for a missing file', () => {
    assert.equal(s.readTail('/nope/does-not-exist.jsonl'), null);
});

test('findOwnSession does not invent a session when the registry has none', () => {
    // A foreign pid and a non-existent workspace: no fallback should match.
    assert.equal(s.findOwnSession('/nope/not-a-workspace', 999999), null);
});

test('readTail widens the window when one record fills the whole tail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');

    // A real transcript can carry a record of hundreds of kilobytes — a large
    // file write, a long tool result. With a fixed 256 KB window the buffer is
    // then a single truncated line and the context indicator silently vanishes.
    const huge = JSON.stringify({
        timestamp: new Date(NOW - 1000).toISOString(),
        type: 'user',
        message: { role: 'user', content: 'x'.repeat(400 * 1024) },
    });
    fs.writeFileSync(file, [JSON.stringify(rec()), huge, ''].join('\n'));

    const last = s.readTail(file);
    assert.ok(last, 'the record before the huge one must still be found');
    assert.equal(s.contextOf(last).tokens, 201002);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('readTail gives up cleanly on a transcript that has no usage at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, JSON.stringify({
        timestamp: new Date(NOW).toISOString(), type: 'user',
        message: { role: 'user', content: 'y'.repeat(300 * 1024) },
    }) + '\n');
    assert.equal(s.readTail(file), null);
    fs.rmSync(dir, { recursive: true, force: true });
});

const chainOf = (...pairs) => pairs.map(([scope, data]) => ({
    scope, path: `/fake/${scope}.json`, documented: true, exists: data !== null, data,
}));

test('the settings chain is the documented order, managed first', () => {
    const scopes = s.settingsFiles('/work').map((f) => f.scope);
    assert.deepEqual(scopes, ['managed', 'local', 'project', 'user local', 'user']);
    // Without a workspace there are no project files to read — and asking for
    // `/.claude/settings.json` at the filesystem root is how that used to look.
    assert.deepEqual(s.settingsFiles('').map((f) => f.scope), ['managed', 'user local', 'user']);
    assert.equal(s.settingsFiles('/work').find((f) => f.scope === 'managed').path, s.MANAGED);
    // The one file the precedence list in the docs does not mention.
    assert.equal(s.settingsFiles('/work').find((f) => f.scope === 'user local').documented, false);
});

test('resolveSetting names the file that won and the ones it shadowed', () => {
    const chain = chainOf(
        ['managed', null],
        ['local', { model: 'opus', alwaysThinkingEnabled: false }],
        ['user', { model: 'sonnet', outputStyle: 'Explanatory' }],
    );
    const model = s.resolveSetting(chain, 'model');
    assert.equal(model.value, 'opus');
    assert.equal(model.from, 'local');
    assert.deepEqual(model.alsoIn.map((a) => a.from), ['user']);

    assert.equal(s.resolveSetting(chain, 'outputStyle').from, 'user');
    assert.equal(s.resolveSetting(chain, 'nothingHere'), null);
    // `false` is stated, so it wins; `null` and `undefined` are not.
    assert.equal(s.resolveSetting(chain, 'alwaysThinkingEnabled').value, false);
    assert.equal(s.resolveSetting(chainOf(['user', { x: null }]), 'x'), null);
});

test('both readers answer from the chain they are given', () => {
    const chain = chainOf(['local', { alwaysThinkingEnabled: false }], ['user', {
        alwaysThinkingEnabled: true, advisorModel: 'fable', showThinkingSummaries: false,
    }]);
    const out = s.settingsOf('/work', chain);
    assert.equal(out.thinking, false, 'the nearer file said false');
    assert.equal(out.thinkingSummaries, false);
    assert.equal(out.advisor, 'fable');

    // Auto-compact off anywhere in the chain means there is no threshold to draw.
    assert.equal(s.autoCompactPct('/work', 200000, chainOf(['user', { autoCompactEnabled: false }])), -1);
    // 200k window, no override: (200000 − 20000 − 13000) / 200000.
    assert.equal(s.autoCompactPct('/work', 200000, chainOf(['user', {}])), 84);
    // A smaller autoCompactWindow moves the threshold down, not the window.
    assert.equal(s.autoCompactPct('/work', 200000, chainOf(['user', { autoCompactWindow: 100000 }])), 34);
});
