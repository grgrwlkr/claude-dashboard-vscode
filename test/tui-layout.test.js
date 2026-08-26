const test = require('node:test');
const assert = require('node:assert');

const tui = require('../tui');

const vis = tui.visibleLength;

test('a row pins one thing left and one right, to the exact width', () => {
    const line = tui.row('Limits', '7% under', 40);
    assert.equal(vis(line), 40);
    assert.ok(line.startsWith('Limits'));
    assert.ok(line.endsWith('7% under'));
});

test('a row whose halves do not fit keeps the right-hand one', () => {
    // The right side carries the figure; the label is what can be shortened.
    const line = tui.row('a very long label indeed that runs on', '43%', 20);
    assert.equal(vis(line), 20);
    assert.ok(line.endsWith('43%'), `the figure survived: ${line}`);
});

test('a meter draws a share as a proportion of the columns it is given', () => {
    const empty = tui.meter(0, 10);
    const half = tui.meter(50, 10);
    const full = tui.meter(100, 10);
    assert.equal(vis(empty), 10);
    assert.equal(vis(half), 10);
    assert.equal(vis(full), 10);
    // More filled cells as the share grows — the property that makes it a meter.
    const filled = (s) => (s.match(/[█▓]/g) || []).length;
    assert.ok(filled(empty) < filled(half), 'nothing filled at zero');
    assert.ok(filled(half) < filled(full), 'everything filled at a hundred');
});

test('a meter marks the plan when one is given, and only then', () => {
    const withPlan = tui.meter(40, 20, { plan: 70 });
    const without = tui.meter(40, 20);
    assert.notEqual(withPlan, without, 'the plan leaves a mark');
    assert.equal(vis(withPlan), 20, 'and costs no width');
});

test('the tile strip lays every tile out in its own column', () => {
    const lines = tui.tiles([
        { label: 'WEEKLY WINDOW', value: '57%', sub: '64% of the week gone', pct: 57 },
        { label: '5-HOUR WINDOW', value: '43%', sub: 'resets in 2h40m', pct: 43 },
        { label: 'CONTEXT', value: '29%', sub: '294k of 1.0M', pct: 29 },
        { label: 'THIS SESSION', value: '~$114.29', sub: '~$5.18 an hour', pct: null },
    ], 100, false);

    const text = lines.join('\n');
    for (const want of ['WEEKLY WINDOW', '57%', '64% of the week gone', '~$114.29']) {
        assert.ok(text.includes(want), `${want} is missing`);
    }
    for (const line of lines) assert.ok(vis(line) <= 100, `a tile line ran to ${vis(line)}`);
    // Four tiles, one strip: the labels share a line, the figures share the next.
    const labelLine = lines.find((l) => l.includes('WEEKLY WINDOW'));
    assert.ok(labelLine.includes('CONTEXT'), 'the labels are one row, not four');
    const figureLine = lines.find((l) => l.includes('57%'));
    assert.ok(figureLine.includes('~$114.29'), 'the figures are one row too');
});

test('a tile strip too narrow for four columns drops to fewer, never overflows', () => {
    const lines = tui.tiles([
        { label: 'ONE', value: '1%', sub: 'a', pct: 1 },
        { label: 'TWO', value: '2%', sub: 'b', pct: 2 },
        { label: 'THREE', value: '3%', sub: 'c', pct: 3 },
        { label: 'FOUR', value: '4%', sub: 'd', pct: 4 },
    ], 40, false);
    for (const line of lines) assert.ok(vis(line) <= 40, `ran to ${vis(line)}: ${line}`);
    assert.ok(lines.join('\n').includes('FOUR'), 'no tile is lost, they wrap instead');
});

