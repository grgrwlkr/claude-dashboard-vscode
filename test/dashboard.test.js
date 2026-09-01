const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../dashboard');
const ix = require('../indexer');
const wf = require('../workflows');

function bucket(cost, msgs = 1, extra = {}) {
    return {
        in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
        cw1h: 0, cw5m: 0, saved: 0, cost, msgs, ...extra,
    };
}

test('esc neutralises markup coming from paths and branch names', () => {
    assert.equal(db.esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(db.esc('feature/"quoted"&odd'), 'feature/&quot;quoted&quot;&amp;odd');
    assert.equal(db.esc(null), '');
});

test('tok scales units and does not print 1.0M', () => {
    assert.equal(db.tok(0), '0');
    assert.equal(db.tok(940), '940');
    assert.equal(db.tok(12500), '13k');
    assert.equal(db.tok(2_400_000), '2.4M');
    assert.equal(db.tok(3_000_000_000), '3.0B');
});

test('shortModel strips the vendor prefix and any date snapshot', () => {
    assert.equal(db.shortModel('claude-opus-5'), 'opus 5');
    assert.equal(db.shortModel('claude-haiku-4-5-20251001'), 'haiku 4.5');
    assert.equal(db.shortModel('claude-sonnet-4-6'), 'sonnet 4.6');
    assert.equal(db.shortModel(''), 'unknown');
});

// A provider spells the same model its own way, and a row labelled
// `us.anthropic.claude-opus-5-v1:0` is unreadable at chip size next to one
// labelled `opus 5` — worse, the two read as different models in the same
// legend. The label follows the same normalisation the rate does.
test('shortModel reads a provider-format id as the model it names', () => {
    assert.equal(db.shortModel('us.anthropic.claude-opus-5-v1:0'), 'opus 5');
    assert.equal(db.shortModel('anthropic.claude-sonnet-5'), 'sonnet 5');
    assert.equal(db.shortModel('claude-haiku-4-5@20251001'), 'haiku 4.5');
    assert.equal(db.shortModel('my-gateway/claude-opus-5'), 'opus 5');
});

test('fmtDur reads as minutes, hours or days', () => {
    assert.equal(db.fmtDur(0), '—');
    assert.equal(db.fmtDur(90 * 1000), '2m');
    assert.equal(db.fmtDur(3 * 3600 * 1000), '3h0m');
    assert.equal(db.fmtDur(50 * 3600 * 1000), '2d2h');
});

test('charts render something for empty input instead of throwing', () => {
    assert.match(db.stackedDays({}, [], {}), /No activity/);
    assert.match(db.heatmap({}), /No activity/);
    assert.match(db.barList([]), /Nothing here/);
    assert.match(db.hourChart({}), /Nothing here/);
});

test('stackedDays draws one rect per model per day and labels them', () => {
    const days = { '2026-08-07': bucket(10), '2026-08-08': bucket(30) };
    const dayModels = {
        '2026-08-07': { 'claude-opus-5': 10 },
        '2026-08-08': { 'claude-opus-5': 20, 'claude-fable-5': 10 },
    };
    const svg = db.stackedDays(days, ['claude-opus-5', 'claude-fable-5'], dayModels);
    assert.equal((svg.match(/<rect /g) || []).length, 3);
    // Day first, month second — 7 August, the way every other date on the page
    // and in the bar is written.
    assert.match(svg, /07\.08/);
    assert.ok(!/08\.07/.test(svg), 'the axis is not writing the American order');
    // The axis runs in round steps up to the first one clearing the data — a
    // busiest day of $30 gets 0/10/20/30, not four quarters of 30.
    assert.match(svg, /class="grid"/);
    for (const tick of ['$0', '$10.00', '$20.00', '$30.00']) {
        assert.ok(svg.includes(`>${tick}<`), `no ${tick} on the axis`);
    }
    assert.ok(!/\$7\.50/.test(svg), 'the axis quartered the data instead of stepping');
});

test('heatmap keeps cells inside the calendar and never runs past today', () => {
    // The clock is passed in rather than read twice. Reading it here and again
    // inside heatmap() put the two on different days across midnight, and the
    // test's own day landed in the future the grid refuses to draw.
    const now = Date.parse('2026-08-08T12:00:00');
    const day = (offset) => {
        const d = new Date(now);
        d.setDate(d.getDate() + offset);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };

    const svg = db.heatmap({ [day(0)]: bucket(5) }, { now });
    // Day cells only: the scale's own swatches are `hm key l#`.
    const cells = (svg.match(/class="hm l/g) || []).length;
    assert.ok(cells > 100 && cells <= 27 * 7, `unexpected cell count: ${cells}`);
    assert.match(svg, /l4/); // the only day with spend is the darkest level
    assert.ok(svg.includes(`<title>${day(0)} `), 'today has a cell of its own');

    // A day past today is not drawn at all, whatever it cost — which is the
    // half of the name the old assertion never actually checked.
    const ahead = db.heatmap({ [day(1)]: bucket(5) }, { now });
    assert.ok(!ahead.includes(`<title>${day(1)} `), 'tomorrow was given a cell');
    assert.ok(!/class="hm l4/.test(ahead), 'a future day coloured the calendar');

    // The scale is drawn whatever the data, and says what its darkest step is
    // worth — without that the shading is a texture with no unit.
    assert.match(svg, /class="hm key l4"/);
    assert.match(svg, /less/);
    assert.match(svg, /more · up to \$5\.00 a day/);
});

test('barList sorts by the caller and caps the list', () => {
    const entries = [['a', bucket(10)], ['b', bucket(5)], ['c', bucket(1)]];
    const html = db.barList(entries, { limit: 2 });
    assert.equal((html.match(/<tr>/g) || []).length, 2);
    assert.match(html, /width:100\.0%/); // the largest entry fills the track
    assert.ok(!html.includes('>c<'));
});

// A model the price table has never heard of is billed at the FALLBACK rate,
// which is the Opus rate — so the figure is a guess, and it carries the tilde
// every other estimate on this page carries. `<synthetic>` is not a model at
// all: it is what Claude Code writes in place of a reply that never arrived —
// a limit, a dropped connection, a 403 — so it is not a row among models.
test('a model with no published rate is a guess, and the refusal log is not a model', () => {
    const total = ix.summarize(demoIndex());
    total.models = {
        'claude-opus-5': bucket(128.4, 10, { in: 1000 }),
        'claude-newthing-9': bucket(3.02, 5, { in: 500 }),
        '<synthetic>': bucket(0, 135),
    };
    const order = Object.keys(total.models);
    db.assignModelColors(order);
    const html = db.overviewTab(total, {}, order);

    assert.match(html, /~\$3\.02/);
    assert.doesNotMatch(html, /~\$128\.40/);
    assert.match(html, /no published rate/);
    assert.doesNotMatch(html, /synthetic/);
});

// The Models tab draws its own breakdown — model against effort tier — from a
// different aggregate, so hiding the refusal log on Overview alone left it a
// row here. One rule, both tables.
test('the refusal log is not a row in the effort matrix either', () => {
    const m = db.effortMatrix({
        [ix.effortKey('claude-opus-5', 'xhigh')]: bucket(10),
        [ix.effortKey('<synthetic>', '')]: bucket(0, 135),
    });
    assert.deepEqual(m.models, ['claude-opus-5']);
});

// The week bar. Positions on it are timestamps rather than fractions: the rail
// is the window, so everything on it — the fill, the marks, the day cells — is
// placed from the same two dates.
const WEEK_S = 604800;
const NOON = Math.floor(new Date('2026-08-10T12:00:00').getTime() / 1000);
// Opened Monday noon, four days in, 62% spent against a plan of 57%.
const week = (over = {}) => ({
    pct: 62, plan: 57, opened: NOON, reset: NOON + WEEK_S, at: NOON + 4 * 86400,
    dryAt: NOON + 5.5 * 86400, ranOut: null, ranOutPlan: null, ...over,
});
const widthOf = (html, cls) => {
    const m = html.match(new RegExp(`class="${cls}[^"]*"[^>]*style="[^"]*width:([\\d.]+)%`));
    return m ? Number(m[1]) : null;
};
const leftOf = (html, cls) => {
    const m = html.match(new RegExp(`class="${cls}[^"]*"[^>]*style="left:([\\d.]+)%`));
    return m ? Number(m[1]) : null;
};

test('the bar puts spend and time on one axis, so the gap between them is the overspend', () => {
    // 62% spent, 57% of the week elapsed: the fill runs to the plan, the excess
    // covers exactly the five points between them, and the mark stands at the
    // share of the window that has passed — four days of seven.
    const html = db.paceTrack(week());
    // Four days of seven is 57.14% of the rail, and every edge here is that
    // same number: the fill stops at the mark, the excess starts at it. Drawn to
    // the printed `plan 57%` instead, the zone would end four pixels short of
    // the line it is measured against.
    assert.equal(widthOf(html, 'wk-spent'), 57.14);
    assert.equal(leftOf(html, 'wk-excess'), 57.14);
    assert.equal(widthOf(html, 'wk-excess'), 4.86);
    assert.equal(Math.round(leftOf(html, 'wk-now')), Math.round((4 / 7) * 100));
    // The verdict is two pills rather than a sentence, and the rail carries no
    // text at all: the figure that used to sit on the fill said in words what
    // the fill was already showing.
    assert.match(html, /class="pill">62% spent</);
    assert.match(html, /class="pill pill-warn">5% over</);
    assert.ok(!html.includes('wk-in'), 'the rail holds no figures');
    assert.ok(!html.includes('wk-slack'), 'nothing is under the plan here');
});

test('under the plan the gap is drawn the other way and signed the other way', () => {
    const html = db.paceTrack(week({ pct: 40 }));
    assert.equal(widthOf(html, 'wk-spent'), 40);
    assert.equal(leftOf(html, 'wk-slack'), 40);
    assert.equal(widthOf(html, 'wk-slack'), 17.14, 'the gap reaches the mark, not the rounded figure');
    assert.match(html, /class="pill pill-safe">17% under</);
    assert.ok(!html.includes('wk-excess'));
});

test('the forecast is stated in every state, and only stands on the rail when it lands on it', () => {
    // Inside the window: a mark on the rail, and a pill wearing that mark's
    // colour — which is what lets the caption above the rail go. Both the time
    // to it and the day it lands on ride in the pill, said once.
    const soon = db.paceTrack(week());
    assert.match(soon, /class="pill pill-alarm"><i class="pill-dot" style="background:var\(--vscode-charts-red/);
    assert.match(soon, /dry in 1d12h → Sun 16\.08, ~00h/);
    assert.equal(soon.match(/Sun 16\.08, ~00h/g).length, 1, 'the forecast is stated once, not in a foot as well');
    assert.match(soon, /class="wk-dry"/, 'and the rail carries the mark it names');

    // Past the reset: no position on this rail, so no dot either — a colour
    // pointing at nothing is worse than no colour, and not running out is not an
    // alarm.
    const far = db.paceTrack(week({ pct: 20, dryAt: NOON + 20 * 86400 }));
    assert.match(far, /class="pill pill-safe">dry Sun 30\.08, ~12h, after the reset</);
    assert.ok(!far.includes('class="wk-dry"'), 'a forecast off the rail draws no line on it');

    // Too early to say anything: the pace module hands over no date at all.
    const early = db.paceTrack(week({ pct: 1, dryAt: null }));
    assert.match(early, /class="pill pill-muted">too early to forecast</);
});

test('out of quota the bar stops forecasting and states the moment it happened', () => {
    const ranOut = (NOON + 3 * 86400) * 1000;
    const html = db.paceTrack(week({ pct: 100, plan: 57, ranOut, ranOutPlan: 43 }));

    // The recorded moment, not the present: the forecast at 100% is `now`
    // forever, which is the reason the moment is written down at all.
    assert.match(html, /ran out Thu 13\.08, ~12h/);
    assert.equal(Math.round(leftOf(html, 'wk-dry')), Math.round((3 / 7) * 100));
    // And `now` keeps moving, which is what says how long the wait has been.
    assert.equal(Math.round(leftOf(html, 'wk-now')), Math.round((4 / 7) * 100));
    assert.ok(!/runs out/.test(html), 'nothing left to forecast');
    // How long the wait has been is the foot's business — `resets … · in 3d0h`
    // — and the pill states what happened rather than repeating it.
    assert.match(html, /in 3d0h/);
});

test('out of quota with nothing recorded says so rather than pointing at now', () => {
    const html = db.paceTrack(week({ pct: 100, ranOut: null }));
    assert.match(html, />out of quota</);
    assert.ok(!html.includes('ran out'), 'no date is invented for a moment nobody wrote down');
    assert.ok(!html.includes('class="wk-dry"'), 'and no line stands where it did not happen');
});

test('the cells are calendar days, named as far as each one has room for', () => {
    const html = db.paceTrack(week());
    // A window opened at noon has seven midnights inside it, so eight cells:
    // two half days at the ends and six whole ones between them.
    assert.equal((html.match(/class="wk-date/g) || []).length, 8);
    assert.match(html, /class="wk-date"[^>]*>Tue 11\.08</);
    // Half a day is 7.1% of the rail — under the width the full label needs, so
    // it drops a step rather than being cut by the edge.
    assert.match(html, /class="wk-date"[^>]*>Mon 10</);
    // Today is the cell `at` falls in, and it is the one drawn bold.
    assert.match(html, /class="wk-date today"[^>]*>Fri 14\.08</);
});

test('a day tick that would sit under a mark is dropped rather than smeared', () => {
    // `at` on the stroke of midnight: the day boundary and the plan mark are the
    // same position, and two lines there read as one thick dirty one.
    const html = db.paceTrack(week({ at: NOON + 3.5 * 86400 }));
    const ticks = (html.match(/class="wk-day"/g) || []).length;
    assert.equal(ticks, 5, 'six boundaries, one of them under the mark');
});

test('dayModelMatrix splits a file across its days without inventing spend', () => {
    const index = {
        files: {
            '/x.jsonl': {
                agg: {
                    days: { '2026-08-07': bucket(30), '2026-08-08': bucket(10) },
                    models: { 'claude-opus-5': bucket(40) },
                    branches: {}, skills: {}, hours: {}, sessions: [], prompts: null,
                },
            },
        },
    };
    const m = db.dayModelMatrix(index);
    assert.ok(Math.abs(m['2026-08-07']['claude-opus-5'] - 30) < 1e-9);
    assert.ok(Math.abs(m['2026-08-08']['claude-opus-5'] - 10) < 1e-9);
});

function demoIndex(over = {}) {
    return {
        files: {
            '/x.jsonl': {
                agg: {
                    days: { '2026-08-08': bucket(5, 1, { in: 100, out: 50, cacheRead: 900, cacheWrite: 400, cw1h: 300, cw5m: 100, saved: 4 }) },
                    models: { 'claude-opus-5': bucket(5, 1, { in: 100, out: 50, cacheRead: 900, cacheWrite: 400, cw1h: 300, cw5m: 100, saved: 4 }) },
                    branches: { '<b>main': bucket(5) },
                    skills: {},
                    hours: { 14: bucket(5) },
                    efforts: { [ix.effortKey('claude-opus-5', 'xhigh')]: bucket(5, 1, { out: 50 }) },
                    entrypoints: { cli: bucket(5) },
                    speeds: { standard: bucket(5) },
                    tools: { Bash: { calls: 9, errors: 2, denials: 1 }, 'mcp__qmd__query': { calls: 3, errors: 0, denials: 0 } },
                    friction: {
                        toolErrors: 2, denials: { 'user-rejected': 1 }, interrupts: 0, hookErrors: 0,
                        shutdowns: 1, compactions: { auto: 2 }, droppedTokens: 40000, compactMs: 60000,
                    },
                    sessions: [{
                        id: 'sess', kind: 'main', project: '<img src=x>', slug: 's', title: '<i>titled</i>',
                        entrypoint: 'cli', start: 1, end: 2, msgs: 3, cost: 5, tokens: 10, out: 50,
                        cacheRead: 900, cacheWrite: 400, tools: 9, errors: 2,
                        models: ['claude-opus-5'], efforts: ['xhigh'], branch: 'main', agentId: '', workflowId: '',
                    }],
                    prompts: { count: 2, chars: 100, longest: 80, byHour: { 14: 2 }, bySource: { typed: 2 }, words: { hello: 3 }, lens: { 0: 2 } },
                    ...over,
                },
            },
        },
    };
}

// Setup used to carry ten tabs while the other sections carried one, four, five
// and four — and half of those ten were not settings at all but observation:
// which sessions are alive, what the background jobs are doing, what is on disk.
// Splitting on that line puts both halves back in the range the rest live in,
// and gives the extension's own settings room to separate from what it launches
// the client with.
test('Setup holds what is set up and Machine holds what is merely happening', () => {
    const ids = Object.fromEntries(db.SECTIONS.map(([id, , items]) => [id, items.map(([t]) => t)]));

    assert.deepEqual(ids.setup, ['settings', 'launch', 'client', 'context', 'health', 'changelog']);
    assert.deepEqual(ids.machine, ['live', 'jobs', 'tasks', 'disk']);

    // Machine comes last, after Setup: it is where you look when something is
    // wrong, not where you go to set something up.
    const order = db.SECTIONS.map(([id]) => id);
    assert.deepEqual(order, ['now', 'spend', 'work', 'efficiency', 'setup', 'machine']);

    // No tab was lost or duplicated by the move.
    const all = db.SECTIONS.flatMap(([, , items]) => items.map(([t]) => t));
    assert.equal(new Set(all).size, all.length, 'a tab id appears in two sections');
    for (const id of ['settings', 'health', 'jobs', 'live', 'tasks', 'disk', 'context', 'client', 'changelog']) {
        assert.ok(all.includes(id), `${id} went missing in the split`);
    }
    assert.ok(all.includes('launch'), 'launch is the one tab this adds');

    // And every section is now within one of the others in size — the imbalance
    // that made Setup unreadable is what this test is really about.
    const sizes = db.SECTIONS.map(([, , items]) => items.length);
    assert.ok(Math.max(...sizes) <= 6, `a section carries ${Math.max(...sizes)} tabs`);
});

test('render produces one pane per tab and escapes hostile project names', () => {
    const index = demoIndex();
    const total = ix.summarize(index);
    const html = db.render(index, total, { files: 1, lastRun: Date.now(), history: [] });

    const tabCount = db.SECTIONS.reduce((a, [, , items]) => a + items.length, 0);
    assert.equal((html.match(/role="tab"/g) || []).length, tabCount);
    assert.equal((html.match(/class="tab"/g) || []).length, tabCount);
    assert.ok(!html.includes('<img src=x>'), 'a project name must not reach the DOM raw');
    assert.ok(!html.includes('<b>main'), 'a branch name must not reach the DOM raw');
    assert.ok(!html.includes('<i>titled</i>'), 'a session title must not reach the DOM raw');
    assert.match(html, /Content-Security-Policy/);
    assert.ok(!/undefined|NaN/.test(html), 'no placeholder leaked into the page');
});

test('only the first section is on screen, and every tab belongs to one', () => {
    const html = db.navHtml();
    const shown = [...html.matchAll(/<button role="tab" data-tab="([^"]+)" data-section="([^"]+)"([^>]*)>/g)];
    assert.equal(shown.length, db.SECTIONS.reduce((a, [, , items]) => a + items.length, 0));
    // Whichever section leads the list is the one on screen, and every visible
    // tab belongs to it — the assertion follows SECTIONS rather than naming a
    // section, so reordering them cannot leave this passing while the page opens
    // on a pane whose tab is hidden.
    const [leadId, , leadTabs] = db.SECTIONS[0];
    const visible = shown.filter((m) => !m[3].includes('hidden'));
    // A section with one tab draws no tab row: the section button is the label,
    // and a lone tab under it repeats the word and answers no question.
    const expected = leadTabs.length === 1 ? [] : Array(leadTabs.length).fill(leadId);
    assert.deepEqual(visible.map((m) => m[2]), expected);
    // The selected tab is still marked even when its row is not drawn — opening
    // the page has to leave exactly one pane on screen either way.
    assert.equal((html.match(/aria-selected="true"/g) || []).length, 2);
});

test('a section holding one tab draws no tab row', () => {
    const html = db.navHtml();
    const [leadId, , leadTabs] = db.SECTIONS[0];
    if (leadTabs.length === 1) {
        assert.match(html, /nav class="tabs empty"/);
        // The pane is still selected, so the page is not blank.
        assert.match(html, new RegExp(`data-tab="${leadTabs[0][0]}"[^>]*aria-selected="true"`));
    }
    // A section with several tabs keeps its row.
    const many = db.SECTIONS.find(([, , items]) => items.length > 1);
    assert.ok(many, 'the dashboard still has a multi-tab section');
});

test('the page survives an index with none of the new dimensions in it', () => {
    // An aggregate written before those fields existed: the version guard makes
    // this unlikely, but a half-written index must degrade, not throw.
    const index = demoIndex();
    const agg = index.files['/x.jsonl'].agg;
    delete agg.efforts; delete agg.entrypoints; delete agg.speeds;
    delete agg.tools; delete agg.friction;
    const total = ix.summarize(index);
    const html = db.render(index, total, { files: 1, lastRun: Date.now(), history: null });
    assert.match(html, /No tool calls recorded/);
    assert.ok(!/undefined|NaN/.test(html));
});

test('effortMatrix orders tiers by depth and keeps a missing effort visible', () => {
    const efforts = {
        [ix.effortKey('claude-opus-5', 'xhigh')]: bucket(30),
        [ix.effortKey('claude-opus-5', 'low')]: bucket(5),
        [ix.effortKey('claude-fable-5', '')]: bucket(10),
    };
    const m = db.effortMatrix(efforts);
    assert.deepEqual(m.tiers, ['low', 'xhigh', 'not sent']);
    assert.deepEqual(m.models, ['claude-opus-5', 'claude-fable-5']); // by spend
    assert.equal(m.get('claude-opus-5', 'xhigh').cost, 30);
    assert.equal(m.get('claude-fable-5', 'xhigh'), null);
});

test('mcpServer reads the server out of a tool name, and only for MCP tools', () => {
    assert.equal(db.mcpServer('mcp__qmd__query'), 'qmd');
    assert.equal(db.mcpServer('mcp__n8n-mcp__get_node'), 'n8n-mcp');
    assert.equal(db.mcpServer('mcp__claude_ai_Gmail__get_message'), 'claude_ai_Gmail');
    assert.equal(db.mcpServer('Bash'), null);
});

test('quantiles describe the fleet, not the outlier', () => {
    assert.equal(db.quantiles([]), null);
    const q = db.quantiles([10, 20, 30, 40, 1000]);
    assert.equal(q.n, 5);
    assert.equal(q.p50, 30);
    assert.equal(q.max, 1000);
});

test('sessionLabel prefers a title and falls back to what the transcript is called', () => {
    assert.equal(db.sessionLabel({ title: 'Fixing the parser', kind: 'main', id: 'abcdef123456' }), 'Fixing the parser');
    assert.equal(db.sessionLabel({ title: '', kind: 'main', id: 'abcdef123456' }), 'abcdef12');
    assert.equal(db.sessionLabel({ title: '', kind: 'agent', id: 'x', agentId: 'a7' }), 'agent a7');
});

test('lineChart draws one path per window and marks the plan', () => {
    const svg = db.lineChart([
        { label: 'last week', current: false, points: [{ x: 0, y: 0 }, { x: 7, y: 80 }] },
        { label: 'this week', current: true, points: [{ x: 0, y: 0 }, { x: 3, y: 50 }] },
    ]);
    assert.equal((svg.match(/class="line"/g) || []).length, 2);
    assert.match(svg, /class="plan"/);
    assert.match(svg, /100%/);
    assert.match(db.lineChart([]), /Nothing recorded/);
});

// A window is named by how long ago it ran, not by where it sits in the list:
// the log only grows while the editor runs, so a fortnight away leaves a hole
// and index arithmetic would call a month-old window "last week".
test('weekLabel counts back from now and survives a gap in the log', () => {
    const now = Date.parse('2026-08-09T20:00:00Z');
    const reset = (days) => Math.floor((now + days * 86400000) / 1000);
    assert.equal(db.weekLabel(reset(4), now), 'this week');
    assert.equal(db.weekLabel(reset(-3), now), 'last week');
    assert.equal(db.weekLabel(reset(-24), now), '4 weeks ago');
});

test('the limits legend names each window and says when it resets', () => {
    const now = Date.parse('2026-08-09T20:00:00Z');
    const week = 604800 * 1000;
    const rows = [
        // Last week, already reset, plus this one still running — and the live
        // one answered twice with a reset a second apart, as the endpoint does.
        { at: now - week - 86400000, weekly: 60, reset: Math.floor((now - week + 3 * 86400000) / 1000) },
        { at: now - 86400000, weekly: 30, reset: Math.floor((now + 3 * 86400000) / 1000) - 1 },
        { at: now - 3600000, weekly: 41, reset: Math.floor((now + 3 * 86400000) / 1000) },
    ];
    const html = db.limitsTab(rows, now);
    assert.equal((html.match(/class="chip"/g) || []).length, 2, 'the drifting reset is one window, not two');
    assert.match(html, /this week<span class="dim">· resets /);
    assert.match(html, /last week<span class="dim">· ended /);
    assert.doesNotMatch(html, /week to /);
    assert.doesNotMatch(html, /nothing to compare/);
});

test('the limits tab says so when a single window has nothing to compare against', () => {
    const now = Date.parse('2026-08-09T20:00:00Z');
    const rows = [{ at: now - 3600000, weekly: 41, reset: Math.floor((now + 3 * 86400000) / 1000) }];
    assert.match(db.limitsTab(rows, now), /nothing to compare/);
    // An empty log has no window at all, so it has nothing to say about one.
    assert.doesNotMatch(db.limitsTab([], now), /nothing to compare/);
});

test('stackedTokens stacks the parts it is given and labels the busiest day', () => {
    const days = {
        '2026-08-07': bucket(0, 1, { cacheRead: 1000, cw1h: 500 }),
        '2026-08-08': bucket(0, 1, { cacheRead: 3000, cw1h: 0 }),
    };
    const svg = db.stackedTokens(days, db.CACHE_PARTS);
    assert.equal((svg.match(/<rect /g) || []).length, 3); // two parts one day, one the next
    assert.match(svg, /3k/);
});

function demoSystem(over = {}) {
    return {
        at: Date.now(),
        versions: { current: '2.1.226', latest: '2.1.226', waiting: false, installed: [{ version: '2.1.226' }] },
        settings: { values: { model: { value: 'claude-opus-5', from: '~/.claude/settings.json' } }, env: { FOO: 'bar' } },
        hooks: [{ event: 'PreToolUse', matcher: 'Bash', kind: 'command', command: 'guard.sh', from: '~/.claude/settings.json' }],
        permissions: [{ mode: 'allow', rule: 'Bash(git status)', from: '~/.claude/settings.json' }],
        mcp: [
            { name: 'qmd', scope: 'user', transport: 'stdio', command: 'npx', project: '' },
            { name: 'ghost', scope: 'user', transport: 'stdio', command: 'npx', project: '' },
        ],
        plugins: [
            { name: 'used-one', marketplace: 'official', enabled: true, version: '1.0.0', copies: 1,
                components: { skills: ['code-review'], agents: [], commands: [], hooks: 0, mcp: [] } },
            { name: 'idle-one', marketplace: 'official', enabled: true, version: '2.0.0', copies: 3,
                components: { skills: ['never-run'], agents: [], commands: [], hooks: 1, mcp: [] } },
            { name: 'ghost-plugin', marketplace: 'official', enabled: true, copies: 0, missing: true,
                components: { skills: [], agents: [], commands: [], hooks: 0, mcp: [] } },
        ],
        jobs: [{ id: 'aaa', name: '<script>x</script>', state: 'working', detail: '', tokens: 5000,
            cliVersion: '2.1.226', cwd: '~/repo', sessionId: 'sess-1234', children: 0, at: Date.now(),
            bytes: 700e6, tmpBytes: 654e6 }],
        live: {
            sessions: [{ id: 'a1b2c3d4', pid: 1, alive: true, cwd: '~/repo', entrypoint: 'cli', status: 'busy', name: '', version: '2.1.226', startedAt: Date.now() }],
            ide: [{ pid: 2, alive: true, name: 'Visual Studio Code', transport: 'ws', folders: ['~/repo'] }],
            daemon: { supervisorPid: 3, alive: true, workers: [{ short: 'w1', pid: 4, alive: true, sessionId: 's1', cwd: '~/repo', cliVersion: '2.1.226' }] },
        },
        tasks: [{ session: 'sess-1234', project: 'demo', at: Date.now(), total: 3, done: 1, open: ['finish the parser'] }],
        disk: {
            total: 3.1e9,
            dirs: [{ name: 'projects', bytes: 1.2e9, kind: 'keep' }, { name: 'plugins', bytes: 800e6, kind: 'regenerable' }],
            hogs: [{ path: 'jobs/aaa/tmp', bytes: 654e6, note: 'scratch of "wasm"' }],
        },
        context: { globalTokens: 24387, files: [{ path: '~/.claude/CLAUDE.md', scope: 'global', bytes: 68000, tokens: 17000 }] },
        changelog: [{ version: '2.1.227', entries: ['something <b>new</b>'] }],
        projects: [{ path: '~/repo', name: 'repo', lastCost: 1.5, lastDuration: 600000, apiDuration: 300000,
            added: 100, removed: 20, webSearches: 3, fps: 58.2, fpsLow: 22, trusted: true, allowedTools: 4, mcpServers: 1, startedAt: Date.now() }],
        prompts: { count: 1575, pasted: 10, byDay: { '2026-08-08': 40 }, byProject: { demo: 100 }, first: Date.now(), last: Date.now() },
        ...over,
    };
}

test('the Setup section renders every panel and escapes what it reads from disk', () => {
    const index = demoIndex();
    const total = ix.summarize(index);
    const html = db.render(index, total, { files: 1, lastRun: Date.now(), history: [], system: demoSystem() });

    assert.match(html, /data-tab="health"/);
    assert.match(html, /data-tab="jobs"/);
    assert.match(html, /data-tab="live"/);
    assert.match(html, /data-tab="disk"/);
    assert.match(html, /data-tab="context"/);
    assert.match(html, /data-tab="changelog"/);
    assert.match(html, /data-tab="tasks"/);
    assert.ok(!html.includes('<script>x</script>'), 'a job name must not reach the DOM raw');
    assert.ok(!html.includes('something <b>new</b>'), 'a changelog line must not reach the DOM raw');
    assert.ok(!/undefined|NaN/.test(html));
});

test('health marks a plugin idle when nothing of it ever ran', () => {
    const total = ix.summarize(demoIndex());
    total.skills = { 'code-review': { cost: 1, msgs: 1 } };
    total.tools = { 'mcp__qmd__query': { calls: 5, errors: 0, denials: 0 } };
    const html = db.healthTab(total, demoSystem());

    const row = (name) => html.slice(html.indexOf(`>${name}<`)).slice(0, 600);
    assert.match(row('used-one'), /class="ok"/);
    assert.match(row('idle-one'), /class="idle"/);
    assert.match(row('ghost-plugin'), /missing/);
    // The MCP server that shows up in tool names is used; the other is not.
    assert.match(row('qmd'), /class="ok"/);
    assert.match(row('ghost'), /class="idle"/);
});

// A day of one long session and a day of nine parallel ones can carry the same
// spend. The sessions tab showed the spend and never the difference.
test('the sessions tab says how wide the busiest moment was', () => {
    const h = (n) => Date.parse('2026-08-08T00:00:00Z') + n * 3600e3;
    const total = ix.summarize(demoIndex());
    total.sessions = [
        { ...total.sessions[0], id: 's1', kind: 'main', start: h(10), end: h(12), activeMs: 3600e3 },
        { ...total.sessions[0], id: 's2', kind: 'main', start: h(11), end: h(13), activeMs: 1800e3 },
        // A fan-out is not the person running three windows: agents are counted
        // on the Agents tab and must not inflate this one.
        { ...total.sessions[0], id: 'a1', kind: 'agent', start: h(10), end: h(13), activeMs: 900e3 },
    ];
    const html = db.render({ files: {} }, total, { files: 0 });

    // The value of the tile itself, not "a 2 somewhere on the page": with the
    // agent counted this reads 3, which is the mistake the tile is guarding.
    assert.match(html, /Peak parallel sessions<\/span><span class="tile-value">2</);
    assert.match(html, /tile-value">1h30m</); // the work, not the three hours it spanned
});

// The cache tab could say how much was read and how much written, and nothing
// about the replies that read nothing at all — which is where the full-rate
// money goes, and the one place it can be traced to a session.
test('the cache tab names the replies the cache could not answer', () => {
    const total = ix.summarize(demoIndex());
    total.breaks = {
        count: 3,
        tokens: 900000,
        top: [{ at: Date.parse('2026-08-08T14:00:00Z'), uncached: 500000, session: 'sess-a', project: 'repo-x', kind: 'main' }],
    };
    const html = db.render({ files: {} }, total, { files: 0 });
    assert.match(html, /repo-x/);
    assert.match(html, /500k|500,000/);
});

test('the cache tab stays quiet when no reply ever broke the cache', () => {
    const total = ix.summarize(demoIndex());
    total.breaks = ix.emptyBreaks();
    assert.doesNotMatch(db.render({ files: {} }, total, { files: 0 }), /could not answer/i);
});

// An agent used to be unmatchable here: its type is named in the arguments of
// the call that spawned it, and the index only ever read results. The meta file
// beside each subagent transcript names it, so an agent now answers the same
// question a skill does — did this component ever run, and what did it cost.
test('a plugin agent is matched by the type its dispatches carried', () => {
    const total = ix.summarize(demoIndex());
    total.agents = { 'guard:scan-researcher': bucket(7, 4) };
    const sys = demoSystem({
        plugins: [{ name: 'guard', marketplace: 'official', enabled: true, version: '1.0.0', copies: 1,
            components: { skills: [], agents: ['scan-researcher'], commands: [], hooks: 0, mcp: [] } }],
    });

    const html = db.healthTab(total, sys);
    const row = html.slice(html.indexOf('>scan-researcher<')).slice(0, 600);
    assert.doesNotMatch(row, /not visible/);
    assert.match(row, /\$7/);
});

test('the Setup panels degrade to a message when there is no snapshot', () => {
    const total = ix.summarize(demoIndex());
    for (const tab of [db.healthTab(total, null), db.jobsTab(null), db.diskTab(null), db.tasksTab(null)]) {
        assert.match(tab, /class="empty"/);
    }
    assert.match(db.liveTab(null), /Live sessions/);
    assert.match(db.changelogTab(null), /Nothing newer/);
    assert.match(db.contextTab(total, null), /Context/i);
});

// acquireVsCodeApi throws on the second call, and the throw kills the rest of
// the script — which is how the Reindex button and the whole settings editor
// ended up in one page, each holding its own handle, one of them dead.
test('the webview acquires the VS Code API exactly once', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()),
        { files: 1, lastRun: Date.now(), history: [], system: demoSystem(), config: { presets: [], palette: [] } });
    assert.equal((html.match(/acquireVsCodeApi\(\)/g) || []).length, 1);
});

// Every date in the tables names its weekday, the same way the tooltips do:
// "13.08" alone does not say whether that is tomorrow or the far side of a
// weekend, and these tables are read to answer exactly that.
test('a date in a table carries its weekday', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()),
        { files: 1, lastRun: Date.now(), history: [], system: demoSystem(), config: { presets: [], palette: [] } });
    const dates = html.match(/[A-Z][a-z]{2} \d{2}\.\d{2} \d{2}:\d{2}/g) || [];
    assert.ok(dates.length > 0, 'no dated row rendered at all');
    // No bare date may survive next to them.
    const bare = html.match(/(?<![A-Za-z] )\b\d{2}\.\d{2} \d{2}:\d{2}/g) || [];
    assert.deepEqual(bare, [], 'a date without its weekday is left in the page');
});

// "1 jobs" shipped, and the same shape was waiting in fifteen other captions.
test('a count of one takes the singular, everywhere the page counts something', () => {
    assert.equal(db.plural(1, 'session'), '1 session');
    assert.equal(db.plural(2, 'session'), '2 sessions');
    assert.equal(db.plural(0, 'session'), '0 sessions');
    // Half these nouns do not take an "s": the second form is spelled out.
    assert.equal(db.plural(1, 'stale entry', 'stale entries'), '1 stale entry');
    assert.equal(db.plural(4, 'stale entry', 'stale entries'), '4 stale entries');

    // Rendered with one of everything, the page must contain no "1 <plural>".
    const one = demoSystem({
        versions: { current: '2.1.226', latest: '', waiting: false, installed: [{ version: '2.1.226' }] },
        live: {
            sessions: [{ id: 'a', pid: 1, alive: false, cwd: '~/r', entrypoint: 'cli', status: '', name: '', version: '', startedAt: Date.now() }],
            ide: [{ pid: 2, alive: true, name: 'Code', transport: 'ws', folders: ['~/r'] }],
            daemon: { supervisorPid: 3, alive: true, workers: [] },
        },
        disk: { total: 1e9, dirs: [{ name: 'projects', bytes: 1e9, kind: 'keep' }], hogs: [{ path: 'x', bytes: 1, note: 'y' }] },
        tasks: [{ session: 's', project: 'p', at: Date.now(), total: 1, done: 0, open: ['one'] }],
    });
    const html = db.render(demoIndex(), ix.summarize(demoIndex()),
        { files: 1, lastRun: Date.now(), history: [], system: one, config: { presets: [], palette: [] } });

    const wrong = html.match(/\b1 (sessions|transcripts|tools|versions|places|edits|lists|requests|lock files|permission rules|stale entries)\b/g);
    assert.deepEqual(wrong, null, `a lone item counted in the plural: ${wrong}`);
});

test('bytes reads in the unit a human would pick', () => {
    assert.equal(db.bytes(0), '0');
    assert.equal(db.bytes(900), '900 B');
    assert.equal(db.bytes(54000), '54 KB');
    assert.equal(db.bytes(654e6), '654 MB');
    assert.equal(db.bytes(3.17e9), '3.2 GB');
});

test('matrixTable tints by weight and shows an empty cell as empty', () => {
    const html = db.matrixTable(['a', 'b'], ['x', 'y'],
        (r, c) => (r === 'a' && c === 'x' ? 10 : 0));
    assert.match(html, /\$10\.00/);
    assert.equal((html.match(/class="num dim"/g) || []).length, 3);
});

// Colour is load-bearing here: the legend is the only key to a stacked chart,
// so two models that look alike make the chart unreadable. Distance is measured
// in CIELAB rather than eyeballed, because hue numbers being far apart does not
// mean the colours look far apart.
function labOf(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const ch = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = [lin(ch(0)), lin(ch(8)), lin(ch(4))];
    const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X / 0.95047) - f(Y)), 200 * (f(Y) - f(Z / 1.08883))];
}

