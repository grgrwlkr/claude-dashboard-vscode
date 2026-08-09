const vscode = require('vscode');
const u = require('./usage');
const s = require('./session');
const ix = require('./indexer');
const dashboard = require('./dashboard');
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

// A tooltip has room a status bar does not, so it gets sections and full rows
// instead of the terminal's single dense line. Each fact lives on its own row
// with a label, and nothing is packed into a heading to save space.
function table(rows, head) {
    const header = head ? `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n` : '| | |\n|---|---|\n';
    return header + rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n') + '\n';
}

function limitsTooltip(lim, pc, now, stale) {
    const md = new vscode.MarkdownString('', true);
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
    return md;
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
    const md = new vscode.MarkdownString('', true);
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
    return md;
}

function moneyTooltip(state) {
    const { stats, todayUsd, context: ctx } = state;
    const md = new vscode.MarkdownString('', true);
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
    return md;
}

// The bar needs the model, not the full id: "claude-opus-5" → "opus 5".
function short(model) {
    return (model || '')
        .replace(/^claude-/, '')
        .replace(/\[[^\]]*\]$/, '')
        .replace(/-(\d)-(\d)$/, ' $1.$2')
        .replace(/-(\d)$/, ' $1');
}

function render(state) {
    renderLimits(state);
    renderContext(state);
    renderMoney(state);
    renderWork(state);
}

function renderLimits({ limitsItem }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = u.readCache(now);
    if (!payload) {
        limitsItem.text = '✻ 7d —';
        limitsItem.tooltip = 'Claude: no recent limit data';
        limitsItem.backgroundColor = undefined;
        limitsItem.show();
        return;
    }
    const lim = u.limitsOf(payload);
    if (!lim.weekly) { limitsItem.hide(); return; }

    const pc = u.pace(lim.weekly, now);
    limitsItem.text = u.barText(lim.weekly, pc);
    limitsItem.tooltip = limitsTooltip(lim, pc, now, now - u.mtime(u.CACHE) > STALE_AFTER);
    limitsItem.backgroundColor = background(lim.weekly.pct);
    limitsItem.show();
}

function renderContext(state) {
    const { contextItem, workspace } = state;
    const own = state.session;
    if (!own || !workspace) { contextItem.hide(); return; }

    const ctx = s.contextOf(s.readTail(s.transcriptPath(workspace, own.sessionId)));
    if (!ctx) {
        // The panel is open but nothing has been exchanged yet — the transcript
        // appears with the first message. A dash is honester than emptiness,
        // which reads as a broken item.
        contextItem.text = '▤ —';
        contextItem.tooltip = 'Session open, nothing exchanged yet — context is empty';
        contextItem.backgroundColor = undefined;
        contextItem.show();
        return;
    }
    state.context = ctx;

    const approx = ctx.estimated ? '~' : '';
    contextItem.text = `▤ ${approx}${ctx.pct}% ${tok(ctx.tokens)}/${tok(ctx.window)}`;
    contextItem.tooltip = contextTooltip(state);
    contextItem.backgroundColor = background(ctx.pct);
    contextItem.show();
}

// Spend gets its own item: it is the one figure that cannot be taken from the
// client exactly, and keeping it next to an exact limit percentage would be
// misleading. That is what the tilde in the bar text is for.
function renderMoney(state) {
    const { moneyItem, stats } = state;
    if (!stats || stats.cost <= 0) { moneyItem.hide(); return; }
    const burn = stats.burn > 0 ? ` ${fmtCost(stats.burn)}/h` : '';
    moneyItem.text = `~${fmtCost(stats.cost)}${burn}`;
    moneyItem.tooltip = moneyTooltip(state);
    moneyItem.backgroundColor = undefined;
    moneyItem.show();
}

