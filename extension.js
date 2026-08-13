const vscode = require('vscode');
const u = require('./usage');
const s = require('./session');
const ix = require('./indexer');
const hist = require('./history');
const sys = require('./system');
const seg = require('./segments');
const dashboard = require('./dashboard');
const wfm = require('./workflows');
const status = require('./status');
const docs = require('./settingsDocs');
const { clientSettings } = require('./clientSettings');
const { fmtCost, ratesFor } = require('./pricing');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Complaining about the cache is only meaningful once refreshes have failed for
// a while: with a one-minute period, a two-minute threshold would fire on an
// ordinary skipped tick in the background.
const STALE_AFTER = 600;

// Context is read from disk in a couple of milliseconds, so it refreshes more
// often than the limits — those hit the network and stay on their minute tick.
const CONTEXT_TICK = 10;

// What the button types into the terminal it opens. A bare name, resolved by the
// shell's PATH like any other command — no path of ours to go stale.
const CLAUDE_COMMAND = 'claude';

// Claude Code's extension, by the id VS Code knows it under, and where its own
// logo sits inside it. Both are read only for the tab icon below, and neither is
// depended on: see `claudeIcon`.
const CLAUDE_CODE = 'Anthropic.claude-code';
const CLAUDE_LOGO = ['resources', 'claude-logo.svg'];

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
    // The trailing blank line matters: two tables in a row without one are read
    // as a single table, and the second one's header lands in it as a row.
    return header + rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n') + '\n\n';
}

// The tooltips render the sections status.js describes. The wording, the rows
// and which of them appear are decided there, so the Now tab of the dashboard
// says exactly the same thing without a second copy of any of it.
const TONE_ICON = {
    alarm: '$(flame)',
    safe: '$(check)',
    warn: '$(warning)',
    update: '$(arrow-up)',
    active: '$(play)',
};

function renderSection(section) {
    const md = new Markdown();
    md.appendMarkdown(`### ${section.title}\n\n`);
    for (const block of section.blocks) {
        if (block.kind === 'meters') {
            if (block.rows.length === 0) continue;
            // The meter is the bar the status bar itself draws — same glyphs,
            // same rounding, so a hover never disagrees with the item under it.
            // Passed its own percentage as the plan, because a meter is a share
            // and has no plan to be ahead of: with a plan of zero every filled
            // cell came out hatched, and hatched now means overspend.
            // Three columns, so the head has to be three wide: a row with more
            // cells than the header loses the extras, which here is the reset.
            md.appendMarkdown(table(block.rows.map((r) => [
                r.label, `\`${u.bar(r.pct, r.pct)}\` **${r.value}**`, r.note ? `_${r.note}_` : '',
            ]), ['', '', '']));
        }
        if (block.kind === 'table') {
            if (block.rows.length === 0) continue;
            // The first column is a label and the second the answer, so the
            // answer is the one in bold — the same emphasis in both renderers.
            const rows = block.head
                ? block.rows.map(([a, b, c]) => [a, `**${b}**`, c])
                : block.rows.map(([a, b]) => [a, b]);
            md.appendMarkdown(table(rows, block.head));
        }
        if (block.kind === 'subtitle') md.appendMarkdown(`\n**${block.text}**\n\n`);
        if (block.kind === 'note') {
            const icon = TONE_ICON[block.tone];
            const label = block.label ? `**${block.label}** — ` : '';
            const body = `${icon ? `${icon} ` : ''}${label}${block.text}`;
            md.appendMarkdown(block.tone === 'muted' ? `\n_${block.text}_\n` : `\n${body}\n`);
        }
    }
    return md.value;
}

// A round million reads as "1M", not "1.0M" — the model window is written the
// way statusline.sh writes it. The formula sits in workflows.js because the tree
// writes the same numbers and cannot import this file: this is the one module
// allowed to require vscode, so what both sides share lives on the other side.
const tok = wfm.tokenLabel;

// The bar needs the model, not the full id: "claude-opus-5" → "opus 5". The rule
// itself lives in dashboard.js, which draws the same model ids in its tables and
// may not require vscode — so, like tokenLabel above, it sits on the other side
// of that line and is borrowed from here. Only the empty case differs: a page
// prints "unknown" where there is no model, while a bar segment with nothing to
// say has to stay empty so it can hide itself.
const short = (model) => (model ? dashboard.shortModel(model) : '');

// The formatting the sections are written against, shared with the segments so
// a date or a cost reads the same in the bar, the tooltip and the page.
function statusHelpers() {
    return {
        fmtCost,
        fmtLeft: u.fmtLeft,
        fmtAbs: (ts) => u.fmtAbs(ts),
        fmtWhen: u.fmtWhen,
        fmtDuration: s.fmtDuration,
        tok,
        shortModel: short,
    };
}

/** Every section, for the dashboard: the same list the tooltips are cut from. */
function statusNow(state) {
    if (!state) return [];
    const now = Math.floor(Date.now() / 1000);
    return status.statusSections(state.data, statusHelpers(), {
        stale: now - u.mtime(u.CACHE) > STALE_AFTER,
        updatedAt: u.mtime(u.CACHE),
    });
}

/** The same state as numbers, for the meters and the track the page draws. */
function statusMetrics(state) {
    return state ? status.statusMetrics(state.data) : {};
}

