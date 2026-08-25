// Public Anthropic rates, $ per 1M tokens. Checked against the claude-api skill
// on 2026-08-08 rather than recalled. Everything derived from these is an
// estimate — the real bill depends on plan and discounts, which is why every
// figure in the UI carries a tilde.
//
// Cache: a write costs 1.25x input at the 5-minute TTL and 2x at the hourly one;
// a read costs 0.1x. Which TTL was used is on disk — `usage.cache_creation`
// splits the write into `ephemeral_5m_input_tokens` and
// `ephemeral_1h_input_tokens` — and the split matters: across the transcripts
// this was built against it runs roughly half and half, so pricing every write
// at 1.25x understated the total by about 10%.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;

const RATES = {
    'claude-opus-5': { in: 5, out: 25 },
    'claude-opus-4-8': { in: 5, out: 25 },
    'claude-opus-4-7': { in: 5, out: 25 },
    'claude-opus-4-6': { in: 5, out: 25 },
    'claude-sonnet-5': { in: 2, out: 10 },
    'claude-sonnet-4-6': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
    'claude-fable-5': { in: 10, out: 50 },
    'claude-mythos-5': { in: 10, out: 50 },
};

// Opus is the priciest tier people actually work in here: an unknown model is
// better overestimated than shown as a reassuringly small number.
const FALLBACK = { in: 5, out: 25 };

// Suffixes like [1m], -fast and a dated snapshot do not change the rate — the
// model id underneath is the same one. The date matters most: transcripts carry
// `claude-haiku-4-5-20251001`, and without stripping it the id misses `RATES`
// and is billed at the Opus fallback — five times Haiku's own rate, under a row
// that still reads "haiku 4.5" because `shortModel` strips what this did not.
function ratesFor(model) {
    const id = (model || '').replace(/\[[^\]]*\]$/, '').replace(/-fast$/, '').replace(/-\d{8}$/, '');
    return { rates: RATES[id] || FALLBACK, known: Boolean(RATES[id]) };
}

/**
 * How a record's cache write splits across the two TTLs. An older record with no
 * `cache_creation` block, or one whose parts do not add up to the total, has the
 * remainder counted as five-minute: that is the client's default and the
 * cheaper of the two, so an unknown write is never over-billed.
 */
function cacheSplit(usage) {
    const total = (usage && usage.cache_creation_input_tokens) || 0;
    const parts = (usage && usage.cache_creation) || null;
    const hour = parts ? (parts.ephemeral_1h_input_tokens || 0) : 0;
    const min5 = parts ? (parts.ephemeral_5m_input_tokens || 0) : 0;
    const rest = Math.max(0, total - hour - min5);
    return { hour, min5: min5 + rest, total };
}

// Cost of a single transcript record from its usage block.
function costOf(model, usage) {
    if (!usage) return 0;
    const { rates } = ratesFor(model);
    const cache = cacheSplit(usage);
    const M = 1e6;
    return (
        ((usage.input_tokens || 0) * rates.in
            + (usage.output_tokens || 0) * rates.out
            + cache.hour * rates.in * CACHE_WRITE_1H
            + cache.min5 * rates.in * CACHE_WRITE_5M
            + (usage.cache_read_input_tokens || 0) * rates.in * CACHE_READ)
        / M
    );
}

/**
 * What the cache saved on one record: reading a cached token costs 0.1x what
 * sending it as fresh input would have. The write that put it there is a
 * separate, already-paid cost — this is the return on it, not a net figure.
 */
function cacheSaving(model, usage) {
    if (!usage) return 0;
    const { rates } = ratesFor(model);
    return ((usage.cache_read_input_tokens || 0) * rates.in * (1 - CACHE_READ)) / 1e6;
}

function fmtCost(usd) {
    if (!(usd > 0)) return '$0';
    if (usd < 0.01) return '<$0.01';
    return `$${usd.toFixed(2)}`;
}

module.exports = {
    RATES, CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ,
    ratesFor, costOf, cacheSplit, cacheSaving, fmtCost,
};
