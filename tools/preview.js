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
const { clientSettings } = require(`${REPO}/clientSettings`);
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
// `--over` spends the demo week ahead of its plan, which is the only state in
// which the forecast has anything to say: below plan the window outlasts the
// spending and `{dry}` is silent on purpose.
const demo = DEMO ? require('./demo-index').demo(now, args.includes('--over') ? { weeklyPct: 76 } : {}) : null;
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
// The changelog is passed in as the fetched file would be, because without it
// the tab this page is measured for is empty: `changelog()` cuts the client's
// own cache at the running version, and on an up-to-date client that leaves
// nothing. A probe over that tab then reports "clean" about a heading and one
// panel — which is not an answer about the 361 releases the tab carries when the
// fetch is on. `config.fetchChangelog` below turns the tab to that heavy state.
const changelogText = (() => {
    try { return fs.readFileSync(path.join(os.homedir(), '.claude', 'cache', 'changelog.md'), 'utf8'); } catch { return ''; }
})();
const snap = demo ? null : sys.snapshot({ workspace: REPO, projects: [REPO], sessionProjects, changelogText });

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
    // withCost takes options, not the cost index itself: passing the Map made
    // every agent free, and the probe then measured a Spend column of dashes.
    try { return wfm.withCost(wfm.scanRuns({ now }), { index }); } catch { return []; }
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
    // The Client tab reads this machine's own settings chain — there is no
    // invented version of it, so in demo mode it draws its empty state instead
    // of photographing whatever is in ~/.claude.
    client: DEMO ? null : clientSettings({
        chain: sess.settingsChain(REPO),
        registry: (() => { try { return require(`${REPO}/claude-settings-registry.json`); } catch { return {}; } })(),
        hostEnv: process.env,
    }),
    config: {
        segments: seg.DEFAULT_SEGMENTS,
        defaults: seg.DEFAULT_SEGMENTS,
        presets: seg.PRESETS,
        alignment: 'right', priority: 100, refreshInterval: 60,
        // Draw the Changelog tab in its heavy state — the one worth measuring.
        fetchChangelog: true,
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
    // The version number lives in the page header, so it appears on every
    // screenshot — and a listing image would then go stale on each bump rather
    // than on each change to what it shows. Seven bumps in one day is what made
    // this worth a line. The marketplace prints the version on the card anyway.
    //
    // Matched on `data-version`, an attribute nothing else uses: this once keyed
    // on `class="ver"`, the version moved into a pill during the header
    // redesign, and the replacement quietly stopped matching — the number was
    // photographed for the listing with nothing failing anywhere. A test in
    // test/dashboard.test.js holds both ends of this to the attribute.
    return html
        .replace(/<span class="pill" data-version>v[^<]*<\/span>/, '')
        .replace(/(data-preset-preview="([^"]+)">)(?:<span class="chip-seg">[\s\S]*?<\/span>)*/g,
        (m, head, id) => head + (previews[id] || []).map((line) => `<span class="chip-seg">${esc(line)}</span>`).join(''));
})() : html;

const wrap = (open, extra = '') => page
    .replace('</head>', `<style>${THEME}</style></head>`)
    .replace('</body>', (open ? `<script>addEventListener('load',()=>{
        document.querySelector('nav.sections [data-section="${open.section}"]').click();
        document.querySelector('nav.tabs [data-tab="${open.tab}"]').click();
        // The height of this tab, published where --dump-dom can read it: a
        // screenshot taken at a fixed height pads short tabs with dead space,
        // and dead space on a listing image reads as an empty product.
        document.title = 'H' + Math.ceil(document.body.getBoundingClientRect().height);
      });</script>` : '') + extra + '</body>');

fs.writeFileSync(out, wrap(null));
for (const [sid, , tabs] of db.SECTIONS) {
    for (const [tab] of tabs) fs.writeFileSync(path.join(dir, `preview-${tab}.html`), wrap({ section: sid, tab }));
}

// The probe walks every tab and reports what runs past its own panel or past the
// window.
//
// The version this replaces compared `documentElement.scrollWidth` against
// `clientWidth` — a difference that is structurally zero on a page whose body
// carries `overflow-x: hidden`, so it reported "no overflow" on a page that was
// visibly clipping content. Content cut off by `overflow: hidden` does not
// scroll and does not widen the document; it simply disappears, which is why
// nothing but geometry catches it. Every element is measured against the panel
// it lives in, and the answer is written into the DOM so `--dump-dom` can read
// it without a console.
fs.writeFileSync(path.join(dir, 'overflow-probe.html'), wrap(null, `<pre id="probe-result"></pre><script>
addEventListener('load', () => {
  const sections = [...document.querySelectorAll('nav.sections button')];
  const out = [];
  for (const s of sections) {
    s.click();
    const tabs = [...document.querySelectorAll('nav.tabs button')]
      .filter((b) => b.dataset.section === s.dataset.section || !b.dataset.section);
    for (const t of tabs) {
      t.click();
      const pane = document.querySelector('section.tab[data-tab="' + t.dataset.tab + '"]');
      if (!pane || pane.hidden) continue;
      // Anything behind a "show the rest" button is still content of this tab —
      // and on the Changelog tab it is 346 of the 361 rows. Unopened, the probe
      // measures fifteen and calls the tab clean.
      for (const more of pane.querySelectorAll('[data-more]')) more.click();
      for (const el of pane.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const host = el.parentElement && el.parentElement.closest('.panel, .tab');
        if (!host) continue;
        const h = host.getBoundingClientRect();
        // A scroll container is allowed to hold something wider than itself:
        // that content is reachable. Everything else is simply lost.
        const scrolls = getComputedStyle(host).overflowX !== 'visible';
        const past = Math.max(scrolls ? 0 : r.right - h.right, r.right - innerWidth);
        if (past > 1) {
          out.push(t.dataset.tab + ' · ' + Math.round(past) + 'px · ' + el.tagName.toLowerCase()
            + (el.className ? '.' + String(el.className).split(' ').join('.') : '')
            + ' · ' + (el.textContent || '').trim().slice(0, 40).replace(/\\s+/g, ' '));
        }
      }
    }
  }
  document.getElementById('probe-result').textContent =
    'PROBE ' + innerWidth + 'px: ' + (out.length ? out.length + ' findings\\n' + out.join('\\n') : 'clean');
});
</script>`));

// A leak is a value the page failed to compute, not the word for one. Searching
// the whole document for `undefined` matched prose quoted from a transcript —
// and a real leak is invisible in that noise. What cannot be prose: the entire
// contents of an element, or an attribute that is nothing else.
const LEAK = /(?:>\s*(?:undefined|NaN|\[object Object\])\s*<)|(?:="(?:undefined|NaN|\[object Object\])")/g;
const leaks = [...html.matchAll(LEAK)];
console.log('rendered', (html.length / 1024).toFixed(0), 'KB · panes:', (html.match(/class="tab"/g) || []).length,
    '· placeholder leak:', leaks.length
        ? `${leaks.length} — ${html.slice(Math.max(0, leaks[0].index - 90), leaks[0].index + 30)}`
        : 'none');
