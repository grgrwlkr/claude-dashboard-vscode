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

test('every pair of model colours stays perceptually distinct', () => {
    const rows = Array.from({ length: 9 }, (_, i) => [`m${i}`, bucket(9 - i)]);
    const html = db.barList(rows, { limit: 9 });
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
