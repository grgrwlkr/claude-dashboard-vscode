// The dashboard webview: tabs, tables and hand-rolled SVG charts.
//
// Everything is drawn from the index, which already holds aggregates — the
// webview never touches a transcript, so opening a tab costs nothing. Charts are
// SVG built as strings: a charting library would be the only dependency in the
// project and would buy nothing that a bar and a heatmap need.
//
// Colours come from VS Code theme variables, so the page follows light, dark and
// high-contrast themes without a palette of its own.

const { fmtCost } = require('./pricing');

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const tok = (n) => {
    if (!n) return '0';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
    return String(n);
};

const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

function fmtDur(ms) {
    if (!(ms > 0)) return '—';
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

const fmtDay = (key) => key.slice(5).replace('-', '.');

function fmtDateTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Short model label: "claude-opus-5" → "opus 5". Full ids are noise in a table.
function shortModel(model) {
    return (model || 'unknown')
        .replace(/^claude-/, '')
        .replace(/-\d{8}$/, '')
        .replace(/\[[^\]]*\]$/, '')
        .replace(/-(\d)-(\d)$/, ' $1.$2')
        .replace(/-(\d)$/, ' $1');
}

// A stable colour per position, so a model keeps its colour across every chart
// and the legend. Hue alone runs out at about six entries — anything further
// apart on the wheel starts closing the circle — so later slots also move in
// saturation and lightness, which keeps them apart even where the hues are
// neighbours. Slot 7 is deliberately dark lime rather than cyan: cyan next to
// the blue of slot 2 was indistinguishable at chip size.
const MODEL_COLORS = [
    [265, 60, 58], // violet
    [200, 62, 55], // blue
    [145, 52, 48], // green
    [35, 72, 55],  // orange
    [0, 60, 57],   // red
    [310, 52, 62], // pink
    [75, 55, 42],  // dark lime
    [190, 22, 68], // muted steel
    [20, 40, 38],  // brown
];
function modelColor(model, i) {
    const [h, s, l] = MODEL_COLORS[i % MODEL_COLORS.length];
    return `hsl(${h} ${s}% ${l}%)`;
}

// --- charts -----------------------------------------------------------------