function demoAgent(over = {}) {
    return {
        agentId: 'a1', label: 'review:bugs', phase: 'Review', model: 'claude-opus-5',
        state: 'done', tokens: 300000, reportedTokens: 120000, cost: 3, toolCalls: 12,
        durationMs: 90000, promptPreview: 'найди баги', resultPreview: '{"findings":[]}',
        lastToolName: 'Grep', agentType: '', lastActivity: 1,
        ...over,
    };
}

function demoRun(over = {}) {
    return {
        runId: 'wf_demo-1', name: 'review-changes', state: 'finished', status: 'completed',
        project: 'demo', lastActivity: Date.parse('2026-08-09T10:00:00Z'), durationMs: 181000,
        phases: [{ title: 'Review', detail: '' }, { title: 'Verify', detail: '' }],
        totals: {
            agents: 1, reported: 0, cost: 3.5, tokens: 400000, unlisted: 0, done: 1,
            reportedTokens: 999000, toolCalls: 12,
        },
        agents: [demoAgent()],
        ...over,
    };
}

// The notes beside the table are the only description of the two surfaces a
// reader cannot see from here — the run still going, and the tree in the
// sidebar — so they are held to what the code does rather than to what it did
// when they were written.
test('the notes describe the tab and the tree that exist', () => {
    const wide = (i) => demoRun({
        runId: `wf_wide-${i}`, lastActivity: 1000 - i,
        totals: { agents: 100, reported: 0, cost: 1, tokens: 0, unlisted: 0, done: 100 },
        agents: Array.from({ length: 100 }, (_, k) => demoAgent({ agentId: `a${i}-${k}` })),
    });
    const html = db.agentsTab(ix.summarize(demoIndex()), Array.from({ length: 6 }, (_, i) => wide(i)));

    assert.doesNotMatch(html, /carries no verdict/,
        'a run still going says "running" — the chip is drawn and tested above');
    assert.doesNotMatch(html, /no such limit/, 'the tree caps its finished runs like everything else');
    assert.match(html, new RegExp(`${wf.TREE_FINISHED} newest finished runs`),
        'and the note names the cap the tree actually applies');
});

