const vscode = require('vscode');
const u = require('./usage');
const s = require('./session');
const ix = require('./indexer');
const hist = require('./history');
const sys = require('./system');
const seg = require('./segments');
const dashboard = require('./dashboard');
const wfm = require('./workflows');
const { fmtCost, ratesFor } = require('./pricing');

// Complaining about the cache is only meaningful once refreshes have failed for
// a while: with a one-minute period, a two-minute threshold would fire on an
// ordinary skipped tick in the background.
const STALE_AFTER = 600;

// Context is read from disk in a couple of milliseconds, so it refreshes more
// often than the limits — those hit the network and stay on their minute tick.
const CONTEXT_TICK = 10;

// StatusBarItem has no arbitrary colors — only these three states — so the
// 50/80 thresholds from statusline.sh map onto them one to one.
function background(pct) {
    if (pct >= 80) return new vscode.ThemeColor('statusBarItem.errorBackground');
    if (pct >= 50) return new vscode.ThemeColor('statusBarItem.warningBackground');
    return undefined;
}

// A minimal stand-in for MarkdownString while a tooltip is being assembled: the
// same appendMarkdown call site, but the result is a plain string that can be
// concatenated with another section.
class Markdown {
    constructor() { this.value = ''; }

    appendMarkdown(text) { this.value += text; return this; }
}

// A tooltip has room a status bar does not, so it gets sections and full rows
// instead of the terminal's single dense line. Each fact lives on its own row
// with a label, and nothing is packed into a heading to save space.
function table(rows, head) {
    const header = head ? `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n` : '| | |\n|---|---|\n';
    return header + rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n') + '\n';
}

// The tooltips build markdown rather than a MarkdownString: a segment can carry
// fields from two topics, and then its tooltip is both sections joined — which
// is only possible if each section is a string first.
function limitsTooltip(lim, pc, now, stale) {
    const md = new Markdown();
    const rows = [];
    const row = (label, pct, reset) =>
        [label, `**${pct}%**`, reset ? `${u.fmtLeft(reset, now)} → ${u.fmtAbs(reset)}` : ''];

    if (lim.session) rows.push(row('5h', lim.session.pct, lim.session.reset));
    if (lim.weekly) rows.push(row('7d', lim.weekly.pct, lim.weekly.reset));
    // Per-model windows almost always reset together with the overall weekly one;
    // repeating that date on every row would turn the table into noise.
    for (const scoped of lim.scoped) {
        const own = Math.abs(scoped.reset - (lim.weekly?.reset ?? 0)) > 60 ? scoped.reset : 0;
        rows.push(row(scoped.scope.toLowerCase(), scoped.pct, own));
    }
    md.appendMarkdown(table(rows, ['limit', 'used', 'resets']));

    if (pc && lim.weekly) {
        // Pace as its own section: spend against plan is a comparison, and a
        // comparison squeezed into a row label is the thing that was hard to read.
        const diff = lim.weekly.pct - pc.plan;
        const verdict = diff > 0 ? `${diff} pp ahead of plan` : diff < 0 ? `${-diff} pp under plan` : 'exactly on plan';
        md.appendMarkdown(`\n**Pace** — ${lim.weekly.pct}% spent, ${pc.plan}% of the window elapsed: ${verdict}\n`);

        // The forecast is stated even when it lands past the reset. "You will not
        // run out" is worth far more with the date that would have been.
        if (pc.dryAt && pc.elapsed >= 1800 && lim.weekly.pct >= 2) {
            const when = `**${u.fmtWhen(pc.dryAt)}**, in ${u.fmtLeft(pc.dryAt, now)}`;
            md.appendMarkdown(pc.beforeReset
                ? `\n$(flame) **Forecast** — 100% around ${when}, before the window resets\n`
                : `\n$(check) **Forecast** — 100% would be ${when}, which is after the reset: you do not get there\n`);
        }
    }

    if (stale) md.appendMarkdown('\n$(warning) showing cached data — refresh failed\n');
    md.appendMarkdown(`\n_updated ${u.fmtAbs(u.mtime(u.CACHE))}_`);
    return md.value;
}

