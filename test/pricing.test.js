const test = require('node:test');
const assert = require('node:assert');
const p = require('../pricing');

const M = 1e6;

test('a cache write is priced by the TTL the record reports', () => {
    const hourly = {
        input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
        cache_creation_input_tokens: M,
        cache_creation: { ephemeral_1h_input_tokens: M, ephemeral_5m_input_tokens: 0 },
    };
    const fiveMin = {
        ...hourly,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: M },
    };
    // Opus input is $5/M: 2x hourly, 1.25x five-minute.
    assert.equal(p.costOf('claude-opus-5', hourly), 10);
    assert.equal(p.costOf('claude-opus-5', fiveMin), 6.25);
});

test('a record with no TTL split is priced at the cheaper rate, never the dearer', () => {
    const old = { cache_creation_input_tokens: M };
    assert.equal(p.costOf('claude-opus-5', old), 6.25);

    // A split that does not add up leaves a remainder, which is five-minute too.
    const partial = {
        cache_creation_input_tokens: M,
        cache_creation: { ephemeral_1h_input_tokens: M / 2 },
    };
    assert.equal(p.costOf('claude-opus-5', partial), 5 + 3.125);
});

test('cacheSplit accounts for every written token exactly once', () => {
    const split = p.cacheSplit({
        cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_1h_input_tokens: 600, ephemeral_5m_input_tokens: 300 },
    });
    assert.equal(split.hour, 600);
    assert.equal(split.min5, 400); // 300 reported plus 100 unaccounted for
    assert.equal(split.hour + split.min5, split.total);
    assert.deepEqual(p.cacheSplit(null), { hour: 0, min5: 0, total: 0 });
});

test('cacheSaving is what those reads would have cost as fresh input', () => {
    assert.equal(p.cacheSaving('claude-opus-5', { cache_read_input_tokens: M }), 4.5);
    assert.equal(p.cacheSaving('claude-haiku-4-5', { cache_read_input_tokens: M }), 0.9);
    assert.equal(p.cacheSaving('claude-opus-5', null), 0);
});

test('an unknown model is priced at Opus rates and says so', () => {
    assert.equal(p.ratesFor('claude-opus-5').known, true);
    assert.equal(p.ratesFor('claude-opus-5[1m]').known, true);
    assert.equal(p.ratesFor('claude-newthing-9').known, false);
    assert.deepEqual(p.ratesFor('claude-newthing-9').rates, p.RATES['claude-opus-5']);
});

// A dated id is the same model as its alias — `claude-haiku-4-5-20251001` is
// what the transcripts of that model actually carry. Without the suffix coming
// off, it misses `RATES`, falls back to the Opus rate, and Haiku is billed at
// five times its price while the row still reads "haiku 4.5", because
// `shortModel` strips the date and `ratesFor` did not.
test('a dated model id finds the rate of the alias it belongs to', () => {
    assert.equal(p.ratesFor('claude-haiku-4-5-20251001').known, true);
    assert.deepEqual(p.ratesFor('claude-haiku-4-5-20251001').rates, p.RATES['claude-haiku-4-5']);
    // And stripping the date invents nothing: a model the table never listed is
    // still unknown without it. `claude-opus-4-5` is one — it has no row here.
    assert.equal(p.ratesFor('claude-opus-4-5-20251101').known, false);
});

test('output and input are unaffected by the cache change', () => {
    assert.equal(p.costOf('claude-opus-5', { output_tokens: M }), 25);
    assert.equal(p.costOf('claude-opus-5', { input_tokens: M }), 5);
    assert.equal(p.costOf('claude-opus-5', { cache_read_input_tokens: M }), 0.5);
    assert.equal(p.costOf('claude-opus-5', null), 0);
});