function sectionFor(state, id) {
    const section = statusNow(state).find((x) => x.id === id);
    return section ? renderSection(section) : '';
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

// Borrowed text on its way into a hover: an agent's prompt, a workflow's name, a
// model id read out of a transcript — prose from someone else's file, full of
// hashes, backticks, asterisks and dashes that a MarkdownString renders as
// markup. The escaped set is the one VS Code escapes in
// MarkdownString.appendText; the escaping is spelled out here because the value
// is assembled in one string rather than appended.
const prose = (text) => String(text || '').replace(/[\\`*_{}[\]()#+\-!~>]/g, '\\$&');

// The same, for text going into a table cell, which has two rules of its own: it
// holds one line — a newline would end the row — and no bare pipe, which would
// split it. The pipe is escaped after the markdown pass, or the backslash that
// escapes it would itself be escaped.
const cell = (text) => prose(String(text || '').replace(/\s+/g, ' ')).replace(/\|/g, '\\|');

// How many agents of one run a hover shows. A run here has reached 208 of them,
// and a table that long is a wall rather than a hint — the tree and the dashboard
// tab have the room for the whole list, a tooltip does not.
const TOOLTIP_AGENTS = 12;

// Which agents get the dozen rows. The ones still working come first, because
// that is what a hover over a running workflow is asked: what is happening now.
// The rest keep their order, so the table still reads as the run was dispatched.
function visibleAgents(run) {
    if (run.agents.length <= TOOLTIP_AGENTS) return { shown: null, hidden: 0 };
    const working = (a) => wfm.outcomeOf(a.state, run.state) === 'running';
    const ordered = [...run.agents.filter(working), ...run.agents.filter((a) => !working(a))];
    const shown = new Set(ordered.slice(0, TOOLTIP_AGENTS).map((a) => a.agentId));
    return { shown, hidden: run.agents.length - shown.size };
}

function workflowTooltip(state) {
    const active = (state.data.workflows && state.data.workflows.active) || [];
    if (active.length === 0) return '';
    const md = new Markdown();
    for (const run of active) {
        // The name comes out of a file someone else wrote, so it is escaped like
        // any other borrowed text before it becomes markdown.
        md.appendMarkdown(`### ${cell(run.name || run.runId)}\n\n`);
        const { shown, hidden } = visibleAgents(run);
        // Grouped by phase, because a phase is what the run's author wrote it in
        // terms of: a flat list of fourteen agents does not say which stage the
        // run is sitting in. A live run knows no phases yet — the client only
        // writes them with the final snapshot — so they all fall in one group.
        const byPhase = new Map();
        for (const agent of run.agents) {
            if (shown && !shown.has(agent.agentId)) continue;
            const key = agent.phase || '';
            if (!byPhase.has(key)) byPhase.set(key, []);
            byPhase.get(key).push(agent);
        }
        for (const [phase, agents] of byPhase) {
            // The blank line is what ends the table above: a heading written
            // straight after the last row is read as part of it. The title is a
            // phase someone wrote in a script, so it is borrowed text too.
            if (phase) md.appendMarkdown(`\n**${prose(phase)}**\n\n`);
            md.appendMarkdown(table(agents.map((a) => [
                AGENT_ICON[wfm.outcomeOf(a.state, run.state)] || AGENT_ICON.unknown,
                // How an agent is named is one rule, and it lives beside the
                // tree that names them the same way: a live agent has no label
                // of its own, so the first line of what it was told stands in.
                cell(wfm.agentLabel(a)),
                // The model is read out of a transcript, so it is borrowed text
                // too, however unlikely a pipe in a model id is.
                cell(short(a.model)),
                a.tokens ? tok(a.tokens) : '',
            ]), ['', 'agent', 'model', 'tokens']));
        }
        if (hidden > 0) md.appendMarkdown(`\n_…and ${hidden} more_\n`);
        if (run.totals.cost > 0) md.appendMarkdown(`\n_~${fmtCost(run.totals.cost)} so far_\n`);
    }
    return md.value;
}

// One builder per topic, so a segment that mixes topics gets both sections
// joined rather than a tooltip about half of what it shows.
const TOOLTIPS = {
    limits: (state) => sectionFor(state, 'limits'),
    context: (state) => sectionFor(state, 'context'),
    money: (state) => sectionFor(state, 'money'),
    work: (state) => sectionFor(state, 'work'),
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

// The tree is a thin skin over treeNodes(): what is grouped under what, what a
// row says and which icon it carries are decided in workflows.js, where a test
// can reach them. Nothing here reads a run — it reads the state the two ticks
// have already filled, so the panel and the bar can never disagree.
class WorkflowTree {
    constructor(state) {
        this.state = state;
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
        // The reading the tree was last drawn from, and what that reading would
        // have drawn, so a draw that changed nothing does not ask for one.
        this.drawn = null;
        this.stamp = '';
    }

    // Only when the reading actually changed — and what counts as a change is
    // whether the tree would draw something different, not whether a collector
    // built a fresh object. Both of them replace state.data.workflows wholesale,
    // and the slow one does it every minute whether or not anything moved, so
    // the object is a fast "certainly unchanged" test and nothing more: the
    // stamp is taken from the nodes themselves, which is the only thing that
    // cannot disagree with what a redraw would produce.
    refresh() {
        const data = this.state.data.workflows || null;
        if (data === this.drawn) return;
        this.drawn = data;
        const stamp = wfm.treeStamp((data && data.runs) || []);
        if (stamp === this.stamp) return;
        this.stamp = stamp;
        this.emitter.fire();
    }

    getChildren(node) {
        if (node) return node.children;
        return wfm.treeNodes((this.state.data.workflows && this.state.data.workflows.runs) || []);
    }

    getTreeItem(node) {
        // A run in flight opens itself, and so do its phases: the panel is
        // watched while something is happening, and a row the user has to click
        // to see the agents is a row that arrives too late. Everything else stays
        // folded — the history of this machine is 74 runs deep.
        const collapsed = node.children.length === 0
            ? vscode.TreeItemCollapsibleState.None
            : (node.run.state === 'running'
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed);
        const item = new vscode.TreeItem(node.label, collapsed);
        // Stable and unique per node, which is what carries the expanded rows
        // across the refresh that follows every draw.
        item.id = node.id;
        item.description = node.description;
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        // What the context menu of Task 9 keys on: run rows get run commands.
        item.contextValue = node.kind;
        if (node.kind === 'agent') {
            const text = [prose(node.agent.promptPreview), prose(node.agent.resultPreview)]
                .filter(Boolean).join('\n\n');
            if (text) item.tooltip = new vscode.MarkdownString(text);
        }
        return item;
    }
}

// One section per topic the segment carries. A builder that throws on the record
// it was handed costs its own section and nothing else — every workflow field
// comes out of another program's files, and a hover is worth less than the
// number beside it. A topic with no builder at all is a bug in this file rather
// than bad data, so that one is left to fail: the item hides, and the test that
// walks every topic sees it.
function tooltipSections(state, topics) {
    return topics.map((topic) => {
        const build = TOOLTIPS[topic];
        if (typeof build !== 'function') throw new TypeError(`no tooltip builder for topic ${topic}`);
        try { return build(state); } catch { return ''; }
    }).filter(Boolean);
}

function drawItem(state, item, i) {
    const out = seg.renderSegment(state.segments[i], state.data, state.registry);
    if (!out.visible) { item.hide(); return; }

    item.text = out.text;
    const sections = tooltipSections(state, out.topics);
    item.tooltip = sections.length
        ? new vscode.MarkdownString(sections.join('\n\n---\n\n'), true)
        : 'Claude — click for the usage dashboard';
    const worst = Math.max(-1, ...out.topics.map((topic) => COLOUR_BY[topic](state.data)));
    item.backgroundColor = background(worst);
    item.show();
}

function render(state) {
    state.items.forEach((item, i) => {
        try {
            drawItem(state, item, i);
        } catch {
            // This runs from an interval, so a throw here is not one bad draw:
            // it would leave every later item frozen on its old text and skip
            // the tree below, on every tick, until the record that caused it
            // left the state — which the collector would keep putting back. A
            // segment that cannot be drawn hides, the way an unreadable field
            // hides its row everywhere else in this extension.
            item.hide();
        }
    });

    // The panel draws from the same state as the bar, so one draw refreshes
    // both. A test that fills a state by hand has no tree, and the bar is not
    // held hostage to one — nor the other way round.
    if (state.tree) {
        try { state.tree.refresh(); } catch { /* the bar is drawn; the tree waits for the next tick */ }
    }
}

// Fields whose value comes out of the single expensive pass over the whole
// transcript, and the context fields that come from its tail.
const MONEY_FIELDS = ['cost', 'burn', 'requests', 'duration', 'apiShare', 'added', 'removed'];
const CONTEXT_FIELDS = ['ctx', 'ctxTokens', 'ctxWindow', 'ctxCache', 'model', 'effort', 'branch', 'compact'];

// Everything cheap enough for the ten-second tick: the transcript tail, and the
// two registry reads behind peers and the task list.
function collectFast(state) {
    const d = state.data;
    d.now = Math.floor(Date.now() / 1000);
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
        const runs = wfm.withCost(
            wfm.scanRuns({ root: state.projectsRoot, liveSessions, known: knownAgents(state) }),
            { index: indexNow(state), live: true, carried: state.spent },
        );
        forgetFinished(state.spent, runs);
        state.workflows = runs;
        state.data.workflows = { runs, active: runs.filter((r) => r.state === 'running') };
    } catch {
        // A half-readable tree must not take the bar down with it: the previous
        // reading stays until a tick manages to replace it.
        state.data.workflows = state.data.workflows || { runs: [], active: [] };
    }
}

// What the previous look already knows about the agents of each running run, in
// the shape scanRuns hands on to readLive: an agent whose transcript has not
// been written to since is described from this rather than read again.
function knownAgents(state) {
    const out = new Map();
    for (const run of (state.data.workflows ? state.data.workflows.runs : [])) {
        if (run.state !== 'running') continue;
        out.set(run.runId, new Map(run.agents.map((a) => [a.agentId, a])));
    }
    return out;
}

// The index prices workflow agents that have stopped. It is read here and never
// built — building it is a seconds-long walk that belongs to the dashboard's
// progress notification. Whether the file behind it has changed since the last
// tick is indexer.js's question, not this file's: nothing here touches a disk.
function indexNow(state) {
    if (state.storageDir) state.index = ix.freshIndex(state.storageDir);
    return state.index;
}

// What a live transcript has cost so far is kept per agent between ticks, so
// each look reads only what appeared since the last one. A run that has stopped
// will never be read incrementally again, and its rows would otherwise sit in
// that map for the life of the window.
function forgetFinished(spent, runs) {
    const going = new Set(runs.filter((r) => r.state === 'running').map((r) => r.runId));
    for (const key of spent.keys()) {
        if (!going.has(key.slice(0, key.lastIndexOf('/')))) spent.delete(key);
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
            // A snapshot appearing is how a run announces it is over, and how it
            // went is written in that same file — so the run is read from it
            // rather than marked finished with nothing to say for the up to a
            // minute until the next sweep. That is one bounded read, once, since
            // a finished run never comes back down this path. Finding it and
            // reading it live in workflows.js, so this file keeps its hands off
            // the disk; a snapshot too broken to read returns nothing and the
            // run stays as it was, for the sweep to classify.
            const done = wfm.finishRun(run);
            if (done) return done;
            // What the last look learned goes back in: readLive skips the head
            // and the tail of every transcript that has not been written to
            // since, which on a wide run is most of them on most ticks.
            const before = new Map(run.agents.map((a) => [a.agentId, a]));
            const live = wfm.readLive(run.runDir, { known: before });
            if (!live) return run;
            // What an agent has cost is settled by the slow tick, which prices
            // transcripts; this one only re-reads what each agent is doing. The
            // figures are carried across rather than dropped, or the money
            // columns empty out for the fifty seconds between slow ticks. An
            // agent that appeared since then has none yet, which is the truth.
            const agents = live.agents.map((a) => {
                const was = before.get(a.agentId);
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

// The single request this extension makes is opt-out. `fetchLimits: false` means
// the OAuth token is never read and api.anthropic.com is never called; limits
// then come from the cache `statusline.sh` may have written, or not at all.
// Absent rather than false is treated as on, so a stub or an older settings file
// keeps the default behaviour.
function limitsWanted() {
    return vscode.workspace.getConfiguration('claudeStatusline').get('fetchLimits') !== false;
}

// The heavy work — the network call for limits and the full transcript pass for
// spend — lives here and runs on the minute tick, not on every draw.
function slowTick(state) {
    if (limitsWanted() && u.stampExpired(Math.floor(Date.now() / 1000))) {
        u.touchStamp();
        u.refreshUsage().then(() => { collectSlow(state); render(state); }, () => { /* draw from cache */ });
    }
    refreshSession(state);
    collectFast(state);
    collectSlow(state);
    render(state);
}

// Workflows are refreshed here rather than inside collectFast: the slow tick
// calls collectFast too, and the sweep that follows it re-reads every live run
// from scratch anyway — doing both would read each running agent twice a minute
// for one drawing. It also sits outside the session guard on purpose: a workflow
// is a fact about the machine, and a window with no Claude session of its own
// still has a bar, a tree and a dashboard tab to fill.
function fastTick(state) {
    refreshSession(state);
    collectWorkflowsFast(state);
    collectFast(state);
    render(state);
    // A session is named a little after it starts and renamed at any point, so
    // the tab follows on the same ten seconds as the rest of the cheap reads.
    renameActiveTab(state);
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

// The live state of the bar, kept here rather than parked on the ExtensionContext
// the commands are handed. The dashboard and the settings tab read every number
// through this: hanging it off an object the editor owns worked in tests and
// silently produced an empty page in the editor itself, where the palette and
// every preview came back blank while the bar beside them was full of numbers.
let barState = null;

// Which tab the page has open, reported by the webview. A refresh that lands
// while the settings editor is on screen would throw away half-typed segments,
// so that one tab is left alone until the user navigates away from it.
let openTab = '';

// The page is rebuilt on the same tick as the bar — it is the interval the user
// already set, and a second one would only be another number to keep in sync.
// Three things hold it back: a panel nobody is looking at, a rebuild already in
// flight, and the settings editor, whose unsaved fields a redraw would discard.
let refreshing = false;

// When the page on screen was last assembled. A hidden panel skips its ticks,
// so this is how stale the reader's copy is when the tab comes back.
let lastRender = 0;

// The slow tick's interval, floored the same way wherever it is read: the timer
// arms itself with it, and a page has missed a tick exactly when it is older
// than one of these.
const tickSeconds = () => Math.max(15, vscode.workspace.getConfiguration('claudeStatusline').get('refreshInterval') || 60);

// Returns the rebuild, so a caller — the tick ignores it, a test does not — can
// wait for the page to actually be replaced.
function refreshDashboard(context) {
    if (!panel || !panel.visible || refreshing || openTab === 'settings') return Promise.resolve(false);
    // The timer is a setting, not a law: a page nobody asked to move is a page
    // that scrolls out from under a reader.
    // `!== false`, not a truthiness test: a settings file written before this key
    // existed returns undefined, and undefined has to mean the documented
    // default — which is on — rather than silently switching the timer off.
    if (vscode.workspace.getConfiguration('claudeStatusline').get('autoRefresh') === false) return Promise.resolve(false);
    refreshing = true;
    return showDashboard(context, { silent: true })
        .then(() => true)
        .catch(() => false) // a page that fails to rebuild keeps the one on screen
        .finally(() => { refreshing = false; });
}

// Same escape hatch the workflow collector uses: without it a test that opens
// the dashboard reads every transcript on the machine, including those of
// sessions running right now.
const indexRoot = () => process.env.CLAUDE_STATUSLINE_PROJECTS || ix.PROJECTS;

// Indexing a gigabyte of transcripts takes seconds on the first run, so it
// happens inside a progress notification the user can watch — and reuses the
// stored fingerprints on every run after that.
async function buildIndex(storageDir, { force = false, silent = false } = {}) {
    // A refresh nobody asked for does not get a notification: the page is
    // already on screen, and a toast every minute is the opposite of ambient.
    if (silent) return ix.refreshIndex(storageDir, { root: indexRoot() });
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
                root: indexRoot(),
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

/**
 * The month against its ceiling, said once per threshold. It fires where the
 * index is refreshed — opening the dashboard, a reindex, activation — and not
 * on the tick: a month of spend comes from the index, and rebuilding the index
 * every minute is the one expensive read this extension keeps off a timer.
 */
/**
 * The index, out of the extension and into a file the user picked. Two shapes
 * because two questions: JSON keeps every aggregate the page draws, CSV is one
 * row per transcript, which is what a spreadsheet can pivot.
 */
async function exportIndex(context) {
    const { index } = await buildIndex(context.globalStorageUri.fsPath, { silent: true });
    const total = ix.summarize(index);
    const stamp = new Date().toISOString().slice(0, 10);
    const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `claude-usage-${stamp}.csv`)),
        filters: { CSV: ['csv'], JSON: ['json'] },
        saveLabel: 'Export',
    });
    if (!target) return;
    const asJson = target.fsPath.toLowerCase().endsWith('.json');
    try {
        fs.writeFileSync(target.fsPath, asJson ? ix.exportJson(index, total) : ix.exportCsv(total));
        vscode.window.showInformationMessage(
            `Exported ${asJson ? 'the whole summary' : `${total.sessions.length} transcripts`} to ${target.fsPath}`);
    } catch (err) {
        vscode.window.showErrorMessage(`Export failed: ${err.message}`);
    }
}

function checkBudget(context, total) {
    const budget = Number(vscode.workspace.getConfiguration('claudeStatusline').get('monthlyBudget')) || 0;
    if (budget <= 0) return;
    const month = ix.monthToDate(total);
    const share = (month.spent / budget) * 100;
    const key = `budget:${new Date().getFullYear()}-${new Date().getMonth() + 1}`;
    const said = context.globalState.get(key) || 0;
    const level = share >= 100 ? 100 : share >= 80 ? 80 : 0;
    if (level <= said) return;
    context.globalState.update(key, level);
    const text = level === 100
        ? `Claude: ${fmtCost(month.spent)} this month, past the ${fmtCost(budget)} you set.`
        : `Claude: ${fmtCost(month.spent)} this month — ${Math.round(share)}% of ${fmtCost(budget)}, on track for ~${fmtCost(month.projected)}.`;
    vscode.window.showWarningMessage(text);
}

function systemSnapshot(state, index, { force = false, changelogText = '' } = {}) {
    // A newly fetched changelog is a reason to rebuild even inside the TTL:
    // otherwise switching the setting on shows the old cache for a minute and
    // reads as "it did nothing".
    const fresh = systemCache && !force && Date.now() - systemCache.at < SYSTEM_TTL
        && systemCache.changelogSource === changelogText.length;
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
            changelogText,
        });
        systemCache.changelogSource = changelogText.length;
    } catch {
        // A tree that is half-readable must not take the dashboard down with it.
        systemCache = null;
    }
    return systemCache;
}

