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

test('thinking is detected from a content block, not from a flag', () => {
    const withThinking = rec();
    withThinking.message.content = [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'ok' }];
    assert.equal(s.contextOf(withThinking).thinking, true);
    assert.equal(s.contextOf(rec()).thinking, false);
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
