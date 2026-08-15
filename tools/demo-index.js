// Invented data for the marketplace screenshots.
//
// The preview harness renders from the real index, which on any developer's
// machine means real project names, real session titles and real money. None of
// that belongs on a public listing, so the screenshots are shot on this instead:
// the same shapes the indexer produces, filled with a fictional four-project
// workload. Nothing here is read from disk.
//
// Amounts are drawn from a seeded generator, so re-shooting a screenshot after a
// layout change produces the same numbers and the diff is the layout.

const ix = require('../indexer');
const seg = require('../segments');
const status = require('../status');
const u = require('../usage');
const wfm = require('../workflows');
const db = require('../dashboard');
const { fmtCost } = require('../pricing');

// mulberry32: four lines, and the only property that matters here is that the
// same seed gives the same page twice.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const PROJECTS = ['acme-api', 'web-client', 'platform-infra', 'docs-site'];
const BRANCHES = ['main', 'feat/checkout-v2', 'fix/rate-limiter', 'chore/deps'];
const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const EFFORTS = ['xhigh', 'high', 'medium', 'low'];
const SKILLS = ['test-driven-development', 'systematic-debugging', 'writing-plans', 'code-review'];
const AGENT_TYPES = ['general-purpose', 'workflow-subagent', 'Explore', 'code-reviewer'];
const TITLES = [
    'Rate limiter drops bursts under load', 'Checkout flow: split the payment step',
    'Migrate the orders table to UUID keys', 'Why is the p99 on /search 400 ms',
    'Docs: rewrite the quickstart', 'Flaky test in the scheduler suite',
    'Add idempotency keys to the webhook', 'Cache the product catalogue',
    'Trace a memory leak in the worker', 'Backfill script for the new column',
];
const WORDS = {
    migration: 34, endpoint: 31, latency: 27, schema: 24, webhook: 22, retries: 19,
    idempotency: 17, backfill: 15, throughput: 14, rollback: 12, indexes: 11, fixture: 9,
};

const day = 86400000;

function buck(cost, msgs, tokens) {
    const out = Math.round(tokens * 0.06);
    const cacheRead = Math.round(tokens * 0.78);
    const cacheWrite = Math.round(tokens * 0.11);
    return {
        in: tokens - out - cacheRead - cacheWrite,
        out,
        cacheRead,
        cacheWrite,
        cw1h: Math.round(cacheWrite * 0.65),
        cw5m: Math.round(cacheWrite * 0.35),
        saved: Math.round(cacheRead * 0.9),
        cost,
        msgs,
    };
}