// A round million reads as "1M", not "1.0M" — the model window is written the
// way statusline.sh writes it.
const tok = (n) => {
    if (n < 1e6) return `${Math.round(n / 1000)}k`;
    const m = n / 1e6;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
};

function contextTooltip(state) {
    const { context: ctx, settings, version } = state;
    if (!ctx) return '';
    const md = new Markdown();
    md.appendMarkdown(`### ${short(ctx.model)}\n\n`);

    // The terminal packs model, effort, thinking and advisor into one line
    // because it has one line. Here each is a labelled row: the values are
    // unrelated to each other and reading them as a run of dot-separated words
    // means parsing the separator rather than the fact.
    const advisor = ctx.advisor || settings.advisor;
    const model = [];
    if (ctx.effort) model.push(['effort', ctx.effort]);
    model.push(['thinking', ctx.thinking ? 'on' : 'off']);
    if (advisor) model.push(['advisor', short(advisor)]);
    if (settings.outputStyle) model.push(['output style', settings.outputStyle]);
    md.appendMarkdown(table(model));

    const win = `${tok(ctx.tokens)} / ${tok(ctx.window)}`;
    const fill = [['window', `**${ctx.estimated ? '~' : ''}${ctx.pct}%** — ${win}`]];
    if (ctx.estimated) fill.push(['note', 'window size unknown for this model']);
    if (ctx.cachePct >= 0) fill.push(['from cache', `${ctx.cachePct}%`]);
    if (state.compactPct > 0) {
        const left = state.compactPct - ctx.pct;
        fill.push(['auto-compact', left > 0 ? `at ${state.compactPct}% — ${left} pp away` : `at ${state.compactPct}% — due`]);
    }
    md.appendMarkdown(`\n**Context**\n\n${table(fill)}`);

    const env = [];
    if (ctx.branch) env.push(['branch', ctx.branch]);
    if (version.current) env.push(['client', `v${version.current}`]);
    if (env.length) md.appendMarkdown(`\n**Environment**\n\n${table(env)}`);

    if (version.latest) {
        md.appendMarkdown(`\n$(arrow-up) **${version.latest}** is unpacked and starts with the next launch\n`);
    }
    return md.value;
}

function moneyTooltip(state) {
    const { stats, todayUsd, context: ctx } = state;
    if (!stats) return '';
    const md = new Markdown();
    md.appendMarkdown(`### ~${fmtCost(stats.cost)} this session\n\n`);

    const spend = [['today', `~${fmtCost(todayUsd)}`]];
    if (stats.burn > 0) spend.push(['burn rate', `~${fmtCost(stats.burn)}/h`]);
    md.appendMarkdown(table(spend));

    const work = [];
    if (stats.durationMs > 0) work.push(['duration', s.fmtDuration(stats.durationMs)]);
    work.push(['requests', String(stats.messages)]);
    if (stats.apiPct >= 0) work.push(['waiting on model', `~${stats.apiPct}% of that time`]);
    if (stats.added || stats.removed) work.push(['edits', `+${stats.added} / −${stats.removed} lines`]);
    md.appendMarkdown(`\n**This session**\n\n${table(work)}`);

    const known = ctx ? ratesFor(ctx.model).known : true;
    md.appendMarkdown(known
        ? '\n_estimated from public rates — not a bill. Click for the full dashboard._'
        : '\n_estimated at Opus rates: this model has no published rate. Click for the full dashboard._');
    return md.value;
}

// The bar needs the model, not the full id: "claude-opus-5" → "opus 5".
function short(model) {
    return (model || '')
        .replace(/^claude-/, '')
        .replace(/\[[^\]]*\]$/, '')
        .replace(/-(\d)-(\d)$/, ' $1.$2')
        .replace(/-(\d)$/, ' $1');
}