// Every rate in the table is a published price, and Sonnet 5 is the one that
// moved: the $2/$10 announced as introductory became the standard price, and the
// rise to $3/$15 scheduled for 2026-09-01 was cancelled. A rate that is wrong
// costs attribution rather than money — the figure is simply not what was
// billed. Checked 2026-08-24 against Anthropic's pricing page.
test('the rate table matches the published prices', () => {
    const published = {
        'claude-opus-5': { in: 5, out: 25 },
        'claude-opus-4-8': { in: 5, out: 25 },
        'claude-opus-4-7': { in: 5, out: 25 },
        'claude-opus-4-6': { in: 5, out: 25 },
        'claude-sonnet-5': { in: 2, out: 10 },
        'claude-sonnet-4-6': { in: 3, out: 15 },
        'claude-haiku-4-5': { in: 1, out: 5 },
        'claude-fable-5': { in: 10, out: 50 },
        'claude-mythos-5': { in: 10, out: 50 },
        'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.025 },
        'claude-mythos-5-1': { in: 10, out: 50, cacheRead: 0.025 },
    };
    for (const [id, rate] of Object.entries(published)) {
        assert.deepEqual(p.ratesFor(id).rates, rate, `${id} is priced wrong`);
    }
});

// A provider-format id names the same model as its Anthropic id: Bedrock spells
// it `us.anthropic.claude-opus-5-v1:0`, Vertex pins a version with `@`, and a
// gateway prefixes a host. Without those coming off, every one of them misses
// `RATES` and is billed at the Opus fallback — the same failure the dated
// suffix caused, and now reachable from a `modelPicker` lineup, whose rows are
// documented to accept exactly these spellings.
test('a provider-format model id finds the rate of the model it names', () => {
    const bedrock = 'us.anthropic.claude-haiku-4-5-v1:0';
    assert.equal(p.ratesFor(bedrock).known, true);
    assert.deepEqual(p.ratesFor(bedrock).rates, p.RATES['claude-haiku-4-5']);

    for (const id of [
        'anthropic.claude-sonnet-5',              // Bedrock, no region prefix
        'eu.anthropic.claude-sonnet-5-v1:0',      // Bedrock, EU inference profile
        'global.anthropic.claude-sonnet-5-v1:0',  // Bedrock, global profile
        'claude-sonnet-5@20260101',               // Vertex, version pinned with @
        'my-gateway/claude-sonnet-5',             // LLM gateway, host prefix
    ]) {
        assert.equal(p.ratesFor(id).known, true, `${id} should be known`);
        assert.deepEqual(p.ratesFor(id).rates, p.RATES['claude-sonnet-5'], `${id} is priced wrong`);
    }
});

// Stripping a provider's spelling invents nothing: a model the table never
// listed stays unknown, and the Opus fallback still covers it.
test('a provider-format id of an unlisted model is still unknown', () => {
    assert.equal(p.ratesFor('us.anthropic.claude-newthing-9-v1:0').known, false);
    assert.equal(p.ratesFor('my-gateway/claude-opus-4-5').known, false);
    assert.deepEqual(p.ratesFor('my-gateway/claude-opus-4-5').rates, p.RATES['claude-opus-5']);
});

// Fable 5.1 reads its cache at $0.25/M — 0.025x of its $10 input rate, where
// every other model pays 0.1x. Fable 5 keeps 0.1x: the two share every other
// price, and this is the one place they differ. Mythos 5.1 is the same model
// under another access programme and is priced like Fable 5.1 throughout; its
// read rate was "open at launch" and is taken to match.
// Checked 2026-09-01 against the claude-api skill.
test('a cache read is priced at the rate of the model that reads it', () => {
    assert.equal(p.costOf('claude-fable-5-1', { cache_read_input_tokens: M }), 0.25);
    assert.equal(p.costOf('claude-fable-5', { cache_read_input_tokens: M }), 1);
    assert.equal(p.costOf('claude-mythos-5-1', { cache_read_input_tokens: M }), 0.25);
    assert.equal(p.cacheSaving('claude-fable-5-1', { cache_read_input_tokens: M }), 9.75);
});

test('Fable 5.1 and Mythos 5.1 have a published rate', () => {
    assert.equal(p.ratesFor('claude-fable-5-1').known, true);
    assert.equal(p.ratesFor('claude-mythos-5-1').known, true);
    assert.equal(p.ratesFor('claude-fable-5-1[1m]').known, true);
});

