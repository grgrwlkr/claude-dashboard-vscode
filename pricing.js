// Public Anthropic rates, $ per 1M tokens. Checked against the claude-api skill
// on 2026-09-01 rather than recalled. Everything derived from these is an
// estimate — the real bill depends on plan and discounts, which is why every
// figure in the UI carries a tilde.
//
// Cache: a write costs 1.25x input at the 5-minute TTL and 2x at the hourly one;
// a read costs 0.1x — unless the row says otherwise: Fable 5.1 reads at $0.25/M,
// 0.025x of its input rate, and `cacheRead` on a row is that exception. Which
// TTL was used is on disk — `usage.cache_creation`
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
    'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.025 },
    // The same model as Fable 5.1 under another access programme, priced like
    // it throughout. Its read rate was "open at launch"; the row takes Fable
    // 5.1's until a different one is published.
    'claude-mythos-5-1': { in: 10, out: 50, cacheRead: 0.025 },
};

const cacheReadOf = (rates) => (rates.cacheRead === undefined ? CACHE_READ : rates.cacheRead);

// Opus is the priciest tier people actually work in here: an unknown model is
// better overestimated than shown as a reassuringly small number.
const FALLBACK = { in: 5, out: 25 };

// The Anthropic id a spelling names. Suffixes like [1m], -fast and a dated
// snapshot do not change the rate, and neither does the way a provider spells
// the id: Bedrock writes `us.anthropic.claude-opus-5-v1:0`, Vertex pins the
// version after an `@`, a gateway puts its host in front. Every one of those
// carries the same model underneath.
//
// The date matters most, because transcripts carry it: `claude-haiku-4-5-20251001`
// without the suffix off misses `RATES` and is billed at the Opus fallback —
// five times Haiku's own rate, under a row that still reads "haiku 4.5" because
// `shortModel` strips what this did not. The provider spellings reach us the
// same way now: `modelPicker` (CLI 2.1.242) takes each row's model verbatim and
// accepts exactly these formats, so what the picker offers is what the
// transcript records.
//
// Stripping invents nothing — a model the table never listed stays unknown, and
// the fallback covers it.
function canonicalModel(model) {
    return (model || '')
        .replace(/^.*\//, '')                       // gateway host: my-gateway/claude-opus-5
        .replace(/^(?:[a-z0-9-]+\.)?anthropic\./, '') // Bedrock region profile + vendor
        .replace(/:\d+$/, '')                        // Bedrock version qualifier: -v1:0
        .replace(/-v\d+$/, '')
        .replace(/@.*$/, '')                         // Vertex version pin
        .replace(/\[[^\]]*\]$/, '')
        .replace(/-fast$/, '')
        .replace(/-\d{8}$/, '');
}

function ratesFor(model) {
    const id = canonicalModel(model);
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

/**
 * The advisor's consultations inside a record. A response that consulted one
 * carries the consultation as an `advisor_message` entry of `usage.iterations`,
 * under the advisor's own model and with a usage of its own — and the record's
 * top-level counters leave it out: they sum the `message` entries only, which is
 * why those entries are not walked here, and why walking them would bill every
 * reply twice. A consultation is a few dollars, the reply around it cents.
 *
 * `advisor` is the record's own `advisorModel`, the model that was consulted:
 * an entry that does not name its model — none of the 435 in a week of
 * transcripts here — is priced at that. With neither, it is the fallback.
 */
function advisorUsages(usage, advisor = '') {
    const its = usage && usage.iterations;
    if (!Array.isArray(its)) return [];
    return its
        .filter((it) => it && it.type === 'advisor_message')
        .map((it) => (it.model ? it : { ...it, model: advisor }));
}

/**
 * The records of one response, and which of them is charged.
 *
 * A reply written as thinking, text and a tool call is three records under one
 * request id, and they carry the same usage — every multi-record response in a
 * week of transcripts here does; older ones held a running counter. Either way
 * a response is charged once, from the record whose usage totals the most. A
 * record with no request id is a response of its own; `solo` tells two of them
 * apart, since a fixture may carry no uuid either.
 */
function usageTotal(u) {
    return (u.input_tokens || 0) + (u.output_tokens || 0)
        + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

function responseKey(r, solo = '') {
    return r.requestId || `solo:${r.uuid || solo}`;
}

// The price of one usage block at one model's rates, iterations not included.
function priceOf(model, usage) {
    const { rates } = ratesFor(model);
    const cache = cacheSplit(usage);
    const M = 1e6;
    return (
        ((usage.input_tokens || 0) * rates.in
            + (usage.output_tokens || 0) * rates.out
            + cache.hour * rates.in * CACHE_WRITE_1H
            + cache.min5 * rates.in * CACHE_WRITE_5M
            + (usage.cache_read_input_tokens || 0) * rates.in * cacheReadOf(rates))
        / M
    );
}

// Cost of a single transcript record from its usage block: the reply at its
// model's rates, plus every advisor consultation inside it at the advisor's.
function costOf(model, usage, advisor = '') {
    if (!usage) return 0;
    let total = priceOf(model, usage);
    for (const it of advisorUsages(usage, advisor)) total += priceOf(it.model, it);
    return total;
}

/**
 * What the cache saved on one record: reading a cached token costs a fraction
 * of what sending it as fresh input would have — 0.1x, or the row's own rate.
 * The write that put it there is a separate, already-paid cost — this is the
 * return on it, not a net figure. An advisor's reads count the same way, at the
 * advisor's rate.
 */
function cacheSaving(model, usage, advisor = '') {
    if (!usage) return 0;
    const saving = (m, u) => {
        const { rates } = ratesFor(m);
        return ((u.cache_read_input_tokens || 0) * rates.in * (1 - cacheReadOf(rates))) / 1e6;
    };
    let total = saving(model, usage);
    for (const it of advisorUsages(usage, advisor)) total += saving(it.model, it);
    return total;
}

function fmtCost(usd) {
    if (!(usd > 0)) return '$0';
    if (usd < 0.01) return '<$0.01';
    return `$${usd.toFixed(2)}`;
}

// How a model is named wherever one is shown: the status bar, the page, the
// terminal. It lives beside `canonicalModel` because it is the same question —
// which model is this — asked for a reader instead of for a rate table.
// What the client writes in place of a reply that never came, with an all-zero
// usage. It reaches counters of messages, which is what it is — but it is not a
// model, and belongs in no breakdown of them.
const SYNTHETIC_MODEL = '<synthetic>';

// A models bucket without it. Every surface that lists models filters here
// rather than remembering to.
const realModels = (models) => Object.fromEntries(
    Object.entries(models || {}).filter(([m]) => m !== SYNTHETIC_MODEL),
);

function shortModel(model) {
    return (canonicalModel(model) || 'unknown')
        .replace(/^claude-/, '')
        .replace(/-(\d)-(\d)$/, ' $1.$2')
        .replace(/-(\d)$/, ' $1');
}

// A token count in the width a status line can afford. Whole millions lose the
// decimal: `2M` rather than `2.0M`.
function tokenLabel(n) {
    if (n < 1e6) return `${Math.round(n / 1000)}k`;
    const m = n / 1e6;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
}

module.exports = {
    RATES, CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ,
    ratesFor, costOf, cacheSplit, cacheSaving, fmtCost, canonicalModel,
    shortModel, tokenLabel, SYNTHETIC_MODEL, realModels,
    advisorUsages, usageTotal, responseKey,
};