test('the workflow table names the run, its status and its phases', () => {
    const runs = [demoRun()];
    const html = db.render({ files: {} }, ix.summarize(demoIndex()), { files: 0, workflows: runs });

    assert.match(html, /review-changes/);
    assert.match(html, /completed/);
    assert.match(html, /Review/);
    assert.match(html, /review:bugs/);
    assert.match(html, /найди баги/);
});

test('workflow text from another program is escaped', () => {
    const runs = [demoRun({
        runId: 'wf_evil-1', name: '<img src=x onerror=alert(1)>', phases: [],
        agents: [demoAgent({
            label: '<script>bad()</script>', phase: '', promptPreview: '<b>x</b>',
            resultPreview: '<i>y</i>', lastToolName: '<u>t</u>',
        })],
    })];
    const html = db.render({ files: {} }, ix.summarize(demoIndex()), { files: 0, workflows: runs });

    assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
    assert.doesNotMatch(html, /<img src=x onerror/);
    assert.match(html, /&lt;script&gt;/);
});

test('the tab still renders with no workflow data at all', () => {
    const html = db.render({ files: {} }, ix.summarize(demoIndex()), { files: 0 });
    assert.match(html, /data-tab="agents"/);
});

// Which kind of agent the money went to. Until the meta file beside each
// subagent transcript was read, this page could say what subagents cost in total
// and nothing about which of them — the Health tab said so in as many words.
test('the agents tab ranks subagent types by spend', () => {
    const total = ix.summarize(demoIndex());
    total.agents = {
        'general-purpose': bucket(90, 12, { out: 900 }),
        'worker-researcher': bucket(10, 3, { out: 100 }),
    };
    const html = db.agentsTab(total, []);
    assert.match(html, /general-purpose/);
    assert.match(html, /worker-researcher/);
});

// `plural` defaults the plural to the word plus an `s`, which is wrong for
// exactly the noun this page counts most often. It reached a listing screenshot.
// The sidebar is 250–400 px wide, where both of the dashboard's wide devices
// break: the four-across headline strip and the balanced columns. What is left
// is the sections themselves — the same ones, in the same order, one per column.
//
// And only those. A summary strip above them repeated the two figures the first
// section already draws, in a second format, four scroll-lines higher: the pane
// opened on the weekly window twice and on the pace note not at all.
test('the sidebar draws the sections themselves, and adds no summary of its own', () => {
    const sections = [
        { id: 'limits', title: 'limits', blocks: [{ kind: 'meters', rows: [{ label: '5h', value: '20%', pct: 20, note: '1h5m' }] }] },
        { id: 'money', title: 'spend', blocks: [{ kind: 'table', rows: [['today', '~$4.20']] }] },
    ];
    const html = db.sidebarNow(sections, 'limits');

    assert.match(html, /20%/);
    assert.match(html, /~\$4\.20/);
    // The first section stays first: limits lead on the dashboard too.
    assert.ok(html.indexOf('limits') < html.indexOf('spend'));
    assert.doesNotMatch(html, /class="tiles"/);
    assert.doesNotMatch(html, /class="cols"/);
    assert.doesNotMatch(html, /side-stat/);
});

// Each pane says what is missing from *it*. The limits pane going quiet means
// the reading failed; the session pane going quiet only means no Claude session
// is open in this window — and saying "no limits have been read" there was wrong
// beside a limits pane that had just drawn them.
test('an empty pane says what its own emptiness means', () => {
    assert.match(db.sidebarNow([], 'limits'), /limits/i);
    assert.doesNotMatch(db.sidebarNow([], 'limits'), /session is open/i);
    assert.match(db.sidebarNow([], 'session'), /session is open in this window/i);
    assert.doesNotMatch(db.sidebarNow([], 'session'), /no limits have been read/i);
});

// Limits get a view to themselves so that the one section worth seeing without
// scrolling cannot be pushed under the fold by whatever is below it. And `work`
// — the peers — is on neither view: the sessions are the tree one row down,
// where they come from the registry rather than from a transcript.
test('the sidebar splits the sections between its views and leaves the peers out', () => {
    const sections = [
        { id: 'limits', title: 'Limits', blocks: [] },
        { id: 'context', title: 'opus 5', blocks: [] },
        { id: 'money', title: '~$4 this session', blocks: [] },
        { id: 'work', title: 'Other sessions here', blocks: [] },
    ];
    assert.deepEqual(db.sidebarSections(sections, 'limits').map((s) => s.id), ['limits']);
    assert.deepEqual(db.sidebarSections(sections, 'session').map((s) => s.id), ['context', 'money']);
});

// The view has nothing to click, so its policy is stricter than the dashboard's:
// styles inline, scripts nowhere.
test('the sidebar page states a policy that forbids script outright', () => {
    const html = db.sidebarPage([], 'limits');
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /script-src/);
    assert.doesNotMatch(html, /<script/);
});

test('a count of replies is spelled the English way', () => {
    const total = ix.summarize(demoIndex());
    total.agents = { 'general-purpose': bucket(5, 2843) };
    const html = db.agentsTab(total, []);
    assert.match(html, /2843 replies/);
    assert.doesNotMatch(html, /replys/);
});

test('the agents tab drops the type panel when nothing carries a type', () => {
    const total = ix.summarize(demoIndex());
    total.agents = {};
    assert.doesNotMatch(db.agentsTab(total, []), /agent type/i);
});

// A list of 13 rows under a heading of 74 says the run finished everything it
// started. The client's own counter is the only place that gap is recorded.
test('the run row shows the client count when it disagrees with the list', () => {
    const total = ix.summarize(demoIndex());
    const html = db.agentsTab(total, [demoRun({
        status: 'killed',
        totals: { agents: 1, reported: 74, cost: 1, tokens: 0, unlisted: 0, done: 1 },
    })]);
    assert.match(html, /1 of 74/);
});

// A run's price is the sum over the agents it lists, and its directory can hold
// transcripts no snapshot names — on one run here that is $88.45 beside $107.65.
// Beside, in the same cell, and never added: $196.10 is what folding them
// together would print.
test('money no snapshot accounts for is shown beside the price of the run', () => {
    const total = ix.summarize(demoIndex());
    const priced = db.agentsTab(total, [demoRun({
        totals: { agents: 1, reported: 0, cost: 107.65, tokens: 0, unlisted: 88.45, done: 1 },
    })]);
    assert.match(priced, /~\$107\.65 <span class="dim"[^>]*>\+~\$88\.45<\/span><\/td>/);
    assert.doesNotMatch(priced, /196\.10/);

    // A run whose own agents cost nothing while its directory did: a dash next
    // to "+~$88.45" would read as arithmetic on nothing.
    const bare = db.agentsTab(total, [demoRun({
        totals: { agents: 1, reported: 0, cost: 0, tokens: 0, unlisted: 88.45, done: 1 },
    })]);
    assert.match(bare, /~\$88\.45 unlisted/);
    assert.doesNotMatch(bare, /—\s*<span class="dim"[^>]*>\+/);
});

