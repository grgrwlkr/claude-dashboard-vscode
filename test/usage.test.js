const test = require('node:test');
const assert = require('node:assert');
const u = require('../usage');

const WEEK = 604800;
// A fixed "now" in local time so tests do not depend on the hour they run at:
// 2026-08-08, 12:00 local.
const NOW_MS = new Date(2026, 7, 8, 12, 0, 0).getTime();
const NOW = Math.floor(NOW_MS / 1000);

const iso = (ts) => new Date(ts * 1000).toISOString();

function payload({ weeklyPct, weeklyReset, sessionPct = 7, scoped = [] }) {
    return {
        limits: [
            { kind: 'session', percent: sessionPct, resets_at: iso(NOW + 3600) },
            { kind: 'weekly_all', percent: weeklyPct, resets_at: iso(weeklyReset) },
            ...scoped.map(([name, pct]) => ({
                kind: 'weekly_scoped', percent: pct, resets_at: iso(weeklyReset),
                scope: { model: { display_name: name } },
            })),
        ],
    };
}

test('limitsOf splits limits[] by kind and floors a fractional percent', () => {
    const lim = u.limitsOf(payload({
        weeklyPct: 24.9, weeklyReset: NOW + 100, scoped: [['Fable', 1.7]],
    }));
    assert.equal(lim.session.pct, 7);
    assert.equal(lim.weekly.pct, 24);
    assert.deepEqual(lim.scoped.map((s) => [s.scope, s.pct]), [['Fable', 1]]);
});

test('limitsOf survives an empty or malformed payload', () => {
    for (const bad of [null, {}, { limits: null }, { limits: [] }]) {
        const lim = u.limitsOf(bad);
        assert.equal(lim.weekly, undefined);
        assert.deepEqual(lim.scoped, []);
    }
});

test('isoToTs understands the microseconds and +00:00 the API sends', () => {
    assert.equal(u.isoToTs('2026-08-13T12:00:00.315848+00:00'), 1786622400);
    assert.equal(u.isoToTs(''), 0);
    assert.equal(u.isoToTs('not a date'), 0);
});

test('pace: the plan is the share of the window elapsed, not the spend', () => {
    // Exactly two days of the window are behind: 2/7 = 28.57% → floor 28.
    const pc = u.pace({ pct: 10, reset: NOW + WEEK - 2 * 86400 }, NOW);
    assert.equal(pc.plan, 28);
    assert.equal(pc.elapsed, 2 * 86400);
});

test('dry reproduces the real case: 23% at 19% of the window → ~4.45 days', () => {
    const elapsed = Math.round(0.19 * WEEK);
    const pc = u.pace({ pct: 23, reset: NOW + WEEK - elapsed }, NOW);
    const days = (pc.dry - NOW) / 86400;
    assert.ok(Math.abs(days - 4.45) < 0.02, `expected ~4.45 days, got ${days}`);
});

test('dry stays silent in the first 30 minutes of a window', () => {
    const pc = u.pace({ pct: 40, reset: NOW + WEEK - 1799 }, NOW);
    assert.equal(pc.dry, null);
    assert.equal(u.pace({ pct: 40, reset: NOW + WEEK - 1800 }, NOW).dry !== null, true);
});

test('dry stays silent below 2%, where percent rounding dominates', () => {
    // An hour into the window: at 2% the forecast still lands inside the window
    // (two days), so silence at 1% is the threshold and not a reset cutoff.
    const reset = NOW + WEEK - 3600;
    assert.equal(u.pace({ pct: 1, reset }, NOW).dry, null);
    assert.notEqual(u.pace({ pct: 2, reset }, NOW).dry, null);
});

test('dry is not drawn when it lands after the window resets', () => {
    // Half the window gone, 30% spent — 100% is further away than the reset.
    const pc = u.pace({ pct: 30, reset: NOW + WEEK / 2 }, NOW);
    assert.equal(pc.dry, null);
});

test('pace returns null without a reset time', () => {
    assert.equal(u.pace({ pct: 50, reset: 0 }, NOW), null);
    assert.equal(u.pace(null, NOW), null);
});

test('fmtDry: no date when today, weekday and date otherwise, always an hour with a tilde', () => {
    const today = Math.floor(new Date(2026, 7, 8, 21, 40).getTime() / 1000);
    const later = Math.floor(new Date(2026, 7, 12, 9, 5).getTime() / 1000);
    assert.equal(u.fmtDry(today, NOW_MS), '~21h');
    // "12.08" alone does not say whether that is tomorrow or past the weekend.
    assert.equal(u.fmtDry(later, NOW_MS), 'Wed 12.08 ~09h');
});

test('fmtDry floors, the way date +%H does in statusline.sh', () => {
    const almost = Math.floor(new Date(2026, 7, 12, 11, 58).getTime() / 1000);
    assert.equal(u.fmtDry(almost, NOW_MS), 'Wed 12.08 ~11h');
});

test('fmtLeft: days, hours, minutes, and the past', () => {
    assert.equal(u.fmtLeft(NOW + 5 * 86400 + 2 * 3600, NOW), '5d2h');
    assert.equal(u.fmtLeft(NOW + 2 * 3600 + 13 * 60, NOW), '2h13m');
    assert.equal(u.fmtLeft(NOW + 37 * 60, NOW), '37m');
    assert.equal(u.fmtLeft(NOW - 1, NOW), 'now');
});

