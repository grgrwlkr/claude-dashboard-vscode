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
const ix = require('./indexer');
const hist = require('./history');
const wfm = require('./workflows');

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

/**
 * A count with the noun that fits it. Both forms are spelled out rather than
 * appending an "s", because half the nouns counted here do not take one:
 * copies, entries, places. One job read as "1 jobs" until this existed.
 */
const plural = (n, one, many = `${one}s`) => `${n} ${Math.abs(n) === 1 ? one : many}`;

function fmtDur(ms) {
    if (!(ms > 0)) return '—';
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

const fmtDay = (key) => key.slice(5).replace('-', '.');

// Weekdays come from usage.js so the tooltips and these tables name a day the
// same way; nothing else of that module is used here.
const { WEEKDAYS, fmtLeft } = require('./usage');

function fmtDateTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${WEEKDAYS[d.getDay()]} ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
    // Start on the Sunday that begins the first visible week, counting whole
    // weeks back from the one today sits in — so the last column is the current
    // week and today always has a cell. Counting back a fixed number of days
    // instead ended the grid on the most recent Sunday, which silently dropped
    // Monday through Saturday of the week in progress.
    const start = new Date(today);
    start.setDate(start.getDate() - today.getDay() - (weeks - 1) * 7);

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

/**
 * Several series on one percentage grid. Used for the weekly windows, where the
 * point is comparison: every line starts at the left edge of its own window, so
 * this week's slope can be read against the ones before it. The dashed diagonal
 * is the linear plan — spending the window evenly.
 */
function lineChart(series, { width = 760, height = 200, xMax = 7, xLabel = (v) => `${v}d` } = {}) {
    if (!series.length || series.every((s) => s.points.length === 0)) {
        return '<p class="empty">Nothing recorded yet.</p>';
    }
    const pad = { l: 30, r: 8, t: 10, b: 20 };
    const w = width - pad.l - pad.r;
    const h = height - pad.t - pad.b;
    const X = (v) => pad.l + (Math.max(0, Math.min(xMax, v)) / xMax) * w;
    const Y = (v) => pad.t + h - (Math.max(0, Math.min(100, v)) / 100) * h;

    let grid = '';
    for (const pct of [0, 25, 50, 75, 100]) {
        grid += `<line class="grid" x1="${pad.l}" y1="${Y(pct)}" x2="${pad.l + w}" y2="${Y(pct)}"/>`
            + `<text class="tick" x="0" y="${Y(pct) + 3}">${pct}%</text>`;
    }
    for (let d = 0; d <= xMax; d++) {
        grid += `<text class="tick" x="${X(d)}" y="${height - 6}" text-anchor="middle">${esc(xLabel(d))}</text>`;
    }
    grid += `<line class="plan" x1="${X(0)}" y1="${Y(0)}" x2="${X(xMax)}" y2="${Y(100)}"/>`;

    const lines = series.map((s, i) => {
        const pts = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        if (pts.length === 0) return '';
        const d = pts.map((p, j) => `${j === 0 ? 'M' : 'L'}${X(p.x).toFixed(1)} ${Y(p.y).toFixed(1)}`).join(' ');
        const last = pts[pts.length - 1];
        const color = modelColor(s.label, i);
        // The newest window is the one being asked about; the older ones are
        // context and fade back so the eye lands on the right line first.
        const faded = s.current ? '' : ' opacity=".45"';
        return `<path class="line" d="${d}" stroke="${color}"${faded}><title>${esc(s.label)}</title></path>`
            + `<circle cx="${X(last.x).toFixed(1)}" cy="${Y(last.y).toFixed(1)}" r="${s.current ? 3.5 : 2.5}" fill="${color}"${faded}/>`;
    }).join('');

    return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">${grid}${lines}</svg>`;
}

/**
 * A stacked bar per day over token counts rather than money. Cost needs a rate
 * and a rate needs a model, which a day-level bucket does not have; tokens are
 * exact, and the split between reads, writes and fresh input is the thing the
 * cache tab is about anyway.
 */
function stackedTokens(days, parts, { width = 860, height = 170 } = {}) {
    const keys = Object.keys(days).sort();
    if (keys.length === 0) return '<p class="empty">No activity recorded yet.</p>';

    const totalOf = (b) => parts.reduce((a, p) => a + (b[p.field] || 0), 0);
    const max = Math.max(...keys.map((k) => totalOf(days[k])));
    const barW = Math.max(2, Math.min(26, Math.floor(width / keys.length) - 2));
    const step = barW + 2;
    const w = Math.max(width, keys.length * step);
    const scale = (v) => (max > 0 ? (v / max) * (height - 26) : 0);

    let bars = '';
    keys.forEach((key, i) => {
        const x = i * step;
        let y = height - 18;
        for (const part of parts) {
            const v = days[key][part.field] || 0;
            if (v <= 0) continue;
            const barH = scale(v);
            y -= barH;
            bars += `<rect x="${x}" y="${y.toFixed(1)}" width="${barW}" height="${barH.toFixed(1)}" fill="${part.color}">`
                + `<title>${esc(fmtDay(key))} · ${esc(part.label)} · ${esc(tok(v))}</title></rect>`;
        }
        if (keys.length <= 32 || i % 3 === 0) {
            bars += `<text class="tick" x="${x + barW / 2}" y="${height - 4}" text-anchor="middle">${esc(fmtDay(key))}</text>`;
        }
    });

    return `<svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="xMinYMin meet" role="img">`
        + `<text class="tick" x="0" y="10">${esc(tok(max))}</text>${bars}</svg>`;
}

/**
 * Rows against columns, with the cell carrying its own weight as a background
 * tint. A plain table of numbers hides the shape; the tint is what makes a
 * whole column of cheap work — or one expensive cell — visible at a glance.
 */
function matrixTable(rows, cols, cellOf, { rowLabel = (r) => r, colLabel = (c) => c, format = fmtCost } = {}) {
    if (rows.length === 0 || cols.length === 0) return '<p class="empty">Nothing here yet.</p>';
    let max = 0;
    for (const r of rows) for (const c of cols) max = Math.max(max, cellOf(r, c) || 0);

    const head = `<tr><th></th>${cols.map((c) => `<th class="num">${esc(colLabel(c))}</th>`).join('')}</tr>`;
    const body = rows.map((r) => {
        const cells = cols.map((c) => {
            const v = cellOf(r, c) || 0;
            if (v <= 0) return '<td class="num dim">·</td>';
            const share = max > 0 ? v / max : 0;
            return `<td class="num heat-cell" style="background:rgba(127,127,127,${(share * 0.35).toFixed(3)})">${esc(format(v))}</td>`;
        }).join('');
        return `<tr><th scope="row">${esc(rowLabel(r))}</th>${cells}</tr>`;
    }).join('');
    return `<table class="matrix"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Percentiles over a sorted-in-place copy. Used for agent fan-out, where the
// mean is the wrong summary: one long-running agent drags it above nearly every
// agent that actually ran.
function quantiles(values) {
    const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const at = (q) => v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))];
    return { n: v.length, p50: at(0.5), p90: at(0.9), max: v[v.length - 1] };
}

// --- tabs -------------------------------------------------------------------

const card = (label, value, sub) =>
    `<div class="card"><span class="card-label">${esc(label)}</span>`
    + `<span class="card-value">${esc(value)}</span>`
    + `<span class="card-sub">${esc(sub || '')}</span></div>`;

const sumOf = (map, field) => Object.values(map).reduce((a, b) => a + (b[field] || 0), 0);

function statCards(total) {
    const days = Object.keys(total.days).sort();
    const todayKey = days[days.length - 1];
    const spend = Object.values(total.days).reduce((a, b) => a + b.cost, 0);
    const last7 = days.slice(-7).reduce((a, k) => a + total.days[k].cost, 0);
    const last30 = days.slice(-30).reduce((a, k) => a + total.days[k].cost, 0);
    const msgs = sumOf(total.models, 'msgs');
    const cacheRead = sumOf(total.models, 'cacheRead');
    const allIn = Object.values(total.models).reduce((a, b) => a + b.in + b.cacheRead + b.cacheWrite, 0);

    return '<div class="cards">'
        + card('All time', fmtCost(spend), `${days.length} active days`)
        + card('Last 30 days', fmtCost(last30), '')
        + card('Last 7 days', fmtCost(last7), '')
        + card('Latest day', todayKey ? fmtCost(total.days[todayKey].cost) : '$0', todayKey || '')
        + card('Requests', String(msgs), plural(total.sessions.length, 'session'))
        + card('Served from cache', pct(cacheRead, allIn), `${tok(allIn)} input tokens`)
        + '</div>';
}

function overviewTab(total, dayModels, modelOrder) {
    return `<section class="tab" data-tab="overview" hidden>
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

// A subagent has no title of its own — it never had a conversation to name. Its
// id is what the workflow journal refers to it by, so that is what it shows.
function sessionLabel(s) {
    if (s.title) return s.title;
    if (s.kind === 'main') return s.id.slice(0, 8);
    return s.agentId ? `agent ${s.agentId}` : s.id.slice(0, 8);
}

function sessionsTab(total) {
    const rows = total.sessions.slice(0, 300).map((s) => `<tr>
        <td class="nowrap">${esc(fmtDateTime(s.end))}</td>
        <td>${esc(s.project)}</td>
        <td class="wrap" title="${esc(s.id)}">${esc(sessionLabel(s))}</td>
        <td class="nowrap opt3"><span class="kind k-${esc(s.kind)}">${esc(s.kind)}</span></td>
        <td class="nowrap opt">${s.entrypoint ? `<span class="kind">${esc(s.entrypoint)}</span>` : '<span class="dim">—</span>'}</td>
        <td class="nowrap opt3">${esc(s.models.map(shortModel).join(', ') || '—')}</td>
        <td class="nowrap dim opt">${s.efforts && s.efforts.length ? esc(s.efforts.join(' / ')) : '—'}</td>
        <td class="num opt2">${esc(fmtDur(s.end - s.start))}</td>
        <td class="num">${s.msgs}</td>
        <td class="num opt2">${esc(tok(s.tokens))}</td>
        <td class="num">${esc(fmtCost(s.cost))}</td></tr>`).join('');
    return `<section class="tab" data-tab="sessions" hidden>
        <p class="note">Newest first, capped at 300 rows of ${total.sessions.length}. A row is one transcript: a main session, a subagent, or one agent of a workflow. The name is the session's own title where it has one.</p>
        <table><thead><tr><th>Last activity</th><th>Project</th><th>Session</th><th class="opt3">Kind</th><th class="opt">Client</th>
        <th class="opt3">Models</th><th class="opt">Effort</th>
        <th class="num opt2">Duration</th><th class="num">Requests</th><th class="num opt2">Tokens</th><th class="num">Spend</th></tr></thead>
        <tbody>${rows}</tbody></table></section>`;
}

function breakdownTab(name, title, entries, note) {
    return `<section class="tab" data-tab="${name}" hidden>
        ${note ? `<p class="note">${esc(note)}</p>` : ''}
        <h2>${esc(title)}</h2>
        ${barList(entries, { limit: 24, label: (v, b) => `${fmtCost(v)} · ${b.msgs} req` })}
    </section>`;
}

/**
 * One agent as a row that opens. The state is read through `outcomeOf` and never
 * off the raw word: the client writes `error` and has never written `failed`,
 * and an agent of a run that was killed stays recorded as working forever — both
 * would otherwise be drawn as finished work.
 *
 * The previews are prose from another program's file, capped at 400 characters
 * by workflows.js, so they go through `esc()` like every other borrowed string.
 */
function agentCard(agent, run) {
    const outcome = wfm.outcomeOf(agent.state, run.state);
    const facts = [
        agent.model ? shortModel(agent.model) : '',
        agent.tokens ? `~${tok(agent.tokens)}` : '',
        agent.cost ? `~${fmtCost(agent.cost)}` : '',
        agent.toolCalls ? `${agent.toolCalls} tool call${agent.toolCalls === 1 ? '' : 's'}` : '',
        agent.durationMs ? fmtDur(agent.durationMs) : '',
        agent.lastToolName ? `last: ${agent.lastToolName}` : '',
    ].filter(Boolean).join(' · ');

    return `<details class="agent"><summary><span class="kind o-${outcome}">${esc(outcome)}</span>
        ${esc(wfm.agentLabel(agent))} <span class="dim">${esc(facts)}</span></summary>
        ${agent.promptPreview ? `<p class="prompt">${esc(agent.promptPreview)}</p>` : ''}
        ${agent.resultPreview ? `<pre class="result">${esc(agent.resultPreview)}</pre>` : ''}
      </details>`;
}

const UNLISTED_TITLE = 'Spent in this run&#39;s directory by transcripts no snapshot lists';

// The two halves of what a run cost, side by side and never added: the sum over
// the agents its snapshot lists, and the money the index found in the same
// directory under transcripts no snapshot names. A run whose own agents cost
// nothing while its directory did is the case a dash followed by a plus sign
// would read as arithmetic on nothing, so that one says the word instead.
function spendCell(totals) {
    const priced = totals.cost ? esc(`~${fmtCost(totals.cost)}`) : '';
    if (!totals.unlisted) return priced || '—';
    const extra = esc(`~${fmtCost(totals.unlisted)}`);
    const text = priced ? `+${extra}` : `${extra} unlisted`;
    return `${priced}${priced ? ' ' : ''}<span class="dim" title="${UNLISTED_TITLE}">${text}</span>`;
}

// A hundred runs is already more history than a table is read for, and each row
// carries its agents underneath it.
const RUN_LIMIT = 100;

// How many agent cards the page may carry. The row limit bounds the table, not
// the document: the widest run here lists 107 agents and the tree has seen 208,
// so a hundred such rows would be tens of megabytes of prompt and result text
// for cards nobody opened. Past the budget a run keeps its row — the numbers are
// what the table is for — and the page says where the cards stopped.
const CARD_BUDGET = 400;

// How many of the newest runs get their agents drawn. The first run is never
// budgeted away however wide it is: it is the one being looked at, and a rule
// that hides it serves nobody.
function cardedRuns(runs) {
    let spent = 0;
    let n = 0;
    for (const run of runs) {
        const size = (run.agents || []).length;
        if (n > 0 && spent + size > CARD_BUDGET) break;
        spent += size;
        n++;
    }
    return n;
}

function runRows(runs) {
    const shown = [...runs].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
        .slice(0, RUN_LIMIT);
    const carded = cardedRuns(shown);

    const rows = shown.map((run, i) => {
        const totals = run.totals || {};
        const agents = run.agents || [];
        const verdict = wfm.verdictOf(run);
        const phases = (run.phases || []).map((p) => p.title).join(' → ');
        // An agent list of its own row rather than of a cell: the agents are the
        // answer to "what did this run actually do", and folding a hundred of
        // them into the last column would leave the table unreadable for the
        // ninety-nine runs nobody is looking at.
        const detail = agents.length && i < carded ? `<tr class="detail"><td colspan="8">
            <details class="agents"><summary>${agents.length} agent${agents.length === 1 ? '' : 's'}</summary>
              ${agents.map((agent) => agentCard(agent, run)).join('')}
            </details></td></tr>` : '';

        return `<tr><td class="nowrap">${esc(fmtDateTime(run.lastActivity))}</td>
            <td class="opt">${esc(run.project)}</td>
            <td class="wrap" title="${esc(run.runId)}">${esc(run.name || run.runId)}</td>
            <td>${verdict.word ? `<span class="kind o-${verdict.outcome}">${esc(verdict.word)}</span>` : '<span class="dim">—</span>'}</td>
            <td class="opt2">${esc(phases)}</td>
            <td class="num">${esc(wfm.countLabel(run, { always: true }))}</td>
            <td class="num opt2">${run.durationMs ? esc(fmtDur(run.durationMs)) : '—'}</td>
            <td class="num">${spendCell(totals)}</td></tr>${detail}`;
    }).join('');

    return { rows, shown: shown.length, carded };
}

function agentsTab(total, runs = []) {
    const agents = total.sessions.filter((s) => s.kind === 'agent');
    const wf = total.sessions.filter((s) => s.kind === 'workflow');
    const main = total.sessions.filter((s) => s.kind === 'main');
    const sum = (rows) => rows.reduce((a, r) => a + r.cost, 0);

    // How many agents each run dispatched, counted by workflow id off the
    // transcripts rather than off the snapshots: a fan-out figure is about what
    // was actually written, and this answers for runs whose snapshot is gone.
    const perWorkflow = {};
    for (const row of wf) perWorkflow[row.workflowId] = (perWorkflow[row.workflowId] || 0) + 1;

    const totalCost = sum(main) + sum(agents) + sum(wf);

    // What one agent costs is the number needed to size a fan-out, and the mean
    // is the wrong summary for it: a handful of long agents sit far above the
    // rest, so a median and a p90 describe the fleet and an average describes
    // nobody.
    const spread = [
        ['subagent', quantiles(agents.map((s) => s.out))],
        ['workflow agent', quantiles(wf.map((s) => s.out))],
    ].filter(([, q]) => q);
    const perRun = quantiles(Object.values(perWorkflow));
    const table = runRows(runs);

    return `<section class="tab" data-tab="agents" hidden>
        <p class="note">Subagents and workflows write their own transcripts, so this spend is invisible in the terminal statusline — it belongs to no single session there.</p>
        <div class="cards">
          ${card('Main sessions', fmtCost(sum(main)), `${plural(main.length, 'transcript')} · ${pct(sum(main), totalCost)}`)}
          ${card('Subagents', fmtCost(sum(agents)), `${plural(agents.length, 'transcript')} · ${pct(sum(agents), totalCost)}`)}
          ${card('Workflow agents', fmtCost(sum(wf)), `${plural(wf.length, 'transcript')} · ${pct(sum(wf), totalCost)}`)}
          ${perRun ? card('Agents per workflow', String(perRun.p50), `p90 ${perRun.p90} · max ${perRun.max}`) : ''}
        </div>
        ${spread.length ? `<h2>Output tokens one agent writes</h2>
        <table class="matrix"><thead><tr><th></th><th class="num">agents</th><th class="num">median</th>
          <th class="num">p90</th><th class="num">max</th></tr></thead><tbody>
          ${spread.map(([label, q]) => `<tr><th scope="row">${esc(label)}</th><td class="num">${q.n}</td>
            <td class="num">${esc(tok(q.p50))}</td><td class="num">${esc(tok(q.p90))}</td>
            <td class="num">${esc(tok(q.max))}</td></tr>`).join('')}
        </tbody></table>
        <p class="note">Multiply the median by the fleet size for the usual case, and the p90 for the bad one.</p>` : ''}
        <h2>Workflow runs</h2>
        ${runs.length ? `<p class="note">Newest first, capped at ${RUN_LIMIT} rows of ${runs.length}. Each run as its own snapshot describes it — the name, how it ended, the phases it was written in. A run still going has written no snapshot yet, so its row is assembled from the journal instead and says what it is doing rather than how it ended. Open one to see its agents: what each was told, what it answered and what it cost. A run's price is the sum over the agents its snapshot lists; money spent in the same directory by transcripts no snapshot names is added beside that figure rather than folded into it.</p>
        <table><thead><tr><th>Last activity</th><th class="opt">Project</th><th>Workflow</th>
          <th>Status</th><th class="opt2">Phases</th><th class="num">Agents</th>
          <th class="num opt2">Duration</th><th class="num">Spend</th></tr></thead>
          <tbody>${table.rows}</tbody></table>
        ${table.carded < table.shown ? `<p class="note">Agents are drawn only for the ${table.carded} newest runs of the ${table.shown} above. A fan-out of hundreds carries every prompt and every result into the page, so the rest keep their row without them — the tree in the sidebar draws the agents of every run it lists, and it lists the ${wfm.TREE_FINISHED} newest finished runs beside everything still going or abandoned.</p>` : ''}`
        : '<p class="empty">No workflow runs recorded.</p>'}
    </section>`;
}

function contentTab(total, sys) {
    const p = total.prompts;
    if (!p || p.count === 0) {
        return '<section class="tab" data-tab="content" hidden><p class="empty">No prompts recorded yet.</p></section>';
    }
    // The client keeps a second log of typed prompts, shared across projects.
    // Only its counts are read — never a line of it.
    const log = sys && sys.prompts;
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
          <div class="card"><span class="card-label">Prompts</span><span class="card-value">${p.count}</span><span class="card-sub">across ${plural(total.sessions.length, 'transcript')}</span></div>
          <div class="card"><span class="card-label">Longest</span><span class="card-value">${tok(p.longest)}</span><span class="card-sub">characters</span></div>
        </div>
        <div class="two">
          <div><h2>Prompt length</h2>${barList(lens, { limit: 8, label: (v) => `${v}` })}</div>
          <div><h2>Where they came from</h2>${barList(sources, { limit: 8, label: (v) => `${v}` })}</div>
        </div>
        ${log ? `<h2>Prompts the client logged</h2>
        <p class="note">From <code>~/.claude/history.jsonl</code>, which keeps every prompt typed on this machine across every project. Only counts are read here — the text stays in the file.</p>
        <div class="cards">
          ${card('Logged prompts', String(log.count), `${log.pasted} carried a paste`)}
          ${card('Active days', String(Object.keys(log.byDay).length), log.first ? `since ${fmtDateTime(log.first)}` : '')}
        </div>
        <div class="two">
          <div><h2>By project</h2>${barList(
            Object.entries(log.byProject).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, { cost: n, msgs: n }]),
            { limit: 10, label: (v) => String(v) },
        )}</div>
          <div><h2>Busiest days</h2>${barList(
            Object.entries(log.byDay).sort((a, b) => b[1] - a[1]).map(([k, n]) => [fmtDay(k), { cost: n, msgs: n }]),
            { limit: 10, label: (v) => String(v) },
        )}</div>
        </div>` : ''}
        <h2>Words you use</h2>
        <p class="note">Five letters or more, with anything appearing in most sessions dropped as filler. Pasted code counts too — that is why identifiers show up.</p>
        <div class="cloud">${words.map(([w, n]) => {
        const size = 0.8 + (n / maxWord) * 1.1;
        return `<span class="word" style="font-size:${size.toFixed(2)}rem" title="${n}">${esc(w)}</span>`;
    }).join('')}</div>
    </section>`;
}

// The tiers the client offers, in order. Anything else a transcript reports is
// appended as it comes, and a reply with no effort at all gets its own column:
// SDK sessions do not send one, and that is a fact about them worth seeing.
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_EFFORT = 'not sent';

function effortMatrix(efforts) {
    const models = [];
    const tiers = [];
    const cells = new Map();
    for (const [key, b] of Object.entries(efforts)) {
        const { model, effort } = ix.splitEffort(key);
        const tier = effort || NO_EFFORT;
        if (!models.includes(model)) models.push(model);
        if (!tiers.includes(tier)) tiers.push(tier);
        cells.set(`${model}${tier}`, b);
    }
    const rank = (t) => {
        const i = EFFORT_ORDER.indexOf(t);
        return i < 0 ? EFFORT_ORDER.length + (t === NO_EFFORT ? 1 : 0) : i;
    };
    tiers.sort((a, b) => rank(a) - rank(b));
    models.sort((a, b) => costOfModel(efforts, b) - costOfModel(efforts, a));
    return { models, tiers, get: (m, t) => cells.get(`${m}${t}`) || null };
}

function costOfModel(efforts, model) {
    let sum = 0;
    for (const [key, b] of Object.entries(efforts)) {
        if (ix.splitEffort(key).model === model) sum += b.cost;
    }
    return sum;
}

function modelsTab(total) {
    const m = effortMatrix(total.efforts || {});
    const entries = Object.entries(total.entrypoints || {}).sort((a, b) => b[1].cost - a[1].cost);
    const speeds = Object.entries(total.speeds || {}).sort((a, b) => b[1].cost - a[1].cost);

    // Output per request is the honest measure of what a tier costs: a higher
    // effort does not change the rate, it changes how much the model writes.
    const perTier = m.tiers.map((tier) => {
        let out = 0; let msgs = 0; let cost = 0;
        for (const model of m.models) {
            const b = m.get(model, tier);
            if (!b) continue;
            out += b.out; msgs += b.msgs; cost += b.cost;
        }
        return [tier, { out, msgs, cost, perReq: msgs > 0 ? out / msgs : 0 }];
    }).filter(([, v]) => v.msgs > 0).sort((a, b) => b[1].perReq - a[1].perReq);

    return `<section class="tab" data-tab="models" hidden>
        <p class="note">Which model did the work, at which reasoning effort, from which client. A dispatch that forgot to name a model or an effort inherits the session's — and that inheritance is only visible here.</p>
        <h2>Spend by model and effort</h2>
        ${matrixTable(m.models, m.tiers, (model, tier) => (m.get(model, tier) || {}).cost,
        { rowLabel: shortModel })}
        <div class="two">
          <div><h2>Where the requests came from</h2>
            ${barList(entries, { limit: 8, label: (v, b) => `${fmtCost(v)} · ${b.msgs} req` })}
            <p class="note">An <code>sdk-*</code> entrypoint is a program driving Claude Code, not a session you typed in: it carries its own model choice and ignores <code>settings.json</code>.</p>
          </div>
          <div><h2>Output per request, by effort</h2>
            ${barList(perTier, { limit: 8, value: (b) => b.perReq, label: (v, b) => `${tok(Math.round(v))} · ${b.msgs} req` })}
            ${speeds.length > 1 ? `<h2>Speed</h2>${barList(speeds, { limit: 4, label: (v, b) => `${fmtCost(v)} · ${b.msgs} req` })}` : ''}
          </div>
        </div>
    </section>`;
}

// mcp__<server>__<tool> is the only naming convention in the tool list that
// carries structure, and it is the one worth grouping by: it answers "which of
// these servers do I actually use".
function mcpServer(name) {
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
    return m ? m[1] : null;
}

function toolsTab(total) {
    const tools = Object.entries(total.tools || {});
    if (tools.length === 0) {
        return '<section class="tab" data-tab="tools" hidden><p class="empty">No tool calls recorded yet.</p></section>';
    }
    const calls = tools.reduce((a, [, t]) => a + t.calls, 0);
    const errors = tools.reduce((a, [, t]) => a + t.errors, 0);
    const denials = tools.reduce((a, [, t]) => a + t.denials, 0);
    const advisor = (total.tools.advisor || {}).calls || 0;

    const servers = {};
    for (const [name, t] of tools) {
        const server = mcpServer(name);
        if (!server) continue;
        const s = servers[server] || (servers[server] = { calls: 0, errors: 0, tools: 0 });
        s.calls += t.calls;
        s.errors += t.errors;
        s.tools++;
    }

    const byCalls = tools.slice().sort((a, b) => b[1].calls - a[1].calls);
    // A tool that failed twice out of three calls is worth seeing; one that
    // failed twice out of nine hundred is noise, so the rate needs a floor
    // under it before it means anything.
    const flaky = tools.filter(([, t]) => t.calls >= 20 && t.errors > 0)
        .map(([name, t]) => [name, { ...t, rate: t.errors / t.calls }])
        .sort((a, b) => b[1].rate - a[1].rate);

    return `<section class="tab" data-tab="tools" hidden>
        <p class="note">Counted from the tool_use blocks of every reply on this machine. A failed result is blamed on the tool that produced it, matched back through the call id.</p>
        <div class="cards">
          ${card('Tool calls', String(calls), `${plural(tools.length, 'distinct tool')}`)}
          ${card('Failed', String(errors), pct(errors, calls) + ' of calls')}
          ${card('Denied', String(denials), 'refused by you or by a rule')}
          ${card('Advisor', String(advisor), 'consultations — priced server-side, not here')}
        </div>
        <div class="two">
          <div><h2>Most used</h2>
            ${barList(byCalls, { limit: 16, value: (t) => t.calls, label: (v, t) => (t.errors ? `${v} · ${t.errors} failed` : String(v)) })}
          </div>
          <div><h2>MCP servers</h2>
            ${barList(Object.entries(servers).sort((a, b) => b[1].calls - a[1].calls),
        { limit: 12, value: (s) => s.calls, label: (v, s) => `${v} · ${plural(s.tools, 'tool')}` })}
            <p class="note">A server with no calls at all does not appear here — that is the answer to whether it earns its place in the config.</p>
            <h2>Failing most often</h2>
            ${barList(flaky, { limit: 8, value: (t) => t.rate * 100, label: (v, t) => `${v.toFixed(0)}% of ${t.calls}` })}
          </div>
        </div>
    </section>`;
}

// Two charts rather than one stack. Cache reads outweigh everything else by an
// order of magnitude, so stacking them together leaves four invisible slivers
// under one blue wall — and the interesting question is about those slivers,
// since they are the tokens billed at the full rate.
const BILLED_PARTS = [
    { field: 'cw1h', label: 'cache write 1h', color: 'hsl(35 72% 55%)' },
    { field: 'cw5m', label: 'cache write 5m', color: 'hsl(145 52% 48%)' },
    { field: 'in', label: 'fresh input', color: 'hsl(265 60% 58%)' },
    { field: 'out', label: 'output', color: 'hsl(0 60% 57%)' },
];
const READ_PARTS = [{ field: 'cacheRead', label: 'cache read', color: 'hsl(200 62% 55%)' }];
const CACHE_PARTS = [...READ_PARTS, ...BILLED_PARTS];

function cacheTab(total) {
    const read = sumOf(total.models, 'cacheRead');
    const write = sumOf(total.models, 'cacheWrite');
    const w1h = sumOf(total.models, 'cw1h');
    const w5m = sumOf(total.models, 'cw5m');
    const fresh = sumOf(total.models, 'in');
    const saved = sumOf(total.models, 'saved');
    const allIn = read + write + fresh;
    if (allIn === 0) {
        return '<section class="tab" data-tab="cache" hidden><p class="empty">Nothing recorded yet.</p></section>';
    }

    // Written once, read back how many times. Below 1 the cache is being
    // rebuilt more often than it is used, which is the expensive direction.
    const leverage = write > 0 ? read / write : 0;
    const byModel = Object.entries(total.models)
        .filter(([, b]) => b.cacheRead + b.cacheWrite > 0)
        .sort((a, b) => (b[1].cacheRead + b[1].cacheWrite) - (a[1].cacheRead + a[1].cacheWrite))
        .map(([m, b]) => [shortModel(m), { ...b, hit: b.cacheRead / (b.cacheRead + b.cacheWrite + b.in) }]);

    return `<section class="tab" data-tab="cache" hidden>
        <p class="note">A cached token is read at a tenth of the input rate; putting it there costs 1.25x at the five-minute TTL and 2x at the hourly one. Which TTL a request used is recorded per reply, so both sides are exact.</p>
        <div class="cards">
          ${card('Served from cache', pct(read, allIn), `${tok(read)} of ${tok(allIn)} input tokens`)}
          ${card('Saved by reads', `~${fmtCost(saved)}`, 'against sending them fresh')}
          ${card('Read per token written', leverage.toFixed(1) + '×', leverage < 1 ? 'rebuilt more than reused' : 'each write paid off')}
          ${card('Hourly TTL', pct(w1h, write), `${tok(w1h)} at 2× · ${tok(w5m)} at 1.25×`)}
        </div>
        <h2>Tokens billed at the full rate, by day</h2>
        ${stackedTokens(total.days, BILLED_PARTS, { height: 150 })}
        <div class="legend">${BILLED_PARTS.map((p) =>
        `<span class="chip"><i style="background:${p.color}"></i>${esc(p.label)}</span>`).join('')}</div>
        <h2>Cache reads, by day</h2>
        <p class="note">The same days on their own scale — reads run an order of magnitude above everything above, which is the point of them.</p>
        ${stackedTokens(total.days, READ_PARTS, { height: 110 })}
        <h2>Cache hit rate by model</h2>
        ${barList(byModel, { limit: 10, value: (b) => b.hit * 100, label: (v, b) => `${v.toFixed(0)}% · ${tok(b.cacheRead)} read` })}
    </section>`;
}

function frictionTab(total) {
    const f = total.friction || {};
    const compactions = Object.values(f.compactions || {}).reduce((a, n) => a + n, 0);
    const denials = Object.entries(f.denials || {}).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => [k, { cost: n, msgs: n }]);
    const compactRows = Object.entries(f.compactions || {}).sort((a, b) => b[1] - a[1])
        .map(([k, n]) => [k, { cost: n, msgs: n }]);
    const worst = (total.sessions || []).filter((s) => s.errors > 0)
        .sort((a, b) => b.errors - a.errors).slice(0, 12);

    const toolErrors = Object.entries(total.tools || {}).filter(([, t]) => t.errors > 0)
        .sort((a, b) => b[1].errors - a[1].errors);

    return `<section class="tab" data-tab="friction" hidden>
        <p class="note">What the spend ran into. None of it is priced separately — a rejected call still cost the tokens that proposed it, and those are already counted as spend.</p>
        <div class="cards">
          ${card('Failed tool calls', String(f.toolErrors || 0), '')}
          ${card('Denied', String(Object.values(f.denials || {}).reduce((a, n) => a + n, 0)), 'refused before running')}
          ${card('Compactions', String(compactions), `${tok(f.droppedTokens || 0)} of context dropped`)}
          ${card('Cut off', String(f.shutdowns || 0), 'by the client going away')}
        </div>
        <div class="two">
          <div><h2>Why a call was refused</h2>${barList(denials, { limit: 8, label: (v) => String(v) })}</div>
          <div><h2>What triggered a compaction</h2>${barList(compactRows, { limit: 6, label: (v) => String(v) })}
            ${f.compactMs > 0 ? `<p class="note">Compacting took ${esc(fmtDur(f.compactMs))} of wall-clock in total.</p>` : ''}
          </div>
        </div>
        <h2>Tools that failed</h2>
        ${barList(toolErrors, { limit: 12, value: (t) => t.errors, label: (v, t) => `${v} of ${t.calls}` })}
        <h2>Sessions with the most failures</h2>
        ${worst.length ? `<table><thead><tr><th>Last activity</th><th>Project</th><th>Session</th>
          <th class="num">Failed</th><th class="num opt2">Requests</th><th class="num">Spend</th></tr></thead>
          <tbody>${worst.map((s) => `<tr><td>${esc(fmtDateTime(s.end))}</td><td>${esc(s.project)}</td>
            <td class="wrap">${esc(s.title || s.id)}</td><td class="num">${s.errors}</td>
            <td class="num opt2">${s.msgs}</td><td class="num">${esc(fmtCost(s.cost))}</td></tr>`).join('')}
          </tbody></table>` : '<p class="empty">No failed tool calls recorded.</p>'}
    </section>`;
}

// Which week a window was, counted from now rather than from its position in
// the list: the log only grows while the editor runs, so a fortnight with the
// laptop shut leaves a gap, and "the one before the last one" would then label a
// month-old window "last week".
function weekLabel(reset, nowMs) {
    const ms = reset * 1000;
    if (ms > nowMs) return 'this week';
    const back = Math.floor((nowMs - ms) / hist.WEEK_MS) + 1;
    return back === 1 ? 'last week' : `${back} weeks ago`;
}

function limitsTab(history, nowMs = Date.now()) {
    // Sorted here rather than trusted: the caller reads a file that several
    // windows append to, and "the last row" has to mean the latest reading.
    const rows = (history || []).slice().sort((a, b) => a.at - b.at);
    const windows = hist.weeklyWindows(rows);
    const series = windows.map((w) => ({
        label: weekLabel(w.reset, nowMs),
        // Still running, rather than last in the list: after a week away the
        // newest window on file is history too, and nothing is "now".
        current: w.reset * 1000 > nowMs,
        reset: w.reset,
        points: w.points.map((p) => ({ x: p.day, y: p.pct })),
    }));
    const last = rows[rows.length - 1];

    const cards = last ? '<div class="cards">'
        + card('Weekly window', `${last.weekly}%`, `resets ${fmtDateTime(last.reset * 1000)}`)
        + (typeof last.session === 'number' ? card('Session window', `${last.session}%`, 'the rolling 5 hours') : '')
        + card('Readings kept', String(rows.length), `since ${fmtDateTime(rows[0].at)}`)
        + '</div>' : '';

    const models = last && last.models ? Object.entries(last.models).sort((a, b) => b[1] - a[1]) : [];

    return `<section class="tab" data-tab="limits" hidden>
        <p class="note">The usage endpoint answers only for right now, so this is a local log: one row whenever a percentage moves, kept in the extension's own storage. It starts empty and fills in as the extension runs.</p>
        ${cards}
        <h2>Weekly windows, overlaid</h2>
        <p class="note">One line per weekly window, each drawn from its own beginning: across is days since that window opened, up is how much of the weekly limit was gone by then. Stacking the weeks on one pair of axes compares the pace rather than the dates — the same day of two different weeks sits at the same place. The dashed diagonal is a window spent evenly; a line above it runs out before the reset, a line below leaves quota unused.</p>
        ${lineChart(series)}
        <div class="legend">${series.map((s, i) =>
        `<span class="chip"><i style="background:${modelColor(s.label, i)}"></i>${esc(s.label)}<span class="dim">· ${s.current ? 'resets' : 'ended'} ${esc(fmtDateTime(s.reset * 1000))}</span></span>`).join('')}</div>
        ${series.length === 1 ? '<p class="note">Only one window has been recorded so far, so there is nothing to compare it against yet — the older lines appear as resets go by.</p>' : ''}
        ${models.length ? `<h2>Per-model windows, latest reading</h2>${barList(
        models.map(([name, p]) => [name, { cost: p, msgs: p }]),
        { limit: 8, label: (v) => `${v}%` })}` : ''}
    </section>`;
}

// --- setup: the installation itself, not its usage --------------------------

const bytes = (n) => {
    if (!n) return '0';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
    if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
    return `${n} B`;
};

const ago = (ms) => {
    if (!ms) return '—';
    const d = Math.floor((Date.now() - ms) / 86400000);
    if (d <= 0) return 'today';
    if (d === 1) return 'yesterday';
    return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
};

/** A definition list of resolved settings — the value in force, and its source. */
function settingsList(settings) {
    const rows = Object.entries(settings.values || {});
    if (rows.length === 0) return '<p class="empty">No settings found.</p>';
    return `<table class="kv"><tbody>${rows.map(([key, v]) =>
        `<tr><th scope="row">${esc(key)}</th><td>${esc(String(v.value))}</td>
         <td class="dim opt">${esc(v.from)}</td></tr>`).join('')}</tbody></table>`;
}

/**
 * The configured inventory against what actually ran. A plugin's skills and an
 * MCP server's tools both show up in the index under names that can be matched
 * back, so "installed" and "used" can sit in the same row — which is the only
 * way the list answers what to uninstall.
 */
function healthTab(total, sys) {
    if (!sys) return '<section class="tab" data-tab="health" hidden><p class="empty">No installation data.</p></section>';
    const v = sys.versions || {};
    const usedServers = new Set();
    for (const name of Object.keys(total.tools || {})) {
        const server = mcpServer(name);
        if (server) usedServers.add(server.toLowerCase());
    }
    // A server registered as `qmd` shows up in tool names as mcp__qmd__…, but a
    // server a plugin brings arrives prefixed with the plugin — `context7`
    // becomes `plugin_context7_context7`. A suffix match pairs the two without
    // inventing a mapping that does not exist.
    const serverUsed = (name) => {
        const key = String(name).toLowerCase();
        return [...usedServers].some((s) => s === key || s.endsWith(`_${key}`) || s.endsWith(`-${key}`));
    };
    const mcpRows = (sys.mcp || []).map((m) => ({ ...m, used: serverUsed(m.name) }));

    const usedSkills = new Set(Object.keys(total.skills || {}).map((s) => s.toLowerCase()));
    const usedTools = new Set(Object.keys(total.tools || {}).map((s) => s.toLowerCase()));
    const pluginRows = (sys.plugins || []).map((p) => {
        const parts = p.components || {};
        const names = [...(parts.skills || []), ...(parts.agents || []), ...(parts.commands || [])]
            .map((n) => n.toLowerCase());
        // A skill is attributed as `plugin:skill`, an agent turns up as a tool
        // argument; either way the plugin's own name in the tally is the signal.
        const used = names.some((n) => usedSkills.has(n) || usedSkills.has(`${p.name.toLowerCase()}:${n}`))
            || usedSkills.has(p.name.toLowerCase())
            || usedTools.has(p.name.toLowerCase())
            || (parts.mcp || []).some(serverUsed);
        return { ...p, used, size: names.length + (parts.hooks || 0) + (parts.mcp || []).length };
    }).sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(a.used) - Number(b.used));

    const idle = pluginRows.filter((p) => p.enabled && !p.used);
    const yes = '<span class="ok">used</span>';
    const no = '<span class="idle">idle</span>';

    return `<section class="tab" data-tab="health" hidden>
        <p class="note">What is configured on this machine, and which of it has actually run. "Idle" means none of its skills, commands or MCP tools appears anywhere in the indexed transcripts. Two things it cannot see: an agent, whose type is named in a tool call's arguments rather than its result, and a hook, which leaves no record at all — so a plugin that ships only those reads as idle whether or not it fired.</p>
        <div class="cards">
          ${card('Client', v.current || '—', v.waiting ? `${v.latest} unpacked and waiting` : `${plural((v.installed || []).length, 'version')} on disk`)}
          ${card('Plugins', String(pluginRows.filter((p) => p.enabled).length), `${idle.length} enabled but idle`)}
          ${card('MCP servers', String(mcpRows.length), `${mcpRows.filter((m) => !m.used).length} never called`)}
          ${card('Hooks', String((sys.hooks || []).length), plural((sys.permissions || []).length, 'permission rule'))}
        </div>
        <div class="two">
          <div><h2>Settings in force</h2>${settingsList(sys.settings || {})}
            ${Object.keys((sys.settings || {}).env || {}).length ? `<h2>Environment</h2>
              <table class="kv"><tbody>${Object.entries(sys.settings.env).map(([k, val]) =>
        `<tr><th scope="row">${esc(k)}</th><td>${esc(String(val))}</td></tr>`).join('')}</tbody></table>` : ''}
          </div>
          <div><h2>MCP servers</h2>
            <table><thead><tr><th>Server</th><th>Scope</th><th class="opt2">Via</th><th>Used</th></tr></thead><tbody>
            ${mcpRows.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.scope)}${m.project ? ` <span class="dim">${esc(m.project)}</span>` : ''}</td>
              <td class="dim opt2">${esc(m.command || m.transport)}</td><td>${m.used ? yes : no}</td></tr>`).join('')}
            </tbody></table>
            <h2>Hooks</h2>
            ${(sys.hooks || []).length ? `<table><thead><tr><th>Event</th><th class="opt2">Matcher</th><th>Runs</th></tr></thead><tbody>
              ${sys.hooks.map((h) => `<tr><td>${esc(h.event)}</td><td class="mono opt2">${esc(h.matcher)}</td>
                <td class="mono wrap" title="${esc(h.command)}">${esc(h.command)}</td></tr>`).join('')}
            </tbody></table>` : '<p class="empty">No hooks configured.</p>'}
          </div>
        </div>
        <h2>Plugins</h2>
        <table><thead><tr><th>Plugin</th><th class="opt">Marketplace</th><th class="opt2">Version</th>
          <th class="num">Skills</th><th class="num">Agents</th><th class="num">Commands</th>
          <th class="num">Hooks</th><th class="opt2">MCP</th><th class="num opt">Copies</th><th>State</th></tr></thead><tbody>
        ${pluginRows.map((p) => {
        const c = p.components || {};
        return `<tr class="${p.enabled ? '' : 'off'}"><td>${esc(p.name)}</td><td class="dim opt">${esc(p.marketplace)}</td>
              <td class="dim opt2">${esc(p.version || '—')}</td>
              <td class="num">${(c.skills || []).length || '·'}</td><td class="num">${(c.agents || []).length || '·'}</td>
              <td class="num">${(c.commands || []).length || '·'}</td><td class="num">${c.hooks || '·'}</td>
              <td class="dim opt2">${esc((c.mcp || []).join(', ') || '·')}</td>
              <td class="num opt">${p.copies > 1 ? p.copies : '·'}</td>
              <td>${p.missing ? '<span class="idle">missing</span>' : !p.enabled ? '<span class="dim">off</span>' : p.used ? yes : no}</td></tr>`;
    }).join('')}
        </tbody></table>
        ${(sys.permissions || []).length ? `<h2>Permission rules</h2>
        <table><thead><tr><th>Mode</th><th>Rule</th><th class="opt">From</th></tr></thead><tbody>
          ${sys.permissions.map((p) => `<tr><td>${esc(p.mode)}</td><td class="mono">${esc(p.rule)}</td>
            <td class="dim opt">${esc(p.from)}</td></tr>`).join('')}
        </tbody></table>
        <p class="note">A call refused by one of these is counted on the Friction tab as <code>permission-rule</code>.</p>` : ''}
    </section>`;
}

function jobsTab(sys) {
    const rows = (sys && sys.jobs) || [];
    if (rows.length === 0) {
        return '<section class="tab" data-tab="jobs" hidden><p class="empty">No background jobs on this machine.</p></section>';
    }
    const running = rows.filter((j) => j.state === 'working');
    const tokens = rows.reduce((a, j) => a + (j.tokens || 0), 0);
    const scratch = rows.reduce((a, j) => a + (j.tmpBytes || 0), 0);

    return `<section class="tab" data-tab="jobs" hidden>
        <p class="note">Background agents keep their own state, their own transcript and a working directory that nothing cleans up. A job still holding a session is also the reason <code>/resume</code> on that session refuses to open it.</p>
        <div class="cards">
          ${card('Jobs', String(rows.length), `${running.length} still working`)}
          ${card('Tokens', tok(tokens), 'across every job')}
          ${card('Scratch on disk', bytes(scratch), 'in jobs/*/tmp')}
        </div>
        <table><thead><tr><th>Last change</th><th>Job</th><th>State</th><th class="opt">Project</th>
          <th class="opt2">Session</th><th class="num">Tokens</th><th class="num">On disk</th><th class="opt">Client</th></tr></thead><tbody>
        ${rows.map((j) => `<tr>
          <td class="nowrap">${esc(fmtDateTime(j.at))}</td>
          <td class="wrap" title="${esc(j.detail || j.id)}">${esc(j.name || j.id)}</td>
          <td><span class="kind j-${esc(j.state || 'unknown')}">${esc(j.state || '—')}</span></td>
          <td class="dim opt">${esc(j.cwd)}</td>
          <td class="mono opt2">${esc((j.sessionId || '').slice(0, 8) || '—')}</td>
          <td class="num">${j.tokens ? esc(tok(j.tokens)) : '·'}</td>
          <td class="num">${esc(bytes(j.bytes))}${j.tmpBytes > 50e6 ? ' <span class="idle">scratch</span>' : ''}</td>
          <td class="dim opt">${esc(j.cliVersion || '—')}</td></tr>`).join('')}
        </tbody></table>
    </section>`;
}

function liveTab(sys) {
    const l = (sys && sys.live) || { sessions: [], ide: [], daemon: { workers: [] } };
    const aliveSessions = l.sessions.filter((s) => s.alive);
    const stale = l.sessions.length - aliveSessions.length;

    return `<section class="tab" data-tab="live" hidden>
        <p class="note">Read at the moment the dashboard was opened: the session registry, the IDE windows attached to it, and the daemon's own workers. A registry entry whose process is gone is shown as stale rather than hidden — it is what a crashed session leaves.</p>
        <div class="cards">
          ${card('Live sessions', String(aliveSessions.length), stale ? `${plural(stale, 'stale entry', 'stale entries')}` : 'registry is clean')}
          ${card('Editors attached', String(l.ide.filter((i) => i.alive).length), plural(l.ide.length, 'lock file'))}
          ${card('Daemon workers', String(l.daemon.workers.filter((w) => w.alive).length), l.daemon.alive ? `supervisor ${l.daemon.supervisorPid}` : 'supervisor not running')}
        </div>
        <h2>Sessions</h2>
        ${l.sessions.length ? `<table><thead><tr><th class="opt2">Started</th><th>Session</th><th class="opt">Project</th>
          <th>Entrypoint</th><th>Status</th><th class="num opt2">PID</th><th class="opt">Client</th></tr></thead><tbody>
          ${l.sessions.map((s) => `<tr class="${s.alive ? '' : 'off'}">
            <td class="nowrap opt2">${esc(fmtDateTime(s.startedAt))}</td>
            <td class="wrap">${esc(s.name || s.id.slice(0, 8))}</td>
            <td class="dim opt">${esc(s.cwd)}</td>
            <td>${esc(s.entrypoint || '—')}</td>
            <td>${s.alive ? `<span class="ok">${esc(s.status || 'idle')}</span>` : '<span class="idle">stale</span>'}</td>
            <td class="num mono opt2">${s.pid}</td><td class="dim opt">${esc(s.version || '')}</td></tr>`).join('')}
        </tbody></table>` : '<p class="empty">No sessions in the registry.</p>'}
        <div class="two">
          <div><h2>Editors</h2>
            ${l.ide.length ? `<table><thead><tr><th>Editor</th><th class="num">PID</th><th>Folders</th></tr></thead><tbody>
              ${l.ide.map((i) => `<tr class="${i.alive ? '' : 'off'}"><td>${esc(i.name || '—')}</td>
                <td class="num mono">${i.pid}</td><td class="dim">${esc(i.folders.join(', '))}</td></tr>`).join('')}
            </tbody></table>` : '<p class="empty">No editor attached.</p>'}
          </div>
          <div><h2>Daemon workers</h2>
            ${l.daemon.workers.length ? `<table><thead><tr><th>Worker</th><th>Project</th><th class="num">PID</th></tr></thead><tbody>
              ${l.daemon.workers.map((w) => `<tr class="${w.alive ? '' : 'off'}"><td class="mono">${esc(w.short)}</td>
                <td class="dim">${esc(w.cwd)}</td><td class="num mono">${w.pid}</td></tr>`).join('')}
            </tbody></table>` : '<p class="empty">The daemon is not running.</p>'}
          </div>
        </div>
    </section>`;
}

function diskTab(sys) {
    const d = sys && sys.disk;
    if (!d) return '<section class="tab" data-tab="disk" hidden><p class="empty">Disk usage has not been measured yet — press Reindex.</p></section>';
    const kindLabel = { keep: 'keep', regenerable: 'regenerates', mixed: '' };
    return `<section class="tab" data-tab="disk" hidden>
        <p class="note">Everything under <code>~/.claude</code>. Nothing here is deleted by this extension and there is no button that would — the numbers are the point, the decision is yours.</p>
        <div class="cards">
          ${card('Total', bytes(d.total), '~/.claude')}
          ${d.hogs.length ? card('Leftovers', bytes(d.hogs.reduce((a, h) => a + h.bytes, 0)), `${plural(d.hogs.length, 'place')}, safe to remove`) : ''}
        </div>
        <h2>By directory</h2>
        ${barList(d.dirs.map((x) => [x.name, x]), {
        limit: 20, value: (x) => x.bytes,
        label: (v, x) => `${bytes(v)}${kindLabel[x.kind] ? ` · ${kindLabel[x.kind]}` : ''}`,
    })}
        ${d.hogs.length ? `<h2>Named leftovers</h2>
        <table><thead><tr><th>Path</th><th>What it is</th><th class="num">Size</th></tr></thead><tbody>
          ${d.hogs.map((h) => `<tr><td class="mono">${esc(h.path)}</td><td class="dim">${esc(h.note)}</td>
            <td class="num">${esc(bytes(h.bytes))}</td></tr>`).join('')}
        </tbody></table>
        <p class="note">A job's <code>tmp</code> is the working directory of a background agent that has since finished; a <code>temp_subdir_*</code> clone is what an interrupted marketplace update left behind.</p>` : ''}
    </section>`;
}

function contextTab(total, sys) {
    const c = (sys && sys.context) || { files: [], globalTokens: 0 };
    const msgs = sumOf(total.models, 'msgs');
    // Rough, and it says so: the instruction layer is re-sent with every
    // request, but almost always from cache — so this is what it would cost at
    // the input rate, not a second bill.
    const perRequest = c.globalTokens;
    const lifetime = (perRequest * msgs) / 1e6 * 5;

    return `<section class="tab" data-tab="context" hidden>
        <p class="note">Files that are loaded into the prompt of every session in scope. Sizes are exact; tokens are the size over four characters, which is close enough to compare paragraphs against each other.</p>
        <div class="cards">
          ${card('Global instructions', `~${tok(perRequest)}`, 'tokens in every request')}
          ${card('Across all requests', `~${fmtCost(lifetime)}`, `${plural(msgs, 'request')} at Opus input rates`)}
          ${card('Files', String(c.files.length), 'CLAUDE.md, rules, project memory')}
        </div>
        <h2>What is loaded</h2>
        ${barList(c.files.map((f) => [f.path, f]), {
        limit: 20, value: (f) => f.tokens,
        label: (v, f) => `~${tok(v)} · ${bytes(f.bytes)} · ${f.scope}`,
    })}
        <p class="note">Cached, this is read at a tenth of the input rate — the figure above is the uncached case, which is what a fresh session pays.</p>
    </section>`;
}

function tasksTab(sys) {
    const rows = (sys && sys.tasks) || [];
    const open = rows.filter((t) => t.open.length > 0);
    if (rows.length === 0) {
        return '<section class="tab" data-tab="tasks" hidden><p class="empty">No task lists recorded.</p></section>';
    }
    return `<section class="tab" data-tab="tasks" hidden>
        <p class="note">Todo lists left behind by sessions, newest first. An unfinished item here is work that was planned and never closed — the session may be long gone.</p>
        <div class="cards">
          ${card('Lists', String(rows.length), `${plural(open.length, 'list')} with something open`)}
          ${card('Open items', String(open.reduce((a, t) => a + t.open.length, 0)), 'across every session')}
        </div>
        <table><thead><tr><th class="nowrap">Last touched</th><th>Project</th><th class="opt">Session</th>
          <th class="num">Done</th><th>Still open</th></tr></thead><tbody>
        ${rows.map((t) => `<tr><td class="nowrap">${esc(fmtDateTime(t.at))}</td>
          <td>${esc(t.project || '—')}</td><td class="mono opt">${esc(t.session.slice(0, 8))}</td>
          <td class="num">${t.done}/${t.total}</td>
          <td>${t.open.length ? esc(t.open.join(' · ')) : '<span class="dim">nothing</span>'}</td></tr>`).join('')}
        </tbody></table>
    </section>`;
}

function changelogTab(sys) {
    const releases = (sys && sys.changelog) || [];
    const v = (sys && sys.versions) || {};
    return `<section class="tab" data-tab="changelog" hidden>
        <p class="note">The client's own changelog, which it already keeps in <code>~/.claude/cache</code>. Only releases newer than the one running are shown.</p>
        <div class="cards">
          ${card('Running', v.current || '—', v.waiting ? `${v.latest} is unpacked and waiting` : 'up to date')}
          ${card('Releases ahead', String(releases.length), releases.length ? 'not yet running' : 'nothing new')}
        </div>
        ${releases.length ? releases.map((r) => `<h2>${esc(r.version)}</h2>
          <ul class="log">${r.entries.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`).join('')
        : '<p class="empty">Nothing newer than the version already running.</p>'}
    </section>`;
}

function filesTab(total, sys) {
    const files = Object.entries(total.files || {});
    if (files.length === 0) {
        return '<section class="tab" data-tab="files" hidden><p class="empty">No edits recorded.</p></section>';
    }
    const edits = files.reduce((a, [, f]) => a + f.edits, 0);
    const added = files.reduce((a, [, f]) => a + f.added, 0);
    const removed = files.reduce((a, [, f]) => a + f.removed, 0);
    const byEdits = files.slice().sort((a, b) => b[1].edits - a[1].edits);
    const byChurn = files.slice().sort((a, b) => (b[1].added + b[1].removed) - (a[1].added + a[1].removed));
    const short = (p) => p.replace(/^\/Users\/[^/]+/, '~');

    const projects = (sys && sys.projects) || [];

    return `<section class="tab" data-tab="files" hidden>
        <p class="note">Every file an edit or a write touched, counted from the patch the tool returned. Line counts are the patch's own, so a rewritten file counts as its whole length.</p>
        <div class="cards">
          ${card('Files touched', String(files.length), plural(edits, 'edit'))}
          ${card('Lines added', tok(added), '')}
          ${card('Lines removed', tok(removed), '')}
        </div>
        <div class="two">
          <div><h2>Most often edited</h2>${barList(byEdits.map(([p, f]) => [short(p), f]), {
        limit: 15, value: (f) => f.edits, label: (v, f) => `${v} · +${tok(f.added)}/-${tok(f.removed)}`,
    })}</div>
          <div><h2>Most lines changed</h2>${barList(byChurn.map(([p, f]) => [short(p), f]), {
        limit: 15, value: (f) => f.added + f.removed, label: (v) => tok(v),
    })}</div>
        </div>
        ${projects.length ? `<h2>What the client itself records per project</h2>
        <p class="note">Read from <code>~/.claude.json</code>: the last session in each project, as the client measured it — including the frame rate of its own terminal UI.</p>
        <table><thead><tr><th>Project</th><th class="num">Last spend</th><th class="num">Duration</th>
          <th class="num">In API</th><th class="num">+/−</th><th class="num opt">Searches</th>
          <th class="num opt">FPS</th><th class="num opt2">Tools allowed</th><th class="opt2">Trusted</th></tr></thead><tbody>
        ${projects.map((p) => `<tr><td title="${esc(p.path)}">${esc(p.name)}</td>
          <td class="num">${esc(fmtCost(p.lastCost))}</td>
          <td class="num">${esc(fmtDur(p.lastDuration))}</td>
          <td class="num">${p.lastDuration > 0 && p.apiDuration > 0 ? pct(p.apiDuration, p.lastDuration) : '—'}</td>
          <td class="num">+${tok(p.added)}/−${tok(p.removed)}</td>
          <td class="num opt">${p.webSearches || '·'}</td>
          <td class="num opt">${p.fps ? p.fps.toFixed(0) : '·'}</td>
          <td class="num opt2">${p.allowedTools || '·'}</td>
          <td class="opt2">${p.trusted ? '<span class="ok">yes</span>' : '<span class="dim">no</span>'}</td></tr>`).join('')}
        </tbody></table>` : ''}
    </section>`;
}

// The thresholds the bar colours by, so a number that is orange in the corner of
// the editor is orange on the page too. Charts colours come from the theme, which
// means high-contrast and light themes get their own without a second palette.
const meterTone = (pct) => (pct >= 80 ? 'hot' : pct >= 50 ? 'warm' : 'cool');

/**
 * The week as a length of time rather than a percentage.
 *
 * A bar answers "how much is gone". The question underneath it is "how much is
 * gone *by now*", and that needs two marks a bar cannot carry: where the window
 * has got to, and where the forecast lands. Both live on one track here — the
 * fill is spend, the notch is this moment, the flag is the forecast, and a flag
 * past the right edge is the whole point of the reassuring case: you run out
 * after the window has already reset, which is to say you do not.
 */
function paceTrack(w) {
    if (!w) return '';
    const pct = Math.max(0, Math.min(100, w.pct));
    const now = Math.max(0, Math.min(1, w.now || 0)) * 100;
    const tone = meterTone(pct);
    const dry = w.dry;
    const inside = dry !== null && dry !== undefined && dry <= 1;
    const flagAt = inside ? Math.max(0, Math.min(100, dry * 100)) : null;

    // A label near the right edge would run off the rail, so it changes sides;
    // and two labels within a few percent of each other overprint, so the one
    // that only repeats the tick beneath it gives way to the forecast.
    const side = (at) => (at > 78 ? ' flip' : '');
    const crowded = flagAt !== null && Math.abs(flagAt - now) < 11;

    return `<div class="track">
        <div class="track-head"><b>this week</b><span>spend against the window it has to last</span></div>
        <div class="track-rail">
          <div class="track-fill t-${tone}" style="width:${pct}%"></div>
          <div class="track-edge t-${tone}" style="left:${pct}%"></div>
          <div class="track-now${side(now)}" style="left:${now.toFixed(2)}%">${crowded ? '' : '<span>now</span>'}</div>
          ${flagAt !== null ? `<div class="track-dry${side(flagAt)}" style="left:${flagAt.toFixed(2)}%"><span>dry</span></div>` : ''}
        </div>
        <div class="track-feet">
          <span>window opened</span>
          <span>${dry !== null && dry !== undefined && !inside
        ? `forecast lands past the reset · resets in ${esc(fmtLeft(w.resetIn, 0))}`
        : `resets in ${esc(fmtLeft(w.resetIn, 0))}`}</span>
        </div>
    </div>`;
}

/** One headline number with the meter that gives it a scale. */
function meterTile({ label, value, sub, pct, tone, wide }) {
    const width = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
    return `<div class="tile${wide ? ' tile-wide' : ''}">
        <span class="tile-label">${esc(label)}</span>
        <span class="tile-value">${esc(value)}</span>
        ${width !== null ? `<span class="tile-meter"><i class="t-${tone || meterTone(width)}" style="width:${width}%"></i></span>` : ''}
        <span class="tile-sub">${esc(sub || '')}</span>
    </div>`;
}

// A tone is meaning, not colour: status.js says what a note means and each
// renderer picks how to show it. The tooltip reaches for a codicon; here it is
// a word and a stripe down the side.
const TONE_LABEL = {
    alarm: 'forecast',
    safe: 'forecast',
    warn: 'stale',
    update: 'update',
    active: 'in progress',
};

function statusBlocks(blocks) {
    return blocks.map((block) => {
        if (block.kind === 'subtitle') return `<h3 class="now-sub">${esc(block.text)}</h3>`;
        if (block.kind === 'meters') {
            // A row of its own rather than a table cell: the meter needs the
            // width, and the label reads better above it than beside it.
            return `<div class="rows">${block.rows.map((r) => `<div class="row">
                <span class="row-label">${esc(r.label)}</span>
                <span class="row-meter"><i class="t-${meterTone(r.pct)}" style="width:${Math.max(0, Math.min(100, r.pct))}%"></i></span>
                <span class="row-value">${esc(r.value)}</span>
                <span class="row-note">${esc(r.note || '')}</span>
            </div>`).join('')}</div>`;
        }
        if (block.kind === 'note') {
            const label = block.label ? `<b>${esc(block.label)}</b> — ` : '';
            const tag = TONE_LABEL[block.tone] && !block.label
                ? `<span class="now-tag">${esc(TONE_LABEL[block.tone])}</span> ` : '';
            return `<p class="now-note tone-${esc(block.tone || 'plain')}">${tag}${label}${esc(block.text)}</p>`;
        }
        if (block.rows.length === 0) return '';
        const head = block.head
            ? `<thead><tr>${block.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : '';
        const body = block.rows.map((cells) => {
            const [label, ...rest] = cells;
            return `<tr><th scope="row">${esc(label)}</th>`
                + rest.map((v, i) => `<td class="${i === 0 ? 'now-value' : 'dim'}">${esc(v)}</td>`).join('')
                + '</tr>';
        }).join('');
        return `<table class="now-table">${head}<tbody>${body}</tbody></table>`;
    }).join('');
}