// The three places a live run is drawn differently, none of which the brief had:
// its own word, how far it has got, and the chip both it and its agents carry.
test('a run still going says what it is doing and how far it has got', () => {
    const total = ix.summarize(demoIndex());
    const html = db.agentsTab(total, [demoRun({
        state: 'running', status: '', durationMs: 0,
        totals: { agents: 5, reported: 0, cost: 0, tokens: 0, unlisted: 0, done: 2 },
        agents: [demoAgent({ state: 'progress' })],
    })]);
    assert.match(html, /class="kind o-running">running<\/span>/);
    assert.match(html, /2\/5/);
    assert.equal((html.match(/class="kind o-running"/g) || []).length, 2,
        'the run and the agent still working in it both say so');
});

// A live agent has no label — it is computed in the runtime and reaches the disk
// only with the final snapshot — and the tree names it by the first line of what
// it was told. Both surfaces read one machine, so they name one agent alike.
test('an agent with no label yet is named the way the tree names it', () => {
    const agent = demoAgent({
        agentId: 'abcdef1234', label: '', state: 'progress',
        promptPreview: 'проверь индекс\nи верни таблицу',
    });
    const html = db.agentsTab(ix.summarize(demoIndex()), [demoRun({
        state: 'running', status: '', agents: [agent],
        totals: { agents: 1, reported: 0, cost: 0, tokens: 0, unlisted: 0, done: 0 },
    })]);
    assert.match(html, /проверь индекс <span class="dim"/);
    assert.equal(wf.agentLabel(agent), 'проверь индекс', 'and by the same rule, not a copy of it');
});

// The client's own token figure is the agent's context at its last reply, not
// what it spent — the two differ by a factor of 29 on this machine — so it
// cannot appear on a page whose columns are money.
test('the context size the client reports never reaches the page', () => {
    const html = db.agentsTab(ix.summarize(demoIndex()), [demoRun()]);
    assert.match(html, /~300k/, 'the priced tokens are shown');
    assert.doesNotMatch(html, /120k/, 'the context of the agent is not');
    assert.doesNotMatch(html, /999k/, 'nor the context the run adds up');
});

// The row limit bounds the table, not the document: a hundred rows of the widest
// runs here would be tens of megabytes of markup for cards nobody opened.
test('agent cards stop at a budget, and the page says where', () => {
    const wide = (i) => demoRun({
        runId: `wf_wide-${i}`, lastActivity: 1000 - i,
        totals: { agents: 100, reported: 0, cost: 1, tokens: 0, unlisted: 0, done: 100 },
        agents: Array.from({ length: 100 }, (_, k) => demoAgent({ agentId: `a${i}-${k}` })),
    });
    const runs = Array.from({ length: 6 }, (_, i) => wide(i));
    const html = db.agentsTab(ix.summarize(demoIndex()), runs);

    const cards = (html.match(/<details class="agent">/g) || []).length;
    const details = (html.match(/<tr class="detail">/g) || []).length;
    assert.ok(details >= 1 && details < 6, `every run drew its cards: ${details}`);
    assert.equal(cards, details * 100, 'a run either carries all of its agents or none');
    assert.match(html, /wf_wide-0/, 'the newest run is the one that keeps them');
    assert.match(html, /drawn only for the \d+ newest runs/);
});

// Read through outcomeOf and never off the raw word: the client writes `error`
// and never `failed`, and an agent of a killed run stays recorded as working.
test('an agent the run was cut from under is drawn neither done nor running', () => {
    const total = ix.summarize(demoIndex());
    const html = db.agentsTab(total, [demoRun({
        status: 'killed',
        agents: [
            demoAgent({ agentId: 'a1', state: 'progress' }),
            demoAgent({ agentId: 'a2', state: 'error' }),
            demoAgent({ agentId: 'a3', state: 'done' }),
        ],
    })]);
    assert.match(html, /o-stopped/);
    assert.match(html, /o-failed/);
    assert.match(html, /o-done/);
    assert.doesNotMatch(html, /o-running/);
});

test('a run record with none of its optional halves still draws a row', () => {
    const total = ix.summarize(demoIndex());
    const html = db.agentsTab(total, [{ runId: 'wf_bare-1', state: 'abandoned', project: 'demo' }]);
    assert.match(html, /wf_bare-1/);
    assert.match(html, /no snapshot/);
    assert.ok(!/undefined|NaN/.test(html));
});

test('every pair of model colours stays perceptually distinct', () => {
    const rows = Array.from({ length: 9 }, (_, i) => [`m${i}`, bucket(9 - i)]);
    // Only a list keyed by a model is drawn in model colours; a list of one
    // measure is one hue, so it would offer no pairs to compare.
    const html = db.barList(rows, { limit: 9, byModel: true });
    const colors = [...html.matchAll(/hsl\((\d+) (\d+)% (\d+)%\)/g)]
        .map((m) => labOf(Number(m[1]), Number(m[2]), Number(m[3])));
    assert.equal(colors.length, 9);

    let worst = Infinity;
    let pair = '';
    for (let i = 0; i < colors.length; i++) {
        for (let j = i + 1; j < colors.length; j++) {
            const d = Math.hypot(...colors[i].map((v, k) => v - colors[j][k]));
            if (d < worst) { worst = d; pair = `${i} vs ${j}`; }
        }
    }
    assert.ok(worst >= 25, `colours ${pair} are too close: deltaE ${worst.toFixed(1)}`);
});

// The stacked chart sorts by the canonical order and the list beside it by
// cost. Keyed on the row index, a hue agreed between the two only when those
// orders happened to match — which they do today, and would stop doing the day
// either sort changed.
test('a model keeps its colour whichever list it is drawn in', () => {
    const total = ix.summarize(demoIndex());
    const order = Object.entries(total.models)
        .sort((a, b) => b[1].cost - a[1].cost).map(([m]) => m);
    db.assignModelColors(order);

    const reversed = [...order].reverse();
    const forward = db.barList(order.map((m) => [m, total.models[m]]), { byModel: true });
    const backward = db.barList(reversed.map((m) => [m, total.models[m]]), { byModel: true });

    const hueOf = (html, model) => {
        const row = html.split('<tr>').find((r) => r.includes(`title="${model}"`));
        return (row.match(/hsl\([^)]+\)/) || [])[0];
    };
    for (const model of order) {
        assert.equal(hueOf(backward, model), hueOf(forward, model),
            `${model} changed colour when the list was sorted the other way`);
    }
});

// The panel title, the page heading and the command that opens it are three
// separate strings for one thing. They drifted apart the moment one was
// renamed, and nothing but this notices.
test('the page names itself the same way the command that opens it does', () => {
    const manifest = JSON.parse(require('node:fs').readFileSync(`${__dirname}/../package.json`, 'utf8'));
    const html = db.render(demoIndex(), ix.summarize(demoIndex()), { files: 1, lastRun: Date.now(), history: [] });
    assert.match(html, /<title>Dashnlines for Claude<\/title>/);
    assert.match(html, /<h1>Dashnlines for Claude<\/h1>/);
    // The version rides beside the name as a pill, in the same shape the panels
    // use for state — it was a bare span with its own type treatment. The
    // attribute is what `--demo` strips it by; see the test that holds both
    // files to it.
    assert.match(html, /<h1>Dashnlines for Claude<\/h1><span class="pill" data-version>v\d+\.\d+\.\d+<\/span>/);
    const open = manifest.contributes.commands.find((c) => c.command === 'claudeStatusline.dashboard');
    assert.equal(open.title, 'Claude: Open dashboard');
});

// A column that hides at a narrow width hides as a pair. With the class on the
// header alone the body kept a cell the header had dropped, and every heading
// to its right sat over the wrong column — invisible at full width, and no
// overflow for a probe to find.
// The stylesheet is a file now, and a file can be left out of the package in a
// way a template literal never could: .vscodeignore excludes whole directories
// by pattern, and a page whose CSS did not ship still renders — as unstyled
// markup nobody would call broken until they saw it.
test('the stylesheet is read from dashboard.css and is actually there', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const file = path.join(root, 'dashboard.css');
    assert.ok(fs.existsSync(file), 'dashboard.css is missing from the repository');
    assert.equal(db.STYLE, fs.readFileSync(file, 'utf8'), 'STYLE is not this file');

    // And that it survives packaging. Every other check here reads the working
    // tree, where the file always exists; .vscodeignore is the one thing that
    // can drop it from the .vsix, and a page whose CSS did not ship is what the
    // fallback in dashboard.js exists to make legible rather than fatal.
    const rules = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8')
        .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    for (const asset of ['dashboard.css', 'claude-settings-registry.json']) {
        if (!fs.existsSync(path.join(root, asset))) continue;
        const excluded = rules.some((r) => (r.endsWith('/**') && asset.startsWith(r.slice(0, -2)))
            || r === asset || (r.startsWith('*.') && asset.endsWith(r.slice(1))));
        assert.ok(!excluded || rules.includes(`!${asset}`),
            `${asset} is read at runtime but excluded from the .vsix by .vscodeignore`);
    }
    // A few rules every page depends on, so an empty or truncated file fails
    // here rather than in a screenshot.
    for (const rule of ['.panel {', '.tiles {', '.wk-rail {', '.pill {', '.strip {']) {
        assert.ok(db.STYLE.includes(rule), `${rule} is missing from the stylesheet`);
    }
    assert.ok(db.STYLE.length > 40000, `the stylesheet is only ${db.STYLE.length} bytes`);
});

// Every field of every block, on every section status.js can produce — the older
// parity test drives activate() with only a limit cache pinned, so it walks one
// section and has never seen `context`, `money` or `work` at all. It was green
// while the strip silently dropped two fields the hover was showing.
test('every value a section carries reaches the page, in all four of them', () => {
    const status = require('../status');
    const NOW = 1755000000;
    const h = {
        fmtCost: (n) => `$${n.toFixed(2)}`,
        fmtLeft: () => '1d13h',
        fmtAbs: () => 'Thu 14:59',
        fmtWhen: () => 'Thu 20.08, ~10h',
        fmtDuration: () => '4d1h',
        tok: (n) => `${Math.round(n / 1000)}k`,
        shortModel: (m) => String(m).replace(/^claude-/, ''),
    };
    const sections = status.statusSections({
        now: NOW,
        limits: {
            session: { pct: 3, reset: NOW + 3600 },
            weekly: { pct: 80, reset: NOW + 130000 },
            scoped: [{ scope: 'Fable', pct: 34, reset: NOW + 130000 }],
            credits: { enabled: false, used: 103.67, currency: 'USD', reason: 'out_of_credits' },
        },
        weekly: { pct: 80 },
        pace: { settled: true, plan: 77, dryAt: NOW + 90000, elapsed: 99999, beforeReset: true },
        ctx: {
            model: 'claude-opus-5', window: 1000000, tokens: 318000, pct: 31,
            estimated: false, effort: 'max', cachePct: 99, branch: 'master',
        },
        contextParts: { skills: 8000, agents: 5000, mcp: 2000, tools: 2000, hooks: 2000 },
        memoryTokens: 61000,
        compactPct: 97,
        settings: { thinking: true, thinkingSummaries: true, advisor: 'claude-fable-5', outputStyle: 'explanatory' },
        version: { current: '2.1.234', latest: '2.1.235' },
        stats: { cost: 1287.7, burn: 13.16, durationMs: 1, messages: 2497, apiPct: 7, added: 3161, removed: 614 },
        todayUsd: 0,
        todo: { done: 4, total: 7, active: 'Backfill the orders table' },
        peers: { total: 3, busy: 1 },
    }, h, { updatedAt: NOW });

    assert.deepEqual(sections.map((s) => s.id), ['limits', 'context', 'money', 'work']);
    const html = db.nowTab(sections, [], {});
    const seen = (cell, where) => {
        if (!cell) return;
        assert.ok(html.includes(db.esc(cell)), `"${cell}" (${where}) is in the tooltip but not on the page`);
    };
    for (const section of sections) {
        assert.ok(html.includes(`data-panel="${section.id}"`), `${section.id} missing from the page`);
        for (const b of section.blocks) {
            if (b.kind === 'pills') for (const p of b.items) { seen(p.text, 'pill'); seen(p.value, 'pill value'); }
            if (b.kind === 'gauge') for (const c of [b.headline, b.value, b.sub, ...(b.chips || [])]) seen(c, 'gauge');
            if (b.kind === 'parts' || b.kind === 'meters') {
                seen(b.caption, 'caption'); seen(b.figure, 'caption figure');
                for (const r of b.rows) for (const c of [r.label, r.value, r.note, r.figure]) seen(c, 'row');
            }
            if (b.kind === 'band') {
                for (const f of b.facts || []) seen(f, 'band');
                if (b.chip) for (const c of [b.chip.label, b.chip.value, b.chip.tail]) seen(c, 'chip');
            }
            if (b.kind === 'note') { seen(b.label, 'note label'); seen(b.text, 'note'); }
            if (b.kind === 'subtitle') seen(b.text, 'subtitle');
            if (b.kind === 'table') for (const row of b.rows) for (const c of row) seen(c, 'table');
        }
    }
});

// Four panels in a three-column flow leave one column carrying two and the
// others ending high, and no size of card fixes that — the browser balances the
// columns and tasks are always the odd panel out. So they leave the flow.
test('the task list is a strip across the page, not a fourth column', () => {
    const work = {
        id: 'work',
        title: 'Tasks',
        blocks: [
            { kind: 'pills', items: [{ text: '3 sessions' }, { text: '1 busy', tone: 'active' }] },
            { kind: 'gauge', headline: '4/7', value: '57% done', sub: '3 left', pct: 57, chips: [] },
            { kind: 'note', tone: 'active', label: 'in progress', text: 'Backfill the orders table' },
        ],
    };
    const html = db.nowTab([{ id: 'money', title: 'Spend', blocks: [{ kind: 'table', rows: [['today', '~$0']] }] }, work], [], {});

    const cols = html.match(/<div class="cols">[\s\S]*?<\/div>\s*<div class="strip"/);
    assert.ok(cols, 'the strip follows the columns rather than sitting inside them');
    assert.ok(!/<section class="panel"[^>]*data-panel="work"/.test(html), 'tasks are not a panel');

    // Assembled from the section's blocks by kind, so the strip and the hover
    // cannot drift: every figure status.js wrote is on the page.
    for (const cell of ['Tasks', '4/7', '57% done', 'Backfill the orders table', '3 sessions', '1 busy']) {
        assert.ok(html.includes(db.esc(cell)), `"${cell}" is missing from the strip`);
    }
    assert.match(html, /class="strip-track"><i class="t-warm" style="width:57%"/);

    // Nothing to say, nothing drawn — a session with neither a list nor a
    // neighbour would otherwise get an empty bar across the page.
    assert.ok(!db.nowTab([{ id: 'work', title: 'Tasks', blocks: [] }], [], {}).includes('class="strip"'));
});