/**
 * What the settings tab needs: the values in force, and every placeholder with
 * what it says right now. The palette is only useful with live values next to
 * it — a name means little until you see that `{drift}` currently reads "-7%".
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
        presets: seg.PRESETS,
        alignment: cfg.get('alignment'),
        priority: cfg.get('priority'),
        refreshInterval: cfg.get('refreshInterval'),
        monthlyBudget: cfg.get('monthlyBudget'),
        checkPluginUpdates: cfg.get('checkPluginUpdates'),
        fetchLimits: cfg.get('fetchLimits'),
        autoRefresh: cfg.get('autoRefresh'),
        fetchChangelog: cfg.get('fetchChangelog'),
        palette,
    };
}

// The webview edits settings; writing them is the extension's job. Only these
// four keys are ever written, and only into the scope the form asked for.
// Every setting the page may write, which is every setting the extension has:
// the dashboard is the settings UI, and a key it cannot reach is a key that
// exists only in settings.json — which is the thing the Setup tab was built to
// avoid. The list is the gate: a message naming anything else is dropped.
const WRITABLE = ['segments', 'alignment', 'priority', 'refreshInterval',
    'fetchLimits', 'monthlyBudget', 'checkPluginUpdates', 'autoRefresh', 'fetchChangelog'];

// The full changelog, when the user has allowed the fetch. One public file, no
// credentials, and at most once an hour — kept in the extension's own storage
// so a page opened offline still has the last copy rather than nothing.
const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
const CHANGELOG_TTL = 60 * 60 * 1000;
let changelogCache = { at: 0, text: '' };

// The settings reference. Two more public documentation files behind the same
// switch as the changelog: one toggle for "read Anthropic's published docs",
// rather than a third checkbox saying the same thing about a different URL.
const DOCS_URL = {
    settings: 'https://code.claude.com/docs/en/settings.md',
    env: 'https://code.claude.com/docs/en/env-vars.md',
};
let registryCache = null;
let clientCache = null;

/**
 * The registry, best available: a fetched copy if the switch is on and the
 * network answered, the copy this extension was packaged with otherwise. The
 * packaged one is never discarded — an offline machine still gets defaults and
 * descriptions, just dated ones.
 */