/**
 * Everything the status bar knows, on one page. The four panels are the four
 * tooltips — the same sections, from the same module — so this tab cannot fall
 * behind what the hover says, and a number hidden from a narrow bar is still
 * here in full.
 */
function nowTab(sections, workflows, metrics) {
    const rows = sections || [];
    const m = metrics || {};
    const active = (workflows || []).filter((r) => r.state === 'running' || r.active);

    if (rows.length === 0) {
        return `<section class="tab" data-tab="now">
            <p class="empty">Nothing to report yet — no Claude session is open in this window, and no limits have been read.</p>
        </section>`;
    }

    // The headline row answers the four questions in the order they get asked:
    // will the week hold, will this hour hold, will the context hold, what is it
    // costing. Each number carries its own meter rather than a shared axis —
    // they measure different things and share only a scale of 0 to 100%.
    const tiles = [];
    if (m.weekly) {
        tiles.push(meterTile({
            label: 'weekly window', value: `${m.weekly.pct}%`, pct: m.weekly.pct,
            sub: m.weekly.plan !== null ? `${m.weekly.plan}% of the week gone` : '',
        }));
    }
    if (m.session5h) {
        tiles.push(meterTile({
            label: '5-hour window', value: `${m.session5h.pct}%`, pct: m.session5h.pct,
            sub: `resets in ${fmtLeft(m.session5h.resetIn, 0)}`,
        }));
    }
    if (m.context) {
        tiles.push(meterTile({
            label: 'context', value: `${m.context.estimated ? '~' : ''}${m.context.pct}%`, pct: m.context.pct,
            sub: `${tok(m.context.tokens)} of ${tok(m.context.window)}`,
        }));
    }
    if (m.spend) {
        tiles.push(meterTile({
            label: 'this session', value: `~${fmtCost(m.spend.cost)}`,
            sub: m.spend.burn > 0 ? `~${fmtCost(m.spend.burn)} an hour` : '',
        }));
    }

    return `<section class="tab" data-tab="now">
        ${tiles.length ? `<div class="tiles">${tiles.join('')}</div>` : ''}
        ${paceTrack(m.weekly)}
        <div class="now-grid">
          ${rows.map((section) => `<section class="now-panel" data-panel="${esc(section.id)}">
            <h2 class="now-title">${esc(section.title)}</h2>
            ${statusBlocks(section.blocks)}
          </section>`).join('')}
        </div>
        ${active.length ? `<h2>Running right now</h2>
        <p class="note">One line per workflow still going. The full picture — phases, agents, what each was told and what it answered — is under Work → Agents &amp; workflows.</p>
        <table><thead><tr><th>Run</th><th>Project</th><th class="num">Agents</th><th class="num">Elapsed</th><th class="num">Spend</th></tr></thead><tbody>
        ${active.map((r) => `<tr><td class="wrap">${esc(r.name || r.runId)}</td>
          <td class="dim">${esc(r.project || '')}</td>
          <td class="num">${esc(String((r.totals && r.totals.done) ?? ''))}${r.agents ? `/${r.agents.length}` : ''}</td>
          <td class="num">${esc(r.elapsed || '')}</td>
          <td class="num">${esc(r.cost > 0 ? fmtCost(r.cost) : '')}</td></tr>`).join('')}
        </tbody></table>` : ''}
    </section>`;
}