function workTooltip(state) {
    const { peers, todo } = state.data;
    if (!peers && !todo) return '';
    const md = new Markdown();
    if (todo) {
        md.appendMarkdown(`### Tasks ${todo.done}/${todo.total}\n\n`);
        if (todo.active) md.appendMarkdown(`$(play) ${todo.active}\n\n`);
    }
    if (peers && peers.total > 0) {
        const rows = [['sessions', String(peers.total)]];
        if (peers.busy > 0) rows.push(['busy right now', String(peers.busy)]);
        md.appendMarkdown(`${todo ? '**Other sessions here**' : '### Other sessions here'}\n\n${table(rows)}`);
    }
    return md.value;
}

// What an agent is doing, as one icon. Every word outcomeOf can answer with is
// here, including the two a live run cannot produce today: an unmapped one would
// print "undefined" in the cell, and a cell is read as a fact about the agent.
const AGENT_ICON = {
    running: '$(sync)',
    done: '$(check)',
    failed: '$(error)',
    stopped: '$(circle-slash)',
    unknown: '$(question)',
};

// A table cell holds one line and no pipes, and an agent's prompt is whatever
// someone typed — a newline in it would end the row and a pipe would split it.
function cell(text) {
    return String(text || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}

function workflowTooltip(state) {
    const active = (state.data.workflows && state.data.workflows.active) || [];
    if (active.length === 0) return '';
    const md = new Markdown();
    for (const run of active) {
        md.appendMarkdown(`### ${run.name || run.runId}\n\n`);
        // Grouped by phase, because a phase is what the run's author wrote it in
        // terms of: a flat list of fourteen agents does not say which stage the
        // run is sitting in. A live run knows no phases yet — the client only
        // writes them with the final snapshot — so they all fall in one group.
        const byPhase = new Map();
        for (const agent of run.agents) {
            const key = agent.phase || '';
            if (!byPhase.has(key)) byPhase.set(key, []);
            byPhase.get(key).push(agent);
        }
        for (const [phase, agents] of byPhase) {
            // The blank line is what ends the table above: a heading written
            // straight after the last row is read as part of it.
            if (phase) md.appendMarkdown(`\n**${phase}**\n\n`);
            md.appendMarkdown(table(agents.map((a) => [
                AGENT_ICON[wfm.outcomeOf(a.state, run.state)] || AGENT_ICON.unknown,
                // A live agent has no label — it exists only in the runtime — so
                // the first thing it was told stands in for one.
                cell(a.label || (a.promptPreview || '').slice(0, 40) || a.agentId.slice(0, 8)),
                short(a.model),
                a.tokens ? tok(a.tokens) : '',
            ]), ['', 'agent', 'model', 'tokens']));
        }
        if (run.totals.cost > 0) md.appendMarkdown(`\n_~${fmtCost(run.totals.cost)} so far_\n`);
    }
    return md.value;
}

// One builder per topic, so a segment that mixes topics gets both sections
// joined rather than a tooltip about half of what it shows.
const TOOLTIPS = {
    limits: (state) => {
        const d = state.data;
        if (!d.limits || !d.weekly) return '';
        return limitsTooltip(d.limits, d.pace, d.now, d.now - u.mtime(u.CACHE) > STALE_AFTER);
    },
    context: contextTooltip,
    money: moneyTooltip,
    work: workTooltip,
    // Both maps are looked up by topic on every draw, so an entry missing here
    // is not a segment without a tooltip — it is a throw inside render() that
    // hides the whole bar, the moment the first workflow starts.
    workflow: workflowTooltip,
};

// The percentage a topic colours by. A segment showing both a limit and a
// context fill takes the louder of the two: the point of the colour is to be
// noticed, and the quieter number would hide the other one.
const COLOUR_BY = {
    limits: (d) => (d.weekly ? d.weekly.pct : -1),
    context: (d) => (d.ctx ? d.ctx.pct : -1),
    money: () => -1,
    work: () => -1,
    // A run in flight is not a threshold: there is nothing here to be warned
    // about, and painting the bar red for one would spend the alarm on news.
    workflow: () => -1,
};

function render(state) {
    const registry = state.registry;
    state.items.forEach((item, i) => {
        const template = state.segments[i];
        const out = seg.renderSegment(template, state.data, registry);
        if (!out.visible) { item.hide(); return; }

        item.text = out.text;
        const sections = out.topics.map((topic) => TOOLTIPS[topic](state)).filter(Boolean);
        if (sections.length) {
            const md = new vscode.MarkdownString(sections.join('\n\n---\n\n'), true);
            item.tooltip = md;
        } else {
            item.tooltip = 'Claude — click for the usage dashboard';
        }
        const worst = Math.max(-1, ...out.topics.map((topic) => COLOUR_BY[topic](state.data)));
        item.backgroundColor = background(worst);
        item.show();
    });
}

// Fields whose value comes out of the single expensive pass over the whole
// transcript, and the context fields that come from its tail.
const MONEY_FIELDS = ['cost', 'burn', 'requests', 'duration', 'apiShare', 'added', 'removed'];
const CONTEXT_FIELDS = ['ctx', 'ctxTokens', 'ctxWindow', 'ctxCache', 'model', 'effort', 'thinking', 'branch', 'compact'];

// Everything cheap enough for the ten-second tick: the transcript tail, and the
// two registry reads behind peers and the task list.
function collectFast(state) {
    const d = state.data;
    d.now = Math.floor(Date.now() / 1000);
    // Ahead of the session guard below, and outside state.needs: a workflow is a
    // fact about the machine, not about this window's session — a window with no
    // Claude session in it still has a tree and a dashboard tab to fill.
    collectWorkflowsFast(state);
    const own = state.session;
    if (!own || !state.workspace) {
        d.ctx = null; d.peers = null; d.todo = null;
        state.context = null;
        return;
    }
    if (CONTEXT_FIELDS.some((f) => state.needs.has(f))) {
        d.ctx = s.contextOf(s.readTail(s.transcriptPath(state.workspace, own.sessionId)));
        state.context = d.ctx;
    }
    if (state.needs.has('peers') || state.needs.has('peersBusy')) {
        d.peers = s.peersOf(state.workspace, own.sessionId);
    }
    if (state.needs.has('todo') || state.needs.has('todoActive')) {
        d.todo = s.todoOf(own.sessionId);
    }
}

// The expensive half: the limit cache, the full transcript pass, today's spend
// across every project, and the machine-wide counters. Only what some segment
// actually asks for is read — a bar that never mentions {today} does not pay
// for a walk over every project directory.
function collectSlow(state) {
    const d = state.data;
    d.now = Math.floor(Date.now() / 1000);

    const payload = u.readCache(d.now);
    const lim = payload ? u.limitsOf(payload) : null;
    d.limits = lim;
    d.weekly = lim && lim.weekly ? lim.weekly : null;
    d.session = lim && lim.session ? lim.session : null;
    d.scoped = lim ? lim.scoped : [];
    d.pace = d.weekly ? u.pace(d.weekly, d.now) : null;
    d.bar = d.weekly && d.pace ? u.bar(d.weekly.pct, d.pace.plan) : '';
    // Every window in this VS Code session records the same reading, and only
    // the first one to see a change writes a row — the rest find it unchanged.
    // The endpoint keeps no history, so if nobody writes it down, the shape of
    // the week is gone.
    if (lim && lim.weekly && state.storageDir) hist.recordLimits(state.storageDir, lim);

    if (state.session && state.workspace) {
        // The whole transcript is parsed for this, so it only happens when some
        // segment asks a question that needs it.
        if (MONEY_FIELDS.some((f) => state.needs.has(f))) {
            state.stats = s.sessionStats(s.transcriptPath(state.workspace, state.session.sessionId));
            d.stats = state.stats;
        }
        if (state.needs.has('today')) { state.todayUsd = s.costToday().usd; d.todayUsd = state.todayUsd; }
        state.compactPct = s.autoCompactPct(state.workspace, state.context?.window || 0);
        state.settings = s.settingsOf(state.workspace);
        state.version = s.versionInfo(state.session.version);
        d.compactPct = state.compactPct;
        d.settings = state.settings;
        d.version = state.version;
    } else {
        state.stats = null;
        d.stats = null;
    }

    if (state.needs.has('jobs') || state.needs.has('sessions') || state.needs.has('openTasks')) {
        d.machine = machineCounters(state.needs);
    }

    collectWorkflowsSlow(state);
}

// Which runs exist at all, and what they cost. This walks every project
// directory, so it belongs on the slow tick beside the other expensive reads —
// and it prices the agents of a live run from their transcripts, which is a full
// read of each. Unlike everything above it, it does not consult state.needs: the
// tree and the dashboard want these runs whatever the bar happens to mention.
function collectWorkflowsSlow(state) {
    try {
        const liveSessions = new Set(sys.live().sessions.filter((x) => x.alive).map((x) => x.id));
        // The index is what prices a workflow's agents. It is read here and
        // never built: building it is a seconds-long walk that belongs to the
        // dashboard's progress notification, not to a status-bar tick.
        if (state.storageDir) state.index = ix.loadIndex(state.storageDir);
        const root = state.projectsRoot;
        const runs = wfm.withCost(wfm.scanRuns({ root, liveSessions }), { index: state.index, live: true, root });
        state.workflows = runs;
        state.data.workflows = { runs, active: runs.filter((r) => r.state === 'running') };
    } catch {
        // A half-readable tree must not take the bar down with it: the previous
        // reading stays until a tick manages to replace it.
        state.data.workflows = state.data.workflows || { runs: [], active: [] };
    }
}

// Only the runs already known to be going: their journal and the tails of their
// agents' transcripts, nothing else. This must never call scanRuns — that walks
// every project directory and parses every snapshot on the machine, which is the
// sweep the slow tick owns. What is left is bounded by the number of live agents
// rather than by the history of the machine, which is what makes it affordable
// every ten seconds — and a panel refreshed once a minute is not a live panel.
//
// The price is that a workflow launched a moment ago reaches the bar only on the
// next slow tick, up to a minute later. Discovery is rare; watching a run that
// is already going is the part that has to feel immediate.
function collectWorkflowsFast(state) {
    const runs = (state.data.workflows && state.data.workflows.runs) || [];
    if (!runs.some((r) => r.state === 'running')) return;
    try {
        const next = runs.map((run) => {
            if (run.state !== 'running' || !run.runDir) return run;
            // A snapshot appearing is how a run announces it is over. Looking for
            // it lives in workflows.js, so this file keeps its hands off the disk.
            if (wfm.snapshotArrived(run)) return { ...run, state: 'finished' };
            const live = wfm.readLive(run.runDir);
            if (!live) return run;
            // What an agent has cost is settled by the slow tick, which reads its
            // whole transcript; this one only re-reads what it is doing. The
            // figures are carried across rather than dropped, or the money
            // columns empty out for the fifty seconds between slow ticks. An
            // agent that appeared since then has none yet, which is the truth.
            const priced = new Map(run.agents.map((a) => [a.agentId, a]));
            const agents = live.agents.map((a) => {
                const was = priced.get(a.agentId);
                return was ? { ...a, cost: was.cost || 0, tokens: was.tokens || 0 } : a;
            });
            return {
                ...run,
                agents,
                totals: { ...run.totals, agents: live.total, done: live.done },
            };
        });
        state.workflows = next;
        state.data.workflows = { runs: next, active: next.filter((r) => r.state === 'running') };
    } catch { /* keep the previous reading */ }
}

// Machine-wide counters, read straight from ~/.claude. Sizes are skipped — a
// status bar has no use for them and they are what makes that walk slow.
function machineCounters(needs) {
    const out = { jobs: 0, sessions: 0, openTasks: 0 };
    try {
        if (needs.has('jobs')) {
            out.jobs = sys.jobs(sys.ROOT, { withSizes: false }).filter((j) => j.state === 'working').length;
        }
        if (needs.has('sessions')) {
            out.sessions = sys.live().sessions.filter((x) => x.alive).length;
        }
        if (needs.has('openTasks')) {
            out.openTasks = sys.tasks().reduce((a, t) => a + t.open.length, 0);
        }
    } catch { /* a half-readable tree must not take the bar down */ }
    return out;
}

// The heavy work — the network call for limits and the full transcript pass for
// spend — lives here and runs on the minute tick, not on every draw.
function slowTick(state) {
    if (u.stampExpired(Math.floor(Date.now() / 1000))) {
        u.touchStamp();
        u.refreshUsage().then(() => { collectSlow(state); render(state); }, () => { /* draw from cache */ });
    }
    refreshSession(state);
    collectFast(state);
    collectSlow(state);
    render(state);
}

function fastTick(state) {
    refreshSession(state);
    collectFast(state);
    render(state);
}

// The window's session outlives ticks, but a panel can be closed and reopened —
// re-read the registry once the cached session is gone.
function refreshSession(state) {
    const current = state.session;
    if (current) {
        try { process.kill(current.pid, 0); return; } catch { state.session = null; }
    }
    state.session = s.findOwnSession(state.workspace);
}

// --- dashboard --------------------------------------------------------------

// One panel, reused. A second invocation reveals the existing one rather than
// stacking copies of a page that costs a full index read to build.
let panel = null;

// Indexing a gigabyte of transcripts takes seconds on the first run, so it
// happens inside a progress notification the user can watch — and reuses the
// stored fingerprints on every run after that.
async function buildIndex(storageDir, { force = false } = {}) {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Claude: indexing transcripts',
        cancellable: false,
    }, async (progress) => {
        if (force) ix.saveIndex(storageDir, { version: ix.INDEX_VERSION, files: {} });
        let lastPct = 0;
        const result = await new Promise((resolve) => {
            // setImmediate lets the notification paint before the synchronous
            // read begins; without it the first run looks like a frozen window.
            setImmediate(() => resolve(ix.refreshIndex(storageDir, {
                onProgress: (done, total) => {
                    const p = Math.floor((done / total) * 100);
                    if (p > lastPct) { progress.report({ increment: p - lastPct, message: `${done}/${total}` }); lastPct = p; }
                },
            })));
        });
        return result;
    });
}

