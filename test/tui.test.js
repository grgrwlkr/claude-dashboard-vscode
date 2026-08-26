const test = require('node:test');
const assert = require('node:assert');

const tui = require('../tui');

const plain = (opts = {}) => ({ colour: false, width: 60, ...opts });
const render = (sections, opts) => tui.renderSections(sections, plain(opts));
const joined = (sections, opts) => render(sections, opts).join('\n');

test('a section prints its title, and its pills sit on that same line', () => {
    const out = render([{
        id: 'limits',
        title: 'Limits',
        blocks: [{ kind: 'pills', items: [{ text: '2% over', tone: 'warn' }, { text: 'resets', value: 'Fri' }] }],
    }]);
    assert.match(out[0], /Limits/);
    // The pills are the state of the section, not rows of it: a pill on its own
    // line reads as a fact about nothing.
    assert.match(out[0], /2% over/);
    assert.match(out[0], /resets/);
    assert.match(out[0], /Fri/);
});

test('a gauge leads with its headline and draws the share as a track', () => {
    const out = joined([{
        id: 'limits',
        title: 'Limits',
        blocks: [{ kind: 'gauge', headline: '41%', value: 'of the week', sub: 'resets Friday', pct: 41, plan: 57, chips: ['~$114'] }],
    }]);
    assert.match(out, /41%/);
    assert.match(out, /of the week/);
    assert.match(out, /resets Friday/);
    // The same block characters usage.bar() puts in the status bar, so the page,
    // the bar and this draw one week the same way.
    assert.match(out, /[█▓▒░]/);
    assert.match(out, /~\$114/);
});

test('a gauge with no share of its own draws no track', () => {
    const out = joined([{
        id: 'money',
        title: 'Spend',
        blocks: [{ kind: 'gauge', headline: '~$114.29', value: 'this session', sub: '', pct: null, plan: null, chips: [] }],
    }]);
    assert.match(out, /~\$114\.29/);
    assert.ok(!/[█▓▒░]/.test(out), 'a figure that is not a share has nothing to fill');
});

test('meters put every label in one column and every share in another', () => {
    const out = render([{
        id: 'limits',
        title: 'Limits',
        blocks: [{
            kind: 'meters',
            rows: [
                { label: 'week', value: '41%', pct: 41, note: 'resets Fri' },
                { label: 'five hours', value: '7%', pct: 7, note: '' },
            ],
        }],
    }]);
    const rows = out.filter((l) => /week|five hours/.test(l));
    assert.equal(rows.length, 2);
    // Ragged columns are what makes a terminal table unreadable. The share is
    // pinned to the right edge, so both rows end at the same column.
    assert.equal(rows[0].length, rows[1].length);
    assert.ok(rows[0].trimEnd().endsWith('41%'), rows[0]);
    assert.ok(rows[1].trimEnd().endsWith('7%'), rows[1]);
});

test('a table lines its columns up whatever the widest cell is', () => {
    const out = render([{
        id: 'x',
        title: 'T',
        blocks: [{ kind: 'table', rows: [['model', 'opus 5'], ['a much longer label', 'x']] }],
    }]);
    const rows = out.filter((l) => /opus 5|longer label/.test(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].indexOf('opus 5'), rows[1].indexOf('x'));
});

test('a value too wide for the terminal is cut rather than wrapped', () => {
    const out = render([{
        id: 'x',
        title: 'T',
        blocks: [{ kind: 'table', rows: [['label', 'y'.repeat(200)]] }],
    }], { width: 40 });
    for (const line of out) {
        assert.ok(line.length <= 40, `a line ran to ${line.length} columns: ${line.slice(0, 50)}`);
    }
});

