const test = require('node:test');
const assert = require('node:assert');
const db = require('../dashboard');
const ix = require('../indexer');

function bucket(cost, msgs = 1, extra = {}) {
    return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost, msgs, ...extra };
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
    assert.match(svg, /08\.07/);
    assert.match(svg, /\$30\.00/); // the scale label is the busiest day
});

test('heatmap keeps cells inside the calendar and never runs past today', () => {
    const p = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const key = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const svg = db.heatmap({ [key]: bucket(5) });
    const cells = (svg.match(/class="hm/g) || []).length;
    assert.ok(cells > 100 && cells <= 27 * 7, `unexpected cell count: ${cells}`);
    assert.match(svg, /l4/); // the only day with spend is the darkest level
});

test('barList sorts by the caller and caps the list', () => {
    const entries = [['a', bucket(10)], ['b', bucket(5)], ['c', bucket(1)]];
    const html = db.barList(entries, { limit: 2 });
    assert.equal((html.match(/bar-row/g) || []).length, 2);
    assert.match(html, /width:100\.0%/); // the largest entry fills the track
    assert.ok(!html.includes('>c<'));
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

test('render produces one pane per tab and escapes hostile project names', () => {
    const index = {
        files: {
            '/x.jsonl': {
                agg: {
                    days: { '2026-08-08': bucket(5) },
                    models: { 'claude-opus-5': bucket(5) },
                    branches: { '<b>main': bucket(5) },
                    skills: {},
                    hours: { 14: bucket(5) },
                    sessions: [{
                        id: 'sess', kind: 'main', project: '<img src=x>', slug: 's',
                        start: 1, end: 2, msgs: 3, cost: 5, tokens: 10, models: ['claude-opus-5'],
                        branch: 'main', agentId: '', workflowId: '',
                    }],
                    prompts: { count: 2, chars: 100, longest: 80, byHour: { 14: 2 }, bySource: { typed: 2 }, words: { hello: 3 }, lens: { 0: 2 } },
                },
            },
        },
    };
    const total = ix.summarize(index);
    const html = db.render(index, total, { files: 1, lastRun: Date.now() });

    assert.equal((html.match(/role="tab"/g) || []).length, 7);
    assert.equal((html.match(/class="tab"/g) || []).length, 7);
    assert.ok(!html.includes('<img src=x>'), 'a project name must not reach the DOM raw');
    assert.ok(!html.includes('<b>main'), 'a branch name must not reach the DOM raw');
    assert.match(html, /Content-Security-Policy/);
    assert.ok(!/undefined|NaN/.test(html), 'no placeholder leaked into the page');
});
