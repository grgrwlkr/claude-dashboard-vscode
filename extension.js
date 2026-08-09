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

function limitsTooltip(lim, pc, now, stale) {
    const md = new vscode.MarkdownString('', true);
    const rows = [];
    const row = (label, pct, reset) =>
        `| ${label} | **${pct}%** | ${reset ? `${u.fmtLeft(reset, now)} → ${u.fmtAbs(reset)}` : ''} |`;

    if (lim.session) rows.push(row('5h', lim.session.pct, lim.session.reset));
    if (lim.weekly) {
        rows.push(row(pc ? `7d · plan ${pc.plan}%` : '7d', lim.weekly.pct, lim.weekly.reset));
    }
    // Per-model windows almost always reset together with the overall weekly one;
    // repeating that date on every row would turn the table into noise.
    for (const scoped of lim.scoped) {
        const own = Math.abs(scoped.reset - (lim.weekly?.reset ?? 0)) > 60 ? scoped.reset : 0;
        rows.push(row(scoped.scope.toLowerCase(), scoped.pct, own));
    }

    md.appendMarkdown(`| limit | used | resets |\n|---|---|---|\n${rows.join('\n')}\n`);
    // Silence where a forecast used to be reads as breakage, though it means the
    // opposite: at this pace the limit will not run out. Say so in words.
    if (pc?.dry) {
        md.appendMarkdown(`\n$(flame) at this pace you hit 100% around **${u.fmtDry(pc.dry)}**\n`);
    } else if (pc && lim.weekly.pct >= 2 && pc.elapsed >= 1800) {
        md.appendMarkdown('\n$(check) at this pace you will not hit the limit before it resets\n');
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

    // Header mirrors L2 of the terminal statusline: model, effort, thinking,
    // advisor.
    const advisor = ctx.advisor || settings.advisor;
    const traits = [ctx.effort, ctx.thinking ? 'think' : '', advisor ? `adv ${short(advisor)}` : '']
        .filter(Boolean).join(' · ');
    md.appendMarkdown(`**${short(ctx.model)}**${traits ? ` · ${traits}` : ''}\n\n`);

    const rows = [
        `| context | ${tok(ctx.tokens)} / ${tok(ctx.window)}${ctx.estimated ? ' (window unknown)' : ''} |`,
    ];
    if (ctx.cachePct >= 0) rows.push(`| from cache | ${ctx.cachePct}% |`);
    if (state.compactPct > 0) rows.push(`| auto-compact | at ${state.compactPct}% |`);
    if (settings.outputStyle) rows.push(`| output style | ${settings.outputStyle} |`);
    if (ctx.branch) rows.push(`| branch | ${ctx.branch} |`);
    if (version.current) {
        rows.push(`| client | v${version.current}${version.latest ? ` → ${version.latest} available` : ''} |`);
    }
    md.appendMarkdown(`| | |\n|---|---|\n${rows.join('\n')}\n`);

    if (version.latest) {
        md.appendMarkdown(`\n$(arrow-up) version **${version.latest}** is unpacked — it takes effect on the next launch\n`);
    }
    return md;
}

function moneyTooltip(state) {
    const { stats, todayUsd, context: ctx } = state;
    const md = new vscode.MarkdownString('', true);
    const rows = [
        `| session | ~${fmtCost(stats.cost)} |`,
        `| today | ~${fmtCost(todayUsd)} |`,
    ];
    if (stats.burn > 0) rows.push(`| burn rate | ~${fmtCost(stats.burn)}/h |`);
    if (stats.durationMs > 0) rows.push(`| duration | ${s.fmtDuration(stats.durationMs)} |`);
    if (stats.apiPct >= 0) rows.push(`| waiting on model | ~${stats.apiPct}% of the time |`);
    rows.push(`| requests | ${stats.messages} |`);
    if (stats.added || stats.removed) rows.push(`| edits | +${stats.added} / −${stats.removed} lines |`);
    md.appendMarkdown(`| | |\n|---|---|\n${rows.join('\n')}\n`);

    const known = ctx ? ratesFor(ctx.model).known : true;
    md.appendMarkdown(known
        ? '\n_estimated from public rates — not a bill_'
        : '\n_estimated at Opus rates: this model has no published rate here_');
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
    if (peers.total > 0) {
        md.appendMarkdown(`${peers.total} other session${peers.total === 1 ? '' : 's'} in this repository`
            + `${peers.busy > 0 ? `, ${peers.busy} busy` : ''}\n\n`);
    }
    if (todo) {
        md.appendMarkdown(`**${todo.done}/${todo.total}** tasks${todo.active ? `\n\nnow: ${todo.active}` : ''}`);
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

async function openClaude() {
    try {
        await vscode.commands.executeCommand('claude-vscode.editor.openLast');
    } catch {
        vscode.window.showWarningMessage('Claude Code extension is not responding — cannot open the panel.');
    }
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
    const item = (id, name, offset, command = 'claudeStatusline.open') => {
        const bar = vscode.window.createStatusBarItem(id, align, priority - offset);
        bar.name = name;
        bar.command = command;
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
        // Clicking spend opens the dashboard: that is the question the number
        // raises, so the click should answer it rather than open a chat panel.
        moneyItem: item('claudeStatusline.money', 'Claude spend', 2, 'claudeStatusline.dashboard'),
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
        vscode.commands.registerCommand('claudeStatusline.open', openClaude),
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