const key = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// One aggregate per project, the way the indexer would have written it if these
// four repositories existed.
function projectAgg(project, seed, now) {
    const r = rng(seed);
    const agg = ix.emptyAgg();
    const weight = 1 + r() * 1.6;

    for (let d = 90; d >= 0; d--) {
        const at = now - d * day;
        const weekend = [0, 6].includes(new Date(at).getDay());
        // A quiet day is part of the picture: a heatmap of uniform squares says
        // nothing, and the real one never is uniform.
        if (r() < (weekend ? 0.75 : 0.18)) continue;
        const cost = (0.4 + r() * 7.5) * weight * (weekend ? 0.3 : 1) * (1 + (90 - d) / 140);
        const msgs = 8 + Math.round(r() * 90);
        const tokens = Math.round(cost * 260000);
        const b = buck(cost, msgs, tokens);

        const mergeInto = (map, k) => {
            const t = map[k] || (map[k] = ix.bucket());
            for (const f of Object.keys(b)) t[f] += b[f];
        };
        mergeInto(agg.days, key(at));
        // Opus carries most of the spend, which is what makes the model split
        // worth drawing at all.
        const model = r() < 0.62 ? MODELS[0] : r() < 0.8 ? MODELS[1] : MODELS[2];
        mergeInto(agg.models, model);
        mergeInto(agg.branches, BRANCHES[Math.floor(r() * BRANCHES.length)]);
        mergeInto(agg.hours, String(8 + Math.floor(r() * 12)));
        mergeInto(agg.efforts, ix.effortKey(model, EFFORTS[Math.floor(r() * (model === MODELS[0] ? 2 : 4))]));
        mergeInto(agg.entrypoints, r() < 0.55 ? 'cli' : r() < 0.9 ? 'claude-vscode' : 'sdk-py');
        mergeInto(agg.speeds, r() < 0.85 ? 'standard' : 'fast');
        if (r() < 0.5) mergeInto(agg.skills, SKILLS[Math.floor(r() * SKILLS.length)]);
        // Most agent spend is the general one, the way it is on a real machine;
        // the named ones exist so the list has something to rank.
        if (r() < 0.3) mergeInto(agg.agents, r() < 0.6 ? AGENT_TYPES[0] : AGENT_TYPES[Math.floor(r() * AGENT_TYPES.length)]);
    }

    // A handful of replies the cache could not answer, one of them large enough
    // to be worth the row it takes.
    agg.breaks = { count: 2 + Math.round(r() * 6), tokens: 0, top: [] };
    for (let i = 0; i < 3; i++) {
        const uncached = 120000 + Math.round(r() * 700000);
        agg.breaks.tokens += uncached;
        agg.breaks.top.push({
            at: now - Math.round(r() * 20) * day, uncached, session: `${project}-main-${i}`,
            project, kind: i === 2 ? 'agent' : 'main',
        });
    }
    agg.breaks.top.sort((a, b) => b.uncached - a.uncached);

    for (const [name, base] of [['Bash', 220], ['Read', 610], ['Edit', 180], ['Grep', 140],
        ['Task', 40], ['Glob', 95], ['mcp__github__list_issues', 22], ['mcp__context7__query-docs', 17]]) {
        const calls = Math.round(base * weight * (0.6 + r()));
        agg.tools[name] = {
            calls,
            errors: Math.round(calls * r() * 0.06),
            denials: name === 'Bash' ? Math.round(calls * r() * 0.02) : 0,
        };
    }

    for (const f of ['src/server.ts', 'src/routes/orders.ts', 'src/db/schema.sql',
        'test/orders.test.ts', 'README.md', 'src/lib/cache.ts']) {
        agg.files[`/work/${project}/${f}`] = {
            edits: 1 + Math.round(r() * 40),
            added: Math.round(r() * 900),
            removed: Math.round(r() * 500),
        };
    }

    agg.friction = {
        toolErrors: Math.round(r() * 40), denials: { 'user-rejected': Math.round(r() * 9) },
        interrupts: Math.round(r() * 6), hookErrors: Math.round(r() * 3),
        shutdowns: Math.round(r() * 4), compactions: { auto: Math.round(r() * 7), manual: Math.round(r() * 2) },
        droppedTokens: Math.round(r() * 900000), compactMs: Math.round(r() * 400000),
    };

    agg.prompts = {
        count: 40 + Math.round(r() * 120),
        chars: 30000 + Math.round(r() * 60000),
        longest: 900 + Math.round(r() * 2600),
        byHour: Object.fromEntries([9, 11, 13, 15, 17, 19, 22].map((h) => [h, 3 + Math.round(r() * 22)])),
        bySource: { typed: 60 + Math.round(r() * 70), pasted: 4 + Math.round(r() * 15), command: 6 + Math.round(r() * 20) },
        words: Object.fromEntries(Object.entries(WORDS).map(([w, n]) => [w, Math.round(n * (0.4 + r()))])),
        lens: { 0: 20, 1: 34, 2: 21, 3: 9, 4: 3 },
    };

    // Three kinds of transcript, because the Agents tab exists to hold them
    // against each other.
    let id = 0;
    const session = (kind, cost, out, extra = {}) => {
        const start = now - Math.round(r() * 60) * day - Math.round(r() * 8) * 3600000;
        const dur = (4 + r() * 90) * 60000;
        const tokens = Math.round(cost * 260000);
        return {
            id: `${project}-${kind}-${id++}`, kind, project, slug: project,
            title: TITLES[Math.floor(r() * TITLES.length)],
            entrypoint: kind === 'main' ? 'cli' : 'agent',
            start, end: start + dur, activeMs: Math.round(dur * (0.2 + r() * 0.5)),
            msgs: 6 + Math.round(r() * 120),
            cost, tokens, out, cacheRead: Math.round(tokens * 0.78), cacheWrite: Math.round(tokens * 0.11),
            tools: Math.round(r() * 90), errors: Math.round(r() * 6),
            models: [r() < 0.7 ? MODELS[0] : MODELS[1]], efforts: [EFFORTS[Math.floor(r() * 3)]],
            branch: BRANCHES[Math.floor(r() * BRANCHES.length)], agentId: '', workflowId: '',
            ...extra,
        };
    };
    for (let i = 0; i < 6; i++) agg.sessions.push(session('main', (3 + r() * 26) * weight, 20000 + Math.round(r() * 90000)));
    for (let i = 0; i < 9; i++) {
        agg.sessions.push(session('agent', (0.8 + r() * 9) * weight, 12000 + Math.round(r() * 120000), { agentId: `a${i}` }));
    }
    for (let i = 0; i < 7; i++) {
        agg.sessions.push(session('workflow', (1.2 + r() * 12) * weight, 18000 + Math.round(r() * 140000),
            { agentId: `w${i}`, workflowId: `wf_${['migrate', 'audit', 'review'][i % 3]}${i}` }));
    }

    return agg;
}