test('every hideable column hides its header and its cells together', () => {
    const total = ix.summarize(demoIndex());
    const html = db.render(demoIndex(), total, { files: 1, lastRun: Date.now(), history: [] })
        // A section is required: with none, nowTab returns its empty state and
        // the agent table this is here to inspect is never drawn.
        + db.nowTab([{ id: 'money', title: 'spend', blocks: [{ kind: 'table', rows: [['today', '~$0']] }] }], [{
            runId: 'wf_x', name: 'demo', state: 'running', project: 'p', agents: [{
                agentId: 'a1234567890', label: '', phase: '', model: 'claude-opus-5',
                effort: 'xhigh', state: 'running', lastToolName: 'Bash', promptPreview: 'go',
            }],
            totals: { agents: 1, done: 0, cost: 0 },
        }], {});

    for (const table of html.match(/<table[\s\S]*?<\/table>/g) || []) {
        const head = table.match(/<thead>[\s\S]*?<\/thead>/);
        if (!head) continue;
        const rows = (table.match(/<tbody>([\s\S]*?)<\/tbody>/) || ['', ''])[1]
            .split('</tr>').filter((r) => r.includes('<td') || r.includes('<th'));
        const cls = (cell) => ['opt3', 'opt2', 'opt'].find((c) => new RegExp(`class="[^"]*\\b${c}\\b`).test(cell)) || '';
        // `<th` must be followed by a space or `>`: `<thead>` matches `<th[^>]*>`
        // otherwise, which put a phantom column at the head of every list and
        // made the lengths disagree — so this skipped every table it looked at.
        const heads = (head[0].match(/<th(?=[\s>])[^>]*>/g) || []).map(cls);
        for (const row of rows) {
            const cells = (row.match(/<t[dh](?=[\s>])[^>]*>/g) || []).map(cls);
            if (cells.length !== heads.length) continue; // a colspan row, not a data row
            assert.deepEqual(cells, heads, `header and cells hide differently:\n${head[0]}\n${row}`);
        }
    }
});

// A state word is read through outcomeOf, never off the raw string: the client
// writes `progress` and `queued` for a working agent as well as `running`, and
// a row that tested for one spelling drew every other one as finished.
test('a live agent is counted as working whichever word the client used', () => {
    const run = (state) => ({
        runId: 'wf_v', name: 'vocab', state: 'running', project: 'p',
        totals: { agents: 1, done: 0, cost: 0 },
        agents: [{
            agentId: 'a1234567890', label: '', phase: '', model: 'claude-opus-5',
            effort: 'xhigh', state, lastToolName: '', promptPreview: 'go',
        }],
    });
    const sections = [{ id: 'money', title: 'spend', blocks: [{ kind: 'table', rows: [['today', '~$0']] }] }];

    for (const word of ['running', 'progress', 'queued', 'start']) {
        const html = db.nowTab(sections, [run(word)], {});
        assert.match(html, /o-running/, `${word} was not drawn as working`);
    }
    // A finished agent keeps its row: the list is every agent the run
    // dispatched, and hiding the settled ones was a decision nobody asked for.
    const done = db.nowTab(sections, [run('done')], {});
    assert.match(done, /o-done/);
    assert.ok(!/not listed here|returned —/.test(done));
});

// A run with no snapshot is either working or stuck, and both belong on Now.
// Only this one was drawn before, and the stuck one — the case somebody opens
// the tab to find — was silently absent.
test('a stalled run is shown on Now, and says that it is stalled', () => {
    const sections = [{ id: 'money', title: 'spend', blocks: [{ kind: 'table', rows: [['today', '~$0']] }] }];
    const run = (state, ago) => ({
        runId: 'wf_s', name: 'stuck', state, project: 'p', lastActivity: Date.now() - ago,
        totals: { agents: 2, done: 1, cost: 0 },
        agents: [{ agentId: 'a1', label: '', phase: '', model: 'claude-opus-5', effort: 'xhigh', state: 'running', lastToolName: '', promptPreview: 'go' }],
    });

    const stalled = db.nowTab(sections, [run('abandoned', 30 * 60 * 1000)], {});
    assert.match(stalled, /stuck/);
    assert.match(stalled, /no snapshot/);

    // A run that has not written for a week is history, whatever its state:
    // nothing ever takes one off the disk, and a graveyard is not a status.
    const old = db.nowTab(sections, [run('abandoned', 7 * 24 * 3600 * 1000)], {});
    assert.ok(!/stuck/.test(old));

    // A run that finished twenty minutes ago wrote something in the last hour,
    // so it belongs there too.
    const justDone = db.nowTab(sections, [run('finished', 20 * 60 * 1000)], {});
    assert.match(justDone, /stuck/);
});

// The page says which build drew it, from the manifest the .vsix was built
// from — a screenshot of a dashboard is worth much less when nobody can tell
// whether the window was reloaded after the last install.
test('the page names the version it was built from', () => {
    const manifest = JSON.parse(require('node:fs').readFileSync(`${__dirname}/../package.json`, 'utf8'));
    const html = db.render(demoIndex(), ix.summarize(demoIndex()), { files: 1, lastRun: Date.now(), history: [] });
    assert.ok(html.includes(`v${manifest.version}`), `no v${manifest.version} in the header`);
});

// A tile saying a newer version is unpacked, beside a panel saying there is
// nothing new, is a contradiction on one screen. The cache belongs to the
// client and lags its own releases; the page says which of the two it is.
test('a version on disk without its notes says so, instead of "nothing new"', () => {
    const waiting = db.changelogTab({
        changelog: [],
        versions: { current: '2.1.226', latest: '2.1.227', waiting: true, installed: [] },
    });
    assert.match(waiting, /2\.1\.227 is here, its notes are not/);
    assert.match(waiting, /newest entry there is 2\.1\.226/);
    assert.ok(!/Nothing newer than the version already running/.test(waiting));

    // With nothing waiting, the plain answer is still the plain answer.
    const idle = db.changelogTab({ changelog: [], versions: { current: '2.1.226', installed: [] } });
    assert.match(idle, /Nothing newer than the version already running/);
});

// The changelog has two sources and the tab says which one it is reading. It
// also carries the switch, because the place you notice the notes are thin is
// the place you want to turn the fetch on.
test('the changelog names its source and carries its own switch', () => {
    const local = db.changelogTab({ changelog: [], versions: { current: '2.1.226', installed: [] } }, {});
    assert.match(local, /data-set="fetchChangelog"/);
    assert.match(local, /the client's own copy/);
    assert.ok(!/checked/.test(local.split('data-set="fetchChangelog"')[1].slice(0, 20)));

    const many = Array.from({ length: 80 }, (_, i) => ({ version: `2.1.${200 - i}`, entries: ['x'] }));
    const remote = db.changelogTab({ changelog: many, versions: { current: '2.1.200', installed: [] } },
        { fetchChangelog: true });
    // Newer than the running version: open panels. Everything behind it: one
    // folded list, with the first fifteen visible and a button for the rest.
    // The fixture runs 2.1.200 and its newest release is 2.1.200, so nothing is
    // ahead: the source panel and the folded history are the whole tab.
    assert.equal((remote.match(/class="panel"/g) || []).length, 2);
    // 80 releases, none of them ahead, fifteen shown: the rest are carried folded.
    assert.equal((remote.match(/class="memory folded"/g) || []).length, 80 - 15);
    assert.match(remote, /Show 65 older releases/);
});

// The list used to stop at eighty with nothing on screen saying so, which reads
// as "that is all there was" — and the upstream file is 361 releases deep. The
// only thing allowed to end this list is the source running out.
test('every release the source had reaches the page', () => {
    const all = Array.from({ length: 361 }, (_, i) => ({ version: `2.1.${361 - i}`, entries: ['x'] }));
    const html = db.changelogTab({ changelog: all, versions: { current: '2.1.361', installed: [] } },
        { fetchChangelog: true });
    // The fixture runs its own newest release, so nothing is ahead and all 361
    // are history — one row each.
    assert.equal((html.match(/class="mem-name"/g) || []).length, 361, 'every release the source had is a row');
    assert.match(html, /All 361 releases it had are on this page/);
    assert.ok(html.includes('2.1.1<'), 'the oldest release is drawn, not cut off');
    // The tile is named for what is in front of the running version. It counted
    // every release on the page instead, so a fully up-to-date client was told
    // it had hundreds of releases ahead of it.
    assert.match(html, /Releases ahead[\s\S]{0,200}>0</, 'nothing is ahead of the newest release');
    assert.match(html, /nothing new/);
});

// The switch promised a check and, for one release, performed none: the label
// said the extension "may ask". A panel that says a thing was checked has to
// have checked it.
test('with update checking on, each marketplace reports what the network said', () => {
    const day = 24 * 3600 * 1000;
    const sys = {
        plugins: [], mcp: [], hooks: [], permissions: [], settings: {}, versions: {},
        pluginUpdates: [
            { name: 'a', marketplace: 'official', installed: '1.0.0', available: '1.0.0', declared: true, repo: 'x/y', marketUpdated: Date.now() - 3 * day, installedAt: 0 },
            { name: 'b', marketplace: 'warp', installed: '2.0.0', available: '', declared: false, repo: 'w/z', marketUpdated: Date.now() - day, installedAt: 0 },
        ],
        marketHeads: {
            official: { at: Date.now(), sha: 'abc1234', repo: 'x/y' },
            warp: { at: Date.now() - 2 * day, sha: 'def5678', repo: 'w/z' },
        },
    };
    const html = db.healthTab(ix.summarize(demoIndex()), sys, { checkPluginUpdates: true });
    assert.match(html, /official — <span class="o-stopped">the copy is behind/);
    assert.match(html, /abc1234/);
    assert.match(html, /warp — <span class="ok">the copy is current/);

    // Off, no claim is made about any of them.
    const off = db.healthTab(ix.summarize(demoIndex()), sys, {});
    assert.match(off, /Nothing is asked of the network/);
    assert.ok(!/the copy is behind|the copy is current/.test(off));
});

// A tooltip painted only from a theme variable a webview may never have been
// given is a transparent tooltip, and a transparent tooltip is the row
// underneath read through the row above. The opaque base is not decoration.
test('the hover panel has an opaque base under whatever the theme provides', () => {
    const rule = db.STYLE.split('[data-clipped]:hover::after')[1].split('}')[0];
    assert.match(rule, /background-color:\s*var\(--vscode-editor-background\)/);
    // And the theme's own colour rides on top rather than replacing it.
    assert.match(rule, /background-image:\s*linear-gradient\(var\(--vscode-editorHoverWidget-background/);
});

// What a session starts with is not what the status bar does, and four fields
// about one command line read as a list of unrelated switches when they sit
// among them. They get a panel, and the panel comes before the bar's own.
// What a session starts with is not a setting of this extension — it is what the
// extension hands the client — so it has a tab rather than a panel at the foot
// of one. Settings keeps the bar, the network and the behaviour; Launch keeps
// the command line.
test('what a session starts with is a tab of its own, not a panel in Settings', () => {
    const settings = db.settingsTab({ segments: ['{today}'], palette: [], presets: [] });
    const launch = db.launchTab({ model: 'opus[1m]', effort: 'max', advisor: 'fable' }, {});

    for (const mark of ['name="model"', 'name="effort"', 'name="advisor"', 'id="launchArgs"', 'name="openLocation"']) {
        assert.ok(launch.includes(mark), `${mark} belongs on the launch tab`);
        assert.ok(!settings.includes(mark), `${mark} should have left the settings tab`);
    }
    // Settings keeps what is genuinely the extension's own.
    for (const mark of ['Status bar', 'Reading and the network', 'Behaviour']) {
        assert.ok(settings.includes(mark), `${mark} stays in Settings`);
    }
    // Each choice on the launch tab is a panel, so each carries its own sentence
    // rather than sharing one paragraph with five others.
    for (const title of ['Where it opens', 'Model', 'Effort', 'Advisor', 'Output style', 'Extra arguments']) {
        assert.ok(launch.includes(`>${title}</h2>`), `${title} needs a panel of its own`);
    }
    assert.match(launch, /<section class="tab" data-tab="launch"/);
});

// Every option here is a name that does not explain itself — `xhigh` against
// `max`, `best` against `opusplan`, `opus` against `fable`. The descriptions are
// the client's own words; the rates and windows are what the choice costs.
test('every launch option says what it is for', () => {
    const launch = db.launchTab({ model: 'opus[1m]' }, {});
    assert.match(launch, /Best for everyday, complex tasks/);
    assert.match(launch, /Most capable for your hardest and longest-running tasks/);
    assert.match(launch, /Fastest for quick answers/);
    // `best` is about who has access, not about the task — the manifest said
    // otherwise for months.
    assert.match(launch, /Fable where your organization has access to it/);
    assert.ok(!/whichever the client considers best for the task/i.test(launch));
    // opusplan costs two rates and drops the cache when it switches.
    assert.match(launch, /\$5\/\$25 → \$2\/\$10/);
    assert.match(launch, /drops the prompt cache/);
    // Concise shipped in 2.1.237 and has to be offered like the rest.
    assert.match(launch, /Leads with the result and skips preamble/);

    // No option is left without a sentence. The description carries an optional
    // `data-base` attribute now, so the match has to allow one.
    const names = (launch.match(/class="card-name">([^<]*)</g) || []).length;
    const abouts = (launch.match(/class="card-about"[^>]*>([^<]*)</g) || []).length;
    assert.equal(names, abouts, 'an option was drawn without its description');
});

// The client refuses an advisor that ranks below the model it advises. The page
// knows the rule, so it can say which pairings are dead before the client does —
// and it strikes them through rather than hiding them, because a vanished option
// is a puzzle.
test('the advisor list is ranked against the model the session starts on', () => {
    const onOpus = db.launchTab({ model: 'opus[1m]', advisor: 'fable' }, {});
    assert.match(onOpus, /below Opus 5 — the client refuses this pair/);
    assert.match(onOpus, /the only tier above Opus 5/);
    assert.match(onOpus, /a second Opus reviews the first/);
    // Struck through, not removed: all five options are still drawn.
    assert.equal((onOpus.match(/name="advisor"/g) || []).length, 5);
    assert.equal((onOpus.match(/card-off/g) || []).length, 2, 'sonnet and haiku rank below opus');

    // On a fable session only fable survives; on haiku nothing is refused.
    const onFable = db.launchTab({ model: 'fable' }, {});
    assert.equal((onFable.match(/card-off/g) || []).length, 3);
    const onHaiku = db.launchTab({ model: 'haiku' }, {});
    assert.equal((onHaiku.match(/card-off/g) || []).length, 0);

    // With no model chosen there is nothing to rank against, so nothing is struck.
    const noModel = db.launchTab({}, {});
    assert.equal((noModel.match(/card-off/g) || []).length, 0);
});

// Ranking the advisor list against the model is only useful while you are
// choosing: picking Opus and watching sonnet stay live until the page is next
// drawn is worse than not ranking at all, because the page looked as though it
// had checked. The rule runs in the page, on the same event that changes the
// model.
test('choosing a model re-ranks the advisor list in the page', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()), {
        files: 1, lastRun: Date.now(), history: [],
        config: { segments: [], defaults: [], presets: [], palette: [] },
    });
    const script = html.slice(html.lastIndexOf('<script>'));

    // The pieces the page needs to do it without asking the extension.
    assert.match(html, /data-tier="opus"/);
    assert.match(html, /data-rank="4"[^>]*>|data-rank="4"/);
    assert.match(html, /data-real="Opus 5"/);

    // And a handler that fires on the model choice.
    assert.match(script, /name="model"/);
    assert.match(script, /rankAdvisors|reRank/);
    // It must be able to both strike an option out and put it back — a one-way
    // pass would leave sonnet dead after a single visit to Opus.
    assert.match(script, /disabled = /);
});