/** Stacked daily spend, one segment per model. */
function stackedDays(days, modelOrder, dayModels, { width = 860, height = 190 } = {}) {
    const keys = Object.keys(days).sort();
    if (keys.length === 0) return '<p class="empty">No activity recorded yet.</p>';

    const max = Math.max(...keys.map((k) => days[k].cost));
    const barW = Math.max(2, Math.min(26, Math.floor(width / keys.length) - 2));
    const step = barW + 2;
    const w = Math.max(width, keys.length * step);
    const scale = (v) => (max > 0 ? (v / max) * (height - 26) : 0);

    let bars = '';
    keys.forEach((key, i) => {
        const x = i * step;
        let y = height - 18;
        const perModel = (dayModels[key] || {});
        // Draw the models in a fixed order so a colour means one model in every
        // column, not "whatever was biggest that day".
        modelOrder.forEach((model, mi) => {
            const cost = perModel[model] || 0;
            if (cost <= 0) return;
            const h = scale(cost);
            y -= h;
            bars += `<rect x="${x}" y="${y.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" `
                + `fill="${modelColor(model, mi)}"><title>${esc(fmtDay(key))} · ${esc(shortModel(model))} · ${esc(fmtCost(cost))}</title></rect>`;
        });
        if (keys.length <= 32 || i % 3 === 0) {
            bars += `<text class="tick" x="${x + barW / 2}" y="${height - 4}" text-anchor="middle">${esc(fmtDay(key))}</text>`;
        }
    });

    return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="xMinYMin meet" role="img">`
        + `<text class="tick" x="0" y="10">${esc(fmtCost(max))}</text>${bars}</svg>`;
}

/** GitHub-style calendar: one cell per day, columns are weeks. */
function heatmap(days, { weeks = 27, cell = 12 } = {}) {
    const keys = Object.keys(days);
    if (keys.length === 0) return '<p class="empty">No activity recorded yet.</p>';

    const max = Math.max(...keys.map((k) => days[k].cost));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Start on the Sunday that begins the first visible week.
    const start = new Date(today);
    start.setDate(start.getDate() - (weeks * 7 - 1) - today.getDay());

    let cells = '';
    let months = '';
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
        for (let d = 0; d < 7; d++) {
            const day = new Date(start);
            day.setDate(start.getDate() + w * 7 + d);
            if (day > today) continue;
            const p = (n) => String(n).padStart(2, '0');
            const key = `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}`;
            const cost = days[key] ? days[key].cost : 0;
            const level = cost <= 0 ? 0 : Math.min(4, Math.ceil((cost / max) * 4));
            const x = w * (cell + 2);
            const y = d * (cell + 2) + 14;
            cells += `<rect class="hm l${level}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2">`
                + `<title>${key} · ${cost > 0 ? esc(fmtCost(cost)) : 'nothing'}</title></rect>`;
            if (d === 0 && day.getMonth() !== lastMonth) {
                lastMonth = day.getMonth();
                months += `<text class="tick" x="${x}" y="9">${day.toLocaleString('en', { month: 'short' })}</text>`;
            }
        }
    }
    const w = weeks * (cell + 2);
    return `<svg class="chart heat" viewBox="0 0 ${w} ${7 * (cell + 2) + 16}" role="img">${months}${cells}</svg>`;
}

/**
 * A keyed breakdown — models, projects, branches, skills — as a borderless
 * table. A table rather than free-floating rows because the columns then line
 * up on their own: the name column sizes to the longest name, and the numbers
 * share one right edge instead of drifting with the bar next to them.
 */
function barList(entries, { value = (b) => b.cost, label = fmtCost, limit = 12 } = {}) {
    const rows = entries.slice(0, limit);
    if (rows.length === 0) return '<p class="empty">Nothing here yet.</p>';
    const max = Math.max(...rows.map(([, b]) => value(b)));
    return `<table class="bars">${rows.map(([key, b], i) => {
        const v = value(b);
        const w = max > 0 ? (v / max) * 100 : 0;
        return `<tr><th scope="row" title="${esc(key)}">${esc(key)}</th>`
            + `<td class="bar-cell"><span class="bar-track">`
            + `<span class="bar-fill" style="width:${w.toFixed(1)}%;background:${modelColor(key, i)}"></span>`
            + `</span></td>`
            + `<td class="bar-val">${esc(label(v, b))}</td></tr>`;
    }).join('')}</table>`;
}

/** Activity by hour of day — 24 columns. */
function hourChart(hours) {
    const values = Array.from({ length: 24 }, (_, h) => (hours[String(h)] ? hours[String(h)].cost : 0));
    const max = Math.max(...values, 0);
    if (max <= 0) return '<p class="empty">Nothing here yet.</p>';
    const cols = values.map((v, h) => {
        const height = (v / max) * 70;
        return `<div class="hour" title="${h}:00 · ${esc(fmtCost(v))}">`
            + `<span class="hour-bar" style="height:${height.toFixed(1)}px"></span>`
            + `<span class="hour-lbl">${h % 6 === 0 ? h : ''}</span></div>`;
    }).join('');
    return `<div class="hours">${cols}</div>`;
}

// --- tabs -------------------------------------------------------------------

function statCards(total) {
    const days = Object.keys(total.days).sort();
    const todayKey = days[days.length - 1];
    const spend = Object.values(total.days).reduce((a, b) => a + b.cost, 0);
    const last7 = days.slice(-7).reduce((a, k) => a + total.days[k].cost, 0);
    const last30 = days.slice(-30).reduce((a, k) => a + total.days[k].cost, 0);
    const msgs = Object.values(total.models).reduce((a, b) => a + b.msgs, 0);
    const cacheRead = Object.values(total.models).reduce((a, b) => a + b.cacheRead, 0);
    const allIn = Object.values(total.models).reduce((a, b) => a + b.in + b.cacheRead + b.cacheWrite, 0);

    const card = (label, value, sub) =>
        `<div class="card"><span class="card-label">${esc(label)}</span>`
        + `<span class="card-value">${esc(value)}</span>`
        + `<span class="card-sub">${esc(sub || '')}</span></div>`;

    return '<div class="cards">'
        + card('All time', fmtCost(spend), `${days.length} active days`)
        + card('Last 30 days', fmtCost(last30), '')
        + card('Last 7 days', fmtCost(last7), '')
        + card('Latest day', todayKey ? fmtCost(total.days[todayKey].cost) : '$0', todayKey || '')
        + card('Requests', String(msgs), `${total.sessions.length} sessions`)
        + card('Served from cache', pct(cacheRead, allIn), `${tok(allIn)} input tokens`)
        + '</div>';
}

function overviewTab(total, dayModels, modelOrder) {
    return `<section class="tab" data-tab="overview">
        ${statCards(total)}
        <h2>Daily spend by model</h2>
        ${stackedDays(total.days, modelOrder, dayModels)}
        <div class="legend">${modelOrder.slice(0, 7).map((m, i) =>
        `<span class="chip"><i style="background:${modelColor(m, i)}"></i>${esc(shortModel(m))}</span>`).join('')}</div>
        <h2>Calendar</h2>
        ${heatmap(total.days)}
        <div class="two">
          <div><h2>Models</h2>${barList(
        Object.entries(total.models).sort((a, b) => b[1].cost - a[1].cost),
        { label: (v, b) => `${fmtCost(v)} · ${tok(b.in + b.cacheRead + b.cacheWrite + b.out)}` },
    )}</div>
          <div><h2>Hour of day</h2>${hourChart(total.hours)}</div>
        </div>
    </section>`;
}

function sessionsTab(total) {
    const rows = total.sessions.slice(0, 300).map((s) => `<tr>
        <td>${esc(fmtDateTime(s.end))}</td>
        <td>${esc(s.project)}</td>
        <td><span class="kind k-${esc(s.kind)}">${esc(s.kind)}</span></td>
        <td>${esc(s.models.map(shortModel).join(', ') || '—')}</td>
        <td class="num">${esc(fmtDur(s.end - s.start))}</td>
        <td class="num">${s.msgs}</td>
        <td class="num">${esc(tok(s.tokens))}</td>
        <td class="num">${esc(fmtCost(s.cost))}</td></tr>`).join('');
    return `<section class="tab" data-tab="sessions" hidden>
        <p class="note">Newest first, capped at 300 rows of ${total.sessions.length}. A row is one transcript: a main session, a subagent, or one agent of a workflow.</p>
        <table><thead><tr><th>Last activity</th><th>Project</th><th>Kind</th><th>Models</th>
        <th class="num">Duration</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Spend</th></tr></thead>
        <tbody>${rows}</tbody></table></section>`;
}

function breakdownTab(name, title, entries, note) {
    return `<section class="tab" data-tab="${name}" hidden>
        ${note ? `<p class="note">${esc(note)}</p>` : ''}
        <h2>${esc(title)}</h2>
        ${barList(entries, { limit: 24, label: (v, b) => `${fmtCost(v)} · ${b.msgs} req` })}
    </section>`;
}

function agentsTab(total) {
    const agents = total.sessions.filter((s) => s.kind === 'agent');
    const wf = total.sessions.filter((s) => s.kind === 'workflow');
    const main = total.sessions.filter((s) => s.kind === 'main');
    const sum = (rows) => rows.reduce((a, r) => a + r.cost, 0);

    // Group workflow agents by their workflow id: one workflow run is the unit
    // worth looking at, not each of its agents.
    const byWorkflow = {};
    for (const row of wf) {
        const w = byWorkflow[row.workflowId] || (byWorkflow[row.workflowId] = {
            cost: 0, msgs: 0, agents: 0, end: 0, project: row.project,
        });
        w.cost += row.cost;
        w.msgs += row.msgs;
        w.agents++;
        w.end = Math.max(w.end, row.end);
    }
    const wfRows = Object.entries(byWorkflow).sort((a, b) => b[1].end - a[1].end).slice(0, 100)
        .map(([id, w]) => `<tr><td>${esc(fmtDateTime(w.end))}</td><td>${esc(w.project)}</td>
            <td class="mono">${esc(id)}</td><td class="num">${w.agents}</td>
            <td class="num">${w.msgs}</td><td class="num">${esc(fmtCost(w.cost))}</td></tr>`).join('');

    const totalCost = sum(main) + sum(agents) + sum(wf);
    return `<section class="tab" data-tab="agents" hidden>
        <p class="note">Subagents and workflows write their own transcripts, so this spend is invisible in the terminal statusline — it belongs to no single session there.</p>
        <div class="cards">
          <div class="card"><span class="card-label">Main sessions</span><span class="card-value">${esc(fmtCost(sum(main)))}</span><span class="card-sub">${main.length} transcripts · ${pct(sum(main), totalCost)}</span></div>
          <div class="card"><span class="card-label">Subagents</span><span class="card-value">${esc(fmtCost(sum(agents)))}</span><span class="card-sub">${agents.length} transcripts · ${pct(sum(agents), totalCost)}</span></div>
          <div class="card"><span class="card-label">Workflow agents</span><span class="card-value">${esc(fmtCost(sum(wf)))}</span><span class="card-sub">${wf.length} transcripts · ${pct(sum(wf), totalCost)}</span></div>
        </div>
        <h2>Workflow runs</h2>
        ${wfRows ? `<table><thead><tr><th>Last activity</th><th>Project</th><th>Workflow</th>
          <th class="num">Agents</th><th class="num">Requests</th><th class="num">Spend</th></tr></thead>
          <tbody>${wfRows}</tbody></table>` : '<p class="empty">No workflow runs recorded.</p>'}
    </section>`;
}

function contentTab(total) {
    const p = total.prompts;
    if (!p || p.count === 0) {
        return '<section class="tab" data-tab="content" hidden><p class="empty">No prompts recorded yet.</p></section>';
    }
    const lensOrder = ['0', '100', '500', '2000', '10000'];
    const lensLabel = { 0: '< 100', 100: '100–500', 500: '500–2k', 2000: '2k–10k', 10000: '10k+' };
    const lens = lensOrder.filter((k) => p.lens[k]).map((k) => [lensLabel[k], { cost: p.lens[k], msgs: p.lens[k] }]);
    const sources = Object.entries(p.bySource).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => [k, { cost: n, msgs: n }]);
    const words = Object.entries(p.words).slice(0, 40);
    const maxWord = words.length ? words[0][1] : 1;

    return `<section class="tab" data-tab="content" hidden>
        <p class="note">Computed locally from your own prompts. Only counts and word tallies are stored — never prompt text — and nothing leaves this machine.</p>
        <div class="cards">
          <div class="card"><span class="card-label">Prompts</span><span class="card-value">${p.count}</span><span class="card-sub">across ${total.sessions.length} transcripts</span></div>
          <div class="card"><span class="card-label">Longest</span><span class="card-value">${tok(p.longest)}</span><span class="card-sub">characters</span></div>
        </div>
        <div class="two">
          <div><h2>Prompt length</h2>${barList(lens, { limit: 8, label: (v) => `${v}` })}</div>
          <div><h2>Where they came from</h2>${barList(sources, { limit: 8, label: (v) => `${v}` })}</div>
        </div>
        <h2>Words you use</h2>
        <p class="note">Five letters or more, with anything appearing in most sessions dropped as filler. Pasted code counts too — that is why identifiers show up.</p>
        <div class="cloud">${words.map(([w, n]) => {
        const size = 0.8 + (n / maxWord) * 1.1;
        return `<span class="word" style="font-size:${size.toFixed(2)}rem" title="${n}">${esc(w)}</span>`;
    }).join('')}</div>
    </section>`;
}

// --- page -------------------------------------------------------------------

const STYLE = `
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
  background: var(--vscode-editor-background); margin: 0; padding: 16px 20px 40px; }