// The installation snapshot without the disk walk takes milliseconds; with it,
// a second or two over three gigabytes. So the sizes are measured on the first
// open, kept for an hour, and re-measured whenever Reindex is pressed.
const SYSTEM_TTL = 3600 * 1000;
let systemCache = null;

function systemSnapshot(state, index, { force = false } = {}) {
    const fresh = systemCache && !force && Date.now() - systemCache.at < SYSTEM_TTL;
    if (fresh) return systemCache;

    // Project directories and the session→project map come from the index, so
    // the snapshot can name a task list's repository and price project memory
    // without walking the transcript tree a second time.
    const projects = new Set();
    const sessionProjects = {};
    for (const entry of Object.values(index.files)) {
        for (const row of (entry && entry.agg ? entry.agg.sessions : [])) {
            if (row.kind === 'main' && row.id) sessionProjects[row.id] = row.project;
        }
    }
    for (const folder of vscode.workspace.workspaceFolders || []) projects.add(folder.uri.fsPath);
    if (state && state.workspace) projects.add(state.workspace);

    try {
        systemCache = sys.snapshot({
            workspace: (state && state.workspace) || '',
            projects: [...projects],
            sessionProjects,
        });
    } catch {
        // A tree that is half-readable must not take the dashboard down with it.
        systemCache = null;
    }
    return systemCache;
}