// Save is one form spread over two tabs. The values were always collected from
// the whole page — `picked()` queries the document — but the listener that lit
// the button was bound to the settings tab alone, so a model chosen on Launch
// left Save disabled and there was no way to write it. A test on the markup
// cannot see that: both bars render, and only the subscription is missing.
test('both save bars are wired, and the form covers both tabs', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()), {
        files: 1, lastRun: Date.now(), history: [],
        config: { segments: [], defaults: [], presets: [], palette: [] },
    });
    const script = html.slice(html.lastIndexOf('<script>'));

    // Two bars on the page, one per tab that edits settings.
    assert.equal((html.match(/class="save-bar"/g) || []).length, 2);
    // Bound by class, so a third bar would be wired by existing code rather than
    // needing a third id nobody remembers to add.
    assert.ok(!/getElementById\('save'\)/.test(script), 'a single id cannot reach two bars');
    assert.match(script, /querySelectorAll\('\.save-go'\)/);
    assert.match(script, /querySelectorAll\('\.dirty'\)/);

    // Every tab that carries an input is listened to, not just the first.
    for (const tab of ['settings', 'launch']) {
        assert.ok(script.includes(`data-tab="${tab}"`), `${tab} must be part of the form`);
    }
    // And the elements the script looks for actually exist in the markup.
    for (const cls of ['save-go', 'dirty', 'saved']) {
        assert.ok(new RegExp(`class="[^"]*\\b${cls}\\b`).test(html), `nothing carries .${cls}`);
    }
});

// Save belongs to the whole tab, not to whichever panel it happened to be
// written into — it was the last field of "Behaviour", which reads as though it
// saved that panel alone. And a form that says nothing about having been edited
// leaves the reader to remember: the bar carries the state instead.
test('save sits outside the panels and says when there is something to save', () => {
    const html = db.settingsTab({ segments: ['{today}'], palette: [], presets: [] });
    const bar = html.indexOf('class="save-bar"');
    assert.ok(bar > 0, 'the bar must exist');
    // Every panel opened before it has also been closed before it — which is
    // what "outside the panels" means, and what comparing against the last
    // `</section>` in the whole page does not test: that one closes the tab.
    const before = html.slice(0, bar);
    assert.ok(before.lastIndexOf('</section>') > before.lastIndexOf('<section class="panel"'),
        'the bar sits between the panels and the end of the tab, not inside a panel');
    for (const mark of ['class="btn primary save-go"', 'name="scope"', 'class="dirty"']) {
        assert.ok(html.indexOf(mark) > bar, `${mark} belongs to the bar`);
    }
    // Nothing has been touched yet, so there is nothing to save.
    // Bound by class, not id: the same bar is rendered on two tabs now, and an
    // id can only ever reach one of them.
    assert.match(html.slice(bar), /<button class="btn primary save-go" disabled>/);
});

// Groups of meters that follow one another are different kinds of fact — a
// total, its parts, the remainder — and without a rule between them they read as
// one undifferentiated list. Keyed on `.rows + .rows`, so it needs the blocks to
// be adjacent in the markup, which is the half a stylesheet cannot promise on
// its own.
test('adjacent meter groups are separated by a rule', () => {
    const rule = db.STYLE.split('.rows + .rows')[1].split('}')[0];
    assert.match(rule, /border-top:/);
    const html = db.sidebarNow([{
        id: 'context',
        title: 'opus 5',
        blocks: [
            { kind: 'meters', rows: [{ label: 'window', value: '92%', pct: 92, note: '928k / 1M' }] },
            { kind: 'meters', rows: [{ label: 'memory', value: '~7%', pct: 7, note: '70k' }] },
            { kind: 'meters', rows: [{ label: 'free', value: '7.2%', pct: 7.2, note: '72k' }] },
        ],
    }], 'session');
    // Three groups in a row, with nothing between them for the rule to miss.
    assert.equal((html.match(/<div class="rows">/g) || []).length, 3);
    assert.doesNotMatch(html, /<\/div><h3/, 'nothing separates the groups but the rule itself');
});

// The inputs on this tab were styled through `.form`, a class the page never
// puts on anything — so they fell back to the browser's own control, which under
// `color-scheme: light dark` is drawn dark whatever the page's theme is. On a
// light theme that is a black box among white fields; the screenshot for the
// listing is what showed it.
test('the settings inputs are painted from the theme, not left to the browser', () => {
    const html = db.settingsTab({ segments: ['{today}'], palette: [], presets: [] });
    assert.equal(/class="[^"]*\bform\b/.test(html), false, 'nothing carries the class the old rules keyed on');
    const rule = db.STYLE.split('.field select, .field input')[1].split('}')[0];
    assert.match(rule, /background:\s*var\(--vscode-input-background/);
    assert.match(rule, /color:\s*var\(--vscode-input-foreground/);
});

// A text input with no width of its own is whatever the browser makes it —
// about twenty characters, which is not enough to see one flag, let alone
// several. The number fields beside it are narrow on purpose and this one must
// not inherit that.
test('the extra-arguments field is given room to type in', () => {
    const html = db.launchTab({ segments: ['{today}'] }, {});
    const input = html.match(/<input[^>]*id="launchArgs"[^>]*>/);
    assert.ok(input, 'the field must be on the page at all');
    assert.match(input[0], /class="[^"]*\bwide\b/);
    // Keyed on the container the field actually sits in. The first attempt wrote
    // `.form input.wide`, which is a rule this page never matches — a test on the
    // text of the stylesheet passes just the same, and only the rendered page
    // says the field is still 147 pixels wide. On the launch tab it sits
    // directly in the panel body, so the rule has to name that container too.
    const rule = db.STYLE.split('.panel-body > input.wide')[1].split('}')[0];
    assert.match(rule, /width:\s*100%/);
    const before = html.slice(0, html.indexOf('id="launchArgs"'));
    assert.ok(before.lastIndexOf('class="panel-body"') > before.lastIndexOf('<section class="panel'),
        'the field must sit directly in the panel body the rule is keyed on');
});

// Most plugins live inside the marketplace repository, so their update is the
// marketplace's and there is no second version to compare. The row says which
// of the two it is rather than leaving a reader to infer it from a line above.
test('every plugin row says where its update would come from', () => {
    const day = 24 * 3600 * 1000;
    const sys = {
        plugins: [], mcp: [], hooks: [], permissions: [], settings: {}, versions: {},
        pluginUpdates: [
            { name: 'inside', marketplace: 'official', installed: '1.0.0', available: '1.0.0', declared: true, repo: 'x/y', origin: '', marketUpdated: Date.now() - 3 * day, installedAt: 0 },
            { name: 'own-repo', marketplace: 'official', installed: 'abc', available: '', declared: false, repo: 'x/y', origin: 'https://github.com/o/p.git', marketUpdated: Date.now() - 3 * day, installedAt: 0 },
            { name: 'outdated', marketplace: 'official', installed: '1.0.0', available: '2.0.0', declared: true, repo: 'x/y', origin: '', marketUpdated: Date.now() - 3 * day, installedAt: 0 },
        ],
        marketHeads: { official: { at: Date.now(), sha: 'abc1234', repo: 'x/y' } },
    };
    const on = db.healthTab(ix.summarize(demoIndex()), sys, { checkPluginUpdates: true });
    assert.match(on, /the marketplace, and it has moved/);
    assert.match(on, /its own repository/);
    assert.match(on, /a newer version, 2\.0\.0/);
    assert.match(on, /1 plugin here live in a repository of their own/);

    // Unchecked, no row claims to know anything about the marketplace.
    const off = db.healthTab(ix.summarize(demoIndex()), sys, {});
    assert.match(off, /the marketplace — not checked/);
    assert.ok(!/and it has moved|which is current/.test(off));
});

// A note is a div because notes carry lists. Inside a <p> the parser closes the
// paragraph before the <ul>, and every sentence after the list becomes a
// sibling of the panel — outdented, and no longer a note.
test('a panel note can hold a list without falling out of the panel', () => {
    const html = db.panel('t', '<i>body</i>', { note: 'before<ul><li>x</li></ul>after' });
    assert.match(html, /<div class="panel-note">before<ul>/);
    assert.ok(!/<p class="panel-note">/.test(html));

    // And nowhere on the real page is a note a paragraph either.
    const page = db.render(demoIndex(), ix.summarize(demoIndex()), { files: 1, lastRun: Date.now(), history: [] });
    assert.ok(!/<p class="panel-note">/.test(page));
});

// The header button and the switch on the Settings tab are one setting with two
// controls. Two names for it would be two states, and the pair would agree only
// until someone used the one further from the code they were reading.
test('pausing the timer from the header is the same setting as the switch', () => {
    const page = (autoRefresh) => db.render(demoIndex(), ix.summarize(demoIndex()), {
        files: 1, lastRun: Date.parse('2026-08-11T04:00:00Z'), history: [],
        config: { autoRefresh, refreshInterval: 60, segments: [], defaults: [], presets: [], palette: [] },
    });

    const on = page(true);
    assert.match(on, /<button id="pause" class="btn head-btn" data-on="1"/);
    // The deadline and the interval both reach the script: after a pause the
    // countdown has to be restarted from now, and the markup's own deadline is
    // by then however long the pause lasted out of date.
    assert.match(on, /id="next" data-next="\d+" data-every="60"/);
    // The countdown lives inside the freshness pill, so the two facts about the
    // index — when it was built, when it will be — share one element rather
    // than standing beside each other saying the same thing twice.
    assert.match(on, /<span class="pill" id="idx" title="Last built [^"]+">\d\d:\d\d<i id="next"/);
    // Pausing colours the control and empties the countdown; the script does
    // both, and the page is never rebuilt on the way into a pause.
    assert.match(on, /pauseEl\.classList\.toggle\('held', !on\)/);
    assert.match(on, /if \(!on\) \{ nextEl\.textContent = ''; return; \}/);

    // Off is the same button in the other position, not a different control and
    // not a sentence where a control used to be.
    assert.match(page(false), /<button id="pause" class="btn head-btn" data-on="0"/);

    // Both controls write claudeStatusline.autoRefresh, and the script keeps
    // them in step in both directions.
    assert.match(on, /key: 'autoRefresh'/);
    assert.match(on, /input\[data-set="autoRefresh"\]/);
    assert.match(on, /<input[^>]*data-set="autoRefresh"/);
});

// The version is on every screenshot, because it is in the header of every tab —
// so `--demo` strips it, or a listing image goes stale on each bump rather than
// on each change to what it shows. That strip is a string replacement in another
// file, and it broke silently the day the version moved from its own `.ver`
// span into a pill: the header kept rendering, the tests kept passing, and
// v0.38.0 was photographed for the marketplace. The anchor is now an attribute
// nothing else uses, and this test holds the two files to it.
test('the version carries the anchor --demo strips it by', () => {
    const page = db.render(demoIndex(), ix.summarize(demoIndex()), { files: 1, lastRun: Date.now(), history: [] });
    const head = (page.match(/<header class="page-head">[\s\S]*?<\/header>/) || [''])[0];
    assert.match(head, /<span class="pill" data-version>v[^<]+<\/span>/);

    const preview = require('node:fs').readFileSync(`${__dirname}/../tools/preview.js`, 'utf8');
    assert.ok(preview.includes('data-version'), 'tools/preview.js no longer strips by data-version');
});

// The header row carries both kinds of thing the page has: facts, which are
// pills, and controls, which are buttons. The first version of it drew the
// controls as pills with a cursor — same font size, same 999px radius, same 9%
// fill — so the row said "state, state, state, state" and the two things you
// could actually press were found by reading them. A button here is the page's
// own `.btn`, the one `Save` and `Add segment` use, and a hairline says where
// the reading stops and the pressing starts.
test('the header presses with the same buttons as the rest of the page', () => {
    const page = db.render(demoIndex(), ix.summarize(demoIndex()), {
        files: 1, lastRun: Date.parse('2026-08-11T04:00:00Z'), history: [],
        config: { autoRefresh: true, refreshInterval: 60, segments: [], defaults: [], presets: [], palette: [] },
    });
    const head = (page.match(/<header class="page-head">[\s\S]*?<\/header>/) || [''])[0];
    assert.ok(head, 'the page has a header');

    // Both controls are `.btn`, and the one that does the work is `primary` —
    // the same pair of classes Save carries at the bottom of Setup.
    assert.match(head, /<button id="pause" class="btn head-btn"/);
    assert.match(head, /<button id="refresh" class="btn head-btn primary"/);
    assert.match(page, /<button class="btn primary save-go"/);

    // The hairline sits between the last fact and the first control, not at
    // either end of the group: that is the whole of what it says.
    // The class has to end where the name does, or the `.pills` container that
    // holds them counts as a fourth pill.
    const order = [...head.matchAll(/class="(pill|head-sep|btn)(?: [^"]*)?"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['pill', 'pill', 'pill', 'head-sep', 'btn', 'btn']);

    // And every class the header invents has rules behind it. The version this
    // replaced shipped `class="link"` on a live button with no rule anywhere in
    // the stylesheet, which is a thing only a test can notice: an unstyled
    // button still renders, just as the browser's own.
    for (const cls of ['.head-btn', '.head-sep']) {
        assert.ok(db.STYLE.includes(cls), `${cls} has no rule in dashboard.css`);
    }
});

// The 50/80 thresholds are a port of `color_for` in statusline.sh, and CLAUDE.md
// asks both sides to keep producing the same answer. Nothing held them: the
// shell was read by hand today, and a hand-read leaves no trace that fails when
// one of the two drifts. Boundaries on both sides of each step, because an
// off-by-one here is exactly what a `>` for a `>=` produces.
test('the meter thresholds are the ones statusline.sh colours by', () => {
    assert.equal(db.meterTone(0), 'cool');
    assert.equal(db.meterTone(49), 'cool');
    assert.equal(db.meterTone(50), 'warm', '50 is the first warm value, as in color_for');
    assert.equal(db.meterTone(79), 'warm');
    assert.equal(db.meterTone(80), 'hot', '80 is the first hot value, as in color_for');
    assert.equal(db.meterTone(100), 'hot');
});

// The rebuild is what replaces the document, so a counter that has run out and
// is still on screen means the tick never came — the panel was behind another
// tab, or the settings editor was open. It used to wait for that replacement
// forever, which is what the reader saw: "refreshing…" from the moment the tab
// went into the background until it came back.
test('the countdown rolls over instead of waiting for a rebuild that was skipped', () => {
    const now = Date.parse('2026-08-12T13:31:00Z');
    const every = 60_000;

    // Counting down: the deadline is untouched.
    const ahead = db.countdown(now + 42_000, now, every);
    assert.deepEqual(ahead, { text: 'next in 42s', due: now + 42_000 });

    // Just past it, a rebuild really may be running — it reads every transcript
    // and asks the marketplace, which is seconds, not milliseconds.
    assert.equal(db.countdown(now - 3_000, now, every).text, 'refreshing…');
    assert.equal(db.countdown(now - 3_000, now, every).due, now - 3_000, 'and the deadline still stands');

    // Past the grace nothing is coming: the deadline moves to the next tick.
    const rolled = db.countdown(now - 30_000, now, every);
    assert.equal(rolled.text, 'next in 60s');
    assert.equal(rolled.due, now + every);

    // A minute later it is counting down again rather than stuck.
    assert.equal(db.countdown(rolled.due, now + 20_000, every).text, 'next in 40s');
});

// The function above is the page's, not the module's: its source is interpolated
// into the script the webview runs. Exported only so it can be tested — a test
// that never checks it reached the page would pass over a page that lost it.
test('the countdown the page runs is the one under test', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()), {
        files: 1, lastRun: Date.now(), history: [],
        config: { autoRefresh: true, refreshInterval: 60, segments: [], defaults: [], presets: [], palette: [] },
    });
    assert.match(html, /function countdown\(due, now, every/);
    assert.match(html, /const state = countdown\(due, Date\.now\(\), every\);/);
});

