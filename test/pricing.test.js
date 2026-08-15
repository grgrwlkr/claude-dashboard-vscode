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
