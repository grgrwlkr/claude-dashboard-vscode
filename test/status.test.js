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
            assert.ok(['table', 'meters', 'parts', 'gauge', 'pills', 'band', 'subtitle', 'note'].includes(block.kind), `${section.id}: ${block.kind}`);
            // Pills are the state of the section and are drawn beside its own
            // heading, so a section has at most one set and it comes first.
            if (block.kind === 'pills') {
                assert.equal(section.blocks.indexOf(block), 0, `${section.id}: pills are not the first block`);
                assert.equal(section.blocks.filter((b) => b.kind === 'pills').length, 1);
                for (const item of block.items) {
                    assert.equal(typeof item.text, 'string');
                    if (item.value !== undefined) assert.equal(typeof item.value, 'string');
                }
            }
            if (block.kind === 'band') {
                for (const fact of block.facts || []) assert.equal(typeof fact, 'string');
                if (block.chip) assert.equal(typeof block.chip.value, 'string');
            }
            if (block.kind === 'meters' || block.kind === 'parts') {
                for (const row of block.rows) {
                    // The share travels as a number: a tooltip writes it with
                    // blocks, a page draws it as a bar, and neither can do that
                    // from "52%".
                    assert.equal(typeof row.pct, 'number', `${section.id}: ${row.label} has no share`);
                    assert.ok(row.pct >= 0 && row.pct <= 100, `${section.id}: ${row.label} is ${row.pct}`);
                    assert.equal(typeof row.value, 'string');
                }
            }
            // A gauge is the total a `parts` block hangs under, so it carries
            // the same share-as-a-number contract plus the chips, which are
            // sentences and stay strings.
            // A gauge is the one figure its section exists for. `pct` may be
            // null — money is not a share of anything this extension knows —
            // but when it is a number it is what draws the track.
            if (block.kind === 'gauge') {
                assert.equal(typeof block.headline, 'string', `${section.id}: gauge has no headline`);
                assert.ok(block.pct === null || typeof block.pct === 'number', `${section.id}: ${block.pct}`);
                for (const chip of block.chips || []) assert.equal(typeof chip, 'string');
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
    // The week is the window that stops the work, so it is the gauge; the other
    // windows are rows under it. Drawn as three equal meters — which is what
    // this was — the one that matters is found by reading all three.
    const gauge = limits.blocks.find((b) => b.kind === 'gauge');
    assert.equal(gauge.headline, '52%');
    assert.equal(gauge.pct, 52);
    assert.equal(gauge.value, '7 days');
    assert.equal(gauge.plan, 61, 'the plan is a notch on the week, not a row');
    assert.deepEqual(metersOf(limits).map((r) => r.label), ['5h', 'fable']);
    // A per-model window that resets with the weekly one does not repeat the date.
    assert.equal(metersOf(limits)[1].note, '');

    // The verdict is the pill and the measurement is the note: one fact, one
    // place. Written in both they read as two findings that happen to agree.
    const pills = limits.blocks[0];
    assert.equal(pills.kind, 'pills');
    // The same two words and the same colours as the week track: spending
    // slower than the window elapses is `under` and is not a warning. Said as
    // "behind plan" and coloured warn, this panel and the track above it drew
    // the identical fact in opposite tones.
    assert.ok(pills.items.some((p) => p.text === '9% under' && p.tone === 'safe'));

    const pace = notes(limits).find((n) => n.label === 'Pace');
    assert.match(pace.text, /^52% spent, 61% of the window elapsed$/);
    assert.ok(!/behind plan/.test(pace.text), 'the verdict is not said twice');

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
    // The windows themselves are still reported: what is missing is the opinion,
    // and with it the notch — a plan of zero is not a mark worth drawing.
    assert.deepEqual(metersOf(limits).map((r) => r.label), ['5h', 'fable']);
    assert.equal(limits.blocks.find((b) => b.kind === 'gauge').plan, null);
    const pills = limits.blocks.find((b) => b.kind === 'pills');
    assert.ok(!pills.items.some((p) => /plan/.test(p.text)), 'no verdict, no verdict pill');
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
    // When the reading was taken is the footer of the panel, not a sentence
    // among the findings — every section ends in the same kind of line.
    const band = limits.blocks.find((b) => b.kind === 'band');
    assert.ok(band.facts.some((f) => /^updated /.test(f)));
});

