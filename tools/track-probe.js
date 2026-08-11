// Four weeks that never happen at once, so the track can be seen in each of the
// states it has to survive: forecast inside the window, a fresh week, an
// overspent one, and a week with no forecast at all.
const path = require('path');
const db = require(path.resolve(__dirname, '..', 'dashboard'));
const cases = [
    ['forecast lands inside the window', { pct: 71, plan: 42, now: 0.42, dry: 0.66, beforeReset: true, resetIn: 4 * 86400 }],
    ['a week just opened', { pct: 2, plan: 3, now: 0.03, dry: null, beforeReset: false, resetIn: 6.8 * 86400 }],
    ['spent, with hours to go', { pct: 98, plan: 88, now: 0.88, dry: 0.9, beforeReset: true, resetIn: 20 * 3600 }],
    ['forecast past the reset', { pct: 54, plan: 61, now: 0.61, dry: 1.4, beforeReset: false, resetIn: 2.6 * 86400 }],
];
const THEME = `:root{--vscode-font-family:-apple-system,system-ui,sans-serif;
 --vscode-editor-font-family:ui-monospace,Menlo,monospace;--vscode-foreground:#cccccc;
 --vscode-editor-background:#1f1f1f;--vscode-editorWidget-background:#252526;
 --vscode-panel-border:#3c3c3c;--vscode-charts-blue:#3794ff;--vscode-charts-yellow:#d7ba7d;
 --vscode-charts-red:#f14c4c;}
 body{background:var(--vscode-editor-background);color:var(--vscode-foreground);
 font-family:var(--vscode-font-family);padding:24px;font-size:13px;}
 h4{margin:22px 0 8px;font-size:11px;opacity:.45;font-weight:600;}`;
const fs = require('fs');
const css = fs.readFileSync(`${__dirname}/dashboard-preview.html`, 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
// A work panel with a task list, which no live session here happens to have.
const work = db.nowTab([{ id: 'work', title: 'Tasks 3/6', blocks: [
    { kind: 'meters', rows: [{ label: 'done', value: '50%', pct: 50, note: '' }] },
    { kind: 'note', tone: 'active', text: 'writing the parser' },
    { kind: 'subtitle', text: 'Other sessions here' },
    { kind: 'table', rows: [['sessions', '2'], ['busy right now', '1']] },
] }], [], {});
const LIGHT = process.argv[2] === 'light' ? `:root{
  --vscode-foreground:#3b3b3b; --vscode-editor-background:#ffffff;
  --vscode-editorWidget-background:#f3f3f3; --vscode-panel-border:#e5e5e5;
  --vscode-list-hoverBackground:#e8e8e8; --vscode-charts-blue:#1a85ff;
  --vscode-charts-yellow:#b5910a; --vscode-charts-red:#e51400;}` : '';
console.log(`<!doctype html><meta charset="utf-8"><style>${css}</style><style>${THEME}${LIGHT}</style>` +
    cases.map(([name, w]) => `<h4>${name}</h4>${db.paceTrack(w)}`).join('') +
    `<h4>a work panel with a task list</h4>${work}`);
