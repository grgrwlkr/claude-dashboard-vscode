// Render the dashboard from the real index, wrap it with VS Code's theme
// variables, and emit one file per tab plus an overflow probe.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = '/Users/x/Develop/claude-statusline-vscode';
const ix = require(`${REPO}/indexer`);
const db = require(`${REPO}/dashboard`);
const sys = require(`${REPO}/system`);
const seg = require(`${REPO}/segments`);
const status = require(`${REPO}/status`);
const u = require(`${REPO}/usage`);
const sess = require(`${REPO}/session`);
const { fmtCost } = require(`${REPO}/pricing`);
const wfm = require(`${REPO}/workflows`);

const store = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-prev-'));
const out = process.argv[3] || path.join(os.tmpdir(), 'dashboard-preview.html');
const dir = path.dirname(out);

const { index, stats } = ix.refreshIndex(store);
const total = ix.summarize(index);
const now = Date.now();

const sessionProjects = {};
for (const entry of Object.values(index.files)) {
    for (const row of (entry && entry.agg ? entry.agg.sessions : [])) {
        if (row.kind === 'main' && row.id) sessionProjects[row.id] = row.project;
    }
}
const snap = sys.snapshot({ workspace: REPO, projects: [REPO], sessionProjects });

// A couple of synthetic weeks so the Limits chart has a shape before the
// extension has collected real ones.
const reset = Math.floor((now + 3 * 86400000) / 1000);
const rows = [];
for (let d = 0; d <= 4; d += 0.25) {
    rows.push({ at: reset * 1000 - 7 * 86400000 + d * 86400000, weekly: Math.round(d * 11), session: 5, reset, models: { Opus: Math.round(d * 9) } });
}

const html = db.render(index, total, {
    files: stats.total,
    lastRun: now,
    history: rows,
    system: snap,
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

const THEME = `:root{
  --vscode-font-family: -apple-system, system-ui, sans-serif;
  --vscode-editor-font-family: ui-monospace, Menlo, monospace;
  --vscode-foreground:#cccccc; --vscode-editor-background:#1f1f1f;
  --vscode-editorWidget-background:#252526; --vscode-panel-border:#3c3c3c;
  --vscode-focusBorder:#0078d4; --vscode-list-hoverBackground:#2a2d2e;
  --vscode-charts-blue:#3794ff;
}`;

const wrap = (open, extra = '') => html
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