/**
 * The extension's own settings, edited here rather than in settings.json. The
 * bar is a template, and a template is written by trying it — so each segment
 * carries a live preview rendered by the extension itself, from the same code
 * that draws the real thing.
 */
function settingsTab(config) {
    const cfg = config || {};
    const segments = (cfg.segments || []).length ? cfg.segments : (cfg.defaults || []);
    const palette = cfg.palette || [];
    const byTopic = {};
    for (const field of palette) (byTopic[field.topic] || (byTopic[field.topic] = [])).push(field);

    const row = (template, i) => `<li class="seg" data-index="${i}">
        <div class="seg-head">
          <span class="seg-num">${i + 1}</span>
          <input class="seg-input" type="text" value="${esc(template)}" spellcheck="false"
                 aria-label="Segment ${i + 1}">
          <button class="icon" data-act="up" title="Move left">↑</button>
          <button class="icon" data-act="down" title="Move right">↓</button>
          <button class="icon" data-act="drop" title="Remove">✕</button>
        </div>
        <div class="seg-preview" data-preview="${i}">…</div>
      </li>`;

    return `<section class="tab" data-tab="settings" hidden>
        <p class="note">These are the extension's own settings — the same keys as in <code>settings.json</code>, written straight from here. The status bar updates as soon as you save; nothing needs a reload.</p>

        <h2>Start from one of these</h2>
        <p class="note">Each is a whole bar, not a fragment: picking one fills the editor below, where you can change it before saving. Nothing is written until you press Save.</p>
        <div class="presets">
          ${(cfg.presets || []).map((p) => `<button class="preset" data-preset="${esc(p.id)}">
            <span class="preset-name">${esc(p.name)}</span>
            <span class="preset-about">${esc(p.about)}</span>
            <span class="preset-preview" data-preset-preview="${esc(p.id)}">${p.segments.map((t) => `<span class="chip-seg">${esc(t)}</span>`).join('')}</span>
          </button>`).join('')}
        </div>

        <h2>Status bar</h2>
        <p class="note">One line per status-bar item, left to right. Text outside <code>{…}</code> is yours; <code>[square brackets]</code> mark a group that disappears whole when a placeholder inside it has nothing to say. A segment with nothing to show hides itself.</p>
        <ol class="segs" id="segs">${segments.map(row).join('')}</ol>
        <div class="btns">
          <button class="btn" id="add">Add segment</button>
        </div>

        <h2>Placeholders</h2>
        <p class="note">Click one to insert it into the segment you last edited. The value beside each name is what it says on this machine right now.</p>
        <div class="palette">
          ${Object.entries(byTopic).map(([topic, list]) => `<div class="pal-group">
            <h3>${esc(topic)}</h3>
            ${list.map((f) => `<button class="chip-btn" data-insert="{${esc(f.name)}}" title="${esc(f.doc)}">
              <code>{${esc(f.name)}}</code><span class="pal-val">${f.value ? esc(f.value) : '—'}</span>
            </button>`).join('')}
          </div>`).join('')}
        </div>

        <h2>Behaviour</h2>
        <table class="kv form">
          <tbody>
            <tr><th scope="row"><label for="alignment">Side of the bar</label></th>
              <td><select id="alignment">
                <option value="right"${cfg.alignment === 'right' ? ' selected' : ''}>right</option>
                <option value="left"${cfg.alignment === 'left' ? ' selected' : ''}>left</option>
              </select></td>
              <td class="dim">where the items sit</td></tr>
            <tr><th scope="row"><label for="priority">Priority</label></th>
              <td><input id="priority" type="number" value="${Number(cfg.priority) || 100}"></td>
              <td class="dim">higher means further left</td></tr>
            <tr><th scope="row"><label for="refreshInterval">Refresh interval</label></th>
              <td><input id="refreshInterval" type="number" min="15" value="${Number(cfg.refreshInterval) || 60}"></td>
              <td class="dim">seconds between the expensive reads</td></tr>
            <tr><th scope="row"><label for="scope">Save to</label></th>
              <td><select id="scope">
                <option value="global">my settings</option>
                <option value="workspace">this workspace</option>
              </select></td>
              <td class="dim">workspace settings live in the repository's <code>.vscode/settings.json</code></td></tr>
          </tbody>
        </table>

        <div class="btns">
          <button class="btn primary" id="save">Save</button>
          <span class="saved" id="saved" hidden>Saved</span>
        </div>
    </section>`;
}

