const test = require('node:test');
const assert = require('node:assert');

const term = require('../terminal');

// The client's own JSON, trimmed to the fields these tests speak about. Shape
// and field names are the documented status-line contract, not a guess.
const client = (over = {}) => ({
    session_id: 'abc123',
    transcript_path: '/tmp/nowhere/abc123.jsonl',
    version: '2.1.245',
    model: { id: 'claude-opus-5[1m]', display_name: 'Opus' },
    workspace: { current_dir: '/w', project_dir: '/w', git_worktree: 'master' },
    output_style: { name: 'Proactive' },
    thinking: { enabled: true },
    effort: { level: 'xhigh' },
    context_window: {
        total_input_tokens: 100000,
        context_window_size: 1000000,
        used_percentage: 10,
        current_usage: { input_tokens: 20000, cache_read_input_tokens: 70000, cache_creation_input_tokens: 10000 },
    },
    cost: {
        total_cost_usd: 12.5,
        total_duration_ms: 7200000,
        total_api_duration_ms: 1800000,
        total_lines_added: 156,
        total_lines_removed: 23,
    },
    rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    },
    ...over,
});

test('the context fields come from the client, so no transcript is opened', () => {
    const d = term.clientData(client(), 1738400000);
    // The transcript path in the fixture does not exist: reading it would throw
    // or yield null, and both would show up as an empty ctx.
    assert.equal(d.ctx.tokens, 100000);
    assert.equal(d.ctx.window, 1000000);
    assert.equal(d.ctx.pct, 10);
    assert.equal(d.ctx.model, 'claude-opus-5[1m]');
    assert.equal(d.ctx.effort, 'xhigh');
    assert.equal(d.ctx.branch, 'master');
    assert.equal(d.ctx.estimated, false);
});

test('the cache share is floored the way the extension floors it', () => {
    const d = term.clientData(client(), 1738400000);
    // 70000 of 100000 — and cachePct is a share of what is in the window, not
    // of the window's size.
    assert.equal(d.ctx.cachePct, 70);
});

test('a window with nothing in it reports no cache share rather than zero', () => {
    const d = term.clientData(client({
        context_window: { total_input_tokens: 0, context_window_size: 200000, used_percentage: 0, current_usage: {} },
    }), 1738400000);
    // -1 is what `pct()` in segments.js reads as "nothing to say"; 0 would print
    // "cache 0%" on a window that has not been used yet.
    assert.equal(d.ctx.cachePct, -1);
});

test('a limit percentage is not read a point low by binary rounding', () => {
    // The client multiplies its own fraction by 100, and 0.29 * 100 is
    // 28.999999999999996 in IEEE754 — a bare floor turns 29% into 28%. The same
    // three values bit statusline.sh, which is where the epsilon comes from.
    for (const [raw, want] of [[28.999999999999996, 29], [56.99999999999999, 57], [57.99999999999999, 58]]) {
        const d = term.clientData(client({
            rate_limits: { seven_day: { used_percentage: raw, resets_at: 1738857600 } },
        }), 1738400000);
        assert.equal(d.weekly.pct, want, `${raw} should read as ${want}%`);
    }
});

test('a fractional percentage is floored rather than rounded up', () => {
    const d = term.clientData(client(), 1738400000);
    // 41.2 is 41% used, not 42%: the bar must not claim spend that has not
    // happened.
    assert.equal(d.weekly.pct, 41);
    assert.equal(d.session.pct, 23);
});

test('both limit windows carry the reset the client reported', () => {
    const d = term.clientData(client(), 1738400000);
    assert.equal(d.weekly.reset, 1738857600);
    assert.equal(d.session.reset, 1738425600);
});

test('the pace and the bar are computed from the client limits', () => {
    const now = 1738857600 - 3 * 24 * 3600; // three days left in the week
    const d = term.clientData(client(), now);
    assert.ok(d.pace, 'a pace is forecast once the window has a reset');
    assert.equal(d.pace.plan, 57); // four of seven days elapsed
    assert.equal(d.pace.settled, true);
    assert.ok(d.bar.length > 0, 'the bar is drawn whenever there is a pace');
});

test('a session with no limits yet forecasts nothing instead of guessing', () => {
    const d = term.clientData(client({ rate_limits: {} }), 1738400000);
    assert.equal(d.weekly, null);
    assert.equal(d.session, null);
    assert.equal(d.pace, null);
    assert.equal(d.bar, '');
});

test('the money fields come from the cost block the client reports', () => {
    const d = term.clientData(client(), 1738400000);
    assert.equal(d.stats.cost, 12.5);
    assert.equal(d.stats.added, 156);
    assert.equal(d.stats.removed, 23);
    assert.equal(d.stats.durationMs, 7200000);
    // Two hours of wall clock against $12.50.
    assert.equal(d.stats.burn, 6.25);
    // Half an hour of API time in two hours of session.
    assert.equal(d.stats.apiPct, 25);
});