test('a panel frames its body and carries pills on the title line', () => {
    const lines = tui.panel('Limits', ['  something'], { pills: ['7% under'], width: 40, colour: false });
    assert.ok(lines[0].includes('Limits'), 'the title is on the first line');
    assert.ok(lines[0].includes('7% under'), 'and the pills sit with it');
    for (const line of lines) assert.equal(vis(line), 40, `a panel line was ${vis(line)} wide`);
    assert.ok(lines.some((l) => l.includes('something')), 'the body is inside');
    // A frame: the last line closes what the first opened.
    assert.match(lines[0], /[┌─┐│]/);
    assert.match(lines[lines.length - 1], /[└─┘│]/);
});

test('a panel note is the last thing inside the frame', () => {
    const lines = tui.panel('Spend', ['  x'], { note: 'estimated, not a bill', width: 44, colour: false });
    const noteAt = lines.findIndex((l) => l.includes('estimated, not a bill'));
    assert.ok(noteAt > 0, 'the note is drawn');
    assert.equal(noteAt, lines.length - 2, 'directly above the closing line');
});

test('two panels side by side keep their own widths and line up row for row', () => {
    const left = tui.panel('A', ['  one', '  two', '  three'], { width: 30, colour: false });
    const right = tui.panel('B', ['  x'], { width: 30, colour: false });
    const paired = tui.pair(left, right, 2);
    // The shorter panel is padded, not truncated: a ragged bottom edge is what
    // makes two terminal panels read as one broken one.
    assert.equal(paired.length, Math.max(left.length, right.length));
    // Rows where both panels have content are the full width; rows past the end
    // of the shorter one stop rather than padding out to the edge.
    const bothAt = paired.slice(0, right.length);
    for (const line of bothAt) assert.equal(vis(line), 62, `paired line was ${vis(line)}`);
    for (const line of paired) assert.ok(vis(line) <= 62, `paired line ran to ${vis(line)}`);
    assert.ok(paired[0].includes('A') && paired[0].includes('B'));
});

// --- the Now page ---------------------------------------------------------

