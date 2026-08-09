const test = require('node:test');
const assert = require('node:assert');
const db = require('../dashboard');
const ix = require('../indexer');

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
    assert.equal((html.match(/<tr>/g) || []).length, 2);
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
    const visible = shown.filter((m) => !m[3].includes('hidden'));
    assert.deepEqual(visible.map((m) => m[2]), Array(4).fill('spend'));
    assert.equal((html.match(/aria-selected="true"/g) || []).length, 2); // one section, one tab
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

test('the Setup panels degrade to a message when there is no snapshot', () => {
    const total = ix.summarize(demoIndex());
    for (const tab of [db.healthTab(total, null), db.jobsTab(null), db.diskTab(null), db.tasksTab(null)]) {
        assert.match(tab, /class="empty"/);
    }
    assert.match(db.liveTab(null), /Live sessions/);
    assert.match(db.changelogTab(null), /Nothing newer/);
    assert.match(db.contextTab(total, null), /Context/i);
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