// Three runs, one of each state — the panel's whole vocabulary in one table.
function runs(now) {
    const r = rng(99);
    const agent = (label, phase, state, tokens, cost) => ({
        agentId: `ag_${Math.round(r() * 1e6).toString(16)}`,
        // The Now tab draws a row per live agent with its effort beside its
        // model: leaving the field out here would photograph an empty column and
        // advertise the feature as broken.
        label, phase, state, model: r() < 0.7 ? MODELS[0] : MODELS[1], effort: r() < 0.6 ? 'xhigh' : 'medium',
        tokens, cost, toolCalls: 4 + Math.round(r() * 40), durationMs: (30 + r() * 400) * 1000,
        promptPreview: `${label}. Report findings as structured output; include low-severity ones.`,
        resultPreview: state === 'done' ? '{"findings":[{"severity":"medium","file":"src/db/schema.sql"}]}' : '',
        lastToolName: 'Grep',
    });

    return [
        {
            runId: 'wf_audit_7f21', project: 'acme-api', slug: 'acme-api', sessionId: 'sess-a',
            state: 'running', name: 'schema-audit',
            startedAt: now - 22 * 60000, endedAt: 0, lastActivity: now - 9000,
            status: '', durationMs: 0,
            phases: [{ title: 'Inventory' }, { title: 'Audit' }, { title: 'Verify' }],
            agents: [
                agent('inventory:tables', 'Inventory', 'done', 1_240_000, 3.9),
                agent('audit:constraints', 'Audit', 'done', 2_010_000, 6.4),
                agent('audit:indexes', 'Audit', 'progress', 890_000, 2.7),
                agent('verify:migration-plan', 'Verify', 'progress', 410_000, 1.2),
            ],
            totals: { agents: 6, reported: 0, tokens: 0, reportedTokens: 0, toolCalls: 0, done: 2, cost: 14.2 },
        },
        {
            runId: 'wf_review_31a0', project: 'web-client', slug: 'web-client', sessionId: 'sess-b',
            state: 'finished', name: 'checkout-review',
            startedAt: now - 3 * day, endedAt: now - 3 * day + 51 * 60000, lastActivity: now - 3 * day + 51 * 60000,
            status: 'completed', durationMs: 51 * 60000,
            phases: [{ title: 'Review' }, { title: 'Verify' }],
            agents: [
                agent('review:accessibility', 'Review', 'done', 1_820_000, 5.8),
                agent('review:state-machine', 'Review', 'done', 2_340_000, 7.4),
                agent('verify:cart-totals', 'Verify', 'done', 760_000, 2.3),
            ],
            totals: { agents: 3, reported: 3, tokens: 4_920_000, reportedTokens: 4_920_000, toolCalls: 96, done: 3, cost: 15.5 },
        },
        {
            runId: 'wf_migrate_0c8d', project: 'platform-infra', slug: 'platform-infra', sessionId: 'sess-c',
            state: 'abandoned', name: 'terraform-migrate',
            startedAt: now - 9 * day, endedAt: 0, lastActivity: now - 9 * day + 12 * 60000,
            status: '', durationMs: 0,
            phases: [{ title: 'Plan' }, { title: 'Apply' }],
            agents: [agent('plan:modules', 'Plan', 'progress', 520_000, 1.6)],
            totals: { agents: 4, reported: 0, tokens: 0, reportedTokens: 0, toolCalls: 0, done: 1, cost: 1.6, unlisted: 4.1 },
        },
    ];
}

// What every placeholder says on this invented machine. The palette shows these
// beside the names, and the preset cards are rendered from them — in the editor
// that rendering is done by extension.js over a live reading, and outside it the
// preview harness has to stand in or the cards show their own templates back.
const VALUES = {
    weekly: '57%', weeklyBar: '████░░', plan: '64%', drift: '-7%', dry: '', dryAt: 'Thu 13.08, ~19h',
    dryLeft: '2d4h', reset: 'Wed 13.08 09:00', resetLeft: '2d12h', session5h: '43%', session5hLeft: '2h40m',
    scoped: 'opus 61%', ctx: '29%', ctxTokens: '294k', ctxWindow: '1M', ctxCache: '78%', compact: '78%',
    model: 'Opus 5', effort: 'xhigh', advisor: 'Fable 5', thinking: 'on', outputStyle: 'default',
    branch: 'feat/checkout-v2', version: '2.1.224', update: '',
    // Money and shares arrive without the tilde: it lives in the segment
    // templates, so putting one here too prints "~~$114.29" on every card.
    cost: '$114.29', burn: '$5.18', today: '$38.40',
    requests: '486', duration: '6h12m', apiShare: '61%', added: '+4120', removed: '-1870',
    peers: '3', peersBusy: '1', todo: '4/7', todoActive: 'Backfill the orders table',
    jobs: '2', sessions: '5', openTasks: '9', wfName: 'schema-audit', wfAgents: '2/6',
    wfElapsed: '22m', wfCost: '$14.20', wfRuns: '3',
};

