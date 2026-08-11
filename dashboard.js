// The dashboard webview: tabs, tables and hand-rolled SVG charts.
//
// Everything is drawn from the index, which already holds aggregates — the
// webview never touches a transcript, so opening a tab costs nothing. Charts are
// SVG built as strings: a charting library would be the only dependency in the
// project and would buy nothing that a bar and a heatmap need.
//
// Colours come from VS Code theme variables, so the page follows light, dark and
// high-contrast themes without a palette of its own.

const { fmtCost, ratesFor } = require('./pricing');
const ix = require('./indexer');
const hist = require('./history');
const wfm = require('./workflows');
const { renderValue } = require('./clientSettings');

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
// A model's colour follows the model, not its place in whatever list is being
// drawn. Two panels on one tab sort their rows differently — the stacked chart
// by the canonical order, the list beside it by cost — and keying on the index
// meant a hue agreed between them only by coincidence of ordering.
const modelHues = new Map();

/** Fix the hue of every model once, in the page's one canonical order. */
function assignModelColors(order) {
    modelHues.clear();
    (order || []).forEach((model, i) => modelHues.set(model, i));
}

function modelColor(model, i) {
    const slot = modelHues.has(model) ? modelHues.get(model) : i;
    const [h, s, l] = MODEL_COLORS[slot % MODEL_COLORS.length];
    return `hsl(${h} ${s}% ${l}%)`;
}

// --- charts -----------------------------------------------------------------

/**
 * A y-axis for a column chart: four gridlines and their values, drawn the way
 * lineChart already draws its own. Without it a column chart has no scale at
 * all — a tall bar next to a short one says which is bigger and nothing about
 * how much, and the single "max" label these charts carried was one number
 * floating above a plot with no line to attach it to.
 */
const AXIS_W = 52;

/**
 * Round tick values, chosen the way every chart library chooses them: pick a
 * step from the 1 / 2 / 2.5 / 5 family closest to max/target, then run it up to
 * the first multiple that clears the data. Quartering the maximum instead put
 * $1593.67 and $2390.51 on the axis — arithmetic about one column rather than a
 * scale anyone can hold in their head — and rounding only the top left the four
 * values between it just as ragged.
 */
function niceTicks(max, target = 4) {
    if (!(max > 0)) return { ticks: [], ceiling: 0 };
    const raw = max / target;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const rel = raw / mag;
    const step = [1, 2, 2.5, 5, 10]
        .reduce((best, n) => (Math.abs(n - rel) < Math.abs(best - rel) ? n : best), 1) * mag;
    const ceiling = step * Math.ceil(max / step);
    const ticks = [];
    for (let v = 0; v <= ceiling + step / 2; v += step) ticks.push(v);
    return { ticks, ceiling };
}

/**
 * A y-axis for a column chart: four gridlines and their values, drawn the way
 * lineChart already draws its own. Without it a column chart has no scale at
 * all — a tall bar beside a short one says which is bigger and nothing about
 * how much, and the single "max" label these charts used to carry was a number
 * floating over a plot with nothing to attach it to.
 *
 * Returns the rounded top as well, because the bars have to be scaled against
 * the same number the axis is labelled with.
 */
function yAxis(max, fmt, { top, base, right }) {
    const { ticks, ceiling } = niceTicks(max);
    if (!(ceiling > 0)) return { svg: '', ceiling: 0 };
    let svg = '';
    for (const v of ticks) {
        const y = base - (v / ceiling) * (base - top);
        svg += `<line class="grid" x1="${AXIS_W}" y1="${y.toFixed(1)}" x2="${right}" y2="${y.toFixed(1)}"/>`
            + `<text class="tick" x="${AXIS_W - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`;
    }
    return { svg, ceiling };
}