// The env panels of the Claude Code tab. Both complaints that produced this were
// about the same markup: the sentence lived in a `title`, where the browser drew
// all of it on one line over the panel beside it, and the documented default was
// nowhere on the page at all.
test('an env variable says what it does on the page, and what it would be unset', () => {
    const html = db.clientTab({
        checkedAt: '2026-08-13',
        chain: [], set: [], unknown: [], differs: [], unset: [],
        env: {
            fromSettings: [{
                key: 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
                value: '40',
                known: true,
                description: 'How many subagents can run at once (default: 20).',
                default: '20',
                differs: true,
            }],
            fromHost: [],
            shadowed: [],
        },
        counts: { set: 0, unknown: 0, differs: 0, unset: 0 },
    });

    assert.match(html, /How many subagents can run at once/, 'the sentence is on the page, not in a tooltip');
    assert.match(html, /default 20/);
    assert.ok(!/title="How many subagents/.test(html), 'the description is no longer a native tooltip');
    // A value that is not the documented one is marked, the same red the
    // settings table uses for the same fact.
    assert.match(html, /envrow-def o-failed/);
});

test('a window too young to judge states the share and nothing about pace', () => {
    // Twenty minutes in, 1% spent, plan 0%: every fraction of a percent is
    // "over", and a week would open on an alarm about nothing.
    const fresh = db.paceTrack(week({ pct: 1, plan: 0, at: NOON + 20 * 60, dryAt: null }));
    assert.match(fresh, /1% spent/);
    assert.ok(!/over|under/.test(fresh.replace(/wk-over|wk-under/g, '')), 'no verdict yet');
    assert.ok(!fresh.includes('plan 0%'), 'and no mark claiming what was allowed');

    // An hour in and past 2%, the comparison starts — as its own pill, with the
    // plan getting one too and wearing the colour of the line it names.
    const settled = db.paceTrack(week({ pct: 3, plan: 1, at: NOON + 3600, dryAt: null }));
    assert.match(settled, /class="pill">3% spent</);
    assert.match(settled, /class="pill pill-warn">2% over</);
    assert.match(settled, /<i class="pill-dot" style="background:var\(--vscode-foreground\)"><\/i>plan 1%/);
});

// The defect this pins: `plan` is floored to a whole percent by pace(), so a
// zone drawn to it stopped short of the mark it is measured against — visible
// as daylight between the fill and the line at the width the page renders at.
test('the zone always reaches the mark, whatever the printed plan rounds to', () => {
    // 6.43% of the week elapsed, reported as a plan of 6%.
    const at = NOON + Math.round(0.0643 * WEEK_S);
    for (const pct of [3, 5, 9, 20, 62, 100]) {
        const html = db.paceTrack(week({ pct, plan: 6, at, dryAt: null }));
        const mark = leftOf(html, 'wk-now');
        const zone = html.includes('wk-slack') ? 'wk-slack' : 'wk-excess';
        const edge = pct < 6.43 ? leftOf(html, zone) + widthOf(html, zone) : leftOf(html, zone);
        assert.ok(Math.abs(edge - mark) < 0.02, `${pct}%: the ${zone} edge sits ${edge} against a mark at ${mark}`);
    }
});

// The listing's own sentence about itself. It said "23-tab" for the whole of
// 0.42.0's development, because the count lives in prose and the tabs live in
// SECTIONS, and nothing joined them — the number was noticed in an Open VSX API
// response after the release had already gone out.
test('the marketplace description counts the tabs the page actually has', () => {
    const manifest = JSON.parse(require('node:fs').readFileSync(`${__dirname}/../package.json`, 'utf8'));
    const tabs = db.SECTIONS.reduce((n, [, , list]) => n + list.length, 0);
    const claimed = manifest.description.match(/(\d+)-tab/);
    assert.ok(claimed, `the description no longer says "<n>-tab": ${manifest.description}`);
    assert.equal(Number(claimed[1]), tabs);
});

// A style of your own used to be reachable only by typing its name into the
// extra arguments, which meant reading a directory listing to find out what it
// was called. The panel offers what is on disk, in its own block under the
// client's five, and both blocks are one radio group so the choice stays
// exclusive.
const STYLE_FIXTURE = [
    { name: 'Proactive & concise', description: 'Result first, no preamble', keepCoding: true },
    { name: 'data-analyst', description: '', keepCoding: false },
];

test('output styles of your own are offered beside the built-in ones', () => {
    const launch = db.launchTab({}, {}, STYLE_FIXTURE);
    // The client's own are still there.
    assert.match(launch, /value="Explanatory"/);
    // And so is what is on disk, named the way the client names it.
    assert.match(launch, /value="Proactive &amp; concise"/);
    assert.match(launch, /Result first, no preamble/);
    assert.match(launch, /value="data-analyst"/);
    // One group, so picking a custom style clears the built-in one.
    const groups = (launch.match(/name="outputStyle"/g) || []).length;
    assert.equal(groups, 8, 'five built-in plus the blank plus two of your own, all one group');
});

// The directory is the whole of the feature's discoverability: somebody with no
// styles yet has no way to learn where they go, so the sentence is there
// whether or not the list is empty.
test('the panel says where your own styles live, with or without any', () => {
    for (const styles of [[], STYLE_FIXTURE]) {
        const launch = db.launchTab({}, {}, styles);
        assert.match(launch, /~\/\.claude\/output-styles/,
            `the path belongs on the panel with ${styles.length} styles`);
        // And it no longer sends you to the extra arguments to name one: that
        // was the only route before this panel offered them, and it is wrong now.
        assert.ok(!/through the extra arguments/i.test(launch),
            'the note still routes custom styles through launchArgs');
    }
});

// The heading pill reads the chosen value back. It looked only at the built-in
// list, so a custom style — the one case where the name is not obvious — showed
// as nothing at all.
test('the heading pill names a custom style, not only a built-in one', () => {
    const launch = db.launchTab({ outputStyle: 'Proactive & concise' }, {}, STYLE_FIXTURE);
    const head = launch.slice(launch.indexOf('>Output style</h2>'));
    assert.match(head.slice(0, 400), /Proactive &amp; concise/);
});

// `keep-coding-instructions` defaults to false, and a style without it drops
// Claude Code's engineering instructions entirely. That is worth knowing before
// the session starts rather than after it answers.
test('a custom style that drops the coding instructions says so', () => {
    const launch = db.launchTab({}, {}, STYLE_FIXTURE);
    const analyst = launch.slice(launch.indexOf('value="data-analyst"'));
    assert.match(analyst.slice(0, 500), /coding instructions/i);
    const proactive = launch.slice(launch.indexOf('value="Proactive &amp; concise"'));
    assert.ok(!/coding instructions/i.test(proactive.slice(0, 260)),
        'a style that keeps them needs no warning');
});

// The Launch tab's Extra arguments field sits directly in a panel body, not
// inside a `field()`, so the rule that paints inputs from the theme missed it
// and the browser drew its own control — black on a light page. It shipped that
// way in 0.42.0 and stood in the listing screenshot. The width rule beside it
// already named both containers; the colour rule named one.
test('an input painted from the theme covers both containers it appears in', () => {
    // Every rule that hands an input the theme's input background.
    const rules = [...db.STYLE.matchAll(/([^{}]+)\{([^}]*--vscode-input-background[^}]*)\}/g)]
        .map(([, selector]) => selector.trim().replace(/\s+/g, ' '));
    assert.ok(rules.length, 'no rule paints an input from the theme at all');
    // Any input inside a panel, not one nesting depth of them: the child
    // combinator covered the field that sat directly in a panel body and missed
    // the next one the moment it was wrapped in a row of its own. The rule that
    // does not have to be revisited is the descendant one.
    assert.ok(rules.some((sel) => /\.panel-body input/.test(sel)),
        `the theme colours reach only: ${rules.join(' | ')}`);
});

// The manifest sent people to launchArgs to name a style of their own, which
// was the only route before the panel offered them. It reads as the documented
// way to do it, so it has to stop saying that the moment the panel exists.
test('the manifest no longer routes custom styles through the extra arguments', () => {
    const manifest = JSON.parse(require('node:fs').readFileSync(`${__dirname}/../package.json`, 'utf8'));
    const doc = manifest.contributes.configuration.properties['claudeStatusline.outputStyle'].markdownDescription;
    assert.ok(!/launchArgs/.test(doc), `the setting still points at launchArgs:\n${doc}`);
    assert.match(doc, /output-styles/, 'it should say where a style of your own lives');
});

// A style can be chosen and its file deleted afterwards. The name still travels
// to the client, which ignores what it cannot find, so the panel has to keep
// showing what is set rather than falling back to a bare `style`.
test('the heading pill shows a chosen style whose file has gone', () => {
    const launch = db.launchTab({ outputStyle: 'Deleted style' }, {}, []);
    const head = launch.slice(launch.indexOf('>Output style</h2>'));
    assert.match(head.slice(0, 400), /Deleted style/);
});

// The command the button will run, written out. Reading six panels and working
// out what they add up to is exactly the sum a person cannot do in their head,
// and the answer is also the thing you want to paste into a terminal on another
// machine. It is shown, never typed into: the panels above are the controls, and
// a line you could edit would raise the question of which one wins.
test('the launch tab writes out the command it would run', () => {
    const launch = db.launchTab({
        model: 'opus[1m]', effort: 'max', advisor: 'fable',
        outputStyle: 'Explanatory', launchArgs: '--permission-mode acceptEdits',
    }, {}, []);
    // Exactly what the terminal receives, quoting included — `esc` leaves the
    // shell's single quotes alone and only the JSON's double quotes are escaped.
    assert.match(launch, /claude --model 'opus\[1m\]' --effort 'max' --advisor 'fable'/);
    assert.match(launch, /--settings '\{&quot;outputStyle&quot;:&quot;Explanatory&quot;\}' --permission-mode acceptEdits/);
});

test('the command line is shown rather than edited, and can be copied', () => {
    const launch = db.launchTab({ model: 'opus' }, {}, []);
    const panel = launch.slice(launch.indexOf('data-panel="command"'));
    // The panel itself, not what follows it: the save bar below carries the
    // scope radios, and a window wide enough to reach them finds an input that
    // is nothing to do with this line.
    const block = panel.slice(0, panel.indexOf('</section>'));
    assert.match(block, /<code[^>]*id="launchCommand"/, 'the command needs an element of its own');
    // The claim is about the line, not the panel: the alias below it is named in
    // a field, which is a control like any other. What must never become typable
    // is the command itself, or which of the two wins becomes a question.
    const line = block.slice(block.indexOf('id="launchCommand"'));
    assert.ok(!/<input|<textarea/.test(line.slice(0, line.indexOf('</code>'))),
        'the command must not be an editable field');
    assert.match(block, /data-copy/, 'no way to copy it');
});

// Left alone, every choice passes no flag — so the line is the bare command
// rather than a sentence about there being nothing to show.
test('with nothing chosen the command is just claude', () => {
    const launch = db.launchTab({}, {}, []);
    const panel = launch.slice(launch.indexOf('data-panel="command"'));
    assert.match(panel.slice(0, 400), />claude</);
});

// The page has to ask for a fresh line when a choice changes and copy it when
// the button is pressed. Both are script, which a rendered page cannot prove —
// what it can prove is that the wiring is present at all, which is what went
// missing the day `acquireVsCodeApi` was called twice and the whole editor died
// quietly.
test('the page asks for a fresh command and hands it over on request', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()),
        { files: 1, lastRun: Date.now(), history: [], system: demoSystem(), config: { presets: [], palette: [] } });
    assert.match(html, /type: 'launchPreview'/, 'nothing ever asks for the line');
    assert.match(html, /msg\.type === 'launchPreview'/, 'nothing listens for the answer');
    assert.match(html, /data-copy/, 'the copy button is not wired');
    assert.match(html, /type: 'copy'/, 'copying never reaches the editor');
});

// The two buttons beside the alias line have to follow the field, not the
// render. Only Copy was ever re-enabled, so a page drawn with a name kept a live
// **Write** button after the field was emptied — which is how a blank reached a
// shell file — and a page drawn without one kept a dead button after a name was
// typed.
test('both alias buttons follow the field, not the state they were drawn in', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()),
        { files: 1, lastRun: Date.now(), history: [], system: demoSystem(), config: { presets: [], palette: [] } });
    const handler = html.slice(html.indexOf("msg.type === 'launchPreview'"));
    const body = handler.slice(0, handler.indexOf("msg.type === 'preview'"));
    assert.match(body, /data-copy="launchAlias"/, 'the copy button is not followed');
    assert.match(body, /data-install-alias/, 'the write button keeps the state it was drawn in');
});

// The same command as a shell alias, for the times the session is started
// outside the editor. The naive `alias name='<command>'` does not survive our
// own quoting — the inner quotes close the outer ones and zsh answers
// `no matches found: opus[1m]`, the very failure the quoting exists to prevent —
// so the whole command is quoted again on the way in.
test('the alias line survives the quoting the command already carries', () => {
    const line = db.aliasLine('cvs', {
        model: 'opus[1m]', effort: 'max', outputStyle: 'Explanatory',
        args: '--permission-mode acceptEdits',
    });
    assert.equal(line,
        `alias cvs='claude --model '\\''opus[1m]'\\'' --effort '\\''max'\\'' `
        + `--settings '\\''{"outputStyle":"Explanatory"}'\\'' --permission-mode acceptEdits'`);
});

test('an alias with no name is no alias at all', () => {
    assert.equal(db.aliasLine('', { model: 'opus' }), '');
    assert.equal(db.aliasLine('   ', { model: 'opus' }), '');
});

// A name is typed by hand into a shell, so it is held to what a shell will
// accept as one: anything else would produce a line that cannot be sourced.
test('a name a shell would refuse is refused here', () => {
    assert.equal(db.aliasLine('my alias', { model: 'opus' }), '');
    assert.equal(db.aliasLine("bad';rm -rf /", { model: 'opus' }), '');
    assert.match(db.aliasLine('claude-vs', { model: 'opus' }), /^alias claude-vs=/);
    assert.match(db.aliasLine('cx_2', { model: 'opus' }), /^alias cx_2=/);
});

test('the launch tab shows the alias beside the command, with its own copy', () => {
    const launch = db.launchTab({ model: 'opus', aliasName: 'claude-vs' }, {}, []);
    const panel = launch.slice(launch.indexOf('data-panel="command"'));
    const block = panel.slice(0, panel.indexOf('</section>'));
    assert.match(block, /alias claude-vs=/, 'the alias line is not drawn');
    assert.match(block, /id="launchAlias"/, 'the alias needs an element of its own');
    assert.match(block, /data-copy="launchAlias"/, 'the alias cannot be copied');
    assert.match(block, /id="aliasName"/, 'there is nowhere to name it');
});

// The name is saved like the rest of the launch choices, and the alias follows
// the command as it changes — a line that lagged behind the panels above it
// would be worse than none, because it looks authoritative.
test('the alias name is part of what the page saves and asks about', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()),
        { files: 1, lastRun: Date.now(), history: [], system: demoSystem(), config: { presets: [], palette: [] } });
    assert.match(html, /aliasName: /, 'the name is never saved');
    assert.match(html, /msg\.aliasLine|aliasOut/, 'nothing shows the answer');
});

// Writing into a shell file somebody else wrote and maintains. The rule is that
// everything outside our own markers comes back byte for byte: this file holds
// aliases the user tends by hand, and a feature that rearranged them once would
// never be trusted again.
const RC = [
    '# my shell', 'export EDITOR=vim', '',
    "alias cx='claude --effort max'", "alias cxf='claude --model fable'", '',
].join('\n');