test('the session section reports the thinking setting, not the last reply', () => {
    const sections = status.statusSections(data, helpers, {});
    const ctx = sections.find((x) => x.id === 'context');
    assert.equal(ctx.title, 'opus-5');
    // How the session is set up is state, not measurement: one line of pills
    // beside the model's name rather than four rows above the window itself.
    const pillOf = (section, text) => section.blocks[0].items.find((p) => p.text === text);
    assert.equal(pillOf(ctx, 'thinking').value, 'on');

    const hidden = { ...data, settings: { ...data.settings, thinkingSummaries: false } };
    const ctx2 = status.statusSections(hidden, helpers, {}).find((x) => x.id === 'context');
    assert.equal(pillOf(ctx2, 'thinking').value, 'on · summaries hidden');
});

// What the window is full of, in the same section the window meter lives in —
// which is what puts it on the Now tab and in the sidebar at once. The rows the
// transcript can weigh are estimates and say so; the rest of the window is one
// row that names what is inside it rather than claiming to be the conversation.
test('the context breakdown accounts for everything in use, unseparable parts included', () => {
    const parts = { skills: 8000, tools: 2000, agents: 5000, mcp: 2000, hooks: 1000 };
    const withParts = { ...data, contextParts: parts, memoryTokens: 20000 };
    const ctx = status.statusSections(withParts, helpers, {}).find((x) => x.id === 'context');
    const gauge = ctx.blocks.find((b) => b.kind === 'gauge');
    const group = ctx.blocks.find((b) => b.kind === 'parts');
    const by = Object.fromEntries(group.rows.map((r) => [r.label, r]));

    // A total and its parts are two kinds of fact and are two kinds of block.
    // Drawn as one run of meters — which is what this was — the window read as
    // one more component of itself, and free space as a component of the window.
    assert.equal(ctx.blocks.filter((b) => b.kind === 'gauge').length, 1);
    assert.equal(ctx.blocks.filter((b) => b.kind === 'parts').length, 1);
    assert.equal(gauge.headline, `${data.ctx.pct}%`);
    assert.equal(gauge.value, '529k / 1.0M');
    // The share still travels — it is what turns the headline red as the window
    // fills — but this gauge draws no track: the breakdown's colour bar under it
    // is the same measurement, and two bars of one number stacked on each other
    // is the repetition this layout exists to remove.
    assert.equal(gauge.pct, data.ctx.pct);
    assert.equal(gauge.bar, false);

    // Free space and what came from cache qualify the window and nothing else,
    // so they ride beside the figure rather than as rows among the parts; where
    // auto-compact waits qualifies the breakdown and sits on its caption.
    assert.ok(!by.free, 'free space is not one of the parts');
    assert.match(gauge.sub, /free/);
    assert.match(gauge.sub, /cached/);
    assert.match(group.figure, /compact/);
    assert.ok(!ctx.blocks.some((b) => b.kind === 'table'), 'nothing here is a table any more');

    assert.ok(by.memory && by.skills && by.agents, 'the parts that can be weighed are rows');
    const rest = by['rest in use'];
    assert.ok(rest, 'and what cannot be separated is one row, named for what is in it');
    assert.equal(rest.note, 'chat, system prompt, tool schemas');
    // 529k in use, 38k of it named: the remainder is what is left.
    assert.equal(rest.tokens, data.ctx.tokens - 38000);

    // The rows add up to what is in use — not to the window, which is the gauge
    // above them and holds the free space they are missing.
    assert.equal(group.rows.reduce((sum, r) => sum + r.tokens, 0), data.ctx.tokens);

    // The caption carries what this setup costs every prompt: the one figure
    // here anybody can act on, and the sum of six rows nobody should have to add.
    assert.match(group.figure, /^your setup ~[\d.]+%/);

    // Biggest first: a list of shares that is not sorted by share makes the eye
    // do the ranking, and the rows worth seeing are the largest ones.
    const pcts = group.rows.map((r) => r.pct);
    assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a));

    // Size and share are separate fields, because they are separate columns: the
    // size is the number to act on and the share is what the fill draws.
    assert.equal(by.memory.figure, '20k');
    assert.match(by.memory.value, /^~/);

    // And every label fits one line. The column is narrow in the sidebar, where
    // a two-word label wraps and pushes the rows apart.
    for (const row of group.rows) {
        assert.ok(row.label.length <= 12, `"${row.label}" is too long for the label column`);
    }
});