async function loadRegistry(storageDir) {
    const packaged = () => {
        try { return require('./claude-settings-registry.json'); } catch { return {}; }
    };
    if (vscode.workspace.getConfiguration('claudeStatusline').get('fetchChangelog') !== true) return packaged();

    const file = path.join(storageDir, 'settings-registry.json');
    if (!registryCache) {
        try { registryCache = { at: fs.statSync(file).mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* none yet */ }
    }
    if (registryCache && Date.now() - registryCache.at < CHANGELOG_TTL) return registryCache.data;

    try {
        const [settingsMd, envMd] = await Promise.all(
            [DOCS_URL.settings, DOCS_URL.env].map(async (url) => {
                const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
                return res.ok ? res.text() : '';
            }),
        );
        // buildRegistry throws when a table comes back short, which is what a
        // captive portal, a redesign or a moved heading all look like. The
        // packaged copy is right there, so a throw costs nothing.
        const data = docs.buildRegistry({
            settingsMd, envMd, source: DOCS_URL,
            checkedAt: new Date().toISOString().slice(0, 10),
        });
        registryCache = { at: Date.now(), data };
        try { fs.mkdirSync(storageDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch { /* cache is a bonus */ }
        return data;
    } catch {
        return (registryCache && registryCache.data) || packaged();
    }
}

// Whether each marketplace clone is behind its repository. The clone's own
// `lastUpdated` is on disk; the repository's newest commit is one unauthenticated
// request per marketplace, and there are two of them here. Cached for an hour,
// like the changelog, and silent on failure: a plugin panel is not worth a
// dialog about a network that is down.
const MARKET_TTL = 60 * 60 * 1000;
let marketCache = { at: 0, heads: {} };

async function fetchMarketHeads(updates) {
    if (vscode.workspace.getConfiguration('claudeStatusline').get('checkPluginUpdates') !== true) return {};
    if (Date.now() - marketCache.at < MARKET_TTL) return marketCache.heads;

    const repos = new Map();
    for (const u of updates) if (u.repo && !repos.has(u.marketplace)) repos.set(u.marketplace, u.repo);
    const heads = {};
    await Promise.all([...repos].map(async ([market, repo]) => {
        try {
            const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, {
                headers: { Accept: 'application/vnd.github+json' },
            });
            if (!res.ok) return;
            const body = await res.json();
            const head = Array.isArray(body) ? body[0] : null;
            const at = head && Date.parse(head.commit?.committer?.date || '');
            if (at) heads[market] = { at, sha: String(head.sha || '').slice(0, 7), repo };
        } catch { /* offline is an absent answer, not an error */ }
    }));
    marketCache = { at: Date.now(), heads };
    return heads;
}

async function fetchChangelog(storageDir) {
    if (vscode.workspace.getConfiguration('claudeStatusline').get('fetchChangelog') !== true) return '';
    const file = path.join(storageDir, 'changelog.md');
    if (!changelogCache.text) {
        try { changelogCache = { at: fs.statSync(file).mtimeMs, text: fs.readFileSync(file, 'utf8') }; } catch { /* none yet */ }
    }
    if (changelogCache.text && Date.now() - changelogCache.at < CHANGELOG_TTL) return changelogCache.text;
    try {
        const res = await fetch(CHANGELOG_URL);
        if (!res.ok) return changelogCache.text;
        const text = await res.text();
        // A body that is not a changelog is not written over the good copy: a
        // captive portal answers 200 with a login page.
        if (!/^#\s|^##\s\d/m.test(text)) return changelogCache.text;
        changelogCache = { at: Date.now(), text };
        try { fs.mkdirSync(storageDir, { recursive: true }); fs.writeFileSync(file, text); } catch { /* cache is a bonus */ }
        return text;
    } catch {
        return changelogCache.text; // offline is not an error worth a dialog
    }
}

// One template against the data the bar is holding at this moment, rendered by
// the same code that draws the bar — so a preview cannot disagree with what
// appears after saving. A hidden segment comes back empty, which is what tells
// the editor to say so.
function renderFor(state, template) {
    const out = seg.renderSegment(
        String(template),
        state ? state.data : {},
        state ? state.registry : seg.fields({}),
    );
    return out.visible ? out.text : '';
}

async function handleMessage(context, msg) {
    const state = barState;
    if (!msg || !panel) return;

    if (msg.type === 'refresh') { showDashboard(context, { force: false }); return; }

    if (msg.type === 'tab') { openTab = String(msg.id || ''); return; }

    // Open one of the files the page lists, for editing. Only a path the page
    // was given — the message carries what the extension itself put there, and
    // anything else is refused rather than opened.
    if (msg.type === 'open') {
        const wanted = String(msg.path || '');
        const known = [
            ...((systemCache && systemCache.context && systemCache.context.files) || []).map((f) => f.abs),
            ...((clientCache && clientCache.chain) || []).map((f) => f.path),
        ];
        if (!known.includes(wanted)) return;
        vscode.workspace.openTextDocument(vscode.Uri.file(wanted))
            .then((doc) => vscode.window.showTextDocument(doc),
                (err) => vscode.window.showErrorMessage(`Cannot open ${wanted}: ${err.message}`));
        return;
    }

    if (msg.type === 'preview') {
        const previews = (msg.segments || []).map((template) => ({ text: renderFor(state, template) }));
        panel.webview.postMessage({ type: 'preview', previews });
        return;
    }

    if (msg.type === 'defaults') {
        panel.webview.postMessage({ type: 'defaults', segments: seg.DEFAULT_SEGMENTS });
        return;
    }

    if (msg.type === 'preset') {
        const preset = seg.PRESETS.find((p) => p.id === msg.id);
        // Delivered as `defaults`, because that is exactly what it is to the
        // editor: replace what is in the fields with this list.
        if (preset) panel.webview.postMessage({ type: 'defaults', segments: preset.segments });
        return;
    }

    if (msg.type === 'presetPreviews') {
        const previews = {};
        for (const preset of seg.PRESETS) {
            previews[preset.id] = preset.segments.map((template) => renderFor(state, template));
        }
        panel.webview.postMessage({ type: 'presetPreviews', previews });
        return;
    }

    // One setting, written where it stands. The Settings tab saves a form; a
    // toggle beside the thing it governs saves itself, because walking to
    // another tab to switch on what you are looking at is the friction this
    // page exists to remove.
    if (msg.type === 'set') {
        const key = String(msg.key || '');
        if (!WRITABLE.includes(key)) return;
        const cfg = vscode.workspace.getConfiguration('claudeStatusline');
        cfg.update(key, msg.value, vscode.ConfigurationTarget.Global).then(
            () => {
                // Pausing the timer is the one setting whose own confirmation
                // would undo it: a rebuild here discards every expanded list on
                // the page, which is the thing the pause was pressed to keep.
                // The header redraws itself for this case.
                if (key === 'autoRefresh' && msg.value === false) return;
                showDashboard(context, { silent: true });
            },
            (err) => vscode.window.showErrorMessage(`Claude statusline: could not save ${key} — ${err.message}`),
        );
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

async function showDashboard(context, { force = false, silent = false } = {}) {
    // Stamped where the build starts, not where it ends: a visibility event that
    // lands in the middle of this one would read the previous stamp, find the
    // page stale and start a second build of the same reading.
    lastRender = Date.now();
    const storageDir = context.globalStorageUri.fsPath;
    const { index, stats } = await buildIndex(storageDir, { force, silent });
    const total = ix.summarize(index);
    checkBudget(context, total);
    const changelogText = await fetchChangelog(storageDir);
    clientCache = clientSettings({
        chain: s.settingsChain((barState && barState.workspace) || ''),
        registry: await loadRegistry(storageDir),
        hostEnv: process.env,
    });
    const marketHeads = await fetchMarketHeads(sys.pluginUpdates());
    const html = dashboard.render(index, total, {
        files: stats.total,
        lastRun: Date.now(),
        history: hist.readHistory(storageDir),
        system: { ...systemSnapshot(barState, index, { force, changelogText }), marketHeads },
        config: configView(barState),
        client: clientCache,
        // The same sections the tooltips are cut from, so the Now tab and the
        // hover cannot disagree about a number.
        now: statusNow(barState),
        metrics: statusMetrics(barState),
        // Read from the state the ticks fill rather than scanned here: the panel
        // and the tree then show one reading of the machine, and opening the
        // dashboard does not pay for a second walk of every project directory.
        workflows: (barState && barState.workflows) || [],
    });

    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            'claudeStatusline.dashboard', 'Claude Dashboard', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        panel.onDidDispose(() => { panel = null; });
        panel.webview.onDidReceiveMessage((msg) => handleMessage(context, msg));
        // A panel behind another editor tab is left alone by the tick, so the
        // page a reader comes back to is as old as the moment they left — and
        // its countdown has been sitting past zero all that time. Coming back
        // into view is the one moment that page is worth rebuilding.
        // Only when it has actually missed a tick: flipping between two tabs
        // must not cost an index pass each way.
        // Returned rather than fired and forgotten, for the same reason
        // refreshDashboard returns its rebuild: the editor ignores it, a test
        // waits on it.
        panel.onDidChangeViewState(() => {
            if (!panel || !panel.visible) return Promise.resolve(false);
            if (Date.now() - lastRender < tickSeconds() * 1000) return Promise.resolve(false);
            return refreshDashboard(context);
        });
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
        // Per live agent: what its transcript has cost and how far it was read,
        // so a tick adds up what appeared since instead of reading it all again.
        spent: new Map(),
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
    barState = state;
    // Kept on the context too, purely so a test can reach the state it just
    // activated; nothing in the extension reads it from there.
    context.claudeState = state;

    applyConfig(state);
    // Built before the first collection so the view has a provider the moment it
    // is opened; render() refreshes it from there on.
    state.tree = new WorkflowTree(state);
    slowTick(state);

    // The timer is what `autoRefresh` is named for — "Refresh on a timer" — so
    // it is checked here rather than only inside refreshDashboard. Off, the
    // setting promises that the expensive pass, the spend across every project
    // and the limits request wait to be asked for; gating the redraw alone left
    // every one of them running on the minute, which is the opposite of what the
    // description offers anyone turning it off on battery.
    //
    // Re-armed on a settings change, because the interval is read once when the
    // timer is created: without this, a new refreshInterval — editable right on
    // the Settings tab — did nothing until the window was reloaded.
    // One predicate, three callers: the timer, the focus event and the settings
    // listener. The setting names a promise about the expensive work, not about
    // one of the paths to it, and it was three paths that made the first attempt
    // at this incomplete.
    const timerOn = () => vscode.workspace.getConfiguration('claudeStatusline').get('autoRefresh') !== false;
    let slow = null;
    const armSlow = () => {
        if (slow) clearInterval(slow);
        const every = tickSeconds();
        slow = setInterval(() => {
            // Read per tick, not captured: flipping the switch then has to move
            // nothing but itself, which is why only the interval re-arms below.
            if (!timerOn()) return;
            slowTick(state);
            // The open dashboard follows the same interval: the numbers on it come
            // from the reading that just happened.
            refreshDashboard(context);
        }, every * 1000);
    };
    armSlow();
    const fast = setInterval(() => fastTick(state), CONTEXT_TICK * 1000);

    context.subscriptions.push(
        { dispose: () => { if (slow) clearInterval(slow); clearInterval(fast); for (const i of state.items) i.dispose(); } },
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('claudeStatusline')) return;
            applyConfig(state);
            // Only the interval needs a new timer, and the checkboxes on the
            // Settings tab write immediately — re-arming on any key would reset
            // the countdown every time one of them was ticked.
            if (e.affectsConfiguration('claudeStatusline.refreshInterval')) armSlow();
            // Turning the timer off used to cost one full pass, because this is
            // the event that turning it off produces. With it off the bar is
            // still redrawn from the cheap read — the setting takes away the
            // expensive work, not the picture.
            if (timerOn()) slowTick(state);
            else { collectFast(state); render(state); }
        }),
        // Focus returning to the window is the only sensible "the user is looking
        // again" signal; there is no event channel from the CLI itself. It obeys
        // the same switch: with the timer off, the expensive pass — and with it
        // the limits request — waits to be asked for, and coming back to the
        // window is not asking.
        vscode.window.onDidChangeWindowState((w) => {
            if (!w.focused) return;
            if (timerOn()) slowTick(state);
            else { collectFast(state); render(state); }
        }),
        // Switching to a tab is the moment its name matters, and the moment the
        // rename command can reach it at all.
        vscode.window.onDidChangeActiveTerminal(() => renameActiveTab(state)),
        vscode.window.createTreeView('claudeStatusline.workflows', { treeDataProvider: state.tree }),
        vscode.commands.registerCommand('claudeStatusline.dashboard', () => showDashboard(context)),
        vscode.commands.registerCommand('claudeStatusline.reindex', () => showDashboard(context, { force: true })),
        vscode.commands.registerCommand('claudeStatusline.export', () => exportIndex(context)),
        vscode.commands.registerCommand('claudeStatusline.refresh', async () => {
            // "Refresh now" is still not a way around the setting: with limits
            // switched off this re-reads the disk and redraws, nothing more.
            if (limitsWanted()) {
                u.touchStamp();
                await u.refreshUsage();
            }
            slowTick(state);
        }),
        vscode.commands.registerCommand('claudeStatusline.placeholders', () => showPlaceholders(state)),
        vscode.commands.registerCommand('claudeStatusline.openClaude', () => openClaude(context)),
        vscode.commands.registerCommand('claudeStatusline.copyRunId', async (node) => {
            const run = node && node.run;
            if (!run) return;
            // Both halves of what a replay needs: the id goes into resumeFromRunId,
            // the path into scriptPath, and typing either by hand is how a replay
            // ends up pointed at the wrong run.
            const text = run.scriptPath ? `${run.runId}\n${run.scriptPath}` : run.runId;
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage(`${run.runId} copied`);
        }),
        vscode.commands.registerCommand('claudeStatusline.openWorkflowScript', async (node) => {
            const run = node && node.run;
            // A run with no script is ordinary: the script sits next to the run
            // directory, and the directory is what the client cleans up first.
            if (!run || !run.scriptPath) {
                vscode.window.showWarningMessage('This run kept no script on disk.');
                return;
            }
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(run.scriptPath));
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch {
                vscode.window.showWarningMessage(`Cannot open ${run.scriptPath}`);
            }
        }),
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

// Shell integration is what lets a command be sent as a command rather than as
// typing, and it arrives a moment after the shell starts. This is how long to
// wait for it before typing the line instead — the number Claude Code uses for
// the same wait in its own terminal.
const SHELL_INTEGRATION_WAIT = 3000;

/**
 * What the terminal tab is marked with. The tab is a Claude Code session, so it
 * wears Claude Code's own logo where that extension is installed — a file inside
 * it, pointed at rather than copied.
 *
 * That path is a private one and is treated as such: an id and a file name of
 * theirs, both checked before use, with this extension's own icon behind them.
 * Nothing warns when it moves — the tab simply carries our mark instead, which
 * is the right outcome for a detail this size.
 */
function claudeIcon(context) {
    const theirs = vscode.extensions.getExtension(CLAUDE_CODE);
    if (theirs) {
        const logo = vscode.Uri.joinPath(theirs.extensionUri, ...CLAUDE_LOGO);
        if (fs.existsSync(logo.fsPath)) return logo;
    }
    return {
        light: vscode.Uri.joinPath(context.extensionUri, 'media', 'open-claude-light.svg'),
        dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'open-claude-dark.svg'),
    };
}

/**
 * Claude Code as a tab in the group you are already looking at.
 *
 * This opens the terminal itself rather than asking Claude Code's extension for
 * one, because that command cannot place a session where this button wants it.
 * It takes a third parameter, and each of the three values it knows lands
 * somewhere else — read from `extension.js` of anthropic.claude-code 2.1.231:
 *
 *     let s = o === "beside" || o === void 0 ? { viewColumn: gr.ViewColumn.Beside }
 *           : o === "window" ? { viewColumn: gr.ViewColumn.One }
 *           : void 0;
 *     ... l.show(), o === "window")
 *         await gr.commands.executeCommand("workbench.action.moveEditorToNewWindow");
 *
 * `beside` splits a new editor group off to the right, `window` carries the
 * editor out of the window entirely, and `bottom` — no location at all — leaves
 * it in the panel. Two of those shipped from this button before the third value
 * was ruled out too: first the floating window, then the panel, because moving
 * a panel terminal into the editor afterwards is a second thing that has to work
 * and did not.
 *
 * `{ viewColumn: ViewColumn.Active }` is the whole of it in one argument. What
 * is given up by not calling their command is its own resolution of the
 * executable — `claude` here is whatever the shell's PATH finds, the same one a
 * terminal would run — and its progress notification.
 */
function openClaude(context) {
    const terminal = vscode.window.createTerminal({
        // The same env var Claude Code reads for its own terminal, so a machine
        // that renames one renames both.
        name: process.env.CLAUDE_CODE_TERMINAL_TITLE || 'Claude Code',
        iconPath: claudeIcon(context),
        // The tab lands in the group holding the editor being looked at. This is
        // the entire point of the button.
        location: { viewColumn: vscode.ViewColumn.Active },
        // A session is not worth restoring on the next window: what it was doing
        // is in its transcript, not in a dead terminal.
        isTransient: true,
    });
    terminal.show();

    // Sent through shell integration when it is there, typed when it is not.
    // Typing into a shell that has not finished starting is how the first line
    // gets lost, which is the failure the wait exists for.
    let sent = false;
    const send = (run) => { if (!sent) { sent = true; run(); } };
    const integration = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) send(() => e.shellIntegration.executeCommand(CLAUDE_COMMAND));
    });
    setTimeout(() => send(() => terminal.sendText(CLAUDE_COMMAND)), SHELL_INTEGRATION_WAIT);

    // A session that ended cleanly leaves a shell nobody asked for sitting in a
    // tab, so the tab goes with it. A session that failed keeps its terminal:
    // `claude: command not found` is the answer to why the button did nothing,
    // and closing the tab would take it away.
    const ended = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.terminal === terminal && e.execution.commandLine.value.trim() === CLAUDE_COMMAND && e.exitCode === 0) {
            terminal.dispose();
        }
    });
    // The pid is what ties this tab to a session: `claude` runs as a direct child
    // of this shell. It is asked for once and kept, because the promise resolves
    // after the process is up and the rename runs on a tick.
    const tab = { terminal, pid: 0, named: '' };
    ourTabs.add(tab);
    terminal.processId.then((pid) => { tab.pid = pid || 0; }, () => { /* never started */ });

    const closed = vscode.window.onDidCloseTerminal((t) => {
        if (t !== terminal) return;
        ourTabs.delete(tab);
        integration.dispose();
        ended.dispose();
        closed.dispose();
    });
    return terminal;
}