test('the alias is added to a shell file without disturbing a line of it', () => {
    const out = db.withAliasBlock(RC, "alias cvs='claude --model opus'");
    assert.ok(out.startsWith(RC.trimEnd()), 'the file that was there must survive intact');
    assert.match(out, /alias cvs='claude --model opus'/);
    assert.match(out, /# >>> claude-dashboard >>>[\s\S]*# <<< claude-dashboard <<</);
});

test('writing it twice leaves one block, not two', () => {
    const once = db.withAliasBlock(RC, "alias a='claude'");
    const twice = db.withAliasBlock(once, "alias b='claude --effort max'");
    assert.equal((twice.match(/>>> claude-dashboard >>>/g) || []).length, 1);
    assert.match(twice, /alias b='claude --effort max'/);
    assert.ok(!twice.includes("alias a='claude'"), 'the old alias is still there');
});

test('an empty line removes the block and leaves the file as it was', () => {
    const withBlock = db.withAliasBlock(RC, "alias a='claude'");
    const cleared = db.withAliasBlock(withBlock, '');
    assert.equal(cleared.trimEnd(), RC.trimEnd());
    assert.ok(!cleared.includes('claude-dashboard'), 'a marker was left behind');
});

// The user's own aliases sit in this file. Anything of theirs that happens to
// mention us is still theirs.
test('a line of the user own that mentions the extension is not touched', () => {
    const theirs = `${RC}\n# claude-dashboard is a vscode extension\nalias mine='claude --model haiku'\n`;
    const out = db.withAliasBlock(theirs, "alias ours='claude'");
    assert.match(out, /# claude-dashboard is a vscode extension/);
    assert.match(out, /alias mine='claude --model haiku'/);
});

test('an empty file gets a block and nothing else', () => {
    const out = db.withAliasBlock('', "alias a='claude'");
    assert.match(out, /^# >>> claude-dashboard >>>/);
    assert.ok(out.endsWith('\n'), 'a shell file ends in a newline');
});

// Removing what is not there is not an error, and does not add a trailing blank
// line every time it is asked.
test('clearing a block that was never written changes nothing', () => {
    assert.equal(db.withAliasBlock(RC, ''), RC);
});

// The block says where it came from, because a stranger reading this file in a
// year has to know what wrote it and how to be rid of it.
test('the block explains itself', () => {
    const out = db.withAliasBlock('', "alias a='claude'");
    assert.match(out, /Setup . Launch/, 'nothing says where it is managed from');
    assert.match(out, /claudeStatusline\.aliasName|alias name/i, 'nothing says how to remove it');
});

test('the shell file is chosen by the shell, not guessed', () => {
    assert.match(db.shellRcFor('/bin/zsh'), /\.zshrc$/);
    assert.match(db.shellRcFor('/bin/bash'), /\.bashrc$/);
    assert.equal(db.shellRcFor('/usr/local/bin/fish'), '', 'fish does not take this syntax');
    assert.equal(db.shellRcFor(''), '');
});

// The button that writes it, and what it says. Writing into somebody's shell
// file is not something to do behind a Save: it is asked for by name, and the
// panel says which file and that a new terminal is needed before it exists.
// The shell is named in the config rather than read from the environment: the
// panel says whichever file that shell reads, so a test that leaves it out
// asserts about the machine it runs on — green on a zsh laptop, red on a bash
// CI runner, which is what happened.
test('the alias can be written into the shell file from the page', () => {
    for (const [shell, file] of [['/bin/zsh', '.zshrc'], ['/bin/bash', '.bashrc']]) {
        const launch = db.launchTab({ model: 'opus', aliasName: 'claude-vs', shell }, {}, []);
        const block = launch.slice(launch.indexOf('data-panel="command"'));
        const panel = block.slice(0, block.indexOf('</section>'));
        assert.match(panel, /data-install-alias/, `${shell}: nothing offers to write it`);
        assert.ok(panel.includes(file), `${shell}: the file it would touch is not named`);
    }
});

test('the page sends the install and says nothing was written until it is', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()),
        { files: 1, lastRun: Date.now(), history: [], system: demoSystem(), config: { presets: [], palette: [] } });
    assert.match(html, /type: 'installAlias'/, 'the button never reaches the extension');
    assert.match(html, /data-install-alias/, 'the button is not wired');
});

// The page hands over choices, never the text: whatever it draws, the extension
// builds what it writes into a file a shell runs.
test('the install button sends the choices rather than the drawn line', () => {
    const html = db.render(demoIndex(), ix.summarize(demoIndex()),
        { files: 1, lastRun: Date.now(), history: [], system: demoSystem(), config: { presets: [], palette: [] } });
    const call = html.slice(html.indexOf("type: 'installAlias'"));
    assert.match(call.slice(0, 120), /settings: settingsToSave\(\)/);
    assert.ok(!/type: 'installAlias', line:/.test(html), 'the page still sends its own text');
});

// The card already names the model; the rung beside it is what tells a dispatch
// that claimed `[opus·medium]` from one that inherited the session's level.
test('an agent card names the effort the agent ran on', () => {
    const html = db.agentsTab(ix.summarize(demoIndex()), [demoRun({
        agents: [demoAgent({ effort: 'medium' })],
    })]);
    assert.match(html, /opus 5 · medium/);
});

test('an agent card says nothing about effort when the transcript recorded none', () => {
    const html = db.agentsTab(ix.summarize(demoIndex()), [demoRun({
        agents: [demoAgent({ effort: '' })],
    })]);
    assert.doesNotMatch(html, /opus 5 · (low|medium|high|xhigh|max)/);
});

test('every theme font variable carries a fallback of its own', () => {
    // A webview that does not define `--vscode-editor-font-family` leaves the
    // page with an invalid font-family, and Chromium's own default for
    // monospace is Courier New — which is what the numbers turned into on one
    // machine. `tools/preview.js` defines the variable itself, so the preview
    // could never show this.
    const css = fs.readFileSync(path.join(__dirname, '..', 'dashboard.css'), 'utf8');
    const bare = [...css.matchAll(/var\(--vscode-[a-zA-Z-]*font-family\)/g)].map((m) => m[0]);
    assert.deepEqual(bare, [], `${bare.length} font variables have no fallback`);
});

// --- the plan gets its own mark ------------------------------------------
// The rail used to carry one mark meaning two things: where the week stands and
// where the spend was allowed to be. Those are the same number only for someone
// who burns evenly. With a profile they part, and the rail draws both — the
// clock thin and grey, the plan in its own colour, owning the zone.
const weighted = (over = {}) => week({ planW: 68, weighted: true, ...over });

test('the plan mark stands on the weighted plan, not on the now line', () => {
    const html = db.paceTrack(weighted());
    // Four days of seven is 57.14% of the rail; the plan is at 68%.
    assert.equal(Math.round(leftOf(html, 'wk-now')), 57);
    assert.equal(leftOf(html, 'wk-plan'), 68);
});

test('the zone is measured to the plan, which flips the verdict', () => {
    // 62% spent. Against the clock at 57.14% that is 5% over and red; against a
    // plan of 68% it is 6% under and green. The rail has to agree with the pill.
    const html = db.paceTrack(weighted());
    assert.equal(widthOf(html, 'wk-spent'), 62);
    assert.equal(leftOf(html, 'wk-slack'), 62);
    assert.equal(widthOf(html, 'wk-slack'), 6);
    assert.ok(!html.includes('wk-excess'), 'nothing is over the plan here');
    assert.match(html, /class="pill pill-safe">6% under</);
});

test('the clock keeps a pill of its own, so the week is still readable', () => {
    const html = db.paceTrack(weighted());
    assert.match(html, /class="pill pill-muted">.*now 57%/);
    assert.match(html, /class="pill">62% spent</);
});

test('the now line is marked as paired only when a plan mark shares the rail', () => {
    // Both marks carry full weight — a 1px wash beside a 2px colour read as a
    // seam in the fill rather than as a mark, which is exactly how it was
    // reported. They are told apart by colour: the clock is the foreground, the
    // plan is its own hue, and the pills carry the matching dots.
    assert.match(db.paceTrack(weighted()), /class="wk-now paired"/);
    assert.ok(!db.paceTrack(week()).includes('wk-now paired'), 'alone it needs no pairing class');
    assert.ok(!db.paceTrack(week()).includes('wk-plan'), 'and no second mark appears');
});

test('without a profile the rail is exactly what it was', () => {
    const html = db.paceTrack(week());
    assert.equal(widthOf(html, 'wk-spent'), 57.14);
    assert.equal(widthOf(html, 'wk-excess'), 4.86);
    assert.match(html, /class="pill pill-warn">5% over</);
    assert.ok(!/now \d+%/.test(html), 'no clock pill where the mark is the clock');
});

test('the clock pill says what the rest of the page says about the clock', () => {
    // Both are "how much of the window is behind us", and one screen showing
    // 5% in the header beside 6% on the rail is the rounding, not the truth:
    // pace() floors that number once so every surface says the same thing.
    const html = db.paceTrack(week({ plan: 57, planW: 68, weighted: true, at: NOON + 4 * 86400 + 3600 }));
    assert.match(html, /class="pill pill-muted">.*now 57%/);
});

// The advisor's tier sits in the efforts map beside the real levels, and it is
// the one with the most output behind it — a consultation re-reads the whole
// conversation. Calibrating the effort cards against it would make every level
// read as a fraction of an advisor's reply.
test('effortSpend leaves the advisor tier out of the calibration', () => {
    const efforts = {
        'claude-fable-5-1|xhigh': { msgs: 400, out: 400 * 800 },
        'claude-fable-5-1|high': { msgs: 350, out: 350 * 700 },
        'claude-fable-5-1|advisor': { msgs: 5000, out: 5000 * 9000 },
    };
    const out = db.effortSpend({ efforts }, 'fable');
    assert.equal(out.advisor, undefined);
    assert.match(out.high, /vs xhigh$/);
});

// A call to the advisor and a consultation are not the same count: 90 of 541
// calls in the transcripts here got no answer back and were billed nothing. The
// tile shows what was priced, and says how many calls that came from.
test('the Advisor tile counts priced consultations and names the calls beside them', () => {
    const index = demoIndex({
        tools: { advisor: { calls: 5, errors: 0, denials: 0 } },
        efforts: {
            [ix.effortKey('claude-opus-5', 'xhigh')]: bucket(5, 1, { out: 50 }),
            [ix.effortKey('claude-fable-5-1', ix.ADVISOR_TIER)]: bucket(30, 3, { in: 3e6, out: 3e4 }),
        },
    });
    const total = ix.summarize(index);
    const html = db.render(index, total, { files: 1, lastRun: Date.now(), history: [] });
    const tile = html.match(/<span class="tile-label">Advisor<\/span><span class="tile-value">([^<]*)<\/span>[\s\S]*?<span class="tile-sub">([^<]*)<\/span>/);
    assert.ok(tile, 'the Advisor tile is on the page');
    assert.equal(tile[1], '3');
    assert.match(tile[2], /^5 calls/);
});

// The `[1m]` variants are gone from the list: Sonnet 5 and the Fable models
// carry a 1M window natively, and Opus is upgraded to it on Max, Team and
// Enterprise plans and on the API, so on the Anthropic API the suffix picked
// nothing. A value saved before the change still lands on its plain card.
test('the model list has no [1m] variants and a saved one selects its plain card', () => {
    assert.deepEqual(db.MODELS.map(([v]) => v), ['', 'opus', 'sonnet', 'fable', 'haiku', 'best', 'opusplan']);
    const launch = db.launchTab({ model: 'opus[1m]' }, {});
    assert.match(launch, /name="model" value="opus" checked/);
    assert.ok(!/value="opus\[1m\]"/.test(launch), 'no [1m] card is drawn');
    assert.match(launch, /\$5\/\$25 · 1M/);
    assert.match(launch, /\$2\/\$10 · 1M/);
    assert.match(launch, /on Pro/, 'the panel says where Opus is not 1M');
});

// What the advisor buys scales with the tier gap, and its price does not: a
// consult re-reads the whole conversation at the advisor's rate. So each option
// says what it is for on the model the session starts on — and on a Fable
// session, where the only advisor the client accepts is Fable itself, the row
// says plainly that it is a second opinion at the dearest rate, not a stronger
// model.
test('the advisor options carry advice for the model they would advise', () => {
    const onOpus = db.launchTab({ model: 'opus' }, {});
    assert.match(onOpus, /the pairing Anthropic measured/, 'fable over opus is the measured pairing');
    assert.match(onOpus, /a second Opus reviews the first/);
    const onFable = db.launchTab({ model: 'fable' }, {});
    assert.match(onFable, /not worth turning on/, 'the fable row warns against itself on a fable session');
    assert.match(onFable, /same tier/);
    assert.match(onFable, /pays the whole conversation again/);
    const onSonnet = db.launchTab({ model: 'sonnet' }, {});
    assert.match(onSonnet, /Fable guidance at decision points without running Fable throughout/);
    // The sentence is rebuilt in the page when the model changes, so the page
    // needs the same advice text per (advisor, tier) without a round trip.
    const script = onOpus.slice(onOpus.lastIndexOf('<script>'));
    assert.match(onOpus, /data-advice=/);
});

// Two more of the client's flags become choices: the permission mode the
// session starts in and the model it falls back to when the primary is
// overloaded. Both were free text in the extra arguments until now.
test('permission mode and fallback model are choices on the launch tab and flags on the line', () => {
    assert.deepEqual(db.PERMISSION_MODES.map(([v]) => v), ['', 'default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
    assert.deepEqual(db.FALLBACKS.map(([v]) => v), ['', 'opus', 'sonnet', 'haiku', 'sonnet,haiku']);
    const launch = db.launchTab({ model: 'opus', permissionMode: 'acceptEdits', fallbackModel: 'sonnet,haiku' }, {});
    assert.match(launch, /name="permissionMode" value="acceptEdits" checked/);
    assert.match(launch, /name="fallbackModel" value="sonnet,haiku" checked/);
    assert.match(launch, /isolated containers and VMs only/, 'bypassPermissions carries the client\'s own warning');
    assert.equal(db.claudeCommand({ model: 'opus', permissionMode: 'acceptEdits', fallbackModel: 'sonnet,haiku', args: '--verbose' }),
        "claude --model 'opus' --permission-mode 'acceptEdits' --fallback-model 'sonnet,haiku' --verbose");
    assert.equal(db.claudeCommand({ model: 'opus' }), "claude --model 'opus'");
});


// The header and both rows of tabs stay put while the page scrolls, the way the
// Save bar stays at the bottom: on a long tab the section you are in is the
// first thing you want to see, and it was the first thing to leave. One
// wrapper, sticky at the top, painted in the editor's own background so the
// panels passing beneath do not show through.
test('the header and the tab rows stick to the top of the page', () => {
    const html = db.render({ files: {} }, ix.summarize(demoIndex()), { files: 0 });
    const top = html.match(/<div class="page-top">([\s\S]*?)<\/div>\n<section/);
    assert.ok(top, 'header and navigation sit in one .page-top wrapper ahead of the first tab');
    assert.match(top[1], /<header class="page-head">/);
    assert.match(top[1], /<nav class="sections">/);
    assert.match(top[1], /<nav class="tabs/);
    const css = db.STYLE;
    assert.match(css, /\.page-top \{[^}]*position: sticky;[^}]*top: 0;/);
    assert.match(css, /\.page-top \{[^}]*background: var\(--vscode-editor-background\)/);
});

// A click on a tab or a section starts at the top of what it opened: the scroll
// position belongs to the pane that was left, and carrying it over lands the
// reader in the middle of a different page. The restore after a redraw goes
// the other way — it reopens the same tab and must keep the position — so the
// scroll-to-top rides the click, not `openTab`.
test('switching tab or section by click returns to the top of the page', () => {
    const html = db.render({ files: {} }, ix.summarize(demoIndex()), { files: 0 });
    const script = html.slice(html.lastIndexOf('<script>'));
    assert.match(script, /sections\.forEach\(\(btn\) => btn\.addEventListener\('click', \(\) => \{ openSection\(btn\.dataset\.section\); toTop\(\); \}\)\)/);
    assert.match(script, /tabs\.forEach\(\(btn\) => btn\.addEventListener\('click', \(\) => \{ openTab\(btn\); toTop\(\); \}\)\)/);
    assert.match(script, /function toTop\(\) \{[^}]*window\.scrollTo\(0, 0\);[^}]*remember\(\{ scrollY: 0 \}\)/);
    // And the restore path does not scroll: openTab itself stays free of it.
    const openTab = script.slice(script.indexOf('function openTab('), script.indexOf('function openSection('));
    assert.ok(!/scrollTo|toTop/.test(openTab), 'openTab must not scroll, the redraw restores through it');
});