// The gauge gives up its track because the breakdown draws the same measurement
// in colour underneath. When there is no breakdown — an unreadable transcript, a
// window of zero — the panel would be a percentage floating over nothing.
test('the window keeps a bar of its own when there is no breakdown to draw one', () => {
    const noParts = { ...data, contextParts: null };
    const ctx = status.statusSections(noParts, helpers, {}).find((x) => x.id === 'context');
    const gauge = ctx.blocks.find((b) => b.kind === 'gauge');
    assert.ok(!ctx.blocks.some((b) => b.kind === 'parts'), 'nothing was weighed');
    assert.equal(gauge.bar, true, 'so the gauge draws its own track');
    assert.equal(gauge.pct, data.ctx.pct);
});

test('an unpriced model is flagged where the money is stated', () => {
    const sections = status.statusSections(data, helpers, {});
    const money = sections.find((x) => x.id === 'money');
    // The figure is the gauge, not the heading: a panel titled with its own
    // answer has nowhere left to put the answer.
    assert.equal(money.title, 'Spend');
    assert.equal(money.blocks.find((b) => b.kind === 'gauge').headline, '~$148.46');
    const bandOf = (section) => section.blocks.find((b) => b.kind === 'band');
    assert.match(bandOf(money).facts[0], /estimated from public rates/);

    const unknown = { ...data, ctx: { ...data.ctx, model: 'claude-newthing-9' } };
    const money2 = status.statusSections(unknown, helpers, {}).find((x) => x.id === 'money');
    assert.match(bandOf(money2).facts[0], /no published rate/);
});

test('a waiting share of zero is still reported, unlike a missing one', () => {
    const idle = { ...data, stats: { ...data.stats, apiPct: 0 } };
    const money = status.statusSections(idle, helpers, {}).find((x) => x.id === 'money');
    assert.ok(rowsOf(money, 0).some((r) => r[0] === 'waiting on model'));

    const unknown = { ...data, stats: { ...data.stats, apiPct: -1 } };
    const money2 = status.statusSections(unknown, helpers, {}).find((x) => x.id === 'money');
    assert.ok(!rowsOf(money2, 0).some((r) => r[0] === 'waiting on model'));
});

test('the work section names itself once, whichever half of it exists', () => {
    // With no task list the neighbours are the section, so the title carries the
    // words and nothing inside repeats them.
    const peersOnly = { ...data, todo: null };
    const work = status.statusSections(peersOnly, helpers, {}).find((x) => x.id === 'work');
    assert.equal(work.title, 'Other sessions here');
    assert.equal(work.blocks.filter((b) => b.kind === 'subtitle').length, 0);
    assert.ok(!work.blocks.some((b) => b.kind === 'gauge'), 'no list, no count');

    // With both, the count is the gauge and the neighbours are pills: a title
    // that answers its own panel leaves the panel with nothing to say.
    const both = status.statusSections(data, helpers, {}).find((x) => x.id === 'work');
    assert.equal(both.title, 'Tasks');
    assert.equal(both.blocks.find((b) => b.kind === 'gauge').headline, '3/6');
    assert.deepEqual(both.blocks[0].items.map((p) => p.text), ['2 sessions', '1 busy']);
    assert.ok(both.blocks.some((b) => b.kind === 'note' && b.text === 'writing the parser'));
});