h1 { font-size: 18px; margin: 0 0 2px; font-weight: 600; }
h2 { font-size: 13px; margin: 22px 0 8px; font-weight: 600; opacity: .85; }
.sub { opacity: .6; margin: 0 0 16px; }
.note { opacity: .65; margin: 0 0 12px; max-width: 78ch; line-height: 1.5; }
.empty { opacity: .5; padding: 12px 0; }
nav { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 18px; flex-wrap: wrap; }
nav button { background: none; border: none; border-bottom: 2px solid transparent; color: inherit;
  padding: 7px 12px; cursor: pointer; font: inherit; opacity: .65; }
nav button:hover { opacity: 1; }
nav button[aria-selected="true"] { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
.cards { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 6px; }
.card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
  border-radius: 6px; padding: 10px 14px; min-width: 132px; }
.card-label { display: block; opacity: .6; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
.card-value { display: block; font-size: 20px; font-weight: 600; margin: 2px 0; }
.card-sub { display: block; opacity: .55; font-size: 11px; }
.chart { width: 100%; height: auto; overflow: visible; }
.chart.heat { max-width: 420px; }
.tick { fill: currentColor; opacity: .5; font-size: 9px; }
.hm { fill: currentColor; opacity: .07; }
.hm.l1 { opacity: .25; } .hm.l2 { opacity: .45; } .hm.l3 { opacity: .68; } .hm.l4 { opacity: .92; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; opacity: .75; font-size: 11px; }
.chip i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
@media (max-width: 760px) { .two { grid-template-columns: 1fr; } }
.bars { width: 100%; border-collapse: collapse; }
.bars th, .bars td { border: none; padding: 3px 0; vertical-align: middle; }
.bars th { font: inherit; text-transform: none; letter-spacing: 0; opacity: .85;
  text-align: left; white-space: nowrap; padding-right: 14px; width: 1%; }
.bar-cell { width: 100%; padding-right: 14px !important; }
.bar-track { display: block; background: var(--vscode-editorWidget-background);
  border-radius: 3px; height: 14px; overflow: hidden; }
.bar-fill { display: block; height: 100%; border-radius: 3px; }
.bar-val { opacity: .7; text-align: right; white-space: nowrap;
  font-variant-numeric: tabular-nums; width: 1%; }
.hours { display: flex; align-items: flex-end; gap: 3px; height: 92px; }
.hour { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; flex: 1; height: 100%; }
.hour-bar { width: 100%; background: var(--vscode-charts-blue, hsl(200 60% 55%)); border-radius: 2px 2px 0 0; }
.hour-lbl { font-size: 9px; opacity: .5; margin-top: 3px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
th { font-weight: 600; opacity: .6; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
.mono { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .75; }
.kind { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--vscode-editorWidget-background); opacity: .85; }
.k-workflow { color: hsl(265 60% 65%); } .k-agent { color: hsl(200 60% 60%); } .k-main { color: hsl(145 45% 55%); }
.cloud { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; max-width: 90ch; line-height: 1.7; }
.word { opacity: .8; }
footer { margin-top: 28px; opacity: .5; font-size: 11px; }
`;

const SCRIPT = `
const tabs = document.querySelectorAll('nav button');
const panes = document.querySelectorAll('.tab');
tabs.forEach((btn) => btn.addEventListener('click', () => {
  tabs.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
  panes.forEach((p) => { p.hidden = p.dataset.tab !== btn.dataset.tab; });
}));
const refresh = document.getElementById('refresh');
if (refresh) {
  const vscode = acquireVsCodeApi();
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    refresh.textContent = 'Reindexing…';
    vscode.postMessage({ type: 'refresh' });
  });
}
`;

/** Per-day, per-model cost — needed for the stacked chart, folded here so the
 *  index itself stays small. */
function dayModelMatrix(index) {
    const out = {};
    for (const entry of Object.values(index.files)) {
        const agg = entry && entry.agg;
        if (!agg) continue;
        // A file's days and models are known separately; attributing exactly
        // would mean storing a day×model matrix per file. Instead the file's
        // spend is split across its days in proportion to each day's share,
        // which is exact for the overwhelmingly common single-model transcript.
        const dayCost = Object.entries(agg.days);
        const totalCost = dayCost.reduce((a, [, b]) => a + b.cost, 0);
        if (totalCost <= 0) continue;
        for (const [day, b] of dayCost) {
            const share = b.cost / totalCost;
            const row = out[day] || (out[day] = {});
            for (const [model, mb] of Object.entries(agg.models)) {
                row[model] = (row[model] || 0) + mb.cost * share;
            }
        }
    }
    return out;
}

function render(index, total, meta) {
    const modelOrder = Object.entries(total.models)
        .sort((a, b) => b[1].cost - a[1].cost).map(([m]) => m);
    const dayModels = dayModelMatrix(index);

    const projects = Object.entries(total.projects).sort((a, b) => b[1].cost - a[1].cost);
    const branches = Object.entries(total.branches).sort((a, b) => b[1].cost - a[1].cost);
    const skills = Object.entries(total.skills).sort((a, b) => b[1].cost - a[1].cost);

    const tabs = [
        ['overview', 'Overview'],
        ['sessions', 'Sessions'],
        ['projects', 'Projects'],
        ['branches', 'Branches'],
        ['agents', 'Agents & workflows'],
        ['skills', 'Skills'],
        ['content', 'Content'],
    ];

    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Claude usage</title><style>${STYLE}</style></head><body>
<h1>Claude usage</h1>
<p class="sub">${meta.files} transcripts indexed${meta.lastRun ? ` · updated ${esc(fmtDateTime(meta.lastRun))}` : ''}
 · <button id="refresh" class="link">Reindex</button></p>
<nav role="tablist">${tabs.map(([id, label], i) =>
        `<button role="tab" data-tab="${id}" aria-selected="${i === 0}">${esc(label)}</button>`).join('')}</nav>
${overviewTab(total, dayModels, modelOrder)}
${sessionsTab(total)}
${breakdownTab('projects', 'Spend by project', projects, 'Grouped by the repository a session ran in.')}
${breakdownTab('branches', 'Spend by git branch', branches, 'The branch recorded on each request, so long-lived branches accumulate across sessions.')}
${agentsTab(total)}
${breakdownTab('skills', 'Spend by skill', skills, 'Requests made while a skill was driving, attributed by the attributionSkill field the transcript records.')}
${contentTab(total)}
<footer>All spend figures are estimates from public per-million-token rates, not a bill.</footer>
<script>${SCRIPT}</script></body></html>`;
}

module.exports = {
    render, stackedDays, heatmap, barList, hourChart, dayModelMatrix,
    shortModel, tok, fmtDur, esc,
};