// --- page -------------------------------------------------------------------

const STYLE = `
:root { color-scheme: light dark; }
/* The page has to fit the panel it is dropped into, whatever width that is, and
   a horizontal scrollbar is a failure rather than a fallback: the panel is
   often half a window wide. Everything below follows from that — grid children
   that may shrink, cells that may wrap, and a handful of columns that drop out
   when there is genuinely no room. */
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
  background: var(--vscode-editor-background); margin: 0; padding: 16px 20px 40px;
  overflow-x: hidden; }
h1 { font-size: 18px; margin: 0 0 2px; font-weight: 600; }
h2 { font-size: 13px; margin: 22px 0 8px; font-weight: 600; opacity: .85; }
.sub { opacity: .6; margin: 0 0 16px; }
.note { opacity: .65; margin: 0 0 12px; max-width: 78ch; line-height: 1.5; }
.empty { opacity: .5; padding: 12px 0; }
nav { display: flex; gap: 2px; flex-wrap: wrap; }
nav button { background: none; border: none; color: inherit; padding: 7px 12px;
  cursor: pointer; font: inherit; opacity: .6; }
nav button:hover { opacity: 1; }
nav.sections { gap: 4px; margin-bottom: 2px; }
nav.sections button { font-size: 15px; font-weight: 600; padding: 4px 12px; border-radius: 5px; }
nav.sections button[aria-selected="true"] { opacity: 1; background: var(--vscode-editorWidget-background); }
nav.tabs { border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 18px; min-height: 30px; }
nav.tabs.empty { min-height: 0; margin-bottom: 14px; }
nav.tabs button { border-bottom: 2px solid transparent; }
nav.tabs button[aria-selected="true"] { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
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
.legend { display: flex; gap: 12px; flex-wrap: wrap; margin: 6px 0 14px; }
.chip { display: inline-flex; align-items: center; gap: 5px; opacity: .75; font-size: 11px; }
.chip i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
/* .dim inside an already-faded chip would multiply down to a third of the text
   colour, which is past legible for something that carries a date. */
.chip .dim { opacity: .7; }
/* min-width: 0 is the whole trick: a grid child defaults to min-content, so one
   wide table inside a column pushes the other column off the page instead of
   letting its own content wrap. */
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.two > * { min-width: 0; }
@media (max-width: 1100px) { .two { grid-template-columns: 1fr; gap: 4px; } }
.bars { width: 100%; border-collapse: collapse; }
.bars th, .bars td { border: none; padding: 3px 0; vertical-align: middle; }
.bars th { font: inherit; text-transform: none; letter-spacing: 0; opacity: .85;
  text-align: left; white-space: nowrap; padding-right: 14px; width: 1%;
  /* A long key — a file path — otherwise takes the whole row and squeezes the
     bar out of existence, which is the one thing the bar is there for. */
  max-width: 42ch; overflow: hidden; text-overflow: ellipsis; }
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
/* A path, a JSON setting or a hook command is one long unbreakable token as far
   as the browser is concerned; anywhere-wrapping is what keeps it inside its
   column instead of widening the table past the panel. */
th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--vscode-panel-border);
  overflow-wrap: anywhere; }
th { font-weight: 600; opacity: .6; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow-wrap: normal; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
.mono { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .75; }
.kind { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--vscode-editorWidget-background); opacity: .85; }
.k-workflow { color: hsl(265 60% 65%); } .k-agent { color: hsl(200 60% 60%); } .k-main { color: hsl(145 45% 55%); }
/* How an agent ended, in the five words outcomeOf answers with. A stopped agent
   takes the colour of an idle thing rather than of a failure: nothing crashed
   there, the run was cut from outside and the agent never got to finish. */
.o-done { color: hsl(145 45% 55%); }
.o-running { color: hsl(200 60% 60%); }
.o-failed { color: hsl(0 60% 62%); }
.o-stopped { color: hsl(35 72% 58%); }
.o-unknown { opacity: .55; }
/* The agents of a run, opened from the row above them. <details> rather than a
   handler in SCRIPT: this is the one part of the page that would otherwise need
   its own script, and a table of two thousand agents that stops opening when the
   script does is worse than one the browser opens by itself. */
tr.detail td { padding-top: 0; }
.agents > summary { cursor: pointer; opacity: .6; font-size: 11px; padding: 2px 0; }
.agent { margin-left: 14px; }
.agent > summary { cursor: pointer; padding: 2px 0; }
.prompt { margin: 4px 0 4px 16px; opacity: .8; max-width: 100ch; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.result { margin: 4px 0 10px 16px; padding: 6px 8px; border-radius: 4px; max-width: 100ch;
  background: var(--vscode-editorWidget-background); font-family: var(--vscode-editor-font-family);
  font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.cloud { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; max-width: 90ch; line-height: 1.7; }
.word { opacity: .8; }
.dim { opacity: .45; }
td.wrap { max-width: 34ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td.nowrap, th.nowrap { white-space: nowrap; overflow-wrap: normal; }
/* Columns that carry context rather than the answer. They are the first thing
   to go when the panel is narrow — the row still says what it is without them. */
@media (max-width: 1000px) {
  .opt { display: none; }
  body { padding: 12px 12px 32px; }
  th, td { padding: 5px 4px; }
  td.wrap { max-width: 24ch; }
}
@media (max-width: 900px) {
  .opt2 { display: none; }
  .cards { gap: 6px; }
  .card { min-width: 104px; padding: 8px 10px; }
  .card-value { font-size: 17px; }
}
/* Narrower than this the panel is a sidebar, not a page: what is left is the
   name of the thing and the number being asked about. */
@media (max-width: 720px) {
  .opt3 { display: none; }
  table { font-size: 12px; }
  td.wrap { max-width: 14ch; }
  .chart.heat { max-width: 100%; }
}
.matrix th[scope="row"] { white-space: nowrap; text-transform: none; letter-spacing: 0;
  font-size: inherit; opacity: .85; }
.matrix td { font-variant-numeric: tabular-nums; }
.heat-cell { border-radius: 2px; }
.grid { stroke: currentColor; opacity: .12; }
.plan { stroke: currentColor; opacity: .35; stroke-dasharray: 4 4; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
code { font-family: var(--vscode-editor-font-family); font-size: 11.5px; opacity: .85; }
.kv { width: 100%; }
.kv th[scope="row"] { text-transform: none; letter-spacing: 0; font-size: inherit;
  font-weight: 500; opacity: .75; white-space: nowrap; width: 1%; padding-right: 14px; }
.kv td { font-variant-numeric: tabular-nums; }
.kv td:last-child { text-align: right; white-space: nowrap; }
.ok { color: hsl(145 45% 55%); font-size: 11px; }
.idle { color: hsl(35 72% 58%); font-size: 11px; }
tr.off { opacity: .45; }
.j-working { color: hsl(145 45% 55%); }
.j-done { color: hsl(200 60% 60%); }
.j-stopped { color: hsl(35 72% 58%); }
ul.log { margin: 4px 0 14px; padding-left: 20px; line-height: 1.6; max-width: 90ch; }
ul.log li { margin: 2px 0; opacity: .85; }
.presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 8px; margin-bottom: 6px; max-width: 130ch; }
.preset { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; text-align: left;
  font: inherit; color: inherit; cursor: pointer; padding: 8px 10px; border-radius: 5px;
  background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
.preset:hover { border-color: var(--vscode-focusBorder); }
.preset-name { font-weight: 600; }
.preset-about { opacity: .6; font-size: 11.5px; line-height: 1.4; }
.preset-preview { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.chip-seg { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: .8;
  background: var(--vscode-list-hoverBackground); border-radius: 3px; padding: 1px 5px; }
/* The headline row. Numbers are set in the editor's own monospace at a size the
   rest of the page never uses, so the four answers read before any label does;
   labels drop to a small caps-like treatment and get out of the way. */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 1px; background: var(--vscode-panel-border); border: 1px solid var(--vscode-panel-border);
  border-radius: 6px; overflow: hidden; margin-bottom: 14px; }
.tile { display: flex; flex-direction: column; gap: 5px; padding: 12px 14px 13px;
  background: var(--vscode-editor-background); min-width: 0; }
.tile-label { font-size: 10px; text-transform: uppercase; letter-spacing: .09em; opacity: .5; }
.tile-value { font-family: var(--vscode-editor-font-family); font-size: 25px; line-height: 1.05;
  font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.tile-meter { display: block; height: 3px; border-radius: 2px; overflow: hidden;
  background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); }
.tile-meter i { display: block; height: 100%; border-radius: 2px; }
.tile-sub { font-size: 11px; opacity: .55; min-height: 14px; margin-top: auto; }

/* Spend, plan and forecast are three different jobs, so they get three roles
   from the theme's own chart ramp rather than three invented hues. */
.t-cool { background: var(--vscode-charts-blue, hsl(200 62% 55%)); }
.t-warm { background: var(--vscode-charts-yellow, hsl(35 72% 55%)); }
.t-hot { background: var(--vscode-charts-red, hsl(0 60% 57%)); }

/* The signature: the week as a length of time. Fill is what has been spent,
   the notch is this moment, the flag is where the forecast lands — and a
   forecast that lands past the right edge simply is not drawn, because the
   window resets before it arrives. */
.track { margin: 0 0 20px; max-width: 980px; }
.track-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.track-head b { font-size: 10px; text-transform: uppercase; letter-spacing: .09em;
  opacity: .5; font-weight: 600; }
.track-head span { font-size: 11px; opacity: .5; }
.track-rail { position: relative; height: 18px; border-radius: 4px;
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); overflow: hidden; }
/* The spend reads at its edge, not across its area: a recessive fill with a
   solid cap is a length you can measure, where a bright slab is just a mass.
   The cap is a sibling rather than a child because opacity composites the whole
   subtree: inside the fill it could never be brighter than the fill. */
.track-fill { position: absolute; inset: 0 auto 0 0; border-radius: 4px 0 0 4px; opacity: .3; }
.track-edge { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -2px; border-radius: 1px; }
.track-now, .track-dry { position: absolute; top: 0; bottom: 0; width: 0; }
.track-now::before, .track-dry::before { content: ''; position: absolute; top: 0; bottom: 0;
  width: 2px; margin-left: -1px; }
.track-now::before { background: var(--vscode-foreground); opacity: .8; }
.track-dry::before { background: var(--vscode-charts-red, hsl(0 60% 57%)); }
.track-now span, .track-dry span { position: absolute; top: 3px; left: 6px; font-size: 9.5px;
  text-transform: uppercase; letter-spacing: .08em; white-space: nowrap; opacity: .85; }
.track-now.flip span, .track-dry.flip span { left: auto; right: 6px; }
.track-feet { display: flex; justify-content: space-between; gap: 12px; margin-top: 5px;
  font-size: 11px; opacity: .5; }
.track-feet span:last-child { text-align: right; }

/* Columns rather than a grid: the four panels are of wildly different heights,
   and a grid leaves the short one's row half empty. Multicol packs them. */
.now-grid { columns: 3 300px; column-gap: 14px; margin-bottom: 8px; }
.now-panel { break-inside: avoid; margin: 0 0 14px; padding: 13px 15px 14px; border-radius: 6px;
  background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
.now-title { font-size: 13.5px; font-weight: 600; margin: 0 0 11px; opacity: .8; }
.now-sub { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; opacity: .45;
  margin: 14px 0 4px; font-weight: 600; padding-top: 9px;
  border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
/* label · meter · value · when — four columns that stay in their lanes, so a
   column of windows reads down as easily as across. */
.rows { display: flex; flex-direction: column; gap: 6px; }
.row { display: grid; grid-template-columns: 3.2rem 1fr auto; gap: 4px 9px; align-items: center; }
.row-label { font-size: 11.5px; opacity: .55; }
.row-meter { height: 4px; border-radius: 2px; overflow: hidden;
  background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
.row-meter i { display: block; height: 100%; border-radius: 2px; }
.row-value { font-family: var(--vscode-editor-font-family); font-size: 12.5px; font-weight: 600;
  font-variant-numeric: tabular-nums; }
.row-note { grid-column: 2 / -1; font-size: 11px; opacity: .45; }
.row-note:empty { display: none; }
.now-table { width: 100%; margin: 0; }
.now-table th, .now-table td { border: none; padding: 3px 0; }
.now-table th[scope="row"] { font: inherit; text-transform: none; letter-spacing: 0;
  opacity: .55; text-align: left; white-space: nowrap; padding-right: 14px; width: 1%; }
.now-table thead th { font-size: 10px; opacity: .4; padding-bottom: 3px; letter-spacing: .06em; }
.now-value { font-family: var(--vscode-editor-font-family); font-size: 12.5px;
  font-variant-numeric: tabular-nums; font-weight: 600; }
.now-note { margin: 11px 0 0; padding-left: 10px; line-height: 1.5; font-size: 12px;
  border-left: 2px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent); }
.now-note b { font-weight: 600; }
.now-note.tone-muted { border-left: none; padding-left: 0; opacity: .45; font-size: 11px;
  margin-top: 12px; }
.now-note.tone-alarm { border-left-color: var(--vscode-charts-red, hsl(0 60% 57%)); }
.now-note.tone-safe { border-left-color: var(--vscode-charts-green, hsl(145 45% 50%)); }
.now-note.tone-warn { border-left-color: var(--vscode-charts-yellow, hsl(35 72% 55%)); }
.now-note.tone-update { border-left-color: var(--vscode-charts-blue, hsl(200 62% 55%)); }
.now-note.tone-active { border-left-color: var(--vscode-charts-purple, hsl(265 60% 62%)); }
.now-tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .5; }
.segs { list-style: none; margin: 0 0 10px; padding: 0; max-width: 110ch; }
.seg { margin-bottom: 8px; }
.seg-head { display: flex; align-items: center; gap: 6px; }
.seg-num { opacity: .45; font-size: 11px; width: 14px; text-align: right; }
.seg-input { flex: 1; min-width: 0; font-family: var(--vscode-editor-font-family); font-size: 12px;
  padding: 5px 8px; border-radius: 4px; color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
.seg-input:focus { outline: 1px solid var(--vscode-focusBorder); }
.seg-preview { margin: 3px 0 0 20px; padding: 3px 8px; border-radius: 4px; font-size: 12px;
  background: var(--vscode-editorWidget-background); display: inline-block; min-height: 20px; }
.empty-preview { opacity: .45; font-style: italic; }
.icon { background: none; border: none; color: inherit; opacity: .5; cursor: pointer;
  font: inherit; padding: 2px 6px; border-radius: 3px; }
.icon:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
.btns { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; }
.btn { font: inherit; padding: 5px 12px; border-radius: 4px; cursor: pointer;
  color: var(--vscode-button-secondaryForeground, inherit);
  background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-panel-border); }
.btn:hover { background: var(--vscode-list-hoverBackground); }
.btn.primary { color: var(--vscode-button-foreground, #fff);
  background: var(--vscode-button-background, hsl(210 80% 45%)); border-color: transparent; }
.saved { color: hsl(145 45% 55%); font-size: 12px; }
.palette { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 4px 20px; margin-bottom: 8px; }
.pal-group h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  opacity: .55; margin: 8px 0 4px; font-weight: 600; }
.chip-btn { display: flex; width: 100%; align-items: baseline; gap: 8px; background: none;
  border: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
  padding: 2px 6px; border-radius: 3px; }
.chip-btn:hover { background: var(--vscode-list-hoverBackground); }
.pal-val { margin-left: auto; opacity: .5; font-size: 11px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 14ch; }
.form select, .form input { font: inherit; padding: 3px 6px; border-radius: 4px;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
.form input[type="number"] { width: 8ch; }
.form td:first-of-type { width: 1%; }
footer { margin-top: 28px; opacity: .5; font-size: 11px; }
`;