/**
 * What the settings tab needs: the values in force, and every placeholder with
 * what it says right now. The palette is only useful with live values next to
 * it — a name means little until you see that `{drift}` currently reads "-7pp".
 */
function configView(state) {
    const cfg = vscode.workspace.getConfiguration('claudeStatusline');
    const registry = (state && state.registry) || seg.fields({});
    const data = (state && state.data) || {};
    const palette = Object.entries(registry).map(([name, field]) => {
        let value = '';
        try { value = String(field.get(data, '') ?? ''); } catch { value = ''; }
        return { name, topic: field.topic, doc: field.doc, value };
    });
    return {
        segments: (state && state.segments) || cfg.get('segments') || seg.DEFAULT_SEGMENTS,
        defaults: seg.DEFAULT_SEGMENTS,
        alignment: cfg.get('alignment'),
        priority: cfg.get('priority'),
        refreshInterval: cfg.get('refreshInterval'),
        palette,
    };
}

// The webview edits settings; writing them is the extension's job. Only these
// four keys are ever written, and only into the scope the form asked for.
const WRITABLE = ['segments', 'alignment', 'priority', 'refreshInterval'];

async function handleMessage(context, msg) {
    const state = context.claudeState;
    if (!msg || !panel) return;

    if (msg.type === 'refresh') { showDashboard(context, { force: false }); return; }

    if (msg.type === 'preview') {
        // Rendered by the same code that draws the bar, against the data the
        // bar is holding at this moment — so the preview cannot disagree with
        // what appears after saving.
        const previews = (msg.segments || []).map((template) => {
            const out = seg.renderSegment(String(template), state ? state.data : {}, state ? state.registry : seg.fields({}));
            return { text: out.visible ? out.text : '' };
        });
        panel.webview.postMessage({ type: 'preview', previews });
        return;
    }

    if (msg.type === 'defaults') {
        panel.webview.postMessage({ type: 'defaults', segments: seg.DEFAULT_SEGMENTS });
        return;
    }

    if (msg.type === 'save') {
        const target = msg.scope === 'workspace'
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        const cfg = vscode.workspace.getConfiguration('claudeStatusline');
        try {
            for (const key of WRITABLE) {
                if (msg.settings && msg.settings[key] !== undefined) await cfg.update(key, msg.settings[key], target);
            }
            panel.webview.postMessage({ type: 'saved' });
        } catch (err) {
            vscode.window.showErrorMessage(`Claude statusline: could not save settings — ${err.message}`);
        }
    }
}