// Only the tabs this extension opened. Somebody else's terminal keeps whatever
// name they gave it — this renames what it started, and nothing else.
const ourTabs = new Set();

/**
 * The active tab, renamed to the title of the session running in it.
 *
 * Only the active one, because that is all VS Code offers: the rename command
 * takes no terminal, it acts on whichever is active — so a background tab could
 * only be renamed by first making it active, which moves the tab the user is
 * looking at. Instead it is renamed the moment it becomes active, and a tab
 * opened by the button is active from the start.
 *
 * The title is written into the transcript over and over as a session goes on,
 * so this keeps up with `/rename` and with the generated one changing.
 */
async function renameActiveTab(state) {
    if (vscode.workspace.getConfiguration('claudeStatusline').get('renameTabs') === false) return;
    const active = vscode.window.activeTerminal;
    const tab = active && [...ourTabs].find((t) => t.terminal === active);
    if (!tab || !tab.pid) return;

    const session = s.sessionForShell(tab.pid);
    if (!session) return;
    const title = s.titleOf(session.cwd || state.workspace, session.sessionId);
    if (!title || title === tab.named) return;

    try {
        await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: title });
        tab.named = title;
    } catch { /* the command is gone; the tab keeps the name it has */ }
}

function deactivate() {}

// The draw step and the fast collector on their own: a test can fill the state
// by hand and check what reaches the bar, or drive one refresh of a running
// workflow, without waiting out a ten-second interval.
module.exports = {
    activate,
    deactivate,
    __render: render,
    __collectWorkflowsFast: collectWorkflowsFast,
    // The section list behind both the tooltips and the Now tab, exported so a
    // test can hold the two renderings against each other.
    __statusNow: statusNow,
    // The tick's own redraw, exported so a test can fire it without waiting a
    // minute for the interval.
    __refreshDashboard: refreshDashboard,
    // The hover's own outcome table, exported for the one test that holds the
    // three of them — this, OUTCOME_ICONS and the stylesheet's `.o-*` rules —
    // against each other. They are three legitimate representations of one
    // vocabulary, and nothing but a test can keep them from drifting apart.
    __AGENT_ICON: AGENT_ICON,
    // The markdown half of a section, exported so the shapes a live machine may
    // not happen to produce — two tables in a row, a meter — can still be held
    // to what a MarkdownString does with them.
    __renderSection: renderSection,
};
