// Render the dashboard outside the editor, wrap it with VS Code's theme
// variables, and emit one file per tab plus an overflow probe.
//
//   node tools/preview.js <store-dir> <out.html> [dark|light] [--demo]
//
// Without `--demo` it reads the real index of this machine, which is what the
// overflow probe wants: the awkward widths are the ones real data produces.
// With it, the page is rendered from tools/demo-index.js instead — invented
// projects and invented money, which is the only thing that may be photographed
// for a public listing.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ix = require(`${REPO}/indexer`);
const db = require(`${REPO}/dashboard`);
const sys = require(`${REPO}/system`);
const seg = require(`${REPO}/segments`);
const status = require(`${REPO}/status`);
const u = require(`${REPO}/usage`);
const sess = require(`${REPO}/session`);
const { fmtCost } = require(`${REPO}/pricing`);
const wfm = require(`${REPO}/workflows`);

const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const positional = args.filter((a) => !a.startsWith('--'));
const store = positional[0] || fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-prev-'));
const out = positional[1] || path.join(os.tmpdir(), 'dashboard-preview.html');
const THEME_NAME = positional[2] === 'light' ? 'light' : 'dark';
const dir = path.dirname(out);

const now = Date.now();
const demo = DEMO ? require('./demo-index').demo(now) : null;
const { index, stats } = demo
    ? { index: demo.index, stats: { total: demo.meta.files } }
    : ix.refreshIndex(store);
const total = demo ? demo.total : ix.summarize(index);

const sessionProjects = {};
for (const entry of Object.values(index.files)) {
    for (const row of (entry && entry.agg ? entry.agg.sessions : [])) {
        if (row.kind === 'main' && row.id) sessionProjects[row.id] = row.project;
    }
}
// The Setup section reads the installation itself, and there is no invented
// version of that — in demo mode those tabs draw their own empty states rather
// than photographing this machine's plugins, jobs and disk.
const snap = demo ? null : sys.snapshot({ workspace: REPO, projects: [REPO], sessionProjects });

// A couple of synthetic weeks so the Limits chart has a shape before the
// extension has collected real ones.
const reset = Math.floor((now + 3 * 86400000) / 1000);
const rows = [];
for (let d = 0; d <= 4; d += 0.25) {
    rows.push({ at: reset * 1000 - 7 * 86400000 + d * 86400000, weekly: Math.round(d * 11), session: 5, reset, models: { Opus: Math.round(d * 9) } });
}

// The runs the Agents tab draws. In demo mode they are invented; otherwise they
// are this machine's, priced from the index the same way the extension does it.
const workflowRuns = demo ? demo.meta.workflows : (() => {
    try { return wfm.withCost(wfm.scanRuns({ now }), wfm.costIndex(index)); } catch { return []; }
})();

const html = db.render(index, total, demo ? { ...demo.meta, system: snap } : {
    files: stats.total,
    lastRun: now,
    history: rows,
    system: snap,
    workflows: workflowRuns,
    metrics: (() => {
        const nowS = Math.floor(Date.now() / 1000);
        const lim = u.limitsOf(u.readCache(nowS) || {});
        const pace = lim.weekly ? u.pace(lim.weekly, nowS) : null;
        const own = sess.findOwnSession(REPO);
        const ctx = own ? sess.contextOf(sess.readTail(sess.transcriptPath(REPO, own.sessionId))) : null;
        const stats = own ? sess.sessionStats(sess.transcriptPath(REPO, own.sessionId)) : null;
        return status.statusMetrics({ now: nowS, weekly: lim.weekly, session: lim.session, pace, ctx,
            compactPct: sess.autoCompactPct(REPO, ctx ? ctx.window : 0), stats, todayUsd: sess.costToday().usd });
    })(),
    now: (() => {
        const nowS = Math.floor(Date.now() / 1000);
        const lim = u.limitsOf(u.readCache(nowS) || {});
        const pace = lim.weekly ? u.pace(lim.weekly, nowS) : null;
        const own = sess.findOwnSession(REPO);
        const ctx = own ? sess.contextOf(sess.readTail(sess.transcriptPath(REPO, own.sessionId))) : null;
        const stats = own ? sess.sessionStats(sess.transcriptPath(REPO, own.sessionId)) : null;
        return status.statusSections({
            now: nowS, limits: lim, weekly: lim.weekly, session: lim.session, scoped: lim.scoped, pace,
            ctx, stats, settings: sess.settingsOf(REPO), version: sess.versionInfo(own && own.version),
            compactPct: sess.autoCompactPct(REPO, ctx ? ctx.window : 0), todayUsd: sess.costToday().usd,
            peers: own ? sess.peersOf(REPO, own.sessionId) : null, todo: own ? sess.todoOf(own.sessionId) : null,
        }, {
            fmtCost, fmtLeft: u.fmtLeft, fmtAbs: (ts) => u.fmtAbs(ts), fmtWhen: u.fmtWhen,
            fmtDuration: sess.fmtDuration, tok: wfm.tokenLabel, shortModel: db.shortModel,
        }, { stale: false, updatedAt: u.mtime(u.CACHE) });
    })(),
    config: {
        segments: seg.DEFAULT_SEGMENTS,
        defaults: seg.DEFAULT_SEGMENTS,
        presets: seg.PRESETS,
        alignment: 'right', priority: 100, refreshInterval: 60,
        palette: Object.entries(seg.fields({})).map(([name, f]) => ({ name, topic: f.topic, doc: f.doc, value: '' })),
    },
});

