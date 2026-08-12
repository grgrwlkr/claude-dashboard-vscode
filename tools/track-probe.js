// Seven weeks that never happen at once, so the track can be seen in each of
// the states it has to survive — and measured in them.
//
//   node tools/track-probe.js [dark|light] [--collide] > probe.html
//   chrome --headless --dump-dom file://…/probe.html | rg TRACK-PROBE
//
// The page measures itself: every label is compared against every other label
// of the same track, and the verdict is printed into the DOM where --dump-dom
// can read it. `--collide` puts both labels back on one floor, which is what
// the track did before this change — run it that way first. A probe that has
// never failed is not a probe, and the previous one could not: it compared
// documentElement.scrollWidth against clientWidth on a page whose body carries
// overflow-x: hidden, so it answered "clean" by construction.
const path = require('path');
const db = require(path.resolve(__dirname, '..', 'dashboard'));

const cases = [
    ['forecast inside the window', { pct: 62, plan: 50, now: 0.50, dry: 0.806, beforeReset: true, resetIn: 3.5 * 86400 }],
    ['thin zones — 92% with a day to go', { pct: 92, plan: 84, now: 0.846, dry: 0.920, beforeReset: true, resetIn: 25 * 3600 }],
    ['marks 1.8% apart', { pct: 98, plan: 88, now: 0.88, dry: 0.898, beforeReset: true, resetIn: 20 * 3600 }],
    ['a week just opened', { pct: 2, plan: 3, now: 0.03, dry: null, beforeReset: false, resetIn: 6.8 * 86400 }],
    ['forecast past the reset', { pct: 54, plan: 61, now: 0.61, dry: 1.4, beforeReset: false, resetIn: 2.6 * 86400 }],
    ['out of quota, hours to wait', { pct: 100, plan: 91, now: 0.911, dry: 0.911, beforeReset: true, resetIn: 15 * 3600 }],
    ['out of quota, half a week to wait', { pct: 100, plan: 50, now: 0.50, dry: 0.50, beforeReset: true, resetIn: 3.5 * 86400 }],
];

const THEME = `:root{--vscode-font-family:-apple-system,system-ui,sans-serif;
 --vscode-editor-font-family:ui-monospace,Menlo,monospace;--vscode-foreground:#cccccc;
 --vscode-editor-background:#1f1f1f;--vscode-editorWidget-background:#252526;
 --vscode-panel-border:#3c3c3c;--vscode-charts-blue:#3794ff;--vscode-charts-yellow:#d7ba7d;
 --vscode-charts-red:#f14c4c;--vscode-charts-green:#4ec9b0;}
 body{background:var(--vscode-editor-background);color:var(--vscode-foreground);
 font-family:var(--vscode-font-family);padding:24px;font-size:13px;}
 h4{margin:22px 0 8px;font-size:11px;opacity:.45;font-weight:600;}`;
const LIGHT = `:root{--vscode-foreground:#3b3b3b;--vscode-editor-background:#ffffff;
  --vscode-editorWidget-background:#f3f3f3;--vscode-panel-border:#e5e5e5;
  --vscode-charts-blue:#1a85ff;--vscode-charts-yellow:#b5910a;--vscode-charts-red:#e51400;
  --vscode-charts-green:#107c41;}`;

// The known-bad input: both names pulled onto one line, which is how they used
// to be drawn — over(13) + rail(22) is exactly what separates the two floors, so
// lifting the lower label by 35px puts it back on top of the upper one.
const COLLIDE = `.track-under .track-lbl{top:-35px;}`;

const MEASURE = `
const out = [];
document.querySelectorAll('.track').forEach((track, i) => {
  const labels = [...track.querySelectorAll('.track-lbl')];
  const named = labels.map((el) => el.textContent.trim());
  // Every mark that is drawn must be named, and no name may sit on another.
  if (track.querySelector('.track-flag') && !named.includes('dry')) out.push(i + ': flag drawn without its name');
  if (!named.includes('now')) out.push(i + ': now is not named');
  for (let a = 0; a < labels.length; a++) {
    for (let b = a + 1; b < labels.length; b++) {
      const r = labels[a].getBoundingClientRect(), s = labels[b].getBoundingClientRect();
      const over = r.left < s.right && s.left < r.right && r.top < s.bottom && s.top < r.bottom;
      if (over) out.push(i + ': "' + named[a] + '" overprints "' + named[b] + '"');
    }
  }
  // A duration inside a block must not be wider than the block that holds it.
  track.querySelectorAll('.track-alive span, .track-tail span').forEach((el) => {
    if (el.scrollWidth > el.parentElement.clientWidth + 1) out.push(i + ': "' + el.textContent.trim() + '" is wider than its block');
  });
});
const el = document.createElement('pre');
el.id = 'probe-result';
el.textContent = 'TRACK-PROBE ' + (out.length ? 'FAIL ' + out.length + '\\n' + out.join('\\n') : 'CLEAN');
document.body.appendChild(el);
`;

const light = process.argv.includes('light');
const collide = process.argv.includes('--collide');

console.log(`<!doctype html><meta charset="utf-8"><style>${db.STYLE}</style>
<style>${THEME}${light ? LIGHT : ''}${collide ? COLLIDE : ''}</style>
<body>${cases.map(([name, w]) => `<h4>${name}</h4>${db.paceTrack(w)}`).join('')}
<script>${MEASURE}</script></body>`);