test('bar: cells beyond the plan are marked as spend ahead of schedule', () => {
    assert.equal(u.bar(0, 0), '░░░░░░');
    assert.equal(u.bar(100, 100), '▒▒▒▒▒▒');
    // Fact 50% (3 cells) against a 17% plan (1 cell): two cells are ahead.
    assert.equal(u.bar(50, 17), '▒▓▓░░░');
    // Fact behind the plan: unspent plan cells are dotted. Fact takes two cells,
    // not one — ceil lights a cell at any non-zero percent, the same behaviour as
    // (fact*w+99)/100 in statusline.sh.
    assert.equal(u.bar(17, 50), '▒▒·░░░');
});

test('barText assembles the whole bar string', () => {
    const elapsed = Math.round(0.19 * WEEK);
    const weekly = { pct: 23, reset: NOW + WEEK - elapsed };
    const text = u.barText(weekly, u.pace(weekly, NOW), NOW_MS);
    assert.match(text, /^✻ 7d 23% [▓▒·░]{6} dry [A-Z][a-z]{2} \d{2}\.\d{2} ~\d{2}h$/);
});

test('barText carries neither bar nor dry without a pace', () => {
    assert.equal(u.barText({ pct: 42, reset: 0 }, null, NOW_MS), '✻ 7d 42%');
});

test('parseToken extracts the token and survives junk', () => {
    assert.equal(u.parseToken('{"claudeAiOauth":{"accessToken":"abc"}}'), 'abc');
    assert.equal(u.parseToken('{}'), null);
    assert.equal(u.parseToken('not json'), null);
});

test('pace reports the forecast even when it lands after the reset', () => {
    // Half the window gone, 30% spent: 100% is further away than the reset.
    const weekly = { pct: 30, reset: NOW + WEEK / 2 };
    const pc = u.pace(weekly, NOW);
    assert.equal(pc.dry, null, 'the bar must stay quiet');
    assert.ok(pc.dryAt > weekly.reset, 'but the tooltip still gets a date');
    assert.equal(pc.beforeReset, false);
});

test('pace marks a forecast that lands before the reset', () => {
    const elapsed = Math.round(0.19 * WEEK);
    const pc = u.pace({ pct: 23, reset: NOW + WEEK - elapsed }, NOW);
    assert.equal(pc.beforeReset, true);
    assert.equal(pc.dry, pc.dryAt, 'the bar shows the same moment as the tooltip');
});

test('fmtWhen names the weekday, so a date days out needs no arithmetic', () => {
    // 2026-08-15 is a Saturday.
    const ts = Math.floor(new Date(2026, 7, 15, 6, 40).getTime() / 1000);
    assert.equal(u.fmtWhen(ts), 'Sat 15.08, ~06h');
    assert.equal(u.fmtWhen(0), '—');
});

// The one figure here that is money rather than an estimate from public rates,
// and the only one that was covered by its rendering alone: status.js has a
// fixture for the credits object, and nothing called the function that digs it
// out of the endpoint's answer.
test('creditsOf reads minor units by the exponent the API states', () => {
    const payload = {
        limits: [],
        spend: {
            used: { amount_minor: 10367, exponent: 2 },
            limit: { amount_minor: 20000, exponent: 2 },
            percent: 51.8,
            enabled: false,
            disabled_reason: 'out_of_credits',
        },
    };
    const c = u.creditsOf(payload);
    assert.equal(c.used, 103.67);
    assert.equal(c.limit, 200);
    assert.equal(c.pct, 51);
    assert.equal(c.enabled, false);
    assert.equal(c.reason, 'out_of_credits');
});

// Money already spent stays spent when the account runs out of credits, so a
// disabled block with a used figure is exactly the state worth reporting — and
// the state this machine was in when the field was first read.
test('credits already spent survive the switch being off', () => {
    const spent = u.creditsOf({ spend: { used: { amount_minor: 10367, exponent: 2 }, enabled: false } });
    assert.equal(spent.used, 103.67);
    assert.equal(spent.pct, 0, 'no limit, so a percentage would be of nothing');

    assert.equal(u.creditsOf({}), null, 'no spend block at all is not a zero, it is an absence');
    assert.equal(u.creditsOf({ spend: { enabled: true } }), null, 'enabled with nothing spent has nothing to say');
});

// The currency is stated beside the amount, and this is the one figure in the
// extension that is a bill rather than an estimate from published rates. A
// borrowed `$` would leave the number right and its meaning wrong.
test('creditsOf carries the currency the endpoint named', () => {
    const spend = (currency) => ({ spend: { used: { amount_minor: 10367, exponent: 2, currency }, enabled: true } });
    assert.equal(u.creditsOf(spend('USD')).currency, 'USD');
    assert.equal(u.creditsOf(spend('EUR')).currency, 'EUR');
    assert.equal(u.creditsOf(spend(undefined)).currency, 'USD', 'a missing code is the one everything else assumes');
});