// Outside a webview nothing supplies the `--vscode-*` variables, so the two
// stock themes are written out by hand — Dark Modern and Light Modern, the
// defaults a screenshot should be taken against.
const THEMES = {
    dark: `:root{
  --vscode-font-family: -apple-system, system-ui, sans-serif;
  --vscode-editor-font-family: ui-monospace, Menlo, monospace;
  --vscode-foreground:#cccccc; --vscode-editor-background:#1f1f1f;
  --vscode-editorWidget-background:#252526; --vscode-panel-border:#3c3c3c;
  --vscode-focusBorder:#0078d4; --vscode-list-hoverBackground:#2a2d2e;
  --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff;
  --vscode-button-secondaryBackground:#313131; --vscode-button-secondaryForeground:#cccccc;
  --vscode-input-background:#313131; --vscode-input-foreground:#cccccc; --vscode-input-border:#3c3c3c;
  --vscode-charts-blue:#3794ff; --vscode-charts-green:#89d185; --vscode-charts-purple:#b180d7;
  --vscode-charts-red:#f14c4c; --vscode-charts-yellow:#cca700;
}`,
    light: `:root{
  --vscode-font-family: -apple-system, system-ui, sans-serif;
  --vscode-editor-font-family: ui-monospace, Menlo, monospace;
  --vscode-foreground:#3b3b3b; --vscode-editor-background:#ffffff;
  --vscode-editorWidget-background:#f8f8f8; --vscode-panel-border:#e5e5e5;
  --vscode-focusBorder:#005fb8; --vscode-list-hoverBackground:#f0f0f0;
  --vscode-button-background:#005fb8; --vscode-button-foreground:#ffffff;
  --vscode-button-secondaryBackground:#e5e5e5; --vscode-button-secondaryForeground:#3b3b3b;
  --vscode-input-background:#ffffff; --vscode-input-foreground:#3b3b3b; --vscode-input-border:#cecece;
  --vscode-charts-blue:#1a85ff; --vscode-charts-green:#388a34; --vscode-charts-purple:#652d90;
  --vscode-charts-red:#e51400; --vscode-charts-yellow:#bf8803;
}`,
};
const THEME = THEMES[THEME_NAME];

// The preset cards ship their own templates in the markup and are filled in by
// extension.js over a message — a channel that does not exist outside a webview,
// so a screenshot taken here would show `{weekly}` where the editor shows 57%.
// Same call, same renderer, invented values.
const page = demo ? (() => {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const previews = require('./demo-index').presetPreviews();
    return html.replace(/(data-preset-preview="([^"]+)">)(?:<span class="chip-seg">[\s\S]*?<\/span>)*/g,
        (m, head, id) => head + (previews[id] || []).map((line) => `<span class="chip-seg">${esc(line)}</span>`).join(''));
})() : html;

const wrap = (open, extra = '') => page
    .replace('</head>', `<style>${THEME}</style></head>`)
    .replace('</body>', (open ? `<script>addEventListener('load',()=>{
        document.querySelector('nav.sections [data-section="${open.section}"]').click();
        document.querySelector('nav.tabs [data-tab="${open.tab}"]').click();
      });</script>` : '') + extra + '</body>');

fs.writeFileSync(out, wrap(null));
for (const [sid, , tabs] of db.SECTIONS) {
    for (const [tab] of tabs) fs.writeFileSync(path.join(dir, `preview-${tab}.html`), wrap({ section: sid, tab }));
}

// The probe walks every tab and reports how far each one runs past the viewport.
fs.writeFileSync(path.join(dir, 'overflow-probe.html'), wrap(null, `<script>
addEventListener('load', () => {
  const sections = [...document.querySelectorAll('nav.sections button')];
  const tabs = [...document.querySelectorAll('nav.tabs button')];
  const out = [];
  for (const s of sections) {
    s.click();
    for (const t of tabs.filter((b) => b.dataset.section === s.dataset.section)) {
      t.click();
      const doc = document.documentElement;
      out.push(t.dataset.tab + ': ' + (doc.scrollWidth - doc.clientWidth));
    }
  }
  console.log('RESULT ' + JSON.stringify(out));
});
</script>`));

const bad = /undefined|NaN|\[object Object\]/.exec(html);
console.log('rendered', (html.length / 1024).toFixed(0), 'KB · panes:', (html.match(/class="tab"/g) || []).length,
    '· placeholder leak:', bad ? html.slice(Math.max(0, bad.index - 100), bad.index + 40) : 'none');