async function showDashboard(context, { force = false } = {}) {
    const storageDir = context.globalStorageUri.fsPath;
    const { index, stats } = await buildIndex(storageDir, { force });
    const total = ix.summarize(index);
    const html = dashboard.render(index, total, {
        files: stats.total,
        lastRun: Date.now(),
        history: hist.readHistory(storageDir),
        system: systemSnapshot(context.claudeState, index, { force }),
        config: configView(context.claudeState),
    });

    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            'claudeStatusline.dashboard', 'Claude usage', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        panel.onDidDispose(() => { panel = null; });
        panel.webview.onDidReceiveMessage((msg) => handleMessage(context, msg));
    } else {
        panel.reveal(vscode.ViewColumn.Active);
    }
    panel.webview.html = html;
}

// The helpers the field registry formats with. They live in usage.js and
// session.js, and are passed in rather than imported there so segments.js stays
// a string builder with no idea where its numbers come from.
function buildRegistry() {
    return seg.fields({
        fmtCost,
        fmtDry: (ts) => u.fmtDry(ts),
        fmtLeft: u.fmtLeft,
        fmtAbs: (ts) => u.fmtAbs(ts),
        fmtDuration: s.fmtDuration,
        tok,
        shortModel: short,
    });
}

/**
 * Create one status-bar item per segment, discarding whatever was there before.
 * Called on activation and again whenever the configuration changes, so a new
 * template — or a different alignment — takes effect without a window reload.
 */
