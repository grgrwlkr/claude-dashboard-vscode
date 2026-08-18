const test = require('node:test');
const assert = require('node:assert');
const status = require('../status');
const u = require('../usage');
const s = require('../session');
const { fmtCost } = require('../pricing');

const NOW = Math.floor(Date.parse('2026-08-10T12:00:00Z') / 1000);

const helpers = {
    fmtCost,
    fmtLeft: u.fmtLeft,
    fmtAbs: (ts) => u.fmtAbs(ts, NOW * 1000),
    fmtWhen: u.fmtWhen,
    fmtDuration: s.fmtDuration,
    tok: (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`),
    shortModel: (m) => String(m).replace(/^claude-/, ''),
};

const data = {
    now: NOW,
    limits: {
        session: { pct: 13, reset: NOW + 2 * 3600 },
        weekly: { pct: 52, reset: NOW + 2 * 86400 },
        scoped: [{ scope: 'Fable', pct: 1, reset: NOW + 2 * 86400 }],
        credits: { used: 103.67, limit: 0, pct: 0, enabled: false, reason: 'out_of_credits' },
    },
    weekly: { pct: 52, reset: NOW + 2 * 86400 },
    // `settled` is pace()'s own verdict on whether this window can be compared
    // against its plan yet — four and a half days in, it plainly can.
    pace: { plan: 61, elapsed: 400000, settled: true, dryAt: NOW + 4 * 86400, beforeReset: false },
    ctx: { pct: 52, tokens: 529000, window: 1e6, cachePct: 99, model: 'claude-opus-5', effort: 'xhigh', branch: 'master', estimated: false },
    compactPct: 97,
    settings: { thinking: true, thinkingSummaries: true, advisor: 'claude-fable-5', outputStyle: '' },
    version: { current: '2.1.226', latest: '' },
    stats: { cost: 148.46, burn: 4.54, messages: 322, durationMs: 3 * 3600000, apiPct: 6, added: 900, removed: 120 },
    todayUsd: 795.03,
    peers: { total: 2, busy: 1 },
    todo: { done: 3, total: 6, active: 'writing the parser' },
};

const rowsOf = (section, index = 0) =>
    section.blocks.filter((b) => b.kind === 'table')[index].rows;
const metersOf = (section) => section.blocks.find((b) => b.kind === 'meters').rows;
const notes = (section) => section.blocks.filter((b) => b.kind === 'note');
const text = (section) => JSON.stringify(section.blocks);

test('every section is data, with no markdown or icons baked into it', () => {
    const sections = status.statusSections(data, helpers, { stale: false, updatedAt: NOW });
    assert.deepEqual(sections.map((x) => x.id), ['limits', 'context', 'money', 'work']);
    for (const section of sections) {
        // Emphasis and codicons belong to whichever renderer wants them; a value
        // carrying "**" or "$(" here would arrive as literal text on the page.
        assert.ok(!text(section).includes('**'), `${section.id} carries markdown emphasis`);
        assert.ok(!text(section).includes('$('), `${section.id} carries a codicon`);
        for (const block of section.blocks) {
            assert.ok(['table', 'meters', 'subtitle', 'note'].includes(block.kind), `${section.id}: ${block.kind}`);
            if (block.kind === 'meters') {
                for (const row of block.rows) {
                    // The share travels as a number: a tooltip writes it with
                    // blocks, a page draws it as a bar, and neither can do that
                    // from "52%".
                    assert.equal(typeof row.pct, 'number', `${section.id}: ${row.label} has no share`);
                    assert.ok(row.pct >= 0 && row.pct <= 100, `${section.id}: ${row.label} is ${row.pct}`);
                    assert.equal(typeof row.value, 'string');
                }
            }
            if (block.kind === 'table') {
                for (const row of block.rows) assert.ok(row.every((c) => typeof c === 'string'));
                if (block.head) {
                    for (const row of block.rows) assert.equal(row.length, block.head.length);
                }
            }
        }
    }
});

test('the limits section reads every window and says which side of plan it is on', () => {
    const [limits] = status.statusSections(data, helpers, { stale: false, updatedAt: NOW });
    assert.deepEqual(metersOf(limits).map((r) => r.label), ['5h', '7d', 'fable']);
    assert.equal(metersOf(limits)[1].value, '52%');
    assert.equal(metersOf(limits)[1].pct, 52);
    // A per-model window that resets with the weekly one does not repeat the date.
    assert.equal(metersOf(limits)[2].note, '');

    const pace = notes(limits).find((n) => n.label === 'Pace');
    assert.match(pace.text, /52% spent, 61% of the window elapsed: 9% behind plan/);

    // The forecast lands past the reset, so it is stated as the reassurance it is.
    const forecast = notes(limits).find((n) => n.label === 'Forecast');
    assert.equal(forecast.tone, 'safe');
    assert.match(forecast.text, /after the reset: you do not get there/);
});

// The same guard as the glyph bar and the {drift} field, in the third place the
// comparison is written out.
test('a window too young to judge is not judged in words either', () => {
    const fresh = {
        ...data,
        weekly: { pct: 1, reset: NOW + 604800 - 600 },
        pace: { plan: 0, elapsed: 600, settled: false, dryAt: null, beforeReset: false },
    };
    const [limits] = status.statusSections(fresh, helpers, {});
    assert.equal(notes(limits).find((n) => n.label === 'Pace'), undefined, 'no verdict against a plan of zero');
    assert.equal(notes(limits).find((n) => n.label === 'Forecast'), undefined);
    // The windows themselves are still reported: what is missing is the opinion.
    assert.deepEqual(metersOf(limits).map((r) => r.label), ['5h', '7d', 'fable']);
});

test('a forecast that lands before the reset is the alarming one', () => {
    const soon = { ...data, pace: { ...data.pace, beforeReset: true, dryAt: NOW + 3600 } };
    const [limits] = status.statusSections(soon, helpers, {});
    const forecast = notes(limits).find((n) => n.label === 'Forecast');
    assert.equal(forecast.tone, 'alarm');
    assert.match(forecast.text, /before the window resets/);
});

test('the forecast carries the wait that follows it, and names an empty quota', () => {
    // The track draws two lengths — quota left, then the week without it. The
    // hover is the same answer in words, so it says both rather than a date.
    const soon = { ...data, pace: { ...data.pace, beforeReset: true, dryAt: NOW + 3600 } };
    const [limits] = status.statusSections(soon, helpers, {});
    assert.match(notes(limits).find((n) => n.label === 'Forecast').text, /then .+ without quota before the window resets/);

    // Spent: the forecast has collapsed onto now, and "100% around <now>" would
    // be a date for something that already happened.
    const spent = { ...data, pace: { ...data.pace, beforeReset: true, dryAt: NOW } };
    const [spentLimits] = status.statusSections(spent, helpers, {});
    const note = notes(spentLimits).find((n) => n.label === 'Forecast');
    assert.equal(note.tone, 'alarm');
    assert.match(note.text, /^out of quota — .+ until the window resets$/);
});

test('a stale cache says so, and the reading carries when it was taken', () => {
    const [limits] = status.statusSections(data, helpers, { stale: true, updatedAt: NOW });
    assert.ok(notes(limits).some((n) => n.tone === 'warn' && /refresh failed/.test(n.text)));
    assert.ok(notes(limits).some((n) => n.tone === 'muted' && /^updated /.test(n.text)));
});

test('the session section reports the thinking setting, not the last reply', () => {
    const sections = status.statusSections(data, helpers, {});
    const ctx = sections.find((x) => x.id === 'context');
    assert.equal(ctx.title, 'opus-5');
    assert.deepEqual(rowsOf(ctx).find((r) => r[0] === 'thinking'), ['thinking', 'on']);

    const hidden = { ...data, settings: { ...data.settings, thinkingSummaries: false } };
    const ctx2 = status.statusSections(hidden, helpers, {}).find((x) => x.id === 'context');
    assert.deepEqual(rowsOf(ctx2).find((r) => r[0] === 'thinking'), ['thinking', 'on · summaries hidden']);
});

// What the window is full of, in the same section the window meter lives in —
// which is what puts it on the Now tab and in the sidebar at once. The rows the
// transcript can weigh are estimates and say so; the rest of the window is one
// row that names what is inside it rather than claiming to be the conversation.
test('the context breakdown accounts for the whole window, unseparable parts included', () => {
    const parts = { skills: 8000, tools: 2000, agents: 5000, mcp: 2000, hooks: 1000 };
    const withParts = { ...data, contextParts: parts, memoryTokens: 20000 };
    const ctx = status.statusSections(withParts, helpers, {}).find((x) => x.id === 'context');
    const meters = ctx.blocks.filter((b) => b.kind === 'meters').flatMap((b) => b.rows);
    const by = Object.fromEntries(meters.map((r) => [r.label, r]));

    assert.ok(by.memory && by.skills && by.agents, 'the parts that can be weighed are rows');
    assert.ok(by.free, 'the rest of the window is a row of its own');
    const rest = by['rest in use'];
    assert.ok(rest, 'and what cannot be separated is one row, named for what is in it');
    assert.match(rest.note, /chat, system prompt, tool schemas/);
    // 529k in use, 38k of it named: the remainder is what is left.
    assert.equal(rest.tokens, data.ctx.tokens - 38000);

    // Every row is a share of the window, and together they are the whole of it —
    // the meter beside them is the same number from the other end.
    const parts2 = meters.filter((r) => r.label !== 'window');
    assert.equal(parts2.reduce((sum, r) => sum + r.tokens, 0), data.ctx.window);

    // Biggest first: a list of shares that is not sorted by share makes the eye
    // do the ranking, and the rows worth seeing are the largest ones. Free space
    // is the exception and sits last — it is what the others are measured
    // against, not one of them.
    assert.equal(parts2[parts2.length - 1].label, 'free');
    const pcts = parts2.slice(0, -1).map((r) => r.pct);
    assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a));

    // And every label fits one line beside its meter. The column is narrow in the
    // sidebar, where a two-word label wraps and pushes the rows apart.
    for (const row of parts2) {
        assert.ok(row.label.length <= 12, `"${row.label}" is too long for the label column`);
    }
    // The estimated rows carry a tilde; free space is exact and does not.
    assert.match(by.skills.value, /^~/);
    assert.doesNotMatch(by.free.value, /^~/);
});

test('an unpriced model is flagged where the money is stated', () => {
    const sections = status.statusSections(data, helpers, {});
    const money = sections.find((x) => x.id === 'money');
    assert.match(money.title, /^~\$148\.46 this session$/);
    assert.match(notes(money)[0].text, /estimated from public rates/);

    const unknown = { ...data, ctx: { ...data.ctx, model: 'claude-newthing-9' } };
    const money2 = status.statusSections(unknown, helpers, {}).find((x) => x.id === 'money');
    assert.match(notes(money2)[0].text, /no published rate/);
});

test('a waiting share of zero is still reported, unlike a missing one', () => {
    const idle = { ...data, stats: { ...data.stats, apiPct: 0 } };
    const money = status.statusSections(idle, helpers, {}).find((x) => x.id === 'money');
    assert.ok(rowsOf(money, 1).some((r) => r[0] === 'waiting on model'));

    const unknown = { ...data, stats: { ...data.stats, apiPct: -1 } };
    const money2 = status.statusSections(unknown, helpers, {}).find((x) => x.id === 'money');
    assert.ok(!rowsOf(money2, 1).some((r) => r[0] === 'waiting on model'));
});

test('the work section names itself once, whichever half of it exists', () => {
    // With no task list the neighbours are the section, so the title carries the
    // words and no subtitle repeats them.
    const peersOnly = { ...data, todo: null };
    const work = status.statusSections(peersOnly, helpers, {}).find((x) => x.id === 'work');
    assert.equal(work.title, 'Other sessions here');
    assert.equal(work.blocks.filter((b) => b.kind === 'subtitle').length, 0);

    // With both, the title counts the tasks and the neighbours get a subtitle.
    const both = status.statusSections(data, helpers, {}).find((x) => x.id === 'work');
    assert.equal(both.title, 'Tasks 3/6');
    assert.deepEqual(both.blocks.filter((b) => b.kind === 'subtitle').map((b) => b.text), ['Other sessions here']);
    assert.ok(both.blocks.some((b) => b.kind === 'note' && b.text === 'writing the parser'));
});

test('a task list is a share, and says so beside the count', () => {
    const work = status.statusSections(data, helpers, {}).find((x) => x.id === 'work');
    // The title counts the tasks; the meter is the only thing that says how much
    // of the list is behind you, so it is not a second copy of the count.
    assert.deepEqual(metersOf(work), [{ label: 'done', value: '50%', pct: 50, note: '' }]);

    // An empty list has no share to draw, and dividing by its length would say
    // NaN% in the hover and stretch the meter off the panel.
    const empty = { ...data, todo: { done: 0, total: 0, active: '' } };
    const work2 = status.statusSections(empty, helpers, {}).find((x) => x.id === 'work');
    assert.ok(!work2.blocks.some((b) => b.kind === 'meters'));
});

test('a section with nothing behind it is left out entirely', () => {
    assert.deepEqual(status.statusSections({}, helpers, {}), []);

    const limitsOnly = status.statusSections({ now: NOW, limits: data.limits, weekly: data.weekly }, helpers, {});
    assert.deepEqual(limitsOnly.map((x) => x.id), ['limits']);

    // A session with no task list and no neighbours has no work section, even
    // though the collector filled both fields with empty answers.
    const quiet = { ...data, todo: null, peers: { total: 0, busy: 0 } };
    assert.ok(!status.statusSections(quiet, helpers, {}).some((x) => x.id === 'work'));
});

// The one figure in this extension that is money rather than an estimate from
// public rates, and the only one that may not carry a tilde.
test('credits are stated as billed, and as spent when they have run out', () => {
    const [limits] = status.statusSections(data, helpers, {});
    const note = notes(limits).find((n) => n.label === 'Credits');
    assert.equal(note.tone, 'warn');
    assert.match(note.text, /\$103\.67 spent past the plan/);
    assert.match(note.text, /none left/);
    assert.ok(!note.text.includes('~'), 'a billed figure carries no tilde');

    const on = { ...data, limits: { ...data.limits, credits: { used: 12, limit: 50, pct: 24, enabled: true, reason: '' } } };
    const live = status.statusSections(on, helpers, {}).find((x) => x.id === 'limits');
    assert.match(notes(live).find((n) => n.label === 'Credits').text, /\$12\.00 spent past the plan of \$50\.00, 24%/);

    // No spend object, no note — an absent figure is not a zero.
    const none = { ...data, limits: { ...data.limits, credits: null } };
    const off = status.statusSections(none, helpers, {}).find((x) => x.id === 'limits');
    assert.ok(!notes(off).some((n) => n.label === 'Credits'));
});