// An advisor's consultation is billed to the request that asked for it. The
// record carries it as an `advisor_message` entry of `usage.iterations`, under
// the advisor's own model, and the record's top-level counters leave it out —
// they sum the `message` entries only. The shape below is a live record with
// its numbers kept: input 4 = 2 + 2, output 5076 = 4803 + 273, and the advisor's
// 178 522 tokens of input appear nowhere but in its own entry.
const consulted = {
    input_tokens: 4, output_tokens: 5076, cache_read_input_tokens: 342760, cache_creation_input_tokens: 8060,
    cache_creation: { ephemeral_1h_input_tokens: 1850, ephemeral_5m_input_tokens: 0 },
    iterations: [
        { type: 'message', input_tokens: 2, output_tokens: 4803, cache_read_input_tokens: 170455, cache_creation_input_tokens: 1850, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1850 } },
        { type: 'advisor_message', model: 'claude-fable-5', input_tokens: 178522, output_tokens: 9857, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
        { type: 'message', input_tokens: 2, output_tokens: 273, cache_read_input_tokens: 172305, cache_creation_input_tokens: 6210, cache_creation: { ephemeral_5m_input_tokens: 6210, ephemeral_1h_input_tokens: 0 } },
    ],
};

test('an advisor consultation inside a record is priced at the advisor model', () => {
    const own = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    const consult = (extra) => ({ ...own, iterations: [{ type: 'advisor_message', model: 'claude-fable-5-1', ...own, ...extra }] });
    assert.equal(p.costOf('claude-opus-5', consult({ input_tokens: M })), 10);
    assert.equal(p.costOf('claude-opus-5', consult({ output_tokens: M })), 50);
    // The advisor's cache is priced like anyone's: its own read rate, its own
    // TTL split on a write.
    assert.equal(p.costOf('claude-opus-5', consult({ cache_read_input_tokens: M })), 0.25);
    assert.equal(p.costOf('claude-opus-5', consult({
        cache_creation_input_tokens: M, cache_creation: { ephemeral_1h_input_tokens: M },
    })), 20);
    assert.equal(p.cacheSaving('claude-opus-5', consult({ cache_read_input_tokens: M })), 9.75);
});

test('the message entries of a record are not charged a second time beside its counters', () => {
    const { iterations, ...own } = consulted;
    const advisor = p.costOf('claude-fable-5', iterations[1]);
    assert.ok(advisor > 1, 'the advisor entry alone is worth dollars');
    const whole = p.costOf('claude-opus-5', consulted);
    assert.ok(Math.abs(whole - (p.costOf('claude-opus-5', own) + advisor)) < 1e-9,
        `whole ${whole} should be the record's own cost plus the advisor's`);
});

// A record from before advisors, or one with no consultation in it, costs what
// it always did.
test('a record without an advisor entry is unchanged', () => {
    const plain = { ...consulted, iterations: consulted.iterations.filter((it) => it.type === 'message') };
    const { iterations, ...own } = consulted;
    assert.equal(p.costOf('claude-opus-5', plain), p.costOf('claude-opus-5', own));
    assert.equal(p.costOf('claude-opus-5', { ...own, iterations: null }), p.costOf('claude-opus-5', own));
});

// An advisor entry names its model — every one of the 435 in a week of
// transcripts here does — and the record's own `advisorModel` is the model that
// was consulted when the entry does not. With neither it is the fallback, like
// any unknown model.
test("an advisor entry with no model is priced at the record's advisor", () => {
    const own = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    const consult = { ...own, iterations: [{ type: 'advisor_message', ...own, input_tokens: M }] };
    assert.equal(p.costOf('claude-opus-5', consult, 'claude-fable-5-1'), 10);
    assert.equal(p.costOf('claude-opus-5', consult), 5);
    const read = { ...own, iterations: [{ type: 'advisor_message', ...own, cache_read_input_tokens: M }] };
    assert.equal(p.cacheSaving('claude-opus-5', read, 'claude-fable-5-1'), 9.75);
});

// Which record of a response is charged: the one whose usage totals the most.
// A record with no request id is a response of its own.
test('responseKey groups the records of one response and nothing else', () => {
    assert.equal(p.responseKey({ requestId: 'req-1', uuid: 'a' }), p.responseKey({ requestId: 'req-1', uuid: 'b' }));
    assert.notEqual(p.responseKey({ uuid: 'a' }), p.responseKey({ uuid: 'b' }));
    assert.notEqual(p.responseKey({ requestId: 'req-1' }), p.responseKey({ requestId: 'req-2' }));
    assert.equal(p.usageTotal({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }), 10);
    assert.equal(p.usageTotal({}), 0);
});