function applyConfig(state) {
    const cfg = vscode.workspace.getConfiguration('claudeStatusline');
    const configured = cfg.get('segments');
    state.segments = Array.isArray(configured) && configured.length > 0
        ? configured.map(String) : seg.DEFAULT_SEGMENTS;
    // Only the fields some segment mentions are ever collected; the rest of the
    // reads are skipped entirely.
    state.needs = seg.usedFields(state.segments, state.registry);

    const align = cfg.get('alignment') === 'left'
        ? vscode.StatusBarAlignment.Left
        : vscode.StatusBarAlignment.Right;
    const priority = cfg.get('priority');

    for (const item of state.items) item.dispose();
    // Priority descends along the list, so segments appear left to right in the
    // order they are written whichever side of the bar they sit on.
    state.items = state.segments.map((template, i) => {
        const bar = vscode.window.createStatusBarItem(`claudeStatusline.segment${i}`, align, priority - i);
        bar.name = `Claude ${i + 1}`;
        // Every item opens the dashboard: each number raises the same question —
        // where did this go — and the answer is one page, not four destinations.
        bar.command = 'claudeStatusline.dashboard';
        return bar;
    });
}

function activate(context) {
    const cfg = vscode.workspace.getConfiguration('claudeStatusline');

    const state = {
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        // The limit history lives beside the index, in storage the extension
        // owns. ~/.claude belongs to Claude Code; reading it is one thing,
        // leaving files of ours in it is another.
        storageDir: context.globalStorageUri.fsPath,
        // The tree of runs is read from a field rather than from the constant in
        // workflows.js so a test can point the whole collector at a scratch
        // directory — without it every test that calls activate() walks the real
        // ~/.claude and reads whatever is running on the machine at the time.
        projectsRoot: process.env.CLAUDE_STATUSLINE_PROJECTS || wfm.PROJECTS,
        session: null,
        context: null,
        stats: null,
        // Read from storage on the slow tick, never built here.
        index: null,
        workflows: [],
        todayUsd: 0,
        compactPct: -1,
        settings: { outputStyle: '', advisor: '', model: '' },
        version: { current: '', latest: '' },
        registry: buildRegistry(),
        segments: [],
        needs: new Set(),
        items: [],
        // Everything the templates read, refilled by the two collectors.
        data: { now: 0, scoped: [], bar: '', machine: null },
    };
    // The dashboard is opened from a command, which is handed the extension
    // context rather than this state; parking it here keeps the workspace
    // available there without a second module-level variable.
    context.claudeState = state;

    applyConfig(state);
    slowTick(state);

    const slow = setInterval(() => slowTick(state), Math.max(15, cfg.get('refreshInterval')) * 1000);
    const fast = setInterval(() => fastTick(state), CONTEXT_TICK * 1000);

    context.subscriptions.push(
        { dispose: () => { clearInterval(slow); clearInterval(fast); for (const i of state.items) i.dispose(); } },
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('claudeStatusline')) return;
            applyConfig(state);
            slowTick(state);
        }),
        // Focus returning to the window is the only sensible "the user is looking
        // again" signal; there is no event channel from the CLI itself.
        vscode.window.onDidChangeWindowState((w) => { if (w.focused) slowTick(state); }),
        vscode.commands.registerCommand('claudeStatusline.dashboard', () => showDashboard(context)),
        vscode.commands.registerCommand('claudeStatusline.reindex', () => showDashboard(context, { force: true })),
        vscode.commands.registerCommand('claudeStatusline.refresh', async () => {
            u.touchStamp();
            await u.refreshUsage();
            slowTick(state);
        }),
        vscode.commands.registerCommand('claudeStatusline.placeholders', () => showPlaceholders(state)),
    );
}