/** Stacked daily spend, one segment per model. */
function stackedDays(days, modelOrder, dayModels, { width = 860, height = 190 } = {}) {
    const keys = Object.keys(days).sort();
    if (keys.length === 0) return '<p class="empty">No activity recorded yet.</p>';

    const max = Math.max(...keys.map((k) => days[k].cost));
    const plot = width - AXIS_W;
    const barW = Math.max(2, Math.min(26, Math.floor(plot / keys.length) - 2));
    const step = barW + 2;
    const w = AXIS_W + Math.max(plot, keys.length * step);
    // One axis, built once at the width it is drawn at: the earlier pair built
    // it twice, and the first one's grid lines — right: 0, so zero length — were
    // thrown away for the sake of reading `ceiling` off it.
    const axis = yAxis(max, (v) => fmtCost(v), { top: 8, base: height - 18, right: w });
    const scale = (v) => (axis.ceiling > 0 ? (v / axis.ceiling) * (height - 26) : 0);

    let bars = '';
    keys.forEach((key, i) => {
        const x = AXIS_W + i * step;
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
        + axis.svg
        + `${bars}</svg>`;
}

/** GitHub-style calendar: one cell per day, columns are weeks. */
/**
 * `now` exists for the tests. The grid ends at today and skips anything past it,
 * so a caller that computes "today" from its own clock and a heatmap that reads
 * the clock again can disagree — across midnight, by a whole day. Injecting the
 * moment is the only way to assert "today has a cell" without a race.
 */
function heatmap(days, { weeks = 27, cell = 12, now = Date.now() } = {}) {
    const keys = Object.keys(days);
    if (keys.length === 0) return '<p class="empty">No activity recorded yet.</p>';

    const max = Math.max(...keys.map((k) => days[k].cost));
    const today = new Date(now);
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
    // Five levels and what the darkest one is worth: without it the shading is
    // a texture, and "darker for a heavier day" is a claim with no unit.
    const legendY = 7 * (cell + 2) + 26;
    let legend = `<text class="tick" x="0" y="${legendY + 9}">less</text>`;
    for (let l = 0; l <= 4; l++) {
        legend += `<rect class="hm key l${l}" x="${30 + l * (cell + 2)}" y="${legendY}" width="${cell}" height="${cell}" rx="2"/>`;
    }
    legend += `<text class="tick" x="${30 + 5 * (cell + 2) + 4}" y="${legendY + 9}">more · up to ${esc(fmtCost(max))} a day</text>`;

    return `<svg class="chart heat" viewBox="0 0 ${w} ${legendY + cell + 4}" role="img">${months}${cells}${legend}</svg>`;
}

/**
 * A keyed breakdown — models, projects, branches, skills — as a borderless
 * table. A table rather than free-floating rows because the columns then line
 * up on their own: the name column sizes to the longest name, and the numbers
 * share one right edge instead of drifting with the bar next to them.
 */
/**
 * A ranked list of one measure. One hue for all of it: the bars already say
 * which row is bigger, and a hue per row would claim seven categories where
 * there is one. `byModel` is the exception — there the colour is the model's
 * identity, carried over from the chart above the list.
 */
function barList(entries, { value = (b) => b.cost, label = fmtCost, limit = 12, byModel = false, scaleMax = 0 } = {}) {
    const rows = entries.slice(0, limit);
    if (rows.length === 0) return '<p class="empty">Nothing here yet.</p>';
    // `scaleMax` is for a series that already has a scale of its own. A window
    // at 1% is 1% of a hundred, not 100% of the only row on screen — which is
    // what the biggest-row default drew, and it read as a full bar.
    const max = scaleMax || Math.max(...rows.map(([, b]) => value(b)));
    return `<table class="bars">${rows.map(([key, b], i) => {
        const v = value(b);
        const w = max > 0 ? (v / max) * 100 : 0;
        const fill = byModel ? `background:${modelColor(key, i)}` : '';
        return `<tr><th scope="row" title="${esc(key)}"><span>${esc(key)}</span></th>`
            + `<td class="bar-cell"><span class="bar-track">`
            + `<span class="bar-fill" style="width:${w.toFixed(1)}%${fill ? `;${fill}` : ''}"></span>`
            + `</span></td>`
            + `<td class="bar-val">${esc(label(v, b))}</td></tr>`;
    }).join('')}</table>`;
}

/**
 * Activity by hour of day — 24 columns, and the only chart here that used to
 * carry no figure whatsoever: a row of bars whose height meant nothing you
 * could name without hovering each one.
 */
function hourChart(hours, { width = 420, height = 132 } = {}) {
    const values = Array.from({ length: 24 }, (_, h) => (hours[String(h)] ? hours[String(h)].cost : 0));
    const max = Math.max(...values, 0);
    if (max <= 0) return '<p class="empty">Nothing here yet.</p>';

    const base = height - 18;
    const top = 8;
    const plot = width - AXIS_W;
    const step = plot / 24;
    const barW = Math.max(3, step - 3);

    const axis = yAxis(max, (v) => fmtCost(v), { top, base, right: width });
    const cols = values.map((v, h) => {
        const barH = (v / axis.ceiling) * (base - top);
        const x = AXIS_W + h * step + (step - barW) / 2;
        return `<rect class="hour-bar" x="${x.toFixed(1)}" y="${(base - barH).toFixed(1)}" `
            + `width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="2">`
            + `<title>${h}:00 · ${esc(fmtCost(v))}</title></rect>`
            + (h % 6 === 0
                ? `<text class="tick" x="${(AXIS_W + h * step + step / 2).toFixed(1)}" y="${height - 4}" text-anchor="middle">${h}</text>`
                : '');
    }).join('');

    return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">${axis.svg}${cols}</svg>`;
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
    const plot = width - AXIS_W;
    const barW = Math.max(2, Math.min(26, Math.floor(plot / keys.length) - 2));
    const step = barW + 2;
    const w = AXIS_W + Math.max(plot, keys.length * step);
    const axis = yAxis(max, (v) => tok(Math.round(v)), { top: 8, base: height - 18, right: w });
    const scale = (v) => (axis.ceiling > 0 ? (v / axis.ceiling) * (height - 26) : 0);

    let bars = '';
    keys.forEach((key, i) => {
        const x = AXIS_W + i * step;
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
        + axis.svg
        + `${bars}</svg>`;
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

// The version of the extension that drew the page, read from the manifest the
// .vsix was built from — the same file VS Code reads, so the two cannot
// disagree about which build is running.
const VERSION = (() => {
    try { return require('./package.json').version || ''; } catch { return ''; }
})();

// The extension's icon, redrawn as inline SVG for the page header. It is a copy
// of media/icon.svg rather than a read of it: the file ships in the .vsix but a
// webview cannot reach it without asWebviewUri and an img-src exception, and the
// two are four rectangles and two circles apart. The gradient id is prefixed
// because this markup lands in a document that draws its own gradients.
const MARK = `<svg width="26" height="26" viewBox="0 0 128 128" aria-hidden="true">
  <defs><linearGradient id="mark-g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#2DD4BF"/><stop offset="1" stop-color="#4F46E5"/>
  </linearGradient></defs>
  <rect width="128" height="128" rx="28" fill="url(#mark-g)"/>
  <circle cx="64" cy="64" r="42" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="11"/>
  <circle cx="64" cy="64" r="42" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round"
          stroke-dasharray="158 264" transform="rotate(-90 64 64)"/>
  <rect x="47" y="66" width="10" height="19" rx="4" fill="#fff"/>
  <rect x="59" y="53" width="10" height="32" rx="4" fill="#fff"/>
  <rect x="71" y="43" width="10" height="42" rx="4" fill="#fff"/>
</svg>`;

// --- tabs -------------------------------------------------------------------

/**
 * One headline number, with the meter that gives it a scale where it has one.
 * `pct` is optional: a spend or a count is not a share of anything and gets no
 * meter, and its sub line still lands on the same baseline as its neighbours'.
 */
const tile = (label, value, sub, pct, tone) => {
    const width = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
    return `<div class="tile"><span class="tile-label">${esc(label)}</span>`
        + `<span class="tile-value">${esc(value)}</span>`
        + (width === null ? ''
            : `<span class="tile-meter"><i class="t-${tone || meterTone(width)}" style="width:${width}%"></i></span>`)
        + `<span class="tile-sub">${esc(sub || '')}</span></div>`;
};

/**
 * A setting, switched where it stands. The same control appears in the Settings
 * tab and beside the panel it governs — one component, so a toggle cannot say
 * one thing in one place and another somewhere else, and turning something on
 * never means walking to another tab to do it.
 *
 * It writes immediately and alone: the segment editor saves a form on a button
 * because half-typed text needs a commit point, and a switch does not.
 */
const toggle = (key, label, on, note = '') => `<label class="switch">
    <input type="checkbox" data-set="${esc(key)}"${on ? ' checked' : ''}>
    <span class="switch-box" aria-hidden="true"></span>
    <span class="switch-text"><b>${esc(label)}</b>${note ? `<span class="dim">${note}</span>` : ''}</span>
</label>`;

/** The same, for a setting that is a number rather than a state. */
const numberField = (key, label, value, note = '', min = 0) => `<label class="switch numeric">
    <input type="number" class="num-set" data-set="${esc(key)}" value="${esc(String(value ?? ''))}" min="${min}">
    <span class="switch-text"><b>${esc(label)}</b>${note ? `<span class="dim">${note}</span>` : ''}</span>
</label>`;

/** A row of them. Wrapping is the grid's business, not the caller's. */
const tiles = (...items) => `<div class="tiles">${items.filter(Boolean).join('')}</div>`;

/**
 * A block of the page: a heading, the sentence that explains it, and the thing
 * itself. Every answer on every tab is one of these, so a tab reads as a set of
 * answers rather than a scroll of headings.
 *
 * `title` is text and is escaped here. **`note` and `body` are markup** — they
 * carry `<code>`, links and values the caller has already run through `esc()`,
 * so escaping them again would print the tags.
 *
 * `flush` is for a block whose body is a wide table: the panel keeps its
 * heading and its border and the table runs edge to edge inside it, rather than
 * losing a column's worth of width to padding on both sides.
 */
const panel = (title, body, { note, flush, id } = {}) => `<section class="panel${flush ? ' panel-flush' : ''}"${id ? ` data-panel="${esc(id)}"` : ''}>
    ${title ? `<h2 class="panel-title">${esc(title)}</h2>` : ''}
    ${note ? `<div class="panel-note">${note}</div>` : ''}
    <div class="panel-body">${body}</div>
</section>`;

/**
 * A number in a table that is also a share of the column's largest. The bar is
 * a background, not a column of its own: it costs no width, and a row can be
 * ranked at a glance without reading a single figure.
 */
const shareCell = (text, share, cls = 'num') => {
    const w = Number.isFinite(share) ? Math.max(0, Math.min(100, share * 100)) : 0;
    return `<td class="${cls} share"><i style="width:${w.toFixed(1)}%"></i>${esc(text)}</td>`;
};

const sumOf = (map, field) => Object.values(map).reduce((a, b) => a + (b[field] || 0), 0);

function statCards(total, cfg = {}) {
    const days = Object.keys(total.days).sort();
    const todayKey = days[days.length - 1];
    const spend = Object.values(total.days).reduce((a, b) => a + b.cost, 0);
    const last7 = days.slice(-7).reduce((a, k) => a + total.days[k].cost, 0);
    const last30 = days.slice(-30).reduce((a, k) => a + total.days[k].cost, 0);
    const msgs = sumOf(total.models, 'msgs');
    const cacheRead = sumOf(total.models, 'cacheRead');
    const allIn = Object.values(total.models).reduce((a, b) => a + b.in + b.cacheRead + b.cacheWrite, 0);

    // Only the cache share is a share; a spend and a count are not fractions of
    // anything, and a meter under them would be an invented denominator.
    const month = ix.monthToDate(total);
    const budget = Number(cfg.monthlyBudget) || 0;
    const share = budget > 0 ? Math.round((month.spent / budget) * 100) : null;
    return tiles(
        tile('All time', fmtCost(spend), `${days.length} active days`),
        // The month is the unit a ceiling is set in, and the projection is what
        // the ceiling is for: knowing on the 11th is worth more than knowing on
        // the 31st.
        tile('This month', fmtCost(month.spent),
            budget > 0
                ? `${share}% of ${fmtCost(budget)} · ~${fmtCost(month.projected)} by day ${month.days}`
                : `day ${month.elapsed} of ${month.days} · ~${fmtCost(month.projected)} at this pace`,
            share, share !== null && share >= 100 ? 'hot' : undefined),
        tile('Last 30 days', fmtCost(last30), ''),
        tile('Last 7 days', fmtCost(last7), ''),
        tile('Latest day', todayKey ? fmtCost(total.days[todayKey].cost) : '$0', todayKey || ''),
        tile('Requests', String(msgs), plural(total.sessions.length, 'session')),
        tile('Served from cache', pct(cacheRead, allIn), `${tok(allIn)} input tokens`,
            allIn > 0 ? Math.round((cacheRead / allIn) * 100) : null, 'cool'),
    );
}

function overviewTab(total, dayModels, modelOrder, cfg = {}) {
    const legend = `<div class="legend">${modelOrder.slice(0, 7).map((m, i) =>
        `<span class="chip"><i style="background:${modelColor(m, i)}"></i>${esc(shortModel(m))}</span>`).join('')}</div>`;
    return `<section class="tab" data-tab="overview" hidden>
        ${statCards(total, cfg)}
        ${panel('Daily spend by model', stackedDays(total.days, modelOrder, dayModels) + legend)}
        ${panel('Calendar', heatmap(total.days), {
        note: 'One cell per day, darker for a heavier day. Weeks run down, so the same weekday sits on one row.',
    })}
        ${panel('Models', barList(
        Object.entries(total.models).sort((a, b) => b[1].cost - a[1].cost),
        { byModel: true, label: (v, b) => `${fmtCost(v)} · ${tok(b.in + b.cacheRead + b.cacheWrite + b.out)}` },
    ))}
        ${panel('Hour of day', hourChart(total.hours, { width: 900, height: 180 }), {
        note: 'Every request ever made, by the hour it was made in. Full width because twenty-four columns in half a panel are a texture rather than a chart.',
    })}
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
    const shown = total.sessions.slice(0, 300);
    // The bar behind a spend is that row against the biggest row on screen, not
    // against the whole index: the point is to rank what is in front of you.
    const dearest = shown.reduce((a, s) => Math.max(a, s.cost), 0);
    const rows = shown.map((s) => `<tr>
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
        ${shareCell(fmtCost(s.cost), dearest > 0 ? s.cost / dearest : 0)}</tr>`).join('');
    const table = `<table><thead><tr><th>Last activity</th><th>Project</th><th>Session</th><th class="opt3">Kind</th><th class="opt">Client</th>
        <th class="opt3">Models</th><th class="opt">Effort</th>
        <th class="num opt2">Duration</th><th class="num">Requests</th><th class="num opt2">Tokens</th><th class="num">Spend</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    return `<section class="tab" data-tab="sessions" hidden>
        ${panel('Every transcript', table, {
        flush: true,
        note: `Newest first, capped at 300 rows of ${total.sessions.length}. A row is one transcript: a main session, a subagent, or one agent of a workflow. The name is the session's own title where it has one, and the rule under a spend is that row against the dearest one shown.`,
    })}
    </section>`;
}

function breakdownTab(name, title, entries, note) {
    return `<section class="tab" data-tab="${name}" hidden>
        ${panel(title, barList(entries, { limit: 24, label: (v, b) => `${fmtCost(v)} · ${b.msgs} req` }),
        { note: note ? esc(note) : '' })}
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

/**
 * The runs table, drawn once for both places that show runs: Work, where it is
 * every run on the machine, and Now, where it is the handful still going. The
 * two were separate renderings for about an hour and the Now one was the poorer
 * of the two — no money, no duration, and no way to open an agent and read what
 * it was told.
 */
function runsTableOf(table) {
    return `<table><thead><tr><th>Last activity</th><th class="opt">Project</th><th>Workflow</th>
          <th>Status</th><th class="opt2">Phases</th><th class="num">Agents</th>
          <th class="num opt2">Duration</th><th class="num">Spend</th></tr></thead>
          <tbody>${table.rows}</tbody></table>
        ${table.carded < table.shown ? `<p class="note">Agents are drawn only for the ${table.carded} newest runs of the ${table.shown} above. A fan-out of hundreds carries every prompt and every result into the page, so the rest keep their row without them — the tree in the sidebar draws the agents of every run it lists, and it lists the ${wfm.TREE_FINISHED} newest finished runs beside everything still going or abandoned.</p>` : ''}`;
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

    const spreadTable = `<table class="matrix"><thead><tr><th></th><th class="num">agents</th><th class="num">median</th>
          <th class="num">p90</th><th class="num">max</th></tr></thead><tbody>
          ${spread.map(([label, q]) => `<tr><th scope="row">${esc(label)}</th><td class="num">${q.n}</td>
            <td class="num">${esc(tok(q.p50))}</td><td class="num">${esc(tok(q.p90))}</td>
            <td class="num">${esc(tok(q.max))}</td></tr>`).join('')}
        </tbody></table>
        <p class="note">Multiply the median by the fleet size for the usual case, and the p90 for the bad one.</p>`;

    const runsTable = runsTableOf(table);

    // A share of the total, so the three kinds of transcript rank against each
    // other rather than only against their own figure.
    const share = (rows) => (totalCost > 0 ? Math.round((sum(rows) / totalCost) * 100) : null);

    return `<section class="tab" data-tab="agents" hidden>
        ${tiles(
        tile('Main sessions', fmtCost(sum(main)), `${plural(main.length, 'transcript')} · ${pct(sum(main), totalCost)}`, share(main), 'cool'),
        tile('Subagents', fmtCost(sum(agents)), `${plural(agents.length, 'transcript')} · ${pct(sum(agents), totalCost)}`, share(agents), 'cool'),
        tile('Workflow agents', fmtCost(sum(wf)), `${plural(wf.length, 'transcript')} · ${pct(sum(wf), totalCost)}`, share(wf), 'cool'),
        perRun ? tile('Agents per workflow', String(perRun.p50), `p90 ${perRun.p90} · max ${perRun.max}`) : '',
    )}
        ${spread.length ? panel('Output tokens one agent writes', spreadTable, {
        note: 'Subagents and workflows write their own transcripts, so this spend is invisible in the terminal statusline — it belongs to no single session there.',
    }) : ''}
        ${panel('Workflow runs', runs.length ? runsTable : '<p class="empty">No workflow runs recorded.</p>', {
        flush: runs.length > 0,
        note: runs.length ? `Newest first, capped at ${RUN_LIMIT} rows of ${runs.length}. Each run as its own snapshot describes it — the name, how it ended, the phases it was written in. A run still going has written no snapshot yet, so its row is assembled from the journal instead and says what it is doing rather than how it ended. Open one to see its agents: what each was told, what it answered and what it cost. A run's price is the sum over the agents its snapshot lists; money spent in the same directory by transcripts no snapshot names is added beside that figure rather than folded into it.` : '',
    })}
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

    const cloud = `<div class="cloud">${words.map(([w, n]) => {
        const size = 0.8 + (n / maxWord) * 1.1;
        return `<span class="word" style="font-size:${size.toFixed(2)}rem" title="${n}">${esc(w)}</span>`;
    }).join('')}</div>`;

    return `<section class="tab" data-tab="content" hidden>
        ${tiles(
        tile('Prompts', String(p.count), `across ${plural(total.sessions.length, 'transcript')}`),
        tile('Longest', tok(p.longest), 'characters'),
    )}
        <div class="pair">
          ${panel('Prompt length', barList(lens, { limit: 8, label: (v) => `${v}` }), {
        note: 'Computed locally from your own prompts. Only counts and word tallies are stored — never prompt text — and nothing leaves this machine.',
    })}
          ${panel('Where they came from', barList(sources, { limit: 8, label: (v) => `${v}` }))}
        </div>
        ${log ? `${tiles(
        tile('Logged prompts', String(log.count), `${log.pasted} carried a paste`),
        tile('Active days', String(Object.keys(log.byDay).length), log.first ? `since ${fmtDateTime(log.first)}` : ''),
    )}
        <div class="pair">
          ${panel('Prompts the client logged, by project', barList(
        Object.entries(log.byProject).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, { cost: n, msgs: n }]),
        { limit: 10, label: (v) => String(v) },
    ), { note: 'From <code>~/.claude/history.jsonl</code>, which keeps every prompt typed on this machine across every project. Only counts are read here — the text stays in the file.' })}
          ${panel('Busiest days', barList(
        Object.entries(log.byDay).sort((a, b) => b[1] - a[1]).map(([k, n]) => [fmtDay(k), { cost: n, msgs: n }]),
        { limit: 10, label: (v) => String(v) },
    ))}
        </div>` : ''}
        ${panel('Words you use', cloud, {
        note: 'Five letters or more, from prompts you typed — not from what a program sent, what the client injected, or a suggestion you accepted, which together are more than half of them. Paths, tool ids and snake_case identifiers are stripped first, and a word counts once per prompt rather than once per occurrence, so a pasted file cannot outvote a sentence.',
    })}
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
        ${panel('Spend by model and effort', matrixTable(m.models, m.tiers,
        (model, tier) => (m.get(model, tier) || {}).cost, { rowLabel: shortModel }), {
        note: "Which model did the work, at which reasoning effort, from which client. A dispatch that forgot to name a model or an effort inherits the session's — and that inheritance is only visible here.",
    })}
        <div class="pair">
          ${panel('Where the requests came from',
        barList(entries, { limit: 8, label: (v, b) => `${fmtCost(v)} · ${b.msgs} req` }), {
        note: 'An <code>sdk-*</code> entrypoint is a program driving Claude Code, not a session you typed in: it carries its own model choice and ignores <code>settings.json</code>.',
    })}
          ${panel('Output per request, by effort',
        barList(perTier, { limit: 8, value: (b) => b.perReq, label: (v, b) => `${tok(Math.round(v))} · ${b.msgs} req` })
        + (speeds.length > 1 ? `<h3 class="now-sub">Speed</h3>${barList(speeds, { limit: 4, label: (v, b) => `${fmtCost(v)} · ${b.msgs} req` })}` : ''))}
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

    const rate = (n) => (calls > 0 ? Math.round((n / calls) * 100) : null);
    return `<section class="tab" data-tab="tools" hidden>
        ${tiles(
        tile('Tool calls', String(calls), `${plural(tools.length, 'distinct tool')}`),
        tile('Failed', String(errors), `${pct(errors, calls)} of calls`, rate(errors), 'hot'),
        tile('Denied', String(denials), 'refused by you or by a rule', rate(denials), 'warm'),
        tile('Advisor', String(advisor), 'consultations — priced server-side, not here'),
    )}
        <div class="pair">
          ${panel('Most used', barList(byCalls, { limit: 16, value: (t) => t.calls, label: (v, t) => (t.errors ? `${v} · ${t.errors} failed` : String(v)) }), {
        note: 'Counted from the tool_use blocks of every reply on this machine. A failed result is blamed on the tool that produced it, matched back through the call id.',
    })}
          ${panel('MCP servers', barList(Object.entries(servers).sort((a, b) => b[1].calls - a[1].calls),
        { limit: 12, value: (s) => s.calls, label: (v, s) => `${v} · ${plural(s.tools, 'tool')}` }), {
        note: 'A server with no calls at all does not appear here — that is the answer to whether it earns its place in the config.',
    })}
        </div>
        ${panel('Failing most often', barList(flaky, { limit: 8, scaleMax: 100, value: (t) => t.rate * 100, label: (v, t) => `${v.toFixed(0)}% of ${t.calls}` }), {
        note: 'Only tools called at least twenty times: two failures out of three is worth seeing, two out of nine hundred is noise.',
    })}
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
        ${tiles(
        tile('Served from cache', pct(read, allIn), `${tok(read)} of ${tok(allIn)} input tokens`,
            allIn > 0 ? Math.round((read / allIn) * 100) : null, 'cool'),
        tile('Saved by reads', `~${fmtCost(saved)}`, 'against sending them fresh'),
        tile('Read per token written', `${leverage.toFixed(1)}×`, leverage < 1 ? 'rebuilt more than reused' : 'each write paid off'),
        tile('Hourly TTL', pct(w1h, write), `${tok(w1h)} at 2× · ${tok(w5m)} at 1.25×`,
            write > 0 ? Math.round((w1h / write) * 100) : null, 'warm'),
    )}
        ${panel('Tokens billed at the full rate, by day',
        stackedTokens(total.days, BILLED_PARTS, { height: 150 })
        + `<div class="legend">${BILLED_PARTS.map((p) =>
        `<span class="chip"><i style="background:${p.color}"></i>${esc(p.label)}</span>`).join('')}</div>`, {
        note: 'A cached token is read at a tenth of the input rate; putting it there costs 1.25x at the five-minute TTL and 2x at the hourly one. Which TTL a request used is recorded per reply, so both sides are exact.',
    })}
        ${panel('Cache reads, by day', stackedTokens(total.days, READ_PARTS, { height: 110 }), {
        note: 'The same days on their own scale — reads run an order of magnitude above everything above, which is the point of them.',
    })}
        ${panel('Cache hit rate by model', barList(byModel, { limit: 10, byModel: true, scaleMax: 100, value: (b) => b.hit * 100, label: (v, b) => `${v.toFixed(0)}% · ${tok(b.cacheRead)} read` }))}
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

    const mostFailures = worst.length ? `<table><thead><tr><th>Last activity</th><th>Project</th><th>Session</th>
          <th class="num">Failed</th><th class="num opt2">Requests</th><th class="num">Spend</th></tr></thead>
          <tbody>${worst.map((s) => `<tr><td>${esc(fmtDateTime(s.end))}</td><td>${esc(s.project)}</td>
            <td class="wrap">${esc(s.title || s.id)}</td><td class="num">${s.errors}</td>
            <td class="num opt2">${s.msgs}</td><td class="num">${esc(fmtCost(s.cost))}</td></tr>`).join('')}
          </tbody></table>` : '<p class="empty">No failed tool calls recorded.</p>';

    return `<section class="tab" data-tab="friction" hidden>
        ${tiles(
        tile('Failed tool calls', String(f.toolErrors || 0), ''),
        tile('Denied', String(Object.values(f.denials || {}).reduce((a, n) => a + n, 0)), 'refused before running'),
        tile('Compactions', String(compactions), `${tok(f.droppedTokens || 0)} of context dropped`),
        tile('Cut off', String(f.shutdowns || 0), 'by the client going away'),
    )}
        <div class="pair">
          ${panel('Why a call was refused', barList(denials, { limit: 8, label: (v) => String(v) }), {
        note: 'What the spend ran into. None of it is priced separately — a rejected call still cost the tokens that proposed it, and those are already counted as spend.',
    })}
          ${panel('What triggered a compaction', barList(compactRows, { limit: 6, label: (v) => String(v) }), {
        note: f.compactMs > 0 ? `Compacting took ${esc(fmtDur(f.compactMs))} of wall-clock in total.` : '',
    })}
        </div>
        ${panel('Tools that failed', barList(toolErrors, { limit: 12, value: (t) => t.errors, label: (v, t) => `${v} of ${t.calls}` }))}
        ${panel('Sessions with the most failures', mostFailures, { flush: worst.length > 0 })}
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

    const cards = last ? tiles(
        tile('Weekly window', `${last.weekly}%`, `resets ${fmtDateTime(last.reset * 1000)}`, last.weekly),
        typeof last.session === 'number'
            ? tile('Session window', `${last.session}%`, 'the rolling 5 hours', last.session) : '',
        tile('Readings kept', String(rows.length), `since ${fmtDateTime(rows[0].at)}`),
    ) : '';

    const models = last && last.models ? Object.entries(last.models).sort((a, b) => b[1] - a[1]) : [];

    const overlaid = lineChart(series)
        + `<div class="legend">${series.map((s, i) =>
        `<span class="chip"><i style="background:${modelColor(s.label, i)}"></i>${esc(s.label)}<span class="dim">· ${s.current ? 'resets' : 'ended'} ${esc(fmtDateTime(s.reset * 1000))}</span></span>`).join('')}</div>`
        + (series.length === 1 ? '<p class="note">Only one window has been recorded so far, so there is nothing to compare it against yet — the older lines appear as resets go by.</p>' : '');

    return `<section class="tab" data-tab="limits" hidden>
        ${cards}
        ${panel('Weekly windows, overlaid', overlaid, {
        note: 'One line per weekly window, each drawn from its own beginning: across is days since that window opened, up is how much of the weekly limit was gone by then. Stacking the weeks on one pair of axes compares the pace rather than the dates — the same day of two different weeks sits at the same place. The dashed diagonal is a window spent evenly; a line above it runs out before the reset, a line below leaves quota unused.',
    })}
        ${models.length ? panel('Per-model windows, latest reading', barList(
        models.map(([name, p]) => [name, { cost: p, msgs: p }]),
        { limit: 8, scaleMax: 100, label: (v) => `${v}%` }), {
        note: "The usage endpoint answers only for right now, so this is a local log: one row whenever a percentage moves, kept in the extension's own storage. It starts empty and fills in as the extension runs.",
    }) : ''}
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
/**
 * Every skill, agent and command every installed plugin brings, against what
 * the transcripts say actually ran. The plugin table answers "did any of this
 * fire"; this answers which part — 56 skills are installed here and 14 have
 * ever run, and a plugin reads as used on the strength of one of its six.
 *
 * A component is matched by the two names the client attributes with:
 * `plugin:name` for a skill of a plugin, and the bare name for one that reached
 * the index without its plugin. An agent is a third case and rarely visible at
 * all — its type is named in a tool call's arguments, not its result — so an
 * agent that never matched is reported as unknown rather than as unused.
 */