test('a note carrying a tone is painted, a plain one is not', () => {
    const alarm = tui.renderSections(
        [{ id: 'x', title: 'T', blocks: [{ kind: 'note', text: 'the week is spent', tone: 'alarm' }] }],
        { colour: true, width: 60 },
    ).join('\n');
    const muted = tui.renderSections(
        [{ id: 'x', title: 'T', blocks: [{ kind: 'note', text: 'nothing to report', tone: 'muted' }] }],
        { colour: true, width: 60 },
    ).join('\n');
    assert.ok(alarm.includes('['), 'an alarm says so in colour');
    assert.ok(alarm.includes('the week is spent'));
    assert.notEqual(alarm.replace(/\[[0-9;]*m/g, ''), '');
    assert.ok(!muted.includes('[31m'), 'a muted note is not an alarm');
});

test('parts are drawn as components of the gauge above them, not as more meters', () => {
    const out = joined([{
        id: 'context',
        title: 'Session',
        blocks: [
            { kind: 'gauge', headline: '42%', value: 'of 1M', sub: '', pct: 42, plan: null, chips: [] },
            { kind: 'parts', caption: 'what fills it', rows: [
                { label: 'conversation', note: '', figure: '380k', value: '90%', pct: 90 },
                { label: 'memory files', note: 'CLAUDE.md', figure: '24k', value: '6%', pct: 6 },
            ] },
        ],
    }]);
    assert.match(out, /what fills it/);
    assert.match(out, /conversation/);
    assert.match(out, /380k/);
    assert.match(out, /CLAUDE\.md/);
});

test('a band prints its facts on one line', () => {
    const out = render([{
        id: 'x',
        title: 'T',
        blocks: [{ kind: 'band', facts: ['292 replies', '16 files', '2 commits'], chip: null }],
    }]);
    const line = out.find((l) => /292 replies/.test(l));
    assert.ok(line, 'the facts are printed');
    assert.match(line, /16 files/);
    assert.match(line, /2 commits/);
});

test('a subtitle is a heading inside the section, not a row', () => {
    const out = joined([{
        id: 'x',
        title: 'T',
        blocks: [{ kind: 'subtitle', text: 'per model' }, { kind: 'table', rows: [['opus 5', '$1']] }],
    }]);
    // Upper-cased, the way the page draws a heading inside a panel.
    assert.match(out, /PER MODEL/);
});

test('an unknown block is skipped rather than crashing the page', () => {
    // status.js grows blocks; a terminal that has not caught up must still draw
    // the rest of the section.
    const out = joined([{
        id: 'x',
        title: 'T',
        blocks: [{ kind: 'sparkline', points: [1, 2, 3] }, { kind: 'note', text: 'still here', tone: null }],
    }]);
    assert.match(out, /still here/);
});

test('sections are separated, and an empty list renders nothing', () => {
    assert.deepEqual(render([]), []);
    const two = joined([
        { id: 'a', title: 'First', blocks: [{ kind: 'note', text: 'one', tone: null }] },
        { id: 'b', title: 'Second', blocks: [{ kind: 'note', text: 'two', tone: null }] },
    ]);
    assert.match(two, /First[\s\S]*Second/);
});

test('a note too long for the width is wrapped, not cut', () => {
    // The forecast line is the conclusion the limits section exists for. Cutting
    // it at the column drops exactly the half that says what to do about it.
    const text = '100% would be Thu 27.08 18:13, in 1d8h, which is after the reset: '
        + 'you do not run out of quota this week at this pace';
    const out = render([{ id: 'limits', title: 'Limits', blocks: [{ kind: 'note', text, tone: null }] }], { width: 60 });
    const body = out.filter((l) => l.trim() && !/^Limits/.test(l));
    assert.ok(body.length >= 2, 'the note took more than one line');
    assert.ok(!body.some((l) => l.endsWith('…')), 'nothing was cut');
    // Every word survives, in order.
    const rejoined = body.map((l) => l.trim()).join(' ');
    assert.equal(rejoined, text);
    for (const line of out) assert.ok(line.length <= 60, `line ran to ${line.length}`);
});

test('a wrapped note keeps its continuation lines aligned under the first', () => {
    const text = 'x'.repeat(20) + ' ' + 'y'.repeat(20) + ' ' + 'z'.repeat(20);
    const out = render([{ id: 'x', title: 'T', blocks: [{ kind: 'note', text, tone: null }] }], { width: 40 });
    const body = out.filter((l) => /[xyz]/.test(l));
    assert.ok(body.length >= 2);
    const indents = body.map((l) => l.length - l.trimStart().length);
    assert.equal(new Set(indents).size, 1, `ragged indents: ${indents.join(',')}`);
});

test('a single word longer than the width is still cut rather than looping', () => {
    const out = render([{ id: 'x', title: 'T', blocks: [{ kind: 'note', text: 'q'.repeat(200), tone: null }] }], { width: 30 });
    assert.ok(out.length < 20, 'no runaway');
    for (const line of out) assert.ok(line.length <= 30);
});

// --- the tabbed screen ----------------------------------------------------

const TABS = [{ id: 'now', title: 'Now' }, { id: 'spend', title: 'Spend' }, { id: 'agents', title: 'Agents' }];

test('the tab bar names every tab and marks exactly one active', () => {
    const bar = tui.tabBar(TABS, 1, 60, false);
    for (const t of TABS) assert.ok(bar.includes(t.title), `${t.title} is missing`);
    // Without colour the active tab still has to be distinguishable, or the bar
    // is useless in a pipe and in a screenshot.
    const marks = TABS.filter((t) => bar.includes(`[${t.title}]`));
    assert.equal(marks.length, 1, 'exactly one tab reads as active');
    assert.equal(marks[0].id, 'spend');
});

test('a screen is exactly as tall as it was asked for', () => {
    const lines = tui.screen({
        tabs: TABS, active: 0, width: 50, height: 12,
        body: ['one', 'two'],
        footer: 'q quit',
    });
    assert.equal(lines.length, 12);
    for (const l of lines) assert.ok(tui.visibleLength(l) <= 50, `line ran to ${tui.visibleLength(l)}`);
});

test('a body longer than the screen is scrolled, not spilled', () => {
    const body = Array.from({ length: 100 }, (_, i) => `row ${i}`);
    const top = tui.screen({ tabs: TABS, active: 0, width: 40, height: 10, body, footer: '', scroll: 0 });
    const down = tui.screen({ tabs: TABS, active: 0, width: 40, height: 10, body, footer: '', scroll: 20 });
    assert.equal(top.length, 10);
    assert.equal(down.length, 10);
    assert.ok(top.some((l) => l.includes('row 0')));
    assert.ok(!top.some((l) => l.includes('row 20')), 'the first screen stops before the scrolled row');
    assert.ok(down.some((l) => l.includes('row 20')));
});

test('scrolling stops at the end instead of running past it', () => {
    const body = ['a', 'b', 'c'];
    const far = tui.screen({ tabs: TABS, active: 0, width: 40, height: 10, body, footer: '', scroll: 999 });
    assert.equal(far.length, 10);
    assert.ok(far.some((l) => l.includes('a')), 'a short body is never scrolled off the screen');
});

test('the footer is the last line, and says how to leave', () => {
    const lines = tui.screen({ tabs: TABS, active: 0, width: 60, height: 8, body: ['x'], footer: 'q quit · ←→ tabs' });
    assert.match(lines[lines.length - 1], /q quit/);
    assert.match(lines[lines.length - 1], /tabs/);
});

test('the keys that move between tabs wrap at both ends', () => {
    assert.equal(tui.nextTab(0, 'right', 3), 1);
    assert.equal(tui.nextTab(2, 'right', 3), 0, 'past the last tab comes the first');
    assert.equal(tui.nextTab(0, 'left', 3), 2, 'before the first comes the last');
    // A digit picks a tab outright, and one that is not there changes nothing.
    assert.equal(tui.nextTab(0, '2', 3), 1);
    assert.equal(tui.nextTab(1, '9', 3), 1);
    assert.equal(tui.nextTab(1, 'zzz', 3), 1);
});

// --- what each tab shows --------------------------------------------------

// The shape `indexer.summarize` actually returns: buckets keyed by name, the
// way `dashboard.js` walks them with Object.keys. Asserted here because a
// fixture invented from memory is how a tab comes out empty against real data.
const summary = {
    days: {
        '2026-08-25': { cost: 12.5, tokens: 1e6 },
        '2026-08-24': { cost: 8, tokens: 5e5 },
    },
    models: {
        'claude-opus-5': { cost: 100, tokens: 2e6 },
        'claude-haiku-4-5': { cost: 2, tokens: 1e5 },
    },
    agents: { collector: { count: 12, cost: 4.5, tokens: 3e5 } },
    sessions: { abc: { cost: 3, tokens: 2e5, project: 'repo' } },
};
const help = { fmtCost: (n) => `$${n.toFixed(2)}`, tok: (n) => `${Math.round(n / 1000)}k` };

test('every tab has an id, a title and a body of lines', () => {
    const tabs = tui.tabsFor({ sections: [], summary, helpers: help, width: 70 });
    assert.ok(tabs.length >= 3, 'more than one tab');
    for (const t of tabs) {
        assert.equal(typeof t.id, 'string');
        assert.equal(typeof t.title, 'string');
        assert.ok(Array.isArray(t.body), `${t.id} has no body`);
    }
    // The ids are unique, because a digit key picks one by position and a
    // duplicate would make two positions mean the same thing.
    assert.equal(new Set(tabs.map((t) => t.id)).size, tabs.length);
});

test('the spend tab lists days and models with their figures', () => {
    const tabs = tui.tabsFor({ sections: [], summary, helpers: help, width: 70 });
    const spend = tabs.find((t) => t.id === 'spend');
    const text = spend.body.join('\n');
    assert.match(text, /2026-08-25/);
    // Newest day first: the answer to "what did today cost" is the top row.
    assert.ok(text.indexOf('2026-08-25') < text.indexOf('2026-08-24'), 'days run newest first');
    assert.match(text, /\$12\.50/);
    assert.match(text, /opus 5/, 'a model is named the way every other surface names it');
    // Dearest model first, so the row that explains the bill is at the top.
    assert.ok(text.indexOf('opus 5') < text.indexOf('haiku 4.5'), 'models run dearest first');
    assert.match(text, /\$100\.00/);
});

test('a tab with nothing behind it says so instead of drawing an empty frame', () => {
    const tabs = tui.tabsFor({ sections: [], summary: {}, helpers: help, width: 70 });
    for (const t of tabs) {
        assert.ok(t.body.length > 0, `${t.id} drew nothing at all`);
        assert.ok(t.body.join('\n').trim().length > 0, `${t.id} drew only blanks`);
    }
});

test('the now tab carries the sections it was handed', () => {
    const sections = [{ id: 'limits', title: 'Limits', blocks: [{ kind: 'note', text: 'the week is fine', tone: null }] }];
    const tabs = tui.tabsFor({ sections, summary, helpers: help, width: 70, colour: false });
    const now = tabs.find((t) => t.id === 'now');
    assert.match(now.body.join('\n'), /the week is fine/);
});