/**
 * The list of placeholders with what each one says right now. A template is
 * written against live data, so a static table in a README is the wrong place
 * to learn it from: here every row shows the value this machine would put in
 * the bar this minute, and picking one copies it.
 */
async function showPlaceholders(state) {
    collectFast(state);
    collectSlow(state);
    const items = Object.entries(state.registry).map(([name, field]) => {
        let value = '';
        try { value = String(field.get(state.data, '') ?? ''); } catch { value = ''; }
        return {
            label: `{${name}}`,
            description: value ? `→ ${value}` : '(nothing to show right now)',
            detail: `${field.topic} · ${field.doc}`,
            name,
        };
    });
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Claude statusline placeholders',
        placeHolder: 'Pick one to copy it — paste into claudeStatusline.segments',
        matchOnDetail: true,
    });
    if (!picked) return;
    await vscode.env.clipboard.writeText(picked.label);
    vscode.window.showInformationMessage(`${picked.label} copied — put it in claudeStatusline.segments`);
}

function deactivate() {}

// The draw step and the fast collector on their own: a test can fill the state
// by hand and check what reaches the bar, or drive one refresh of a running
// workflow, without waiting out a ten-second interval.
module.exports = { activate, deactivate, __render: render, __collectWorkflowsFast: collectWorkflowsFast };