function renderWork(state) {
    const { workItem, workspace } = state;
    const own = state.session;
    if (!own || !workspace) { workItem.hide(); return; }

    const peers = s.peersOf(workspace, own.sessionId);
    const todo = s.todoOf(own.sessionId);
    const parts = [];
    if (peers.total > 0) parts.push(peers.busy > 0 ? `⧉ ${peers.total}(${peers.busy})` : `⧉ ${peers.total}`);
    if (todo) parts.push(`▸ ${todo.done}/${todo.total}`);
    if (parts.length === 0) { workItem.hide(); return; }

    workItem.text = parts.join(' ');
    const md = new vscode.MarkdownString('', true);
    if (todo) {
        md.appendMarkdown(`### Tasks ${todo.done}/${todo.total}\n\n`);
        if (todo.active) md.appendMarkdown(`$(play) ${todo.active}\n\n`);
    }
    if (peers.total > 0) {
        const rows = [['sessions', String(peers.total)]];
        if (peers.busy > 0) rows.push(['busy right now', String(peers.busy)]);
        md.appendMarkdown(`${todo ? '**Other sessions here**' : '### Other sessions here'}\n\n${table(rows)}`);
    }
    workItem.tooltip = md;
    workItem.show();
}

// The heavy work — the network call for limits and the full transcript pass for
// spend — lives here and runs on the minute tick, not on every draw.
function slowTick(state) {
    if (u.stampExpired(Math.floor(Date.now() / 1000))) {
        u.touchStamp();
        u.refreshUsage().then(() => renderLimits(state), () => { /* draw from cache */ });
    }
    refreshSession(state);
    if (state.session && state.workspace) {
        const file = s.transcriptPath(state.workspace, state.session.sessionId);
        state.stats = s.sessionStats(file);
        state.todayUsd = s.costToday().usd;
        state.compactPct = s.autoCompactPct(state.workspace, state.context?.window || 0);
        state.settings = s.settingsOf(state.workspace);
        state.version = s.versionInfo(state.session.version);
    }
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

async function showDashboard(context, { force = false } = {}) {
    const storageDir = context.globalStorageUri.fsPath;
    const { index, stats } = await buildIndex(storageDir, { force });
    const total = ix.summarize(index);
    const html = dashboard.render(index, total, { files: stats.total, lastRun: Date.now() });

    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            'claudeStatusline.dashboard', 'Claude usage', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        panel.onDidDispose(() => { panel = null; });
        panel.webview.onDidReceiveMessage((msg) => {
            if (msg && msg.type === 'refresh') showDashboard(context, { force: false });
        });
    } else {
        panel.reveal(vscode.ViewColumn.Active);
    }
    panel.webview.html = html;
}

function activate(context) {
    const cfg = vscode.workspace.getConfiguration('claudeStatusline');
    const align = cfg.get('alignment') === 'left'
        ? vscode.StatusBarAlignment.Left
        : vscode.StatusBarAlignment.Right;
    const priority = cfg.get('priority');
    // Every item opens the dashboard: each number raises the same question —
    // where did this go — and the answer is one page, not four destinations.
    const item = (id, name, offset) => {
        const bar = vscode.window.createStatusBarItem(id, align, priority - offset);
        bar.name = name;
        bar.command = 'claudeStatusline.dashboard';
        context.subscriptions.push(bar);
        return bar;
    };

    const state = {
        workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        session: null,
        context: null,
        stats: null,
        todayUsd: 0,
        compactPct: -1,
        settings: { outputStyle: '', advisor: '', model: '' },
        version: { current: '', latest: '' },
        limitsItem: item('claudeStatusline.limits', 'Claude limits', 0),
        contextItem: item('claudeStatusline.context', 'Claude context', 1),
        moneyItem: item('claudeStatusline.money', 'Claude spend', 2),
        workItem: item('claudeStatusline.work', 'Claude work', 3),
    };

    slowTick(state);

    const slow = setInterval(() => slowTick(state), Math.max(15, cfg.get('refreshInterval')) * 1000);
    const fast = setInterval(() => { refreshSession(state); renderContext(state); renderWork(state); },
        CONTEXT_TICK * 1000);

    context.subscriptions.push(
        { dispose: () => { clearInterval(slow); clearInterval(fast); } },
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
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