function componentRows(plugins, skills) {
    const rows = [];
    for (const p of plugins) {
        const c = p.components || {};
        const of = (kind, name) => {
            const key = `${p.name}:${name}`.toLowerCase();
            const hit = skills[key] || skills[name.toLowerCase()] || null;
            return { plugin: p.name, kind, name, enabled: p.enabled, hit };
        };
        for (const name of c.skills || []) rows.push(of('skill', name));
        for (const name of c.commands || []) rows.push(of('command', name));
        for (const name of c.agents || []) rows.push(of('agent', name));
    }
    // Used first and dearest first inside that, because the question a reader
    // brings here is which of the forty plugins is earning its place.
    return rows.sort((a, b) => Number(Boolean(b.hit)) - Number(Boolean(a.hit))
        || (b.hit ? b.hit.cost : 0) - (a.hit ? a.hit.cost : 0)
        || a.plugin.localeCompare(b.plugin));
}

/**
 * MCP servers with what their tools actually did. The tools tab counts calls
 * and failures per tool and `mcpServer` maps a tool back to its server; joining
 * the two is the difference between "this server has been called" and "this
 * server answers, and fails one call in three".
 */
function mcpHealth(servers, tools) {
    const stats = {};
    for (const [name, t] of Object.entries(tools || {})) {
        const server = mcpServer(name);
        if (!server) continue;
        const s = stats[server] || (stats[server] = { calls: 0, errors: 0, denials: 0, tools: 0 });
        s.calls += t.calls || 0;
        s.errors += t.errors || 0;
        s.denials += t.denials || 0;
        s.tools++;
    }
    return (servers || []).map((m) => ({ ...m, stats: stats[m.name] || null }));
}

function settingsList(settings) {
    const rows = Object.entries(settings.values || {});
    if (rows.length === 0) return '<p class="empty">No settings found.</p>';
    return `<table class="kv"><tbody>${rows.map(([key, v]) =>
        `<tr><th scope="row" title="${esc(key)}"><span>${esc(key)}</span></th><td>${esc(renderValue(key, v.value).text)}</td>
         <td class="dim opt">${esc(v.from)}</td></tr>`).join('')}</tbody></table>`;
}

/**
 * The configured inventory against what actually ran. A plugin's skills and an
 * MCP server's tools both show up in the index under names that can be matched
 * back, so "installed" and "used" can sit in the same row — which is the only
 * way the list answers what to uninstall.
 */
