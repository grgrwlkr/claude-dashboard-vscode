// Public Anthropic rates, $ per 1M tokens. Checked against the claude-api skill
// on 2026-08-08 rather than recalled. Everything derived from these is an
// estimate — the real bill depends on plan and discounts, which is why every
// figure in the UI carries a tilde.
//
// Cache: a write costs 1.25x input at the 5-minute TTL and 2x at the hourly one;
// a read costs 0.1x. The client writes the five-minute cache by default and the
// transcript does not record which TTL was used, so 1.25x is assumed — with an
// hourly cache the estimate runs low.
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

const RATES = {
    'claude-opus-5': { in: 5, out: 25 },
    'claude-opus-4-8': { in: 5, out: 25 },
    'claude-opus-4-7': { in: 5, out: 25 },
    'claude-opus-4-6': { in: 5, out: 25 },
    'claude-sonnet-5': { in: 3, out: 15 },
    'claude-sonnet-4-6': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
    'claude-fable-5': { in: 10, out: 50 },
    'claude-mythos-5': { in: 10, out: 50 },
};

// Opus is the priciest tier people actually work in here: an unknown model is
// better overestimated than shown as a reassuringly small number.
const FALLBACK = { in: 5, out: 25 };

// Suffixes like [1m] and -fast do not change the rate — the model id underneath
// is the same one.
function ratesFor(model) {
    const id = (model || '').replace(/\[[^\]]*\]$/, '').replace(/-fast$/, '');
    return { rates: RATES[id] || FALLBACK, known: Boolean(RATES[id]) };
}

// Cost of a single transcript record from its usage block.
function costOf(model, usage) {
    if (!usage) return 0;
    const { rates } = ratesFor(model);
    const M = 1e6;
    return (
        ((usage.input_tokens || 0) * rates.in
            + (usage.output_tokens || 0) * rates.out
            + (usage.cache_creation_input_tokens || 0) * rates.in * CACHE_WRITE
            + (usage.cache_read_input_tokens || 0) * rates.in * CACHE_READ)
        / M
    );
}

function fmtCost(usd) {
    if (!(usd > 0)) return '$0';
    if (usd < 0.01) return '<$0.01';
    return `$${usd.toFixed(2)}`;
}

module.exports = { RATES, ratesFor, costOf, fmtCost };