test('a task list is a share, and says so beside the count', () => {
    const work = status.statusSections(data, helpers, {}).find((x) => x.id === 'work');
    // The count is the figure and the share stands beside it — one gauge rather
    // than a title counting the tasks and a meter under it saying the same thing
    // from the other end.
    const gauge = work.blocks.find((b) => b.kind === 'gauge');
    assert.equal(gauge.headline, '3/6');
    assert.equal(gauge.value, '50% done');
    assert.equal(gauge.sub, '3 left');
    assert.equal(gauge.pct, 50);

    // An empty list has no share to draw, and dividing by its length would say
    // NaN% in the hover and stretch the meter off the panel.
    const empty = { ...data, todo: { done: 0, total: 0, active: '' } };
    const work2 = status.statusSections(empty, helpers, {}).find((x) => x.id === 'work');
    assert.ok(!work2.blocks.some((b) => b.kind === 'gauge'));
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
    assert.match(note.text, /none are left/);
    // The switch itself is the pill, and the note no longer repeats it: said in
    // both places it read as two findings that happen to agree.
    assert.ok(!/credits are off/.test(note.text), 'the note states the money, the pill states the switch');
    assert.ok(limits.blocks[0].items.some((p) => p.text === 'credits off' && p.tone === 'warn'));
    assert.ok(!note.text.includes('~'), 'a billed figure carries no tilde');

    const on = { ...data, limits: { ...data.limits, credits: { used: 12, limit: 50, pct: 24, enabled: true, reason: '' } } };
    const live = status.statusSections(on, helpers, {}).find((x) => x.id === 'limits');
    assert.match(notes(live).find((n) => n.label === 'Credits').text, /\$12\.00 spent past the plan of \$50\.00, 24%/);

    // No spend object, no note — an absent figure is not a zero.
    const none = { ...data, limits: { ...data.limits, credits: null } };
    const off = status.statusSections(none, helpers, {}).find((x) => x.id === 'limits');
    assert.ok(!notes(off).some((n) => n.label === 'Credits'));
});

// --- the verdict follows the weighted plan --------------------------------
// `plan` is a fact about the clock and stays one. What spend is judged against
// is `planW`, the same window read through the hours the person actually works
// in. Where no profile exists the two are equal and none of this shows.
test('spend is judged against the weighted plan, not the elapsed share', () => {
    const weighted = {
        ...data,
        pace: { ...data.pace, plan: 61, planW: 48, weighted: true },
    };
    const [limits] = status.statusSections(weighted, helpers, {});
    const pills = limits.blocks.find((b) => b.kind === 'pills');
    // 52% spent against a plan of 48% is 4% over — against the elapsed 61% it
    // would have read "9% under", the opposite verdict in the opposite colour.
    assert.ok(pills.items.some((p) => p.text === '4% over'), JSON.stringify(pills.items));
    assert.ok(!pills.items.some((p) => /under/.test(p.text)));
});

test('the pace note names the plan and keeps the clock beside it', () => {
    const weighted = {
        ...data,
        pace: { ...data.pace, plan: 61, planW: 48, weighted: true },
    };
    const pace = notes(status.statusSections(weighted, helpers, {})[0]).find((n) => n.label === 'Pace');
    assert.match(pace.text, /^52% spent, plan 48% \(window 61% elapsed\)$/);
});

test('without a profile the pace note is word for word what it was', () => {
    const flat = { ...data, pace: { ...data.pace, planW: 61, weighted: false } };
    const pace = notes(status.statusSections(flat, helpers, {})[0]).find((n) => n.label === 'Pace');
    assert.match(pace.text, /^52% spent, 61% of the window elapsed$/);
});

test('the drawing half of the payload carries both plans', () => {
    const weighted = { ...data, pace: { ...data.pace, plan: 61, planW: 48, weighted: true } };
    const m = status.statusMetrics(weighted).weekly;
    assert.equal(m.plan, 61);
    assert.equal(m.planW, 48);
    assert.equal(m.weighted, true);
});

test('the gauge mark is the plan the verdict is measured against', () => {
    // One tooltip may not hold two answers: a mark at 61% beside a verdict that
    // says 4% over a plan of 48% is the same contradiction the rail just lost.
    const weighted = { ...data, pace: { ...data.pace, plan: 61, planW: 48, weighted: true } };
    const [limits] = status.statusSections(weighted, helpers, {});
    assert.equal(limits.blocks.find((b) => b.kind === 'gauge').plan, 48);
});
