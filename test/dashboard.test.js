const test = require('node:test');
const assert = require('node:assert');
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
    assert.match(html, /<title>Claude Dashboard<\/title>/);
    assert.match(html, /<h1>Claude Dashboard <span class="ver">/);
    const open = manifest.contributes.commands.find((c) => c.command === 'claudeStatusline.dashboard');
    assert.equal(open.title, 'Claude: Open dashboard');
});

// A column that hides at a narrow width hides as a pair. With the class on the
// header alone the body kept a cell the header had dropped, and every heading
// to its right sat over the wrong column — invisible at full width, and no
// overflow for a probe to find.
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