function healthTab(total, sys, cfg = {}) {
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
    const mcpRows = mcpHealth(sys.mcp || [], total.tools).map((m) => ({ ...m, used: serverUsed(m.name) }));

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

    const settingsBody = settingsList(sys.settings || {})
        + (Object.keys((sys.settings || {}).env || {}).length
            ? `<h3 class="now-sub">Environment</h3><table class="kv"><tbody>${Object.entries(sys.settings.env).map(([k, val]) =>
        `<tr><th scope="row" title="${esc(k)}"><span>${esc(k)}</span></th><td>${esc(renderValue(k, val).text)}</td></tr>`).join('')}</tbody></table>` : '');

    const mcpBody = `<table><thead><tr><th>Server</th><th class="opt2">Scope</th><th class="num">Calls</th>
            <th class="num">Failed</th><th>State</th></tr></thead><tbody>
            ${mcpRows.map((m) => {
        const st = m.stats;
        const rate = st && st.calls > 0 ? st.errors / st.calls : 0;
        // A server that answers most of the time and fails a third is neither
        // used nor idle, and calling it "used" was the whole of what Health
        // could say about it.
        const word = !m.used ? '<span class="idle">never called</span>'
            : rate >= 0.2 ? `<span class="o-failed">failing ${Math.round(rate * 100)}%</span>`
                : '<span class="ok">used</span>';
        return `<tr><td title="${esc(m.command || m.transport)}">${esc(m.name)}</td>
              <td class="dim opt2">${esc(m.scope)}${m.project ? ` ${esc(m.project)}` : ''}</td>
              <td class="num">${st ? esc(String(st.calls)) : '·'}</td>
              <td class="num">${st && st.errors ? esc(String(st.errors)) : '·'}</td>
              <td>${word}</td></tr>`;
    }).join('')}
            </tbody></table>
            <h3 class="now-sub">Hooks</h3>
            ${(sys.hooks || []).length ? `<table><thead><tr><th>Event</th><th class="opt2">Matcher</th><th>Runs</th></tr></thead><tbody>
              ${sys.hooks.map((h) => `<tr><td>${esc(h.event)}</td><td class="mono opt2">${esc(h.matcher)}</td>
                <td class="mono wrap" title="${esc(h.command)}">${esc(h.command)}</td></tr>`).join('')}
            </tbody></table>` : '<p class="empty">No hooks configured.</p>'}`;

    const pluginTable = `<table><thead><tr><th>Plugin</th><th class="opt">Marketplace</th><th class="opt2">Version</th>
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
        </tbody></table>`;

    const permTable = `<table><thead><tr><th>Mode</th><th>Rule</th><th class="opt">From</th></tr></thead><tbody>
          ${(sys.permissions || []).map((p) => `<tr><td>${esc(p.mode)}</td><td class="mono">${esc(p.rule)}</td>
            <td class="dim opt">${esc(p.from)}</td></tr>`).join('')}
        </tbody></table>`;

    const componentRows_ = componentRows(sys.plugins || [], total.skills || {});
    const ranCount = componentRows_.filter((r) => r.hit).length;
    const componentTable = `<table><thead><tr><th>Component</th><th class="opt2">Plugin</th><th>Kind</th>
        <th class="num opt">Requests</th><th class="num">Spend</th><th class="opt">Last used</th></tr></thead><tbody>
      ${componentRows_.map((r) => `<tr class="${r.enabled ? '' : 'off'}">
        <td class="wrap">${esc(r.name)}</td>
        <td class="dim opt2">${esc(r.plugin)}</td>
        <td><span class="kind">${esc(r.kind)}</span></td>
        <td class="num opt">${r.hit ? esc(String(r.hit.msgs)) : '·'}</td>
        <td class="num">${r.hit ? esc(fmtCost(r.hit.cost)) : '·'}</td>
        <td class="opt">${r.hit
        ? (r.hit.last ? esc(fmtDateTime(r.hit.last)) : '<span class="dim">—</span>')
        : (r.kind === 'agent' ? '<span class="dim">not visible</span>' : '<span class="idle">never</span>')}</td>
      </tr>`).join('')}
    </tbody></table>`;

    // Installed against what the machine already has on disk: each marketplace
    // is a local clone, so the version a plugin declares upstream is readable
    // without asking anyone. What needs the network is whether that clone is
    // itself behind — and that is the whole of what the setting buys.
    const updates = sys.pluginUpdates || [];
    const stale = updates.reduce((a, u) => Math.max(a, u.marketUpdated || 0), 0);
    const checks = Boolean(cfg.checkPluginUpdates);
    const behind = updates.filter((u) => u.declared && u.installed && u.installed !== u.available);
    const heads = sys.marketHeads || {};
    const markets = [...new Set(updates.map((u) => u.marketplace))];
    // The question this table is asked is "does this need updating", and for
    // most rows the answer is not a version at all: 24 of 28 plugins here live
    // inside the marketplace repository, so their update is the marketplace's.
    // Saying that per row beats making a reader infer it from a line above.
    const staleMarket = (m) => {
        const head = heads[m];
        const clone = updates.find((u) => u.marketplace === m);
        return Boolean(head && clone && clone.marketUpdated > 0 && head.at > clone.marketUpdated);
    };
    const updateTable = updates.length ? `<table><thead><tr><th>Plugin</th><th class="opt2">Marketplace</th>
        <th>Installed</th><th class="opt">In the local copy</th><th>Update comes from</th></tr></thead><tbody>
      ${updates.map((u) => {
        const behindVersion = u.declared && u.installed && u.installed !== u.available;
        const stale = !u.origin && staleMarket(u.marketplace);
        const where = u.origin
            ? `<span class="dim" title="${esc(u.origin)}">its own repository</span>`
            : (checks
                ? (stale
                    ? `<span class="o-stopped">the marketplace, and it has moved</span>`
                    : '<span class="ok">the marketplace, which is current</span>')
                : '<span class="dim">the marketplace — not checked</span>');
        return `<tr>
        <td class="wrap">${esc(u.name)}</td>
        <td class="dim opt2" title="${esc(u.repo)}">${esc(u.marketplace)}</td>
        <td class="mono">${esc(u.installed || '—')}</td>
        <td class="mono opt">${u.declared
        ? (behindVersion ? `<span class="o-stopped">${esc(u.available)}</span>` : `<span class="ok">${esc(u.available)}</span>`)
        : '<span class="dim">not declared</span>'}</td>
        <td>${behindVersion ? `<span class="o-stopped">a newer version, ${esc(u.available)}</span>` : where}</td>
      </tr>`;
    }).join('')}
    </tbody></table>` : '<p class="empty">No installed plugins recorded.</p>';

    // What the network answered, when it was asked. A clone whose repository has
    // moved since it was cloned is the whole point of the setting, and saying it
    // per marketplace is the only way the answer is actionable — the fix is one
    // `claude plugin update` against that marketplace.
    const marketLines = markets.map((m) => {
        const head = heads[m];
        const clone = updates.find((u) => u.marketplace === m);
        const cloned = clone ? clone.marketUpdated : 0;
        if (!head) return `<li>${esc(m)} — <span class="dim">not asked</span></li>`;
        const late = cloned > 0 && head.at > cloned;
        return `<li>${esc(m)} — ${late
            ? `<span class="o-stopped">the copy is behind</span>, newest commit ${esc(fmtDateTime(head.at))} (<code>${esc(head.sha)}</code>) against a clone from ${esc(fmtDateTime(cloned))}`
            : `<span class="ok">the copy is current</span> as of ${esc(fmtDateTime(head.at))}`}</li>`;
    }).join('');

    const updateNote = `${updates.length} installed from ${markets.length} marketplace${markets.length === 1 ? '' : 's'}, each of which is a clone on this disk${stale ? `, last refreshed ${esc(fmtDateTime(stale))}` : ''}. ${behind.length ? `${behind.length} differ${behind.length === 1 ? 's' : ''} from the copy.` : 'None differs from the copy.'} Most manifests declare no version at all, and a missing version is reported as missing rather than as up to date.
      ${checks
        ? `<b>Update checking is on.</b> One request per marketplace asks GitHub for its newest commit and compares it with the clone:<ul class="log">${marketLines}</ul>Bring a stale copy up to date with <code>claude plugin update</code>. ${updates.filter((u) => u.origin).length} plugin${updates.filter((u) => u.origin).length === 1 ? '' : 's'} here live in a repository of their own rather than in a marketplace, and nothing checks those — a version for them would cost one request each.`
        : '<b>Nothing is asked of the network.</b> Without <code>claudeStatusline.checkPluginUpdates</code> this compares against the copy already on disk, so a plugin whose marketplace moved after that date will read as current. Turn the setting on to check, or refresh the clone yourself with <code>claude plugin update</code>.'}`;

    const enabled = pluginRows.filter((p) => p.enabled).length;
    return `<section class="tab" data-tab="health" hidden>
        ${tiles(
        tile('Client', v.current || '—', v.waiting ? `${v.latest} unpacked and waiting` : `${plural((v.installed || []).length, 'version')} on disk`),
        tile('Plugins', String(enabled), `${idle.length} enabled but idle`,
            enabled > 0 ? Math.round((idle.length / enabled) * 100) : null, 'warm'),
        tile('MCP servers', String(mcpRows.length), `${mcpRows.filter((m) => !m.used).length} never called`,
            mcpRows.length > 0 ? Math.round((mcpRows.filter((m) => !m.used).length / mcpRows.length) * 100) : null, 'warm'),
        tile('Hooks', String((sys.hooks || []).length), plural((sys.permissions || []).length, 'permission rule')),
    )}
        <div class="pair">
          ${panel('Settings in force', settingsBody)}
          ${panel('MCP servers', mcpBody)}
        </div>
        ${panel('Plugins', pluginTable, {
        flush: true,
        note: 'What is configured on this machine, and which of it has actually run. "Idle" means none of its skills, commands or MCP tools appears anywhere in the indexed transcripts. Two things it cannot see: an agent, whose type is named in a tool call\'s arguments rather than its result, and a hook, which leaves no record at all — so a plugin that ships only those reads as idle whether or not it fired.',
    })}
        ${panel('Versions', toggle('checkPluginUpdates', 'Check the marketplaces for newer versions',
        checks, 'One request per marketplace, at most hourly. Off means nothing is asked of the network.')
        + updateTable, {
        flush: true,
        note: updateNote,
    })}
        ${panel('What each plugin actually brings', componentTable, {
        flush: true,
        note: `Every skill, command and agent the installed plugins carry, against what ran. The plugin table above says whether <em>any</em> of a plugin fired; this says which part — ${ranCount} of ${componentRows_.length} components have ever appeared in a transcript. An agent is named in a tool call's arguments rather than its result, so one that never matched is unknown here rather than unused.`,
    })}
        ${(sys.permissions || []).length ? panel('Permission rules', permTable, {
        flush: true,
        note: 'A call refused by one of these is counted on the Friction tab as <code>permission-rule</code>.',
    }) : ''}
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
        ${tiles(
        tile('Jobs', String(rows.length), `${running.length} still working`,
            rows.length > 0 ? Math.round((running.length / rows.length) * 100) : null, 'cool'),
        tile('Tokens', tok(tokens), 'across every job'),
        tile('Scratch on disk', bytes(scratch), 'in jobs/*/tmp'),
    )}
        ${panel('Every job', `<table><thead><tr><th>Last change</th><th>Job</th><th>State</th><th class="opt">Project</th>
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
        </tbody></table>`, {
        flush: true,
        note: 'Background agents keep their own state, their own transcript and a working directory that nothing cleans up. A job still holding a session is also the reason <code>/resume</code> on that session refuses to open it.',
    })}
    </section>`;
}

function liveTab(sys) {
    const l = (sys && sys.live) || { sessions: [], ide: [], daemon: { workers: [] } };
    const aliveSessions = l.sessions.filter((s) => s.alive);
    const stale = l.sessions.length - aliveSessions.length;

    const sessionTable = l.sessions.length ? `<table><thead><tr><th class="opt2">Started</th><th>Session</th><th class="opt">Project</th>
          <th>Entrypoint</th><th>Status</th><th class="num opt2">PID</th><th class="opt">Client</th></tr></thead><tbody>
          ${l.sessions.map((s) => `<tr class="${s.alive ? '' : 'off'}">
            <td class="nowrap opt2">${esc(fmtDateTime(s.startedAt))}</td>
            <td class="wrap">${esc(s.name || s.id.slice(0, 8))}</td>
            <td class="dim opt">${esc(s.cwd)}</td>
            <td>${esc(s.entrypoint || '—')}</td>
            <td>${s.alive ? `<span class="ok">${esc(s.status || 'idle')}</span>` : '<span class="idle">stale</span>'}</td>
            <td class="num mono opt2">${s.pid}</td><td class="dim opt">${esc(s.version || '')}</td></tr>`).join('')}
        </tbody></table>` : '<p class="empty">No sessions in the registry.</p>';

    const editors = l.ide.length ? `<table><thead><tr><th>Editor</th><th class="num">PID</th><th>Folders</th></tr></thead><tbody>
              ${l.ide.map((i) => `<tr class="${i.alive ? '' : 'off'}"><td>${esc(i.name || '—')}</td>
                <td class="num mono">${i.pid}</td><td class="dim">${esc(i.folders.join(', '))}</td></tr>`).join('')}
            </tbody></table>` : '<p class="empty">No editor attached.</p>';

    const workers = l.daemon.workers.length ? `<table><thead><tr><th>Worker</th><th>Project</th><th class="num">PID</th></tr></thead><tbody>
              ${l.daemon.workers.map((w) => `<tr class="${w.alive ? '' : 'off'}"><td class="mono">${esc(w.short)}</td>
                <td class="dim">${esc(w.cwd)}</td><td class="num mono">${w.pid}</td></tr>`).join('')}
            </tbody></table>` : '<p class="empty">The daemon is not running.</p>';

    return `<section class="tab" data-tab="live" hidden>
        ${tiles(
        tile('Live sessions', String(aliveSessions.length), stale ? `${plural(stale, 'stale entry', 'stale entries')}` : 'registry is clean'),
        tile('Editors attached', String(l.ide.filter((i) => i.alive).length), plural(l.ide.length, 'lock file')),
        tile('Daemon workers', String(l.daemon.workers.filter((w) => w.alive).length), l.daemon.alive ? `supervisor ${l.daemon.supervisorPid}` : 'supervisor not running'),
    )}
        ${panel('Sessions', sessionTable, {
        flush: l.sessions.length > 0,
        note: "Read at the moment the dashboard was opened: the session registry, the IDE windows attached to it, and the daemon's own workers. A registry entry whose process is gone is shown as stale rather than hidden — it is what a crashed session leaves.",
    })}
        <div class="pair">
          ${panel('Editors', editors)}
          ${panel('Daemon workers', workers)}
        </div>
    </section>`;
}

function diskTab(sys) {
    const d = sys && sys.disk;
    if (!d) return '<section class="tab" data-tab="disk" hidden><p class="empty">Disk usage has not been measured yet — press Reindex.</p></section>';
    const kindLabel = { keep: 'keep', regenerable: 'regenerates', mixed: '' };
    const junk = d.hogs.reduce((a, h) => a + h.bytes, 0);
    const hogTable = `<table><thead><tr><th>Path</th><th>What it is</th><th class="num">Size</th></tr></thead><tbody>
          ${d.hogs.map((h) => `<tr><td class="mono">${esc(h.path)}</td><td class="dim">${esc(h.note)}</td>
            <td class="num">${esc(bytes(h.bytes))}</td></tr>`).join('')}
        </tbody></table>`;

    return `<section class="tab" data-tab="disk" hidden>
        ${tiles(
        tile('Total', bytes(d.total), '~/.claude'),
        d.hogs.length ? tile('Leftovers', bytes(junk), `${plural(d.hogs.length, 'place')}, safe to remove`,
            d.total > 0 ? Math.round((junk / d.total) * 100) : null, 'warm') : '',
    )}
        ${panel('By directory', barList(d.dirs.map((x) => [x.name, x]), {
        limit: 20, value: (x) => x.bytes,
        label: (v, x) => `${bytes(v)}${kindLabel[x.kind] ? ` · ${kindLabel[x.kind]}` : ''}`,
    }), { note: 'Everything under <code>~/.claude</code>. Nothing here is deleted by this extension and there is no button that would — the numbers are the point, the decision is yours.' })}
        ${d.hogs.length ? panel('Named leftovers', hogTable, {
        flush: true,
        note: "A job's <code>tmp</code> is the working directory of a background agent that has since finished; a <code>temp_subdir_*</code> clone is what an interrupted marketplace update left behind.",
    }) : ''}
    </section>`;
}

// A memory note's own name is what identifies it; the directory it sits in is
// the same forty characters for every one of them and pushed the name off the
// end of the column.
const memoryName = (f) => (f.scope === 'memory' ? String(f.path).split('/').pop() : f.path);

const SCOPE_NOTE = {
    global: 'Loaded in every session on this machine, whatever repository you are in.',
    project: 'Loaded only in the repository it belongs to.',
    memory: 'What the client wrote down about a repository itself, loaded with that repository.',
};

/**
 * Everything that is read into the prompt before you type a word: the
 * instruction layer and the per-project memory the client keeps. Grouped by
 * scope, because that is the order the layers apply in — what holds everywhere
 * first, then what holds here. The order inside one scope belongs to the client
 * and is not claimed.
 *
 * Each file carries its own text, so it can be read without leaving the page or
 * waking the webview's script, and a button hands the path to the editor.
 */
function contextTab(total, sys) {
    const c = (sys && sys.context) || { files: [], globalTokens: 0 };
    const msgs = sumOf(total.models, 'msgs');
    const perRequest = c.globalTokens;
    // The rate comes from pricing.js rather than a number written here: the file
    // is the one place a rate changes, and a copy of it would keep this tile —
    // and its "at Opus input rates" caption — on the old figure for ever.
    const lifetime = (perRequest * msgs) / 1e6 * ratesFor('claude-opus-5').rates.in;
    const files = c.files || [];
    const totalTokens = files.reduce((a, f) => a + f.tokens, 0);

    const groups = ['global', 'project', 'memory']
        .map((scope) => [scope, files.filter((f) => f.scope === scope)])
        .filter(([, list]) => list.length > 0);

    const fileRow = (f) => `<details class="memory">
        <summary>
          <span class="mem-name" title="${esc(f.abs || f.path)}">${esc(memoryName(f))}</span>
          <span class="dim">~${esc(tok(f.tokens))} · ${esc(bytes(f.bytes))}${f.mtime ? ` · ${esc(fmtDateTime(f.mtime))}` : ''}</span>
          <button class="link mem-open" data-open="${esc(f.abs || '')}">open</button>
        </summary>
        <pre class="mem-text">${esc(f.text || '')}</pre>
        ${f.clipped ? `<p class="note">Shown to 60 KB of ${esc(bytes(f.bytes))} — open the file for the rest.</p>` : ''}
    </details>`;

    return `<section class="tab" data-tab="context" hidden>
        ${tiles(
        tile('Every request pays', `~${tok(perRequest)}`, 'tokens of instructions, before you type'),
        tile('Across all requests', `~${fmtCost(lifetime)}`, `${plural(msgs, 'request')} at Opus input rates`),
        tile('Files', String(files.length), `~${tok(totalTokens)} tokens in total`),
    )}
        ${groups.map(([scope, list]) => panel(scope === 'memory' ? 'Project memory' : `${scope[0].toUpperCase()}${scope.slice(1)} instructions`,
        list.map(fileRow).join(''), {
        note: `${esc(SCOPE_NOTE[scope])} ${list.length} file${list.length === 1 ? '' : 's'}, ~${esc(tok(list.reduce((a, f) => a + f.tokens, 0)))} tokens. Click one to read it, or <b>open</b> to edit it.`,
    })).join('')}
        ${files.length === 0 ? panel('Nothing loaded', '<p class="empty">No instruction file was found.</p>') : ''}
        ${panel('What this costs', `<p class="note">Sizes are exact; tokens are the size over four characters, which is close enough to compare paragraphs against each other. Cached, the instruction layer is read at a tenth of the input rate — the figure above is the uncached case, which is what a fresh session pays.</p>`)}
    </section>`;
}

function tasksTab(sys) {
    const rows = (sys && sys.tasks) || [];
    const open = rows.filter((t) => t.open.length > 0);
    if (rows.length === 0) {
        return '<section class="tab" data-tab="tasks" hidden><p class="empty">No task lists recorded.</p></section>';
    }
    const table = `<table><thead><tr><th class="nowrap">Last touched</th><th>Project</th><th class="opt">Session</th>
          <th class="num">Done</th><th>Still open</th></tr></thead><tbody>
        ${rows.map((t) => `<tr><td class="nowrap">${esc(fmtDateTime(t.at))}</td>
          <td>${esc(t.project || '—')}</td><td class="mono nowrap opt">${esc(t.session.slice(0, 8))}</td>
          <td class="num">${t.done}/${t.total}</td>
          <td>${t.open.length ? esc(t.open.join(' · ')) : '<span class="dim">nothing</span>'}</td></tr>`).join('')}
        </tbody></table>`;

    return `<section class="tab" data-tab="tasks" hidden>
        ${tiles(
        tile('Lists', String(rows.length), `${plural(open.length, 'list')} with something open`,
            rows.length > 0 ? Math.round((open.length / rows.length) * 100) : null, 'warm'),
        tile('Open items', String(open.reduce((a, t) => a + t.open.length, 0)), 'across every session'),
    )}
        ${panel('Every list', table, {
        flush: true,
        note: 'Todo lists left behind by sessions, newest first. An unfinished item here is work that was planned and never closed — the session may be long gone.',
    })}
    </section>`;
}

// How many of the older releases are open before the button is pressed. There
// is no second number: the page carries every release the source had, and the
// only thing that ends the list is the source running out. A cap here read as
// "that is all there was" — the upstream file is 361 releases deep and the page
// stopped at eighty with nothing on screen to say so.
const CHANGELOG_SHOWN = 15;

function changelogTab(sys, cfg = {}) {
    const all = (sys && sys.changelog) || [];
    const releases = all;
    const v = (sys && sys.versions) || {};
    const fetched = Boolean(cfg.fetchChangelog);
    // Anything newer than the version running is the answer and stays open;
    // everything behind it is history, folded. With the full file fetched that
    // is the difference between sixty open releases and one screen.
    const newer = (a, b) => {
        const pa = String(a).split('.').map(Number);
        const pb = String(b).split('.').map(Number);
        for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
        return false;
    };
    const ahead = v.current ? releases.filter((r) => newer(r.version, v.current)) : releases;
    const history = releases.filter((r) => !ahead.includes(r));
    const entries = (r) => `<ul class="log">${r.entries.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
    return `<section class="tab" data-tab="changelog" hidden>
        ${tiles(
        tile('Running', v.current || '—', v.waiting ? `${v.latest} is unpacked and waiting` : 'up to date'),
        // `ahead`, not `releases`: the tile is named for what is in front of the
        // running version, and the page carries the whole history behind it.
        tile('Releases ahead', String(ahead.length), ahead.length ? 'not yet running' : 'nothing new'),
    )}
        ${panel('Where these notes come from', toggle('fetchChangelog',
        'Fetch the full changelog from Anthropic', fetched,
        'One public file, no credentials, at most once an hour. Off, the tab reads the copy the client keeps in ~/.claude/cache, which covers only a little history and lags a release by up to a day.'), {
        note: fetched
            ? `Fetched from <code>raw.githubusercontent.com/anthropics/claude-code</code> and kept in the extension's own storage, so this still reads offline. All ${all.length} release${all.length === 1 ? '' : 's'} it had are on this page.`
            : "Reading <code>~/.claude/cache/changelog.md</code>, the client's own copy. It is written when the client feels like it, which is why a version can be unpacked here before its notes are.",
    })}
        ${releases.length
        // A release newer than the one running is a block of the page like any
        // other; the ones behind it are a folded list, because nobody scrolls
        // sixty of them and every one of them was already read once.
        ? ahead.map((r) => panel(r.version, entries(r))).join('')
        + (history.length ? panel(`${history.length} release${history.length === 1 ? '' : 's'} already behind you`,
            // The first fifteen are open to scroll; the rest are in the page and
            // one button away. Revealing rather than fetching, because the data
            // is already here — a round trip to show what is in the document is
            // a spinner for nothing.
            history.map((r, i) => `<details class="memory${i >= CHANGELOG_SHOWN ? ' folded' : ''}"><summary>
                <span class="mem-name">${esc(r.version)}</span>
                <span class="dim">${plural(r.entries.length, 'note')}</span>
              </summary>${entries(r)}</details>`).join('')
            + (history.length > CHANGELOG_SHOWN
                ? `<button class="btn" data-more>Show ${history.length - CHANGELOG_SHOWN} older releases</button>` : ''),
            { note: v.current ? `Up to and including ${esc(v.current)}, the version running now.` : '' }) : '')
        // "Nothing new" beside a tile saying a newer version is unpacked is a
        // contradiction on one screen. The cache is the client's, refreshed on
        // its own schedule, so a version can be on disk before its notes are —
        // and that is what this says instead of pretending there is nothing.
        : panel(v.waiting ? `${v.latest} is here, its notes are not` : 'Nothing new',
            `<p class="empty">${v.waiting
                ? `${esc(v.latest)} is unpacked and starts with the next launch, but the client has not written its notes into <code>~/.claude/cache/changelog.md</code> yet — the newest entry there is ${esc(v.current || '—')}, the version running now. They usually arrive within a day of the release.`
                : 'Nothing newer than the version already running.'}</p>`)}
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

    const dearest = projects.reduce((a, x) => Math.max(a, x.lastCost || 0), 0);
    const perProject = `<table><thead><tr><th>Project</th><th class="num">Last spend</th><th class="num">Duration</th>
          <th class="num">In API</th><th class="num">+/−</th><th class="num opt">Searches</th>
          <th class="num opt">FPS</th><th class="num opt2">Tools allowed</th><th class="opt2">Trusted</th></tr></thead><tbody>
        ${projects.map((p) => `<tr><td title="${esc(p.path)}">${esc(p.name)}</td>
          ${shareCell(fmtCost(p.lastCost), dearest > 0 ? (p.lastCost || 0) / dearest : 0)}
          <td class="num">${esc(fmtDur(p.lastDuration))}</td>
          <td class="num">${p.lastDuration > 0 && p.apiDuration > 0 ? pct(p.apiDuration, p.lastDuration) : '—'}</td>
          <td class="num">+${tok(p.added)}/−${tok(p.removed)}</td>
          <td class="num opt">${p.webSearches || '·'}</td>
          <td class="num opt">${p.fps ? p.fps.toFixed(0) : '·'}</td>
          <td class="num opt2">${p.allowedTools || '·'}</td>
          <td class="opt2">${p.trusted ? '<span class="ok">yes</span>' : '<span class="dim">no</span>'}</td></tr>`).join('')}
        </tbody></table>`;

    return `<section class="tab" data-tab="files" hidden>
        ${tiles(
        tile('Files touched', String(files.length), plural(edits, 'edit')),
        tile('Lines added', tok(added), ''),
        tile('Lines removed', tok(removed), ''),
    )}
        <div class="pair">
          ${panel('Most often edited', barList(byEdits.map(([p, f]) => [short(p), f]), {
        limit: 15, value: (f) => f.edits, label: (v, f) => `${v} · +${tok(f.added)}/-${tok(f.removed)}`,
    }), { note: "Every file an edit or a write touched, counted from the patch the tool returned. Line counts are the patch's own, so a rewritten file counts as its whole length." })}
          ${panel('Most lines changed', barList(byChurn.map(([p, f]) => [short(p), f]), {
        limit: 15, value: (f) => f.added + f.removed, label: (v) => tok(v),
    }))}
        </div>
        ${projects.length ? panel('What the client itself records per project', perProject, {
        flush: true,
        note: 'Read from <code>~/.claude.json</code>: the last session in each project, as the client measured it — including the frame rate of its own terminal UI.',
    }) : ''}
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
    // Anything that wrote something in the last hour, whatever state it is in: a
    // run still going, one that finished ten minutes ago, one that stalled and
    // never wrote a snapshot. All three are what "now" means on a machine that
    // dispatches fan-outs, and only the last hour — nothing ever takes a run off
    // the disk, and a graveyard is not a status.
    const RECENT_MS = 60 * 60 * 1000;
    const now = Date.now();
    // No `r.active` here: these are scanRuns records, which have no such field —
    // it belongs to the { runs, active } shape the bar reads, and testing for it
    // read as a safety net that was never connected to anything.
    const active = (workflows || []).filter((r) => r.state === 'running'
        || (r.lastActivity > 0 && now - r.lastActivity < RECENT_MS));

    if (rows.length === 0) {
        return `<section class="tab" data-tab="now">
            <p class="empty">Nothing to report yet — no Claude session is open in this window, and no limits have been read.</p>
        </section>`;
    }

    // The headline row answers the four questions in the order they get asked:
    // will the week hold, will this hour hold, will the context hold, what is it
    // costing. Each number carries its own meter rather than a shared axis —
    // they measure different things and share only a scale of 0 to 100%.
    const head = [];
    if (m.weekly) {
        head.push(tile('weekly window', `${m.weekly.pct}%`,
            m.weekly.plan !== null ? `${m.weekly.plan}% of the week gone` : '', m.weekly.pct));
    }
    if (m.session5h) {
        head.push(tile('5-hour window', `${m.session5h.pct}%`,
            `resets in ${fmtLeft(m.session5h.resetIn, 0)}`, m.session5h.pct));
    }
    if (m.context) {
        head.push(tile('context', `${m.context.estimated ? '~' : ''}${m.context.pct}%`,
            `${tok(m.context.tokens)} of ${tok(m.context.window)}`, m.context.pct));
    }
    if (m.spend) {
        head.push(tile('this session', `~${fmtCost(m.spend.cost)}`,
            m.spend.burn > 0 ? `~${fmtCost(m.spend.burn)} an hour` : ''));
    }

    return `<section class="tab" data-tab="now">
        ${head.length ? tiles(...head) : ''}
        ${paceTrack(m.weekly)}
        <div class="cols">
          ${rows.map((section) => panel(section.title, statusBlocks(section.blocks), { id: section.id })).join('')}
        </div>
        ${active.length ? panel('Workflows in the last hour', runsTableOf(runRows(active)), {
        flush: true,
        note: 'Every run that wrote something in the last hour — still going, just finished, or stalled without a snapshot. Open one for its agents: what each was told, what it answered, the model and the effort it got, and what it cost. The same table over every run on the machine is under Work → Agents &amp; workflows.',
    }) : ''}
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

    const presets = `<div class="presets">
          ${(cfg.presets || []).map((p) => `<button class="preset" data-preset="${esc(p.id)}">
            <span class="preset-name">${esc(p.name)}</span>
            <span class="preset-about">${esc(p.about)}</span>
            <span class="preset-preview" data-preset-preview="${esc(p.id)}">${p.segments.map((t) => `<span class="chip-seg">${esc(t)}</span>`).join('')}</span>
          </button>`).join('')}
        </div>`;

    const editor = `<ol class="segs" id="segs">${segments.map(row).join('')}</ol>
        <div class="btns">
          <button class="btn" id="add">Add segment</button>
        </div>`;

    const paletteHtml = `<div class="palette">
          ${Object.entries(byTopic).map(([topic, list]) => `<div class="pal-group">
            <h3>${esc(topic)}</h3>
            ${list.map((f) => `<button class="chip-btn" data-insert="{${esc(f.name)}}" title="${esc(f.doc)}">
              <code>{${esc(f.name)}}</code><span class="pal-val">${f.value ? esc(f.value) : '—'}</span>
            </button>`).join('')}
          </div>`).join('')}
        </div>`;

    return `<section class="tab" data-tab="settings" hidden>
        ${panel('Start from one of these', presets, {
        note: "These are the extension's own settings — the same keys as in <code>settings.json</code>, written straight from here. Each preset below is a whole bar, not a fragment: picking one fills the editor, where you can change it before saving. Nothing is written until you press Save, and nothing needs a reload.",
    })}
        ${panel('Status bar', editor, {
        note: 'One line per status-bar item, left to right. Text outside <code>{…}</code> is yours; <code>[square brackets]</code> mark a group that disappears whole when a placeholder inside it has nothing to say. A segment with nothing to show hides itself.',
    })}
        ${panel('Placeholders', paletteHtml, {
        note: 'Click one to insert it into the segment you last edited. The value beside each name is what it says on this machine right now.',
    })}
        ${panel('Reading and the network', [
        toggle('autoRefresh', 'Refresh on a timer', cfg.autoRefresh !== false,
            `Redraw the page and the bar every ${esc(String(Number(cfg.refreshInterval) || 60))} seconds. Off, the expensive pass happens only when you press Reindex.`),
        toggle('fetchLimits', 'Ask Anthropic for the account limits', cfg.fetchLimits !== false,
            'The one request this extension makes, at most once a minute per machine. Off, nothing leaves the machine and the limit fields stay empty unless something else has already written the shared cache.'),
        toggle('checkPluginUpdates', 'Check the marketplaces for newer plugin versions', Boolean(cfg.checkPluginUpdates),
            'Off by default. Off means the Versions panel compares against the marketplace copy already on this disk.'),
        numberField('monthlyBudget', 'Monthly budget', Number(cfg.monthlyBudget) || 0,
            'Dollars. Above zero, the month is drawn against it and you are told once at 80% and once at 100%. Zero turns both off.'),
    ].join(''), {
        note: 'The same switches that sit beside the things they govern — changing one here changes it there, and both write your own settings straight away.',
    })}
        ${panel('Behaviour', `<table class="kv form">
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
        </div>`)}
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
/* The extension's own mark, inline rather than an <img>: a webview image would
   need asWebviewUri plumbed through and img-src opened in the CSP, for one
   26-pixel glyph that is four shapes. */
.mark { display: flex; align-items: center; gap: 9px; }
.mark svg { display: block; flex: none; border-radius: 6px; }
.ver { font-size: 11.5px; font-weight: 500; opacity: .45; letter-spacing: .02em;
  font-family: var(--vscode-editor-font-family); vertical-align: 2px; }
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
/* A loaded file: its name and size on one line, its text under it. <details>
   rather than a handler, for the same reason the agents of a run use one — the
   page opens it without a script. */
.memory { border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 0; }
.memory > summary { cursor: pointer; display: flex; align-items: baseline; gap: 10px;
  padding: 3px 0; font-size: 12.5px; }
.mem-name { font-family: var(--vscode-editor-font-family); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46ch; }
.memory > summary .dim { font-size: 11px; margin-left: auto; white-space: nowrap; }
.mem-open { flex: none; }
/* Carried in the page, out of the way until asked for. */
.memory.folded { display: none; }
.more-open .memory.folded { display: block; }
.mem-text { margin: 6px 0 10px; padding: 10px 12px; border-radius: 5px; max-height: 460px;
  overflow: auto; background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  font-family: var(--vscode-editor-font-family); font-size: 11.5px; line-height: 1.55;
  white-space: pre-wrap; overflow-wrap: anywhere; }

/* A setting where it stands. The box is drawn rather than native so it reads
   the same in both themes and beside a table. */
.switch { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0 12px;
  cursor: pointer; max-width: 78ch; }
.switch input[type="checkbox"] { position: absolute; opacity: 0; width: 0; height: 0; }
.switch-box { flex: none; width: 30px; height: 17px; border-radius: 9px; margin-top: 1px;
  background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  border: 1px solid var(--vscode-panel-border); position: relative; transition: background .12s; }
.switch-box::after { content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px;
  border-radius: 50%; background: var(--vscode-foreground); opacity: .6; transition: transform .12s, opacity .12s; }
.switch input:checked + .switch-box { background: var(--vscode-charts-blue, #3794ff); border-color: transparent; }
.switch input:checked + .switch-box::after { transform: translateX(13px); opacity: 1; background: #fff; }
.switch input:focus-visible + .switch-box { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.switch-text { font-size: 12.5px; line-height: 1.45; }
.switch-text b { font-weight: 500; }
.switch-text .dim { display: block; font-size: 11.5px; margin-top: 2px; }
.switch.numeric input[type="number"] { flex: none; width: 9ch; font: inherit; padding: 3px 6px;
  border-radius: 4px; background: var(--vscode-input-background, var(--vscode-editor-background));
  color: inherit; border: 1px solid var(--vscode-panel-border); }

/* A block of the page: heading, the sentence under it, and the answer. The
   panel is what makes a tab read as a set of answers instead of a scroll; a
   flush one is for a wide table, which keeps its full width inside the border
   rather than paying for padding twice. */
.panel { background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-panel-border); border-radius: 6px;
  padding: 13px 15px 15px; margin: 0 0 14px; }
.panel-title { font-size: 13px; font-weight: 600; margin: 0 0 2px; opacity: .85; }
/* A div, not a p: a note carries lists and sentences after them, and a <ul>
   inside a <p> is closed by the parser before the list — everything after it
   stopped being the note and lost its indent with it. */
.panel-note { opacity: .6; margin: 4px 0 10px; max-width: 78ch; line-height: 1.5; font-size: 12px; }
.panel-note ul { margin: 6px 0; padding-left: 18px; }
.panel-title + .panel-body, .panel-note + .panel-body { margin-top: 9px; }
.panel-body > :first-child { margin-top: 0; }
.panel-body > :last-child { margin-bottom: 0; }
.panel-flush { padding-left: 0; padding-right: 0; }
.panel-flush > .panel-title, .panel-flush > .panel-note { padding: 0 15px; }
.panel-flush > .panel-body { overflow-x: auto; }
/* A flush panel drops its side padding so the table can run to the edge. Only
   the table wants that: anything else in the body — a switch, a paragraph —
   has to be put back in line with the heading above it. */
.panel-flush > .panel-body > :not(table) { padding-left: 15px; padding-right: 15px; }
.panel-flush th:first-child, .panel-flush td:first-child { padding-left: 15px; }
.panel-flush th:last-child, .panel-flush td:last-child { padding-right: 15px; }
/* Two panels side by side where the page is wide enough for it. */
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 14px; margin-bottom: 14px; }
.pair > .panel { margin: 0; }

/* The full name of a label that did not fit, on hover. The title attribute
   covers the same ground and stays as the fallback, but it waits about a second
   and cannot be styled; this appears at once. Only cells the script found
   clipped get it, so it never covers a name that was already whole. */
[data-clipped] { position: relative; }
[data-clipped]:hover::after {
  content: attr(title); position: absolute; left: 0; top: calc(100% + 2px); z-index: 40;
  padding: 3px 8px; border-radius: 4px; white-space: nowrap; font-size: 11.5px;
  font-weight: 400; text-transform: none; letter-spacing: 0; opacity: 1;
  color: var(--vscode-foreground);
  /* Two layers, and the first one is the point: a hover widget colour a webview
     was never given leaves the box transparent, and a transparent tooltip is
     the row underneath read through the row above it. The editor background is
     always defined and always opaque, so it goes underneath whatever the theme
     does or does not provide. */
  background-color: var(--vscode-editor-background);
  background-image: linear-gradient(var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)),
    var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
  box-shadow: 0 2px 10px rgb(0 0 0 / .45); pointer-events: none; }

/* A share drawn under the number rather than beside it: it costs no column, and
   a rule under the figure cannot fight the figure. A block behind the text was
   tried first and read as a selection highlight rather than as a magnitude. */
td.share { position: relative; }
td.share i { position: absolute; right: 0; bottom: 2px; height: 2px; border-radius: 1px;
  background: var(--vscode-charts-blue, #3794ff); opacity: .55; }
td.share.wide i { left: 0; right: auto; }

/* The headline row of any tab. Numbers are set in the editor's own monospace at
   a size the rest of the page never uses, so the answers read before any label
   does; labels drop to a small-caps treatment and get out of the way. One strip
   with hairline separators rather than a row of separate boxes: the tiles of a
   tab answer one question together.

   A tile deliberately has no min-width of zero. A grid item allowed to shrink
   below its content clips the number instead of wrapping the row, and a clipped
   number is a wrong number. */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(152px, 1fr));
  gap: 1px; border-radius: 6px; overflow: hidden; margin-bottom: 16px; }
/* The hairline belongs to each tile rather than to the strip behind them: with
   a background on the strip, six tiles across five columns left the sixth
   beside an empty cell painted like a tile that is not there. */
.tile { display: flex; flex-direction: column; gap: 5px; padding: 12px 14px 13px;
  background: var(--vscode-editor-background);
  box-shadow: 0 0 0 1px var(--vscode-panel-border); }
.tile-label { font-size: 10px; text-transform: uppercase; letter-spacing: .09em; opacity: .5; }
.tile-value { font-family: var(--vscode-editor-font-family); font-size: 24px; line-height: 1.05;
  font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.tile-meter { display: block; height: 3px; border-radius: 2px; overflow: hidden;
  background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); }
.tile-meter i { display: block; height: 100%; border-radius: 2px; }
/* Pushed to the bottom so a tile with no meter keeps its sub on the same
   baseline as the tiles beside it. */
.tile-sub { font-size: 11px; opacity: .55; min-height: 14px; margin-top: auto; }
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
/* Fixed layout, so the three columns are shares of the panel rather than of
   their own content. Under the default auto layout the label and the value both
   claimed their full width and the table grew past the panel — visible only as
   text crossing into the panel beside it, because the body clips horizontally
   and so nothing scrolls to give it away. */
.bars { width: 100%; table-layout: fixed; border-collapse: collapse; }
.bars th, .bars td { border: none; padding: 3px 0; vertical-align: middle; }
.bars th { font: inherit; text-transform: none; letter-spacing: 0; opacity: .85;
  text-align: left; white-space: nowrap; padding-right: 14px; width: 38%; }
/* A long key — a file path, an MCP tool id — otherwise takes the whole row and
   squeezes the bar out of existence, which is the one thing the bar is for. The
   clamp is on a span rather than on the cell: a max-width on a table cell is
   advisory under the default auto layout, and was being ignored. The full text
   is on the row's title attribute. */
.bars th span { display: block; overflow: hidden; text-overflow: ellipsis; }
.bar-cell { width: auto; padding-right: 12px !important; }
/* Tinted from the foreground rather than painted with a surface colour: inside
   a panel the widget background IS the panel, and the track disappeared. */
.bar-track { display: block; border-radius: 3px; height: 14px; overflow: hidden;
  background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
.bar-fill { display: block; height: 100%; border-radius: 3px;
  background: var(--vscode-charts-blue, hsl(200 62% 55%)); }
/* A value wraps rather than clipping: half a figure is a wrong figure, and an
   ellipsis inside a number is worse than a second line. keep-all stops a break
   from landing inside one. */
.bar-val { opacity: .7; text-align: right; white-space: normal; word-break: keep-all;
  font-variant-numeric: tabular-nums; width: 30%; }
.hour-bar { fill: var(--vscode-charts-blue, hsl(200 60% 55%)); }
table { width: 100%; border-collapse: collapse; }
/* A path, a JSON setting or a hook command is one long unbreakable token as far
   as the browser is concerned; anywhere-wrapping is what keeps it inside its
   column instead of widening the table past the panel. */
th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--vscode-panel-border);
  overflow-wrap: break-word; }
/* break-word, not anywhere, and the difference is not cosmetic: only anywhere
   lets a break count towards a cell's min-content width, so a shrink-to-fit
   column could be one character wide. That is what "model" and "allow" and
   "service" became — a letter per line down the page. break-word still breaks a
   token that genuinely cannot fit; it simply does not offer to. The cells that
   really do hold unbreakable strings — paths, hook commands, JSON — ask for
   anywhere by name below. */
th { font-weight: 600; opacity: .6; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  overflow-wrap: normal; }
/* A path, a permission rule, a hook command or a settings value is one long
   token with nothing to break on, and holding it whole widens the table past
   its panel. Every selector here is a cell that takes the width left over, so
   it has no shrink-to-fit column to collapse into. */
.mono, td.wrap, .kv td { overflow-wrap: anywhere; }
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
  .tiles { grid-template-columns: repeat(auto-fit, minmax(124px, 1fr)); }
  .tile { padding: 9px 11px 10px; }
  .tile-value { font-size: 19px; }
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
/* A five-column summary stretched across a full-width panel puts a metre of
   whitespace between a label and its number. It is as wide as it needs to be. */
.panel-body > .matrix { width: auto; min-width: min(100%, 460px); }
.heat-cell { border-radius: 2px; }
.grid { stroke: currentColor; opacity: .12; }
.plan { stroke: currentColor; opacity: .35; stroke-dasharray: 4 4; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
code { font-family: var(--vscode-editor-font-family); font-size: 11.5px; opacity: .85; }
.kv { width: 100%; }
/* The key column stays as narrow as its content allows but may wrap: an env
   var name is forty characters, which on one line was wider than the panel it
   sits in on a split editor.

   break-word rather than the anywhere every other cell gets, and the difference
   is the whole rule: only anywhere lets a break count towards the min-content
   width, and a shrink-to-fit column whose min-content is one character
   collapses to one character — which is what "model" rendered as, stacked down
   the page a letter at a time. */
.kv th[scope="row"] { text-transform: none; letter-spacing: 0; font-size: inherit;
  font-weight: 500; opacity: .75; width: 1%; padding-right: 14px; }
/* The clamp is on a span, because a max-width on a table cell is advisory under
   the default auto layout — the same trap the bar lists fell into. Inside it,
   break-word rather than the anywhere every other cell gets: only anywhere lets
   a break count towards min-content, and a shrink-to-fit column whose
   min-content is one character collapses to one character, which is what
   "model" rendered as — stacked down the page a letter at a time. */
.kv th[scope="row"] span { display: block; max-width: 26ch; overflow-wrap: break-word; }
/* A label inside a header cell wraps like text: the form's row headings are
   sentences, not identifiers. */
.kv th[scope="row"] label { overflow-wrap: break-word; }
.kv td { font-variant-numeric: tabular-nums; }
/* An environment variable is an identifier, not prose: the longest one here is
   40 characters and cannot wrap into half a panel without either widening the
   table past it or breaking mid-word. So this one is clipped with an ellipsis
   and says the whole of itself on hover, which is what [data-clipped] already
   does everywhere else on the page. Fixed layout is what makes the clip
   possible at all — under auto layout the cell asks for its content's width and
   the panel gives it. */
.envkv { width: 100%; table-layout: fixed; }
.envkv th[scope="row"] { width: 55%; }
.envkv th[scope="row"] span, .envkv td span {
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: none;
}
/* The marker is drawn, not placed. An element inside the clipped span keeps
   reporting its full rectangle however hidden it is — overflow: hidden clips
   what you see, not what geometry measures — so a marker written as a <i> was
   both invisible and 161 px outside the panel, which is exactly the shape of
   defect the probe exists to catch. A pseudo-element is part of the text and is
   cut by the same ellipsis as the value it follows. */
.envkv td[data-undoc] span::after { content: ' · undocumented'; opacity: 0.55; }
/* Right-aligned, but allowed to wrap: the last cell of a .kv table is a figure
   on some tabs and a file path on others, and kept on one line the path was
   what pushed Health past its panel in a narrow window. */
/* Wraps, but on words: the last cell of a .kv table holds a settings path, and
   anywhere from the rule above broke a settings path into three lines down a
   narrow column. */
.kv td:last-child { text-align: right; white-space: normal; overflow-wrap: break-word; }
/* The settings form reuses .kv for its layout, but its last column is a
   sentence, not a figure — kept on one line it was what pushed the tab past a
   narrow window. */
.kv.form td:last-child { text-align: left; white-space: normal; }
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

/* Columns rather than a grid: panels of wildly different heights leave a grid
   row half empty, and multicol packs them. A panel may not be split across a
   column break — half a table at the foot of one column is unreadable. */
.cols { columns: 3 300px; column-gap: 14px; margin-bottom: 8px; }
.cols > .panel { break-inside: avoid; }
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
// The countdown to the next rebuild. Rendered as a deadline rather than as a
// number, because the page is redrawn on that very tick — a number printed into
// the markup would be a whole interval out of date the moment it arrived.
const nextEl = document.getElementById('next');
const pauseEl = document.getElementById('pause');
if (nextEl && pauseEl) {
  const every = (Number(nextEl.dataset.every) || 60) * 1000;
  let due = Number(nextEl.dataset.next);
  const paint = () => {
    const on = pauseEl.dataset.on === '1';
    pauseEl.textContent = on ? 'Pause' : 'Resume';
    pauseEl.title = on
      ? 'Stop rebuilding the page on the timer. The same claudeStatusline.autoRefresh you can set on the Settings tab.'
      : 'Rebuild the page on the timer again.';
    if (!on) { nextEl.textContent = 'paused'; return; }
    const left = Math.round((due - Date.now()) / 1000);
    nextEl.textContent = left > 0 ? 'next in ' + left + 's' : 'refreshing…';
  };
  // One setting, two controls: the switch on the Settings tab and this button
  // are the same autoRefresh, so flipping either has to move the other. The
  // page is not rebuilt on the way into a pause — that rebuild would throw away
  // the expanded lists the pause exists to keep — so the header updates itself
  // rather than waiting to be redrawn.
  const setAuto = (on) => {
    pauseEl.dataset.on = on ? '1' : '0';
    if (on) due = Date.now() + every;
    for (const box of document.querySelectorAll('input[data-set="autoRefresh"]')) box.checked = on;
    paint();
  };
  pauseEl.addEventListener('click', () => {
    const on = pauseEl.dataset.on !== '1';
    setAuto(on);
    if (api) api.postMessage({ type: 'set', key: 'autoRefresh', value: on });
  });
  document.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-set="autoRefresh"]');
    if (box) setAuto(box.checked);
  });
  paint();
  setInterval(paint, 1000);
}

// A control carrying a data-set attribute writes its own setting the moment it moves.
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-set]');
  if (!el || !api) return;
  const value = el.type === 'checkbox' ? el.checked : Number(el.value);
  if (el.type === 'number' && !Number.isFinite(value)) return;
  api.postMessage({ type: 'set', key: el.dataset.set, value });
});

document.addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) {
    more.closest('.panel-body').classList.add('more-open');
    more.remove();
    return;
  }
  const open = e.target.closest('[data-open]');
  if (!open || !api) return;
  // Inside a <summary>: without this the click also toggles the disclosure,
  // so the file would open and the text would flap shut behind it.
  e.preventDefault();
  e.stopPropagation();
  api.postMessage({ type: 'open', path: open.dataset.open });
});

let scrollTimer = null;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => remember({ scrollY: window.scrollY }), 150);
});

// A label that has been cut short says so, and says the whole of itself on
// hover. The title attribute is already on every one of them and stays as the
// fallback — this only marks the ones actually clipped at the current width, so
// the hover panel never appears over a name that is already whole.
function markClipped() {
  for (const el of document.querySelectorAll('.bars th span, .kv th[scope="row"] span, .envkv td span, td.wrap')) {
    const cut = el.scrollWidth > el.clientWidth + 1;
    const cell = el.closest('th, td');
    if (cut) cell.setAttribute('data-clipped', '');
    else cell.removeAttribute('data-clipped');
  }
}
addEventListener('load', markClipped);
let clipTimer = null;
addEventListener('resize', () => { clearTimeout(clipTimer); clipTimer = setTimeout(markClipped, 120); });
// A tab is laid out only once it is on screen, so its own widths are unknown
// until it opens.
document.addEventListener('click', (e) => {
  if (e.target.closest('nav button')) requestAnimationFrame(markClipped);
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
/**
 * What Claude Code has been told, against what it can be told.
 *
 * The tab answers three questions and keeps them apart, because only the first
 * is knowable from this machine: what is set, what could be set, and what
 * differs from the documented default. The second and third come from a
 * registry parsed out of the published reference, so the page says when that
 * reference was last read — a settings list without a date reads as current
 * forever, and this client ships settings most weeks.
 */
function clientTab(client, cfg = {}) {
    if (!client) {
        // Not a failure, and it must not read as one. The extension always has a
        // chain to show — a file that is not there is a row saying so — so this
        // branch is only reached where the settings were never collected: the
        // preview tool in demo mode, which renders invented data and has no
        // invented machine to read.
        return '<section class="tab" data-tab="client" hidden><p class="empty">'
            + 'This tab reads the settings of the machine it runs on, and there is none here.</p></section>';
    }
    const c = client.counts;
    const fetched = Boolean(cfg.fetchChangelog);
    const dash = (s) => (s ? esc(s) : '<span class="dim">—</span>');

    const chainBody = `<table><thead><tr><th>Scope</th><th>File</th><th class="num">Keys</th><th class="opt">State</th></tr></thead><tbody>
        ${client.chain.map((f) => `<tr>
            <td>${esc(f.scope)}${f.documented ? '' : ' <span class="dim">undocumented</span>'}</td>
            <td class="path" title="${esc(f.path)}"><span>${esc(f.path)}</span>${f.exists ? `<button class="link mem-open" data-open="${esc(f.path)}">open</button>` : ''}</td>
            <td class="num">${f.exists ? String(f.keys) : ''}</td>
            <td class="opt">${f.exists ? '<span class="ok">read</span>' : '<span class="idle">not there</span>'}</td>
        </tr>`).join('')}
    </tbody></table>`;

    const setRow = (e) => `<tr>
        <td title="${esc(e.description || e.key)}"><span>${esc(e.key)}</span></td>
        <td class="wrap" title="${esc(e.value)}">${esc(e.value)}${e.masked ? ' — hidden' : ''}</td>
        <td class="opt2">${e.differs ? `<span class="o-failed">${esc(e.default)}</span>` : dash(e.default)}</td>
        <td class="opt dim" title="${esc(e.path)}">${esc(e.from)}${e.shadowed.length ? ` <span class="idle">over ${e.shadowed.length}</span>` : ''}</td>
    </tr>`;
    const setBody = client.set.length
        ? `<table><thead><tr><th>Setting</th><th>Value</th><th class="opt2">Default</th><th class="opt">From</th></tr></thead>
           <tbody>${client.set.map(setRow).join('')}</tbody></table>`
        : '<p class="empty">Nothing is set: this client is running on its defaults.</p>';

    // Two lists that are not the same thing, side by side because the difference
    // is the point. The block in settings.json is what every session gets; the
    // window's own environment is what this extension host happens to have, and
    // a session started from a terminal inherits the shell instead.
    const envTable = (rows, empty) => (rows.length
        ? `<table class="kv envkv"><tbody>${rows.map((r) => `<tr>
            <th scope="row" title="${esc(r.key)}${r.description ? ` — ${esc(r.description)}` : ''}"><span>${esc(r.key)}</span></th>
            <td title="${esc(r.value)}"${r.known ? '' : ' data-undoc'}><span>${esc(r.value)}</span></td>
        </tr>`).join('')}</tbody></table>`
        : `<p class="empty">${empty}</p>`);

    const envBody = `<div class="pair">
        ${panel('Set for every session', envTable(client.env.fromSettings, 'No env block in any settings file.'), {
        note: client.env.shadowed.length
            ? `From the winning file only. ${client.env.shadowed.length} other file${client.env.shadowed.length === 1 ? '' : 's'} also define an <code>env</code> block, and the reference does not say object values merge.`
            : 'The <code>env</code> block of the settings file that won, applied to every session and to what it spawns.',
    })}
        ${panel('This window has', envTable(client.env.fromHost, 'This window inherited no Claude variables.'), {
        note: 'The environment of the editor, not of a session. VS Code launched from the Dock inherits launchd; a session you start in a terminal inherits your shell profile. They disagree often enough that this is a hint, not an answer.',
    })}
    </div>`;

    const unknownBody = client.unknown.length
        ? `<table><thead><tr><th>Setting</th><th>Value</th><th class="opt">From</th></tr></thead>
           <tbody>${client.unknown.map((e) => `<tr>
               <td><span>${esc(e.key)}</span></td>
               <td class="wrap" title="${esc(e.value)}">${esc(e.value)}${e.masked ? ' — hidden' : ''}</td>
               <td class="opt dim" title="${esc(e.path)}">${esc(e.from)}</td>
           </tr>`).join('')}</tbody></table>`
        : '';

    const unsetBody = client.unset.length
        ? `<details class="memory"><summary>
            <span class="mem-name">${client.unset.length} you have not set</span>
            <span class="dim">running on the documented default</span>
          </summary>
          <table><thead><tr><th>Setting</th><th class="opt2">Default</th><th class="opt">What it does</th></tr></thead><tbody>
            ${client.unset.map((e) => `<tr>
                <td><span>${esc(e.key)}</span>${e.managedOnly ? ' <span class="idle">managed only</span>' : ''}</td>
                <td class="opt2">${dash(e.default)}</td>
                <td class="opt dim wrap" title="${esc(e.description)}">${esc(e.description)}</td>
            </tr>`).join('')}
          </tbody></table></details>`
        : '';

    return `<section class="tab" data-tab="client" hidden>
        ${tiles(
        tile('Set', String(c.set + c.unknown), c.documented ? `of ${c.documented} in the reference` : 'no reference loaded'),
        tile('Differ from the default', String(c.differs), c.differs ? 'the answer to "what did I change"' : 'every one matches'),
        tile('Available', String(c.unset), 'documented, and not set here'),
        c.unknown ? tile('Not in the reference', String(c.unknown), 'newer than the list below, or a typo') : null,
    )}
        ${panel('Where settings are read from', chainBody, {
        flush: true,
        note: 'Highest precedence first, which is the order the client resolves them in: a managed file overrides everything, then the project, then you. <code>~/.claude/settings.local.json</code> is read because it exists and holds ordinary keys, but the published precedence list does not mention it — so it is marked rather than presented as the client\'s own order.',
    })}
        ${panel('Set on this machine', setBody, {
        flush: true,
        note: 'A red default is one you have moved away from. <span class="idle">over N</span> means the same key is stated in N files further down the chain and lost.',
    })}
        ${envBody}
        ${unknownBody ? panel('Set, but not in the reference', unknownBody, {
        flush: true,
        note: `These are read by the client all the same. A key lands here when it shipped after the reference below was last read${client.checkedAt ? ` on ${esc(client.checkedAt)}` : ''}, or when it is misspelled — the page cannot tell those apart, and guessing which is which is how a real setting gets called a typo.`,
    }) : ''}
        ${unsetBody ? panel('Everything else you could set', unsetBody, { flush: true }) : ''}
        ${panel('Where this reference comes from', toggle('fetchChangelog',
        'Fetch the reference and the changelog from Anthropic', fetched,
        'Two public documentation files and the changelog, no credentials, at most once an hour. Off, the list below is the one packaged with this extension.'), {
        note: client.checkedAt
            ? `Parsed from <code>code.claude.com/docs/en/settings.md</code> and <code>env-vars.md</code>, read on ${esc(client.checkedAt)}: ${c.documented} settings and ${c.variables} variables. ${fetched ? 'Refreshed in the background and kept in the extension\'s own storage, so this still reads offline.' : 'This is the packaged copy — settings ship most weeks, so it drifts.'}`
            : 'No reference is loaded, so this tab can only say what is set — not what else exists, nor what any of it defaults to.',
    })}
    </section>`;
}

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
        ['context', 'Memory & context'],
        ['client', 'Claude Code'],
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
    // Every panel on the page draws a model in this colour from here on, however
    // its own rows happen to be sorted.
    assignModelColors(modelOrder);
    const dayModels = dayModelMatrix(index);

    const projects = Object.entries(total.projects).sort((a, b) => b[1].cost - a[1].cost);
    const branches = Object.entries(total.branches).sort((a, b) => b[1].cost - a[1].cost);
    const skills = Object.entries(total.skills).sort((a, b) => b[1].cost - a[1].cost);

    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Claude Dashboard</title><style>${STYLE}</style></head><body>
<div class="mark">${MARK}<h1>Claude Dashboard <span class="ver">v${esc(VERSION)}</span></h1></div>
<p class="sub">${plural(meta.files, 'transcript')} indexed${meta.lastRun ? ` · updated ${esc(fmtDateTime(meta.lastRun))}` : ''}
 · <button id="refresh" class="link">Reindex</button>
 <span class="dim" id="next" data-next="${Number(meta.lastRun || 0) + (Number((meta.config || {}).refreshInterval) || 60) * 1000}" data-every="${Number((meta.config || {}).refreshInterval) || 60}">·</span>
 <button id="pause" class="link" data-on="${(meta.config || {}).autoRefresh === false ? '0' : '1'}">·</button></p>
${navHtml()}
${nowTab(meta.now, meta.workflows, meta.metrics)}
${overviewTab(total, dayModels, modelOrder, meta.config || {})}
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
${healthTab(total, meta.system, meta.config || {})}
${jobsTab(meta.system)}
${liveTab(meta.system)}
${tasksTab(meta.system)}
${diskTab(meta.system)}
${contextTab(total, meta.system)}
${clientTab(meta.client, meta.config || {})}
${changelogTab(meta.system || {}, meta.config || {})}
<footer>All spend figures are estimates from public per-million-token rates, not a bill.</footer>
<script>${SCRIPT}</script></body></html>`;
}

module.exports = {
    render, stackedDays, heatmap, barList, hourChart, dayModelMatrix,
    lineChart, stackedTokens, matrixTable, quantiles, effortMatrix, mcpServer,
    sessionLabel, navHtml, SECTIONS, CACHE_PARTS,
    agentsTab, healthTab, jobsTab, liveTab, diskTab, contextTab, tasksTab, changelogTab, clientTab, filesTab, settingsTab,
    limitsTab, weekLabel, nowTab, paceTrack, statusBlocks, meterTone,
    tile, tiles, panel, shareCell, assignModelColors,
    shortModel, tok, bytes, plural, fmtDur, esc,
    // The stylesheet, for the one test that holds this page's `.o-*` rules
    // against the two outcome tables the tree and the hover keep: a word the
    // vocabulary gains and the CSS does not draws as unstyled text here, and
    // nothing else would notice.
    STYLE,
};