const SCRIPT = `
// acquireVsCodeApi may be called once per webview and throws on the second try,
// so the page takes one handle here and everything below shares it. It is
// declared first because the tab memory reads it on the very next lines — a
// const declared later is not hoisted, and reaching for it threw before the
// page had drawn anything.
const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
const sections = document.querySelectorAll('nav.sections button');
const tabs = document.querySelectorAll('nav.tabs button');
const panes = document.querySelectorAll('.tab');

// The page is rebuilt on a timer, and a rebuild is a fresh document: without
// this the view would snap back to the first tab and the top of the page every
// minute. getState survives the swap; the extension is told too, because it
// skips the redraw entirely while the settings editor is open.
const memory = api ? (api.getState() || {}) : {};

function remember(patch) {
  if (!api) return;
  Object.assign(memory, patch);
  api.setState(memory);
}

function openTab(btn) {
  tabs.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
  panes.forEach((p) => { p.hidden = p.dataset.tab !== btn.dataset.tab; });
  remember({ tab: btn.dataset.tab, section: btn.dataset.section });
  if (api) api.postMessage({ type: 'tab', id: btn.dataset.tab });
}

// Switching section shows that section's tabs and opens the first of them,
// rather than leaving the page on a pane whose tab is no longer visible.
function openSection(id) {
  sections.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.section === id)));
  const mine = [...tabs].filter((b) => b.dataset.section === id);
  // One tab under a section is not a choice, so the row that offers it is not
  // drawn — the section button above already said where you are.
  const lone = mine.length === 1;
  tabs.forEach((b) => { b.hidden = b.dataset.section !== id || lone; });
  document.querySelector('nav.tabs').classList.toggle('empty', lone);
  if (mine[0]) openTab(mine[0]);
}

sections.forEach((btn) => btn.addEventListener('click', () => openSection(btn.dataset.section)));
tabs.forEach((btn) => btn.addEventListener('click', () => openTab(btn)));

// Restore where the reader was before the last redraw. What to restore is read
// out first: opening a section opens its first tab, which writes over the very
// tab being restored — the page came back one tab to the left every minute.
const wanted = { section: memory.section, tab: memory.tab, scrollY: memory.scrollY };
if (wanted.section && [...sections].some((b) => b.dataset.section === wanted.section)) {
  openSection(wanted.section);
  const tab = [...tabs].find((b) => b.dataset.tab === wanted.tab);
  if (tab) openTab(tab);
}
// Twice, because the page is not tall enough to scroll into until it has been
// laid out: the first attempt lands on whatever height exists at that frame,
// the second — after load — on the finished page.
if (wanted.scrollY) {
  const restore = () => window.scrollTo(0, wanted.scrollY);
  requestAnimationFrame(restore);
  addEventListener('load', () => requestAnimationFrame(restore));
}
let scrollTimer = null;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => remember({ scrollY: window.scrollY }), 150);
});

// --- the settings editor ----------------------------------------------------
const list = document.getElementById('segs');

if (list && api) {
  // The preview is rendered by the extension, not here: the template grammar
  // lives in one module and a second implementation in the webview would drift
  // from it the first time either changed.
  let timer = null;
  const templates = () => [...list.querySelectorAll('.seg-input')].map((i) => i.value);
  const askPreview = () => {
    clearTimeout(timer);
    timer = setTimeout(() => api.postMessage({ type: 'preview', segments: templates() }), 120);
  };

  const renumber = () => {
    [...list.children].forEach((li, i) => {
      li.dataset.index = i;
      li.querySelector('.seg-num').textContent = i + 1;
      li.querySelector('.seg-preview').dataset.preview = i;
    });
    askPreview();
  };

  let lastFocused = list.querySelector('.seg-input');
  list.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('seg-input')) lastFocused = e.target;
  });
  list.addEventListener('input', (e) => {
    if (e.target.classList.contains('seg-input')) askPreview();
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const li = btn.closest('.seg');
    if (btn.dataset.act === 'drop') li.remove();
    if (btn.dataset.act === 'up' && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
    if (btn.dataset.act === 'down' && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
    renumber();
  });

  // Built node by node rather than from a string of HTML: nothing here is
  // interpolated today, and assembling it this way keeps it that way.
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  const addSegment = (value) => {
    const li = el('li', 'seg');
    const head = el('div', 'seg-head');
    head.appendChild(el('span', 'seg-num'));
    const input = el('input', 'seg-input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = value || '';
    head.appendChild(input);
    for (const [act, label, title] of [['up', '↑', 'Move left'], ['down', '↓', 'Move right'], ['drop', '✕', 'Remove']]) {
      const btn = el('button', 'icon', label);
      btn.dataset.act = act;
      btn.title = title;
      head.appendChild(btn);
    }
    li.appendChild(head);
    li.appendChild(el('div', 'seg-preview', '…'));
    list.appendChild(li);
    renumber();
    input.focus();
  };

  document.getElementById('add').addEventListener('click', () => addSegment(''));

  // A preset fills the editor and nothing more: the save is still the user's,
  // so trying one on costs nothing.
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => api.postMessage({ type: 'preset', id: btn.dataset.preset }));
  });
  // What each preset would say right now, rendered by the extension — the
  // template alone does not tell you whether a line has anything to show on
  // this machine today.
  api.postMessage({ type: 'presetPreviews' });

  // Inserting at the caret rather than appending: a placeholder usually belongs
  // between two pieces of text that are already written.
  document.querySelectorAll('[data-insert]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = lastFocused || list.querySelector('.seg-input');
      if (!input) { addSegment(btn.dataset.insert); return; }
      const at = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? at;
      input.value = input.value.slice(0, at) + btn.dataset.insert + input.value.slice(end);
      input.focus();
      input.selectionStart = input.selectionEnd = at + btn.dataset.insert.length;
      askPreview();
    });
  });

  document.getElementById('save').addEventListener('click', () => {
    api.postMessage({
      type: 'save',
      scope: document.getElementById('scope').value,
      settings: {
        segments: templates().filter((t) => t.trim().length > 0),
        alignment: document.getElementById('alignment').value,
        priority: Number(document.getElementById('priority').value) || 100,
        refreshInterval: Number(document.getElementById('refreshInterval').value) || 60,
      },
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'preview') {
      [...list.querySelectorAll('.seg-preview')].forEach((el, i) => {
        const out = msg.previews[i];
        el.textContent = out && out.text ? out.text : '(hidden — nothing to show)';
        el.classList.toggle('empty-preview', !(out && out.text));
      });
    }
    if (msg.type === 'defaults') {
      while (list.firstChild) list.removeChild(list.firstChild);
      for (const t of msg.segments) addSegment(t);
    }
    if (msg.type === 'presetPreviews') {
      for (const [id, texts] of Object.entries(msg.previews)) {
        const box = document.querySelector(\`[data-preset-preview="\${id}"]\`);
        if (!box) continue;
        while (box.firstChild) box.removeChild(box.firstChild);
        const shown = texts.filter((t) => t);
        if (shown.length === 0) {
          box.appendChild(el('span', 'chip-seg empty-preview', 'nothing to show right now'));
          continue;
        }
        for (const text of shown) box.appendChild(el('span', 'chip-seg', text));
      }
    }
    if (msg.type === 'saved') {
      const badge = document.getElementById('saved');
      badge.hidden = false;
      setTimeout(() => { badge.hidden = true; }, 2000);
    }
  });

  askPreview();
}
const refresh = document.getElementById('refresh');
if (refresh && api) {
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    refresh.textContent = 'Reindexing…';
    api.postMessage({ type: 'refresh' });
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

// Twelve tabs in one row is a list to search rather than a place to navigate.
// The sections group them by the question being asked — where did the money go,
// what did the work, what was it spent well on — and only one section's tabs are
// ever on screen.
const SECTIONS = [
    ['now', 'Now', [
        ['now', 'Now'],
    ]],
    ['spend', 'Spend', [
        ['overview', 'Overview'],
        ['sessions', 'Sessions'],
        ['projects', 'Projects'],
        ['branches', 'Branches'],
    ]],
    ['work', 'Work', [
        ['agents', 'Agents & workflows'],
        ['tools', 'Tools & MCP'],
        ['files', 'Files'],
        ['skills', 'Skills'],
        ['content', 'Content'],
    ]],
    ['efficiency', 'Efficiency', [
        ['models', 'Models & effort'],
        ['cache', 'Cache'],
        ['friction', 'Friction'],
        ['limits', 'Limits'],
    ]],
    ['setup', 'Setup', [
        ['settings', 'Settings'],
        ['health', 'Health'],
        ['jobs', 'Background jobs'],
        ['live', 'Live now'],
        ['tasks', 'Task lists'],
        ['disk', 'Disk'],
        ['context', 'Context budget'],
        ['changelog', 'Changelog'],
    ]],
];

function navHtml() {
    // The page opens on whichever section leads SECTIONS — naming one here is
    // how the tabs and the panes came to disagree about which was first.
    const lead = SECTIONS[0][0];
    // A section holding one tab needs no second row: the section button already
    // named the only thing under it, and a lone tab repeating that name reads as
    // a control that does nothing.
    const single = new Set(SECTIONS.filter(([, , items]) => items.length === 1).map(([id]) => id));
    const sections = SECTIONS.map(([id, label], i) =>
        `<button class="section" data-section="${id}" aria-selected="${i === 0}">${esc(label)}</button>`).join('');
    const tabs = SECTIONS.flatMap(([sid, , items]) => items.map(([id, label], j) =>
        `<button role="tab" data-tab="${id}" data-section="${sid}" aria-selected="${sid === lead && j === 0}"`
        + `${sid === lead && !single.has(sid) ? '' : ' hidden'}>${esc(label)}</button>`)).join('');
    return `<nav class="sections">${sections}</nav><nav class="tabs${single.has(lead) ? ' empty' : ''}" role="tablist">${tabs}</nav>`;
}

function render(index, total, meta) {
    const modelOrder = Object.entries(total.models)
        .sort((a, b) => b[1].cost - a[1].cost).map(([m]) => m);
    const dayModels = dayModelMatrix(index);

    const projects = Object.entries(total.projects).sort((a, b) => b[1].cost - a[1].cost);
    const branches = Object.entries(total.branches).sort((a, b) => b[1].cost - a[1].cost);
    const skills = Object.entries(total.skills).sort((a, b) => b[1].cost - a[1].cost);

    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Claude usage</title><style>${STYLE}</style></head><body>
<h1>Claude usage</h1>
<p class="sub">${plural(meta.files, 'transcript')} indexed${meta.lastRun ? ` · updated ${esc(fmtDateTime(meta.lastRun))}` : ''}
 · <button id="refresh" class="link">Reindex</button></p>
${navHtml()}
${nowTab(meta.now, meta.workflows, meta.metrics)}
${overviewTab(total, dayModels, modelOrder)}
${sessionsTab(total)}
${breakdownTab('projects', 'Spend by project', projects, 'Grouped by the repository a session ran in.')}
${breakdownTab('branches', 'Spend by git branch', branches, 'The branch recorded on each request, so long-lived branches accumulate across sessions.')}
${agentsTab(total, meta.workflows || [])}
${toolsTab(total)}
${filesTab(total, meta.system)}
${breakdownTab('skills', 'Spend by skill', skills, 'Requests made while a skill was driving, attributed by the attributionSkill field the transcript records.')}
${contentTab(total, meta.system)}
${modelsTab(total)}
${cacheTab(total)}
${frictionTab(total)}
${limitsTab(meta.history)}
${settingsTab(meta.config)}
${healthTab(total, meta.system)}
${jobsTab(meta.system)}
${liveTab(meta.system)}
${tasksTab(meta.system)}
${diskTab(meta.system)}
${contextTab(total, meta.system)}
${changelogTab(meta.system)}
<footer>All spend figures are estimates from public per-million-token rates, not a bill.</footer>
<script>${SCRIPT}</script></body></html>`;
}

module.exports = {
    render, stackedDays, heatmap, barList, hourChart, dayModelMatrix,
    lineChart, stackedTokens, matrixTable, quantiles, effortMatrix, mcpServer,
    sessionLabel, navHtml, SECTIONS, CACHE_PARTS,
    agentsTab, healthTab, jobsTab, liveTab, diskTab, contextTab, tasksTab, changelogTab, filesTab, settingsTab,
    limitsTab, weekLabel, nowTab, paceTrack, meterTile, meterTone,
    shortModel, tok, bytes, plural, fmtDur, esc,
    // The stylesheet, for the one test that holds this page's `.o-*` rules
    // against the two outcome tables the tree and the hover keep: a word the
    // vocabulary gains and the CSS does not draws as unstyled text here, and
    // nothing else would notice.
    STYLE,
};