const help = {
    fmtCost: (n) => `~$${n.toFixed(2)}`,
    fmtLeft: () => '2d12h',
    fmtAbs: () => 'Mon 24.08 07:45',
    tok: (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`),
    shortModel: (m) => m.replace(/^claude-/, ''),
};

const state = {
    now: 1000,
    weekly: { pct: 57, reset: 200000 },
    session: { pct: 43, reset: 9000 },
    pace: { plan: 64, settled: true, dry: null },
    ctx: { pct: 29, tokens: 294000, window: 1000000, cachePct: 78, model: 'claude-opus-5', effort: 'xhigh' },
    stats: { cost: 114.29, burn: 5.18, durationMs: 22320000, apiPct: 61, added: 4120, removed: 1870 },
};

test('the headline strip carries the four figures the page leads with', () => {
    const lines = tui.nowTiles(state, help, 100, false);
    const text = lines.join('\n');
    // The same four the dashboard puts across its top.
    assert.match(text, /WEEKLY WINDOW/);
    assert.match(text, /5-HOUR/);
    assert.match(text, /CONTEXT/);
    assert.match(text, /SESSION/);
    assert.match(text, /57%/);
    assert.match(text, /43%/);
    assert.match(text, /29%/);
    assert.match(text, /~\$114\.29/);
    for (const l of lines) assert.ok(vis(l) <= 100, `strip line ran to ${vis(l)}`);
});

test('a tile is left out entirely when its number is not known yet', () => {
    const bare = tui.nowTiles({ now: 1 }, help, 100, false).join('\n');
    assert.ok(!/WEEKLY WINDOW/.test(bare), 'no week, no weekly tile');
    assert.ok(!/undefined|NaN/.test(bare), 'and nothing half-drawn in its place');
});

test('the now page frames every section as a panel', () => {
    const sections = [
        { id: 'limits', title: 'Limits', blocks: [{ kind: 'note', text: 'pace is fine', tone: null }] },
        { id: 'money', title: 'Spend', blocks: [{ kind: 'note', text: 'estimated', tone: null }] },
    ];
    const lines = tui.nowPage({ sections, d: state, helpers: help, width: 100, colour: false });
    const text = lines.join('\n');
    assert.match(text, /Limits/);
    assert.match(text, /Spend/);
    assert.match(text, /[┌└]/, 'the sections are framed');
    for (const l of lines) assert.ok(vis(l) <= 100, `page line ran to ${vis(l)}`);
});

test('a narrow terminal stacks the panels instead of squeezing them', () => {
    const sections = [
        { id: 'limits', title: 'Limits', blocks: [{ kind: 'note', text: 'x', tone: null }] },
        { id: 'money', title: 'Spend', blocks: [{ kind: 'note', text: 'y', tone: null }] },
    ];
    const narrow = tui.nowPage({ sections, d: state, helpers: help, width: 60, colour: false });
    for (const l of narrow) assert.ok(vis(l) <= 60, `narrow line ran to ${vis(l)}`);
    // Stacked: the two titles are on different lines.
    const limitsAt = narrow.findIndex((l) => l.includes('Limits'));
    const spendAt = narrow.findIndex((l) => l.includes('Spend'));
    assert.notEqual(limitsAt, spendAt);
});

test('a gauge inside a panel fills the width it was given', () => {
    const wide = tui.renderSection(
        { id: 'x', title: '', blocks: [{ kind: 'gauge', headline: '83%', value: '7 days', sub: '', pct: 83, plan: 84, chips: [] }] },
        70, false,
    );
    const barLine = wide.find((l) => /[█░]/.test(l));
    assert.ok(barLine, 'a track is drawn');
    // The status line's seven cells are for a status line. A panel has room for
    // the whole width, and the page uses it.
    assert.ok(vis(barLine) > 40, `the track was only ${vis(barLine)} columns`);
    assert.ok(vis(barLine) <= 70);
});

test('a meter row pins its share to the right, with the bar between', () => {
    const lines = tui.renderSection(
        { id: 'x', title: '', blocks: [{ kind: 'meters', rows: [
            { label: '5h', value: '15%', pct: 15, note: '' },
            { label: 'fable', value: '7%', pct: 7, note: '' },
        ] }] },
        60, false,
    );
    const rows = lines.filter((l) => /5h|fable/.test(l));
    assert.equal(rows.length, 2);
    for (const r of rows) {
        assert.ok(/[█░]/.test(r), 'each row carries its own bar');
        assert.ok(/\d+%\s*$/.test(r), `the share is at the right edge: ${JSON.stringify(r)}`);
    }
    // Both shares end at the same column.
    assert.equal(vis(rows[0]), vis(rows[1]));
});

test('paired panels leave no trailing spaces past the shorter one', () => {
    const left = tui.panel('A', ['  one', '  two', '  three', '  four'], { width: 30, colour: false });
    const right = tui.panel('B', ['  x'], { width: 30, colour: false });
    for (const line of tui.pair(left, right, 2)) {
        assert.equal(line, line.replace(/\s+$/, ''), `trailing space: ${JSON.stringify(line)}`);
    }
});

test('a subtitle is drawn the way the page draws one — quiet and in caps', () => {
    const lines = tui.renderSection(
        { id: 'x', title: '', blocks: [{ kind: 'subtitle', text: 'what it took' }] },
        50, true,
    );
    const line = lines.find((l) => /WHAT IT TOOK/i.test(l));
    assert.ok(line, 'the subtitle is there');
    assert.match(line, /WHAT IT TOOK/, 'in caps, as on the page');
    assert.ok(line.includes('['), 'and dimmed rather than drawn as a heading');
});

test('a wide terminal fits three panels across', () => {
    const section = (title) => ({ id: title, title, blocks: [{ kind: 'note', text: 'x', tone: null }] });
    const lines = tui.nowPage({
        sections: [section('Limits'), section('Context'), section('Spend')],
        d: {}, helpers: help, width: 130, colour: false,
    });
    const titleRow = lines.find((l) => l.includes('Limits'));
    assert.ok(titleRow.includes('Context') && titleRow.includes('Spend'),
        `three panels share the row: ${titleRow}`);
    for (const l of lines) assert.ok(vis(l) <= 130, `line ran to ${vis(l)}`);
});

test('a middling width still fits two, and a narrow one falls back to a stack', () => {
    const section = (title) => ({ id: title, title, blocks: [{ kind: 'note', text: 'x', tone: null }] });
    const three = [section('Alpha'), section('Beta'), section('Gamma')];
    const two = tui.nowPage({ sections: three, d: {}, helpers: help, width: 100, colour: false });
    const rowA = two.find((l) => l.includes('Alpha'));
    assert.ok(rowA.includes('Beta'), 'two across at 100 columns');
    assert.ok(!rowA.includes('Gamma'), 'but not three');

    const stacked = tui.nowPage({ sections: three, d: {}, helpers: help, width: 50, colour: false });
    const stackedA = stacked.find((l) => l.includes('Alpha'));
    assert.ok(!stackedA.includes('Beta'), 'one per row when narrow');
});

test('the tile strip separates its columns visibly', () => {
    const lines = tui.tiles([
        { label: 'ONE', value: '1%', sub: 'a', pct: 1 },
        { label: 'TWO', value: '2%', sub: 'b', pct: 2 },
    ], 60, false);
    // The page draws a rule between tiles; a terminal needs something in that
    // column or the four figures read as one row of numbers.
    assert.ok(lines.some((l) => /[│┆|]/.test(l)), 'a divider stands between the columns');
});

test('a panel title survives pills that do not fit beside it', () => {
    const lines = tui.panel('Spend', ['  x'], {
        pills: ['burn ~$9.97/h', 'today ~$205.83'], width: 40, colour: false,
    });
    // The title says which panel this is; a pill is a detail about it. When the
    // two compete for the same row, the pills give way.
    assert.ok(lines[0].includes('Spend'), `the title was cut: ${lines[0]}`);
    assert.equal(vis(lines[0]), 40);
});

test('a band wraps its facts instead of cutting the last one in half', () => {
    const lines = tui.renderSection(
        { id: 'x', title: '', blocks: [{ kind: 'band', facts: ['estimated from public rates — not a bill'], chip: null }] },
        38, false,
    );
    // Joined back with the indentation collapsed: the words survive the wrap,
    // which is what matters, not which column they landed in.
    const text = lines.map((l) => l.trim()).filter(Boolean).join(' ');
    assert.equal(text, 'estimated from public rates — not a bill');
    for (const l of lines) assert.ok(vis(l) <= 38, `band line ran to ${vis(l)}`);
});

test('four tiles fit the terminal everyone actually has', () => {
    const lines = tui.tiles([
        { label: 'WEEKLY WINDOW', value: '83%', sub: '84% of the week gone', pct: 83 },
        { label: '5-HOUR WINDOW', value: '15%', sub: 'resets in 1h24m', pct: 15 },
        { label: 'CONTEXT', value: '58%', sub: '584k of 1M', pct: 58 },
        { label: 'THIS SESSION', value: '$177.40', sub: '$10.17 an hour', pct: null },
    ], 80, false);
    const labelRow = lines.find((l) => l.includes('WEEKLY WINDOW'));
    // 80 columns is the default terminal; four figures across is the layout the
    // page has, and splitting one onto its own row wastes four lines to say it.
    assert.ok(labelRow.includes('THIS SESSION'), `the fourth tile wrapped: ${labelRow}`);
    for (const l of lines) assert.ok(vis(l) <= 80, `ran to ${vis(l)}`);
});

test('a strip of tiles with no shares draws no empty meter row', () => {
    const lines = tui.tiles([
        { label: 'A', value: '$1', sub: 'x', pct: null },
        { label: 'B', value: '$2', sub: 'y', pct: null },
    ], 60, false);
    // Three rows, not four: label, figure, sub. A blank row reads as a meter
    // that failed to draw.
    assert.equal(lines.filter((l) => l.trim() === '').length, 0, lines.map((l) => JSON.stringify(l)).join('\n'));
});