test('a session too short to divide reports no burn rate', () => {
    const d = term.clientData(client({
        cost: { total_cost_usd: 0.4, total_duration_ms: 30000, total_api_duration_ms: 12000 },
    }), 1738400000);
    // Under a minute the rate is noise: $0.40 in thirty seconds extrapolates to
    // $48/h and says nothing. statusline.sh uses the same one-minute floor.
    assert.equal(d.stats.burn, null);
});

test('the client settings reach the fields that print them', () => {
    const d = term.clientData(client(), 1738400000);
    assert.equal(d.settings.thinking, true);
    assert.equal(d.settings.outputStyle, 'Proactive');
    assert.equal(d.version.current, '2.1.245');
});

test('a payload with nothing in it yields a shape rather than a crash', () => {
    // Fields are null before the first reply completes, and the whole object can
    // be bare on the very first run of a session.
    const d = term.clientData({}, 1738400000);
    assert.equal(d.ctx, null);
    assert.equal(d.weekly, null);
    assert.equal(d.stats, null);
    assert.equal(d.now, 1738400000);
});

// --- the ANSI half -------------------------------------------------------

const seg = require('../segments');
const registry = seg.fields({ tok: (n) => `${Math.round(n / 1000)}k`, shortModel: (m) => m.replace(/^claude-/, '') });

const ESC = '\u001b[';
const RESET = '\u001b[0m';

// A week loud enough to paint, everything else as it comes.
const loudWeek = (over = {}) => client({
    rate_limits: { seven_day: { used_percentage: 91, resets_at: 1738857600 } },
    ...over,
});

test('a segment whose fields all came back empty is not printed at all', () => {
    // An empty line in a terminal status line is not invisible the way a hidden
    // status-bar item is: it takes a row and pushes the prompt up.
    const lines = term.renderLines(['{weekly}', '[~{cost}]'], term.clientData({}, 0), registry, { colour: false });
    assert.deepEqual(lines, []);
});

test('each template becomes its own line, in the order they were written', () => {
    const d = term.clientData(client(), 1738400000);
    const lines = term.renderLines(['✻ 7d {weekly}', '▤ {ctx}'], d, registry, { colour: false });
    assert.deepEqual(lines, ['✻ 7d 41%', '▤ 10%']);
});

test('a share past the alarm threshold is painted, and the paint is closed', () => {
    const d = term.clientData(loudWeek(), 1738400000);
    const [line] = term.renderLines(['7d {weekly}'], d, registry, { colour: true });
    assert.ok(line.startsWith(ESC), 'the line opens with an escape');
    // Without the reset the prompt drawn after it inherits the colour, and the
    // whole terminal stays red until something else resets it.
    assert.ok(line.endsWith(RESET), 'and closes with a reset');
    assert.ok(line.includes('91%'));
});

test('a quiet share is left unpainted rather than painted a third colour', () => {
    const d = term.clientData(client({
        rate_limits: { seven_day: { used_percentage: 12, resets_at: 1738857600 } },
    }), 1738400000);
    const [line] = term.renderLines(['7d {weekly}'], d, registry, { colour: true });
    assert.ok(!line.includes(ESC), 'nothing to warn about, nothing to paint');
});

test('colour is dropped entirely when the caller asks for none', () => {
    const d = term.clientData(loudWeek(), 1738400000);
    const [line] = term.renderLines(['7d {weekly}'], d, registry, { colour: false });
    assert.equal(line, '7d 91%');
});

test('a segment mixing a loud limit with a quiet context takes the loud one', () => {
    const d = term.clientData(loudWeek(), 1738400000);
    const [loud] = term.renderLines(['{weekly} {ctx}'], d, registry, { colour: true });
    const [quiet] = term.renderLines(['{ctx}'], d, registry, { colour: true });
    assert.ok(loud.includes(ESC), 'the week is alarming and the segment says so');
    assert.ok(!quiet.includes(ESC), 'the context alone is not');
});

test('a codicon in a template is dropped rather than printed as source', () => {
    // The default segments carry `$(gear)`, which the status bar renders as an
    // icon and a terminal renders as the four characters `$(ge`… — and the same
    // goes for any template written for the bar and reused here.
    const d = term.clientData(client(), 1738400000);
    const [line] = term.renderLines(['$(gear) 7d {weekly}'], d, registry, { colour: false });
    assert.equal(line, '7d 41%');
});

test('an escaped dollar survives, because it is not a codicon', () => {
    const d = term.clientData(client(), 1738400000);
    const [line] = term.renderLines(['cost $12 {weekly}'], d, registry, { colour: false });
    assert.equal(line, 'cost $12 41%');
});

test('a segment that is nothing but a codicon prints no line at all', () => {
    const d = term.clientData(client(), 1738400000);
    assert.deepEqual(term.renderLines(['$(gear)'], d, registry, { colour: false }), []);
});

test('the two tones are told apart by the escape they carry', () => {
    const warn = term.paint('x', 'warn');
    const alarm = term.paint('x', 'alarm');
    assert.notEqual(warn, alarm);
    assert.ok(warn.includes('x') && alarm.includes('x'));
    // No tone is no escape, not a default colour: the terminal's own foreground
    // is what the rest of the prompt is drawn in.
    assert.equal(term.paint('x', null), 'x');
});