// The same call extension.js makes for the Settings tab, against a registry that
// answers from VALUES instead of from a machine.
function presetPreviews() {
    const real = seg.fields({});
    const registry = Object.fromEntries(Object.entries(real).map(([name, f]) => [
        name, { topic: f.topic, doc: f.doc, get: () => VALUES[name] ?? '' },
    ]));
    const out = {};
    for (const preset of seg.PRESETS) {
        out[preset.id] = preset.segments
            .map((template) => seg.renderSegment(template, {}, registry).text)
            .filter((line) => line);
    }
    return out;
}

function demo(now = Date.now()) {
    const index = { files: {} };
    PROJECTS.forEach((p, i) => {
        index.files[`/work/${p}/transcript.jsonl`] = { agg: projectAgg(p, 1000 + i * 7, now) };
    });
    const total = ix.summarize(index);
    const nowS = Math.floor(now / 1000);

    // A window two and a half days from its reset, spent a little ahead of an
    // even burn — the state where every part of the Now tab has something to say.
    const reset = nowS + Math.round(2.5 * 86400);
    const limits = {
        session: { pct: 43, reset: nowS + 2 * 3600 + 40 * 60, scope: null },
        weekly: { pct: 57, reset, scope: null },
        scoped: [
            { pct: 61, reset, scope: 'Opus' },
            { pct: 24, reset, scope: 'Sonnet' },
        ],
    };
    const pace = u.pace(limits.weekly, nowS);
    const ctx = {
        model: MODELS[0], effort: 'xhigh', pct: 29, tokens: 294000, window: 1000000,
        cachePct: 78, branch: 'feat/checkout-v2', estimated: false, advisor: 'claude-fable-5',
    };
    const stats = {
        cost: 114.29, burn: 5.18, durationMs: 6 * 3600000 + 12 * 60000, messages: 486,
        apiPct: 61, added: 4120, removed: 1870,
    };
    const settings = { thinking: true, thinkingSummaries: true, advisor: 'claude-fable-5', outputStyle: 'default' };
    const shared = {
        now: nowS, limits, weekly: limits.weekly, session: limits.session, scoped: limits.scoped,
        pace, ctx, stats, settings, version: { current: '2.1.224', latest: '' },
        compactPct: 78, todayUsd: 38.4,
        peers: { total: 3, busy: 1 }, todo: { done: 4, total: 7, active: 'Backfill the orders table' },
    };

    // Ten weeks of the weekly window, so the Limits chart has lines rather than a
    // single point.
    const history = [];
    for (let w = 9; w >= 0; w--) {
        const weekReset = reset - w * 7 * 86400;
        const r = rng(500 + w);
        for (let d = 0; d <= 6.5; d += 0.25) {
            const frac = d / 7;
            history.push({
                at: (weekReset - 7 * 86400 + d * 86400) * 1000,
                weekly: Math.min(100, Math.round(frac * (70 + r() * 45))),
                session: Math.round(r() * 60),
                reset: weekReset,
                models: { Opus: Math.min(100, Math.round(frac * (75 + r() * 40))), Sonnet: Math.round(frac * 30) },
            });
        }
    }

    return {
        index,
        total,
        meta: {
            files: Object.keys(index.files).length * 137,
            lastRun: now,
            history,
            workflows: runs(now),
            system: null,
            metrics: status.statusMetrics(shared),
            now: status.statusSections(shared, {
                fmtCost, fmtLeft: u.fmtLeft, fmtAbs: (ts) => u.fmtAbs(ts, now), fmtWhen: u.fmtWhen,
                fmtDuration: (ms) => `${Math.floor(ms / 3600000)}h${Math.round((ms % 3600000) / 60000)}m`,
                tok: wfm.tokenLabel, shortModel: db.shortModel,
            }, { stale: false, updatedAt: nowS - 40 }),
            config: {
                segments: seg.DEFAULT_SEGMENTS,
                defaults: seg.DEFAULT_SEGMENTS,
                presets: seg.PRESETS,
                alignment: 'right', priority: 100, refreshInterval: 60,
                palette: Object.entries(seg.fields({})).map(([name, f]) => ({
                    name, topic: f.topic, doc: f.doc, value: VALUES[name] ?? '',
                })),
            },
        },
    };
}

module.exports = { demo, presetPreviews, PROJECTS, VALUES };
