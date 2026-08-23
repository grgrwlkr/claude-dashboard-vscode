// The dashboard webview: tabs, tables and hand-rolled SVG charts.
//
// Everything is drawn from the index, which already holds aggregates — the
// webview never touches a transcript, so opening a tab costs nothing. Charts are
// SVG built as strings: a charting library would be the only dependency in the
// project and would buy nothing that a bar and a heatmap need.
//
// Colours come from VS Code theme variables, so the page follows light, dark and
// high-contrast themes without a palette of its own.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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

// A day key — `2026-08-11` — as a date. Day first, because everything else on
// this page and in the status bar writes one that way (`dayLabel` in usage.js,
// `Thu 13.08`), and the old `08.11` read as the eighth of November to anyone
// not told it was the American order.
const fmtDay = (key) => `${String(key).slice(8, 10)}.${String(key).slice(5, 7)}`;

// The same day with its weekday, for a list that has room for it: a row of
// figures next to `Tue 11.08` says which of the peaks are weekends. The axis
// ticks of a chart do not get this — there the labels sit a few pixels apart.
const fmtDayLong = (key) => {
    const at = new Date(`${key}T00:00:00`);
    return Number.isNaN(at.getTime()) ? fmtDay(key) : `${WEEKDAYS[at.getDay()]} ${fmtDay(key)}`;
};

// Weekdays, durations and the way a forecast is written all come from usage.js,
// so the bar in the corner of the editor and this page name a day, a length of
// time and a forecast identically.
const { WEEKDAYS, fmtLeft, fmtWhen } = require('./usage');

function fmtDateTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${WEEKDAYS[d.getDay()]} ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The clock alone, for the header pill that says when the index was last built.
 * The day is dropped rather than abbreviated: the pill sits beside a countdown
 * to the next build, so the question it answers is "how fresh", and a date is
 * only interesting when the answer is "not fresh at all" — which is what the
 * full timestamp on its title attribute is for.
 */
function fmtClock(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Short model label: "claude-opus-5" → "opus 5". Full ids are noise in a table.
// In place of a reply that never arrived — a spent limit, a dropped connection,
// a 403 — Claude Code writes a record of its own and marks it with this id. Its
// usage is all zeroes, so it costs nothing and buys nothing: a refusal log, not
// a model, and therefore not a row in any breakdown of models.
const SYNTHETIC_MODEL = '<synthetic>';

function modelRows(models) {
    return Object.entries(models).filter(([m]) => m !== SYNTHETIC_MODEL);
}

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
function barList(entries, {
    value = (b) => b.cost, label = fmtCost, limit = 12, byModel = false, scaleMax = 0,
    // What a row is about, for the hover — the key by default, a full path where
    // the key is only its last component. And an optional cell after the figure:
    // **markup**, like `panel`'s note, so a caller can put a control there. Both
    // are opt-in; every existing list renders exactly as it did.
    titleOf = null, after = null,
} = {}) {
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
        return `<tr><th scope="row" title="${esc(titleOf ? titleOf(b, key) : key)}"><span>${esc(key)}</span></th>`
            + `<td class="bar-cell"><span class="bar-track">`
            + `<span class="bar-fill" style="width:${w.toFixed(1)}%${fill ? `;${fill}` : ''}"></span>`
            + `</span></td>`
            // The key travels to `label` too: a figure is sometimes an estimate
            // because of what the row *is*, not because of what it adds up to.
            + `<td class="bar-val">${esc(label(v, b, key))}</td>`
            + (after ? `<td class="bar-act">${after(b, key)}</td>` : '')
            + '</tr>';
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
// `aside` is markup the caller has already escaped — the state of the thing the
// panel is about, drawn on the title's own line. Without it the title stays
// exactly as it was, because most panels on this page have no state to show.
const panel = (title, body, { note, flush, id, aside } = {}) => `<section class="panel${flush ? ' panel-flush' : ''}"${id ? ` data-panel="${esc(id)}"` : ''}>
    ${title && aside
        ? `<div class="panel-head"><h2 class="panel-title">${esc(title)}</h2>${aside}</div>`
        : title ? `<h2 class="panel-title">${esc(title)}</h2>` : ''}
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
    // Filtered here rather than only at the caller: the refusal log is not a
    // model on any of these three panels, whoever assembled the order.
    const order = modelOrder.filter((m) => m !== SYNTHETIC_MODEL);
    const legend = `<div class="legend">${order.slice(0, 7).map((m, i) =>
        `<span class="chip"><i style="background:${modelColor(m, i)}"></i>${esc(shortModel(m))}</span>`).join('')}</div>`;
    return `<section class="tab" data-tab="overview" hidden>
        ${statCards(total, cfg)}
        ${panel('Daily spend by model', stackedDays(total.days, order, dayModels) + legend)}
        ${panel('Calendar', heatmap(total.days), {
        note: 'One cell per day, darker for a heavier day. Weeks run down, so the same weekday sits on one row.',
    })}
        ${panel('Models', barList(
        modelRows(total.models).sort((a, b) => b[1].cost - a[1].cost),
        {
            byModel: true,
            // A model with no entry in `RATES` is billed at the FALLBACK rate,
            // which *is* the Opus rate — the number is a guess, and it says so
            // with the tilde every other estimate on this page carries.
            label: (v, b, m) => `${ratesFor(m).known ? '' : '~'}${fmtCost(v)} · ${tok(b.in + b.cacheRead + b.cacheWrite + b.out)}`,
            titleOf: (b, m) => (ratesFor(m).known ? m : `${m} — no published rate, priced at Opus rates`),
        },
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
        <td class="num opt3">${esc(fmtDur(s.activeMs))}</td>
        <td class="num">${s.msgs}</td>
        <td class="num opt2">${esc(tok(s.tokens))}</td>
        ${shareCell(fmtCost(s.cost), dearest > 0 ? s.cost / dearest : 0)}</tr>`).join('');
    const table = `<table><thead><tr><th>Last activity</th><th>Project</th><th>Session</th><th class="opt3">Kind</th><th class="opt">Client</th>
        <th class="opt3">Models</th><th class="opt">Effort</th>
        <th class="num opt2">Open</th><th class="num opt3">Working</th><th class="num">Requests</th><th class="num opt2">Tokens</th><th class="num">Spend</th></tr></thead>
        <tbody>${rows}</tbody></table>`;

    // A day's spend says how much was done and nothing about the shape of it:
    // one session for nine hours and nine for one are the same figure.
    //
    // Main transcripts only. Counting every transcript answers a different
    // question — one fan-out of a hundred agents reads as a hundred parallel
    // sessions, which is true of the machine and false of the person driving it.
    // The width of a fan-out is already the Agents tab's subject.
    const own = total.sessions.filter((s) => s.kind === 'main');
    const days = ix.peakParallel(own);
    const widest = Object.entries(days).sort((a, b) => b[1].peak - a[1].peak
        || b[0].localeCompare(a[0]))[0];
    const open = own.reduce((a, s) => a + Math.max(0, s.end - s.start), 0);
    const working = own.reduce((a, s) => a + (s.activeMs || 0), 0);

    return `<section class="tab" data-tab="sessions" hidden>
        ${tiles(
        widest ? tile('Peak parallel sessions', String(widest[1].peak),
            `${fmtDay(widest[0])} · ${clock(widest[1].at)} · ${plural(widest[1].sessions, 'session')} that day, agents aside`) : '',
        working ? tile('Time actually working', fmtDur(working),
            `of ${fmtDur(open)} with a session open · ${pct(working, open)}`,
            open > 0 ? Math.round((working / open) * 100) : null, 'cool') : '',
    )}
        ${panel('Every transcript', table, {
        flush: true,
        note: `Newest first, capped at 300 rows of ${total.sessions.length}. A row is one transcript: a main session, a subagent, or one agent of a workflow. <em>Open</em> is first record to last; <em>working</em> drops the gaps longer than five minutes, which is a session left sitting rather than one thinking. The name is the session's own title where it has one, and the rule under a spend is that row against the dearest one shown.`,
    })}
    </section>`;
}

// Minutes past midnight as a clock face, for a peak that happened at one.
function clock(ms) {
    const m = Math.round(ms / 60000);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
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

    // Which kind of agent the fan-out money went to. The type is not in the
    // transcript — it is in the meta file the client writes beside it — so an
    // agent old enough to predate that file has spend here and no type, and is
    // absent from this list rather than lumped into a bucket it never chose.
    const byType = Object.entries(total.agents || {}).sort((a, b) => b[1].cost - a[1].cost);
    const typed = byType.reduce((a, [, b]) => a + b.cost, 0);

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
        ${byType.length ? panel('Spend by agent type', barList(byType, {
        label: (v, b) => `${fmtCost(v)} · ${plural(b.msgs, 'reply', 'replies')}`,
    }), {
        note: `The type each dispatch asked for, read from the meta file beside every subagent transcript. ${pct(typed, sum(agents) + sum(wf))} of subagent and workflow spend is typed this way; the rest is older than the meta file and has no type to be ranked under.`,
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
        Object.entries(log.byDay).sort((a, b) => b[1] - a[1]).map(([k, n]) => [fmtDayLong(k), { cost: n, msgs: n }]),
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
        if (model === SYNTHETIC_MODEL) continue;
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
        ${breaksPanel(total.breaks)}
    </section>`;
}

/**
 * The replies the cache could not answer — input that had to be sent fresh and
 * billed at the full rate. Every session opens with one, so a count alone would
 * only measure how many sessions there were; the list is what carries the
 * signal, because a big break in the middle of a run is a cache that was
 * rebuilt rather than reused.
 */
function breaksPanel(breaks) {
    if (!breaks || !breaks.count) return '';
    const rows = (breaks.top || []).map((b) => `<tr>
        <td>${b.at ? esc(fmtDateTime(b.at)) : '<span class="dim">—</span>'}</td>
        <td class="wrap">${esc(b.project || '')}</td>
        <td class="dim opt">${esc(sessionLabel({ id: b.session }))}</td>
        <td class="opt2"><span class="kind">${esc(b.kind || 'main')}</span></td>
        <td class="num">${esc(tok(b.uncached))}</td></tr>`).join('');

    return panel('Replies the cache could not answer', `<table><thead><tr><th>When</th><th>Project</th>
        <th class="opt">Session</th><th class="opt2">Kind</th><th class="num">Uncached input</th></tr></thead>
        <tbody>${rows}</tbody></table>`, {
        flush: true,
        note: `${plural(breaks.count, 'reply', 'replies')} sent more than ${tok(ix.CACHE_BREAK_TOKENS)} of input at the full rate, ${tok(breaks.tokens)} in total; the ${(breaks.top || []).length} largest are listed. The first reply of any session is one of these and cannot be avoided — what is worth reading here is a large one partway through a run, or several in the same session within minutes.`,
    });
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
 * the index without its plugin. An agent is looked up in its own tally: what a
 * dispatch asked for is recorded in the meta file beside the transcript it
 * wrote, under the same two names — so an agent old enough to predate that file
 * is still unknown here rather than unused, and a newer one answers plainly.
 */
function componentRows(plugins, skills, agents = {}) {
    const rows = [];
    for (const p of plugins) {
        const c = p.components || {};
        const of = (kind, name) => {
            const from = kind === 'agent' ? agents : skills;
            const key = `${p.name}:${name}`.toLowerCase();
            const hit = from[key] || from[name.toLowerCase()] || null;
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

    const componentRows_ = componentRows(sys.plugins || [], total.skills || {}, total.agents || {});
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
        : '<span class="idle">never</span>'}</td>
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
        note: 'What is configured on this machine, and which of it has actually run. "Idle" means none of its skills, agents, commands or MCP tools appears anywhere in the indexed transcripts. One thing it still cannot see is a hook, which leaves no record at all — so a plugin that ships only hooks reads as idle whether or not it fired.',
    })}
        ${panel('Versions', toggle('checkPluginUpdates', 'Check the marketplaces for newer versions',
        checks, 'One request per marketplace, at most hourly. Off means nothing is asked of the network.')
        + updateTable, {
        flush: true,
        note: updateNote,
    })}
        ${panel('What each plugin actually brings', componentTable, {
        flush: true,
        note: `Every skill, command and agent the installed plugins carry, against what ran. The plugin table above says whether <em>any</em> of a plugin fired; this says which part — ${ranCount} of ${componentRows_.length} components have ever appeared in a transcript. A skill is matched by what the client attributed the reply to, an agent by the type its dispatch recorded beside the transcript it wrote.`,
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
    // Opens the directory in the OS file manager rather than in the editor: a
    // folder is not a document, and what is wanted here is to look inside it —
    // and, if it comes to that, to delete from there. This extension still
    // deletes nothing itself.
    const reveal = (abs) => (abs
        ? `<button class="link" data-reveal="${esc(abs)}" title="${esc(abs)}">show</button>` : '');
    const hogTable = `<table><thead><tr><th>Path</th><th>What it is</th><th class="num">Size</th><th></th></tr></thead><tbody>
          ${d.hogs.map((h) => `<tr><td class="mono" title="${esc(h.abs || h.path)}">${esc(h.path)}</td><td class="dim">${esc(h.note)}</td>
            <td class="num">${esc(bytes(h.bytes))}</td><td class="num">${reveal(h.abs)}</td></tr>`).join('')}
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
        titleOf: (x) => x.path || x.name,
        after: (x) => reveal(x.path),
    }), { note: 'Everything under <code>~/.claude</code>. Nothing here is deleted by this extension and there is no button that would — <b>show</b> opens the directory in Finder and the decision stays yours.' })}
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
 * The week: how much of the quota is gone, how much of it was allowed by now,
 * and when it runs out — on one rail whose axis is the window itself.
 *
 * Spend and time share that axis because an even burn puts x% of the limit at
 * x% of the week. So the fill is the spend, the mark is where the week stands,
 * and the gap between them IS the over- or underspend: no second number to
 * compare, no arithmetic. Red past the mark is spend ahead of the plan; green
 * short of it is plan not yet used.
 *
 * This replaces a rail that measured time alone. That one was written after an
 * earlier version drew the fill from spend while the marks came from the
 * calendar and left the reader to compare them by eye — the fix then was to take
 * spend off the rail entirely. It is back, deliberately: the cells are calendar
 * days with their dates, so the rail reads as a week rather than as a bar that
 * happens to be full, and the two quantities are told apart by shape rather than
 * by the reader.
 *
 * At 100% the forecast is worthless — `(100 - pct) / pct` collapses onto now —
 * so the moment the quota ended comes from the marks file instead, and the mark
 * stays where it happened while `now` keeps moving. The distance between them is
 * how long you have been without quota, and the delta on the fill melts towards
 * zero as the plan catches up: 100% four days early reads +46%, then +32%, then
 * nothing on the day of the reset.
 */
// A day cell narrower than this cannot hold the label at its side of the
// cascade, and a label wider than its cell is one the rail's edge cuts in half.
const DAY_LABELS = [
    { min: 7.5, of: (d) => `${WEEKDAYS[d.getDay()]} ${p2(d.getDate())}.${p2(d.getMonth() + 1)}` },
    { min: 5.0, of: (d) => `${WEEKDAYS[d.getDay()]} ${p2(d.getDate())}` },
    { min: 3.2, of: (d) => `${p2(d.getDate())}.${p2(d.getMonth() + 1)}` },
];

// A day tick this close to a mark is not read as a boundary — it is read as the
// mark being smeared. The mark wins: it is one midnight of seven.
const TICK_CLEARANCE = 0.9;

const p2 = (n) => String(n).padStart(2, '0');
const trackAt = (x) => `${Math.max(0, Math.min(100, x)).toFixed(2)}%`;

// Every local midnight strictly inside the window. Calendar days, not sevenths:
// a fixed window opens at whatever hour it opens, and cells bounded at 14:59
// would be days nobody keeps.
function trackMidnights(opened, reset) {
    const out = [];
    const d = new Date(opened * 1000);
    d.setHours(24, 0, 0, 0);
    for (let ts = Math.floor(d.getTime() / 1000); ts < reset; ts += 86400) out.push(ts);
    return out;
}

function paceTrack(w) {
    if (!w || !w.reset || !w.opened) return '';
    const at = Number.isFinite(w.at) ? w.at : Math.floor(Date.now() / 1000);
    const span = Math.max(1, w.reset - w.opened);
    const pos = (ts) => ((ts - w.opened) / span) * 100;

    const pct = Math.max(0, Math.min(100, Number(w.pct) || 0));
    // Whether the window can be judged against its plan at all — pace() decides
    // it once for every surface (see `settled` there); the fallback covers a
    // caller that built this object by hand, as the tests do.
    const settled = w.settled !== undefined ? w.settled : (at - w.opened >= 1800 && pct >= 2);
    const plan = settled && Number.isFinite(w.plan) ? w.plan : null;
    const nowPos = pos(at);
    // The zone between spend and plan is measured to the mark itself, not to the
    // rounded percentage printed under it. `plan` arrives floored to a whole
    // percent — 6.43% of the week elapsed is reported as 6 — so a zone drawn to
    // 6% while the mark stood at 6.43% left a gap of nearly half a percent
    // between the two, which is four pixels of daylight where the whole point is
    // that the fill and the mark meet.
    const over = plan !== null && pct > nowPos;
    const under = plan !== null && pct < nowPos;

    // The quota is gone when the account says 100%, whatever the forecast makes
    // of it. `ranOut` is the recorded moment; without one the mark has no place
    // to stand and says so rather than standing on now and implying it.
    const spent = pct >= 100;
    const ranOutPos = spent && w.ranOut ? pos(Math.floor(w.ranOut / 1000)) : null;
    const dryPos = !spent && w.dryAt ? pos(w.dryAt) : null;
    const dryInside = dryPos !== null && dryPos <= 100;

    const marks = [nowPos];
    if (ranOutPos !== null) marks.push(ranOutPos);
    if (dryInside) marks.push(dryPos);

    const cells = [w.opened, ...trackMidnights(w.opened, w.reset)].map((ts, i, all) => {
        const end = i + 1 < all.length ? all[i + 1] : w.reset;
        return { ts, left: pos(ts), width: ((end - ts) / span) * 100, today: at >= ts && at < end };
    });

    // Everything this rail used to say in words is now a pill beside the
    // heading, in the order it gets read: how much is gone, where an evenly
    // spent week would be, which side of that the spend is on, and when the
    // quota runs out. The two pills that name a mark on the rail wear a dot in
    // that mark's colour — which is what lets the labels go: the mark is found
    // by its colour rather than by a caption pinned above or below it.
    const pill = (text, tone, colour) => ({ text, tone, colour });
    const pills = [pill(`${pct}% spent`)];
    // The plan mark IS the now line: the plan is the share of the window that
    // has elapsed, so it always stands exactly where the current moment does.
    if (plan !== null) pills.push(pill(`plan ${plan}%`, null, 'var(--vscode-foreground)'));
    if (plan !== null && pct !== plan) {
        pills.push(over ? pill(`${pct - plan}% over`, 'warn') : pill(`${plan - pct}% under`, 'safe'));
    }
    // The forecast is stated in every state, the way the terminal states it —
    // how long until it, then the day and hour. "You will not run out" is worth
    // far more with the date that would have been. A dot only where there is a
    // mark to point at: past the reset the rail has none, and a colour pointing
    // at nothing is worse than no colour.
    const dryColour = 'var(--vscode-charts-red, hsl(0 60% 57%))';
    if (spent) {
        pills.push(w.ranOut
            ? pill(`ran out ${fmtWhen(Math.floor(w.ranOut / 1000))}`, 'alarm', dryColour)
            : pill('out of quota', 'alarm'));
    } else if (dryInside) {
        pills.push(pill(`dry in ${fmtLeft(w.dryAt, at)} → ${fmtWhen(w.dryAt)}`, 'alarm', dryColour));
    } else if (w.dryAt) {
        pills.push(pill(`dry ${fmtWhen(w.dryAt)}, after the reset`, 'safe'));
    } else {
        pills.push(pill('too early to forecast', 'muted'));
    }

    return panel('This week', `<div class="wk">
        <div class="wk-rail">
          <div class="wk-spent" style="width:${trackAt(over ? nowPos : pct)}"></div>
          ${over ? `<div class="wk-excess" style="left:${trackAt(nowPos)};width:${trackAt(pct - nowPos)}"></div>` : ''}
          ${under ? `<div class="wk-slack" style="left:${trackAt(pct)};width:${trackAt(nowPos - pct)}"></div>` : ''}
          ${cells.slice(1).map((c) => c.left).filter((x) => marks.every((m) => Math.abs(m - x) > TICK_CLEARANCE))
        .map((x) => `<div class="wk-day" style="left:${trackAt(x)}"></div>`).join('')}
          <div class="wk-now" style="left:${trackAt(nowPos)}"></div>
          ${dryInside ? `<div class="wk-dry" style="left:${trackAt(dryPos)}"></div>` : ''}
          ${ranOutPos !== null ? `<div class="wk-dry" style="left:${trackAt(ranOutPos)}"></div>` : ''}
          ${cells.map((c) => {
        const fit = DAY_LABELS.find((f) => c.width >= f.min);
        return fit ? `<span class="wk-date${c.today ? ' today' : ''}" style="left:${trackAt(c.left + c.width / 2)}">${esc(fit.of(new Date(c.ts * 1000)))}</span>` : '';
    }).join('')}
        </div>
        <div class="wk-feet">
          <span>opened ${esc(fmtDateTime(w.opened * 1000))}</span>
          <span>resets ${esc(fmtDateTime(w.reset * 1000))} · in ${esc(fmtLeft(w.reset, at))}</span>
        </div>
      </div>`, { id: 'week', aside: pillsHtml({ items: pills }) });
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

const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));

/**
 * A hue per part, keyed by the part's name and never by its place in the list.
 * The breakdown is sorted by size, so an index-keyed palette repaints every row
 * the moment two parts swap order — the same trap `assignModelColors` exists to
 * avoid on the charts. A part this table does not know still gets a stable
 * colour: the hash is of its name, so it keeps it between renders.
 */
const PART_HUES = {
    'rest in use': 210, memory: 265, skills: 160, agents: 35, hooks: 320, mcp: 190, tools: 95,
};
const partColor = (label) => {
    const known = PART_HUES[label];
    if (known !== undefined) return `hsl(${known} 62% 58%)`;
    let hash = 0;
    for (let i = 0; i < String(label).length; i++) hash = (hash * 31 + String(label).charCodeAt(i)) % 360;
    return `hsl(${hash} 62% 58%)`;
};

// `colour` is a mark this pill names elsewhere on the panel — the plan line and
// the dry tick on the week rail. The dot is how those marks kept their meaning
// after their captions came off: the pill says what, the rail says where, and
// the colour is the only thing joining the two.
const pillsHtml = (block) => (block && (block.items || []).length
    ? `<div class="pills">${block.items.map((p) => `<span class="pill${p.tone ? ` pill-${esc(p.tone)}` : ''}">${
        p.colour ? `<i class="pill-dot" style="background:${p.colour}"></i>` : ''}${
        esc(p.text)}${p.value ? ` <b>${esc(p.value)}</b>` : ''}</span>`).join('')}</div>`
    : '');

/**
 * Pills describe the section rather than sit inside it, so both renderers lift
 * them out of the block list and draw them beside their own heading. Returned as
 * a pair so neither has to know that a section may have none.
 */
const splitPills = (blocks) => {
    const list = blocks || [];
    const pills = list.find((b) => b.kind === 'pills');
    return [pillsHtml(pills), pills ? list.filter((b) => b !== pills) : list];
};

/**
 * The task list as one strip across the page rather than a fourth panel.
 *
 * Four panels in a three-column flow leave the shortest column carrying two and
 * the other two ending high — a ragged foot no size of card fixes, because the
 * browser balances the columns and this one is always the odd panel out. Out of
 * the flow it also reads truer: tasks are the state of the work, not a subject
 * beside limits and money.
 *
 * Assembled from the section's own blocks by kind, never by position, so the
 * hover and this strip cannot drift: what `status.js` writes is what both show.
 */
function tasksStrip(section) {
    if (!section) return '';
    const gauge = section.blocks.find((b) => b.kind === 'gauge');
    const active = section.blocks.find((b) => b.kind === 'note' && b.tone === 'active');
    const [pills] = splitPills(section.blocks);
    if (!gauge && !pills) return '';
    return `<div class="strip" data-panel="${esc(section.id)}">
        <span class="strip-name">${esc(section.title)}</span>
        ${gauge ? `<span class="strip-count">${esc(gauge.headline)}</span>
        <span class="strip-track"><i class="t-${meterTone(gauge.pct)}" style="width:${clampPct(gauge.pct)}%"></i></span>
        <span class="strip-pct">${esc(gauge.value)}</span>${
    gauge.sub ? `<span class="strip-sub">${esc(gauge.sub)}</span>` : ''}` : ''}
        ${active ? `<span class="strip-now"><i></i>${
    active.label ? `<em>${esc(active.label)}</em>` : ''}<span>${esc(active.text)}</span></span>` : '<span class="strip-now"></span>'}
        ${pills}
    </div>`;
}

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
        // The one figure a section exists for. `pct` is what makes it a share:
        // without one there is no track, because money is not a share of
        // anything this extension knows, and the context bar is drawn by the
        // breakdown right under it rather than twice.
        if (block.kind === 'gauge') {
            const share = Number.isFinite(block.pct);
            // `bar: false` is a share that draws no track — the context gauge,
            // whose track is the colour bar of the breakdown under it. The tone
            // still comes from the share, which is what turns 98% red.
            const track = share && block.bar !== false;
            const plan = Number.isFinite(block.plan);
            return `<div class="gauge">
                <div class="gauge-top">
                    <div class="gauge-big${share ? ` g-${meterTone(block.pct)}` : ''}">${esc(block.headline)}</div>
                    <div class="gauge-side"><b>${esc(block.value || '')}</b>${block.sub ? `<span>${esc(block.sub)}</span>` : ''}</div>
                </div>
                ${track ? `<div class="gauge-track"><i class="t-${meterTone(block.pct)}" style="width:${clampPct(block.pct)}%"></i>${
    plan ? `<span class="gauge-plan" style="left:${clampPct(block.plan)}%"></span>` : ''}</div>` : ''}
                ${track && plan ? `<div class="gauge-plan-lbl">plan ${block.plan}%</div>` : ''}
                ${(block.chips || []).length ? `<p class="gauge-chips">${block.chips.map((c) => `<span>${esc(c)}</span>`).join('')}</p>` : ''}
            </div>`;
        }
        // One colour bar for the whole, and the list under it is its legend: at
        // 89% against 0.2% a meter column would be seven empty tracks, and a
        // fill behind the text reads as a selected row rather than a share.
        if (block.kind === 'parts') {
            if (!block.rows.length) return '';
            return `<div class="parts">
                <div class="parts-stack">${block.rows.map((r) => `<i style="width:${clampPct(r.pct)}%;background:${partColor(r.label)}"></i>`).join('')}</div>
                <div class="parts-cap"><span>${esc(block.caption)}</span>${block.figure ? `<i>${esc(block.figure)}</i>` : ''}</div>
                ${block.rows.map((r) => `<div class="part" title="${esc(`${r.label}${r.note ? ` — ${r.note}` : ''}`)}">
                    <span class="part-dot" style="background:${partColor(r.label)}"></span>
                    <span class="part-name">${esc(r.label)}${r.note ? `<em>${esc(r.note)}</em>` : ''}</span>
                    <span class="part-figure">${esc(r.figure || '')}</span>
                    <span class="part-value">${esc(r.value)}</span>
                </div>`).join('')}
            </div>`;
        }
        // The footer: what never changes mid-session, and at most one chip for
        // the single thing here that asks to be acted on.
        if (block.kind === 'band') {
            const facts = (block.facts || []).map((f) => `<span>${esc(f)}</span>`).join('<i>·</i>');
            const c = block.chip;
            return `<div class="band${c ? '' : ' band-quiet'}">
                <span class="band-facts">${facts}</span>
                ${c ? `<span class="band-chip">${esc(c.label)} <b>${esc(c.value)}</b>${c.tail ? ` ${esc(c.tail)}` : ''}</span>` : ''}
            </div>`;
        }
        // Pills belong beside the section's own heading, and both renderers lift
        // them out before calling this. One reaching here is a section drawn by
        // something that has not been taught to — draw it rather than drop it.
        if (block.kind === 'pills') return pillsHtml(block);
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
          ${rows.filter((section) => section.id !== 'work').map((section) => {
        const [aside, blocks] = splitPills(section.blocks);
        return panel(section.title, statusBlocks(blocks), { id: section.id, aside });
    }).join('')}
        </div>
        ${tasksStrip(rows.find((section) => section.id === 'work'))}
        ${active.length ? panel('Workflows in the last hour', runsTableOf(runRows(active)), {
        flush: true,
        note: 'Every run that wrote something in the last hour — still going, just finished, or stalled without a snapshot. Open one for its agents: what each was told, what it answered, the model and the effort it got, and what it cost. The same table over every run on the machine is under Work → Agents &amp; workflows.',
    }) : ''}
    </section>`;
}

/**
 * The same Now, for the sidebar — 250 to 400 px, where both of this page's wide
 * devices fail: `tiles` puts four figures across a strip that has no room for
 * two, and `.cols` balances panels into columns there is width for exactly one
 * of. So the numbers become rows, the panels become plain sections, and the
 * sections themselves are the ones the tooltips use — the sidebar cannot drift
 * from the hover any more than the Now tab can.
 *
 * The workflow table is deliberately absent: it is six columns wide and lives
 * one view below, in a tree that is already built for this width.
 */
/**
 * Which of the status sections each sidebar view draws.
 *
 * Limits stand alone because they are the one thing worth reading without
 * scrolling, and a view holds its own height: sharing a pane with the context
 * and the session cost is what pushed the pace note under the fold. VS Code's
 * `initialSize` sets the starting height, but only the first time — after that
 * the user's own drag is remembered — so the guarantee has to come from the
 * split rather than from a number in the manifest.
 *
 * `work` is on neither: it is the peers and the todo list, and the peers are the
 * Live sessions tree one row below, read from the session registry rather than
 * from this window's transcript.
 */
const SIDEBAR_VIEWS = {
    limits: ['limits'],
    session: ['context', 'money'],
};

function sidebarSections(sections, view) {
    const want = SIDEBAR_VIEWS[view] || [];
    return (sections || []).filter((section) => want.includes(section.id));
}

// What an empty pane says. Each names what is missing from itself: the limits
// pane going quiet means the reading failed, while the session pane going quiet
// only means nothing is running here — and saying "no limits have been read"
// there was plainly wrong beside a limits pane that had just drawn them.
const SIDEBAR_EMPTY = {
    limits: 'No limits have been read yet.',
    session: 'No Claude session is open in this window.',
};

function sidebarNow(sections, which) {
    const rows = sections || [];
    if (rows.length === 0) {
        return `<p class="empty">${esc(SIDEBAR_EMPTY[which] || SIDEBAR_EMPTY.session)}</p>`;
    }

    return `<div class="side">
        ${rows.map((section) => {
        const [aside, blocks] = splitPills(section.blocks);
        return `<section class="side-sec" data-sec="${esc(section.id || '')}">
            <div class="side-head"><h3>${esc(section.title)}</h3>${aside}</div>
            ${statusBlocks(blocks)}
        </section>`;
    }).join('')}
    </div>`;
}

/**
 * The whole document for the sidebar view. The dashboard's page allows inline
 * script because its tabs, sections and folds are all clicks; this one has none
 * of that — it is a readout that the extension replaces on every tick — so its
 * policy leaves script out entirely rather than allowing what nothing uses.
 */
function sidebarPage(sections, which) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>${STYLE}</style></head><body class="side-body">${sidebarNow(sections, which)}</body></html>`;
}

// Every choice on this tab, with the sentence that says what picking it does.
// A dropdown hides all but one of these behind a click, which is the whole
// reason they are drawn open: a setting nobody can see the alternatives to is a
// setting nobody changes.
const ALIGNMENTS = [
    ['right', 'right', 'the usual side, beside the notifications bell'],
    ['left', 'left', 'the other end, past the branch and the problem counts'],
];
const PLACES = [
    ['activeGroup', 'in a tab here', 'among the files you are looking at'],
    ['beside', 'in a tab beside', 'a new editor group to the right'],
    ['panel', 'in the terminal panel', 'at the bottom, with the other terminals'],
    ['newWindow', 'in a new window', 'opened here, then carried out of this one'],
];
const SCOPES = [['global', 'my settings'], ['workspace', 'this workspace']];
// The aliases `claude --model` accepts, read out of the client itself, and the
// levels `--effort` takes. One list each: the manifest's dropdown, the quick
// pick behind **Open Claude Code with…** and this page all read from here, and a
// test holds the manifest to it. The empty value is a real option — it passes no
// flag and leaves the choice to the client.
// The `[1m]` entries are not duplicates of the plain ones: the suffix picks the
// million-token variant of the same model, which the client offers as its own
// choice — "Opus (1M context)" — and has a `prefer1m` setting for. Without it the
// session starts on that model's ordinary window.
const MODELS = [
    ['', 'client decides'],
    ['opus', 'opus'], ['opus[1m]', 'opus 1M'],
    ['sonnet', 'sonnet'], ['sonnet[1m]', 'sonnet 1M'],
    ['fable', 'fable'], ['fable[1m]', 'fable 1M'],
    ['haiku', 'haiku'],
    ['best', 'best'], ['opusplan', 'opus in plan mode'],
];
/**
 * What each alias is for, in the client's own words — these sentences are the
 * strings the `/model` picker shows, not a paraphrase of them — plus the rate
 * and the window, which is what the choice actually costs.
 *
 * `best` is not "whichever suits the task", which is what this extension's
 * manifest said for months: the docs are specific, and it is a question of what
 * the organization has access to.
 */
const MODEL_ABOUT = {
    '': ['', 'No --model flag — whatever the client starts on by itself', ''],
    opus: ['Opus 5', 'Best for everyday, complex tasks', '$5/$25 · 200k'],
    'opus[1m]': ['Opus 5', 'Best for everyday, complex tasks', '$5/$25 · 1M'],
    sonnet: ['Sonnet 5', 'Efficient for routine tasks', '$3/$15 · 200k'],
    'sonnet[1m]': ['Sonnet 5', 'Efficient for routine tasks', '$3/$15 · 1M'],
    fable: ['Fable 5', 'Most capable for your hardest and longest-running tasks', '$10/$50 · 200k'],
    'fable[1m]': ['Fable 5', 'Most capable for your hardest and longest-running tasks', '$10/$50 · 1M'],
    haiku: ['Haiku 4.5', 'Fastest for quick answers', '$1/$5 · 200k'],
    best: ['Fable 5 or Opus 5', 'Fable where your organization has access to it, latest Opus otherwise', ''],
    opusplan: ['Opus 5 → Sonnet 5', 'Opus while planning, Sonnet for execution — the switch also drops the prompt cache', '$5/$25 → $3/$15'],
};
const EFFORTS = [
    ['', 'client decides'],
    ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max'],
];
// Anthropic publishes no multiplier for effort — the docs say only that low is
// cheaper and that max "may show diminishing returns and is prone to
// overthinking". What each level costs here is measured instead, from the
// index's own (model, effort) aggregate.
const EFFORT_ABOUT = {
    '': 'No --effort flag is passed',
    low: 'Shallowest reasoning, fastest answers',
    medium: 'Reduces token usage where some intelligence can be traded off',
    high: 'Balances tokens and intelligence — the default on every model but Opus 4.7',
    xhigh: 'Deeper reasoning at higher token spend',
    max: 'Can improve demanding tasks, but shows diminishing returns and overthinks',
};
const STYLE_ABOUT = {
    '': 'No style is asked for — whatever your settings files say',
    default: "Claude Code's ordinary system prompt for software engineering",
    Proactive: 'Executes immediately, assumes rather than pausing for routine decisions',
    Explanatory: 'Adds educational insights between the steps of a task',
    Learning: 'Insights plus TODO(human) markers for you to fill in',
    Concise: 'Leads with the result and skips preamble and narration',
};
/**
 * The tiers an advisor is ranked against. The client refuses a pairing whose
 * advisor sits below the model it advises, so the page can say which options are
 * dead before the client does — and `fable` is the only tier above an Opus
 * session, which is the whole reason that pairing exists.
 */
const TIERS = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
const ADVISOR_ABOUT = {
    opus: ['Opus 5', '$5/$25'], sonnet: ['Sonnet 5', '$3/$15'],
    fable: ['Fable 5', '$10/$50'], haiku: ['Haiku 4.5', '$1/$5'],
};
/**
 * The tier a `--model` value resolves to, or '' when it does not name one.
 *
 * `opusplan` is two models, and this ranks it by the stronger half. That is an
 * assumption, not a documented rule: the docs describe what opusplan switches
 * between but say nothing about which half an advisor is checked against. It
 * errs towards refusing a pairing that might have been allowed during the Sonnet
 * phase, which is the safe direction — the client would reject it at the wrong
 * moment otherwise, mid-session and with no explanation.
 */
const tierOf = (alias) => {
    const base = String(alias || '').replace(/\[1m\]$/, '');
    if (base === 'opusplan') return 'opus';
    return TIERS[base] ? base : '';
};
// `--advisor` is a real flag the client keeps out of its own `--help`, and it
// takes an alias or a full id like `--model` does. The variants with a context
// suffix are left out: an advisor reads the transcript it is handed rather than
// carrying a window of its own.
const ADVISORS = [
    ['', 'off'],
    ['opus', 'opus'], ['sonnet', 'sonnet'], ['fable', 'fable'], ['haiku', 'haiku'],
];
// The client's built-in output styles, spelled as the client spells them: the
// value travels verbatim into `--settings`, and one it does not recognise is
// ignored rather than reported. A style of your own is a file under
// `~/.claude/output-styles`, and its name goes in the extra arguments — there is
// no flag for any of this, so it travels as `--settings` JSON.
//
// A closed list is a claim about somebody else's release, and it goes stale
// silently: `Concise` shipped in 2.1.237 and this list, which had said "four
// built-in" since the beginning, quietly stopped offering everything the client
// had. The names are in the client binary before they are in its documentation.
const STYLES = [
    ['', 'client decides'],
    ['default', 'default'], ['Proactive', 'proactive'],
    ['Explanatory', 'explanatory'], ['Learning', 'learning'],
    ['Concise', 'concise'],
];

/**
 * One setting: what it is called, what it does, and the control for it.
 *
 * A radio group carries the name on the group rather than on a label, because
 * the thing being named is the choice and not any one option of it; a single
 * input takes an ordinary `for`.
 */
const field = (label, hint, control, forId) => `<div class="field"${forId ? '' : ' role="radiogroup" aria-label="' + esc(label) + '"'}>
        <div class="field-head">${forId ? `<label for="${forId}">${esc(label)}</label>` : `<span class="field-label">${esc(label)}</span>`}
          <span class="dim">${hint}</span></div>
        ${control}
      </div>`;

// A choice whose options need a sentence each: the option is the card, the
// sentence is under its name, and the whole card is the click target.
/**
 * A choice where each option earns a sentence. Two optional columns past the
 * description: `meta` is a figure the options can be compared by — a price, a
 * measured cost — and `why` is the reason an option cannot be picked, which
 * dims the row rather than hiding it. A vanished option is a puzzle; a struck
 * one explains itself.
 */
const cards = (name, options, chosen) => `<div class="cards">${options.map(([value, label, about, meta, why, data]) => `
        <label class="card-opt${why ? ' card-off' : ''}"${Object.entries(data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')}>
          <input type="radio" name="${name}" value="${esc(value)}"${value === chosen ? ' checked' : ''}${why ? ' disabled' : ''}>
          <span class="card-body"><span class="card-name">${esc(label)}</span><span class="card-about"${
    (data || {}).base ? ` data-base="${esc(data.base)}"` : ''}>${esc(about)}</span></span>
          <span class="card-why">${esc(why || '')}</span>
          ${meta ? `<span class="card-meta">${esc(meta)}</span>` : ''}
        </label>`).join('')}</div>`;

// A switch with nothing written beside it: on this tab the name and the sentence
// are the field's own head, the same as for a choice or a number, so the switch
// is only the control. Everywhere else on the page `toggle()` still carries its
// own label, because there it sits alone beside the thing it governs.
const switchOnly = (key, on) => `<label class="switch bare">
        <input type="checkbox" data-set="${esc(key)}"${on ? ' checked' : ''}>
        <span class="switch-box" aria-hidden="true"></span>
      </label>`;

// A choice whose options explain themselves in their own two words.
//
// `chip-`, not `opt-`: `.opt` is already the class every table puts on a column
// it drops when the page is narrow, and styling that name here reached forty
// cells across the dashboard — the sessions table went three pixels past its
// panel at 910 px, on a tab this work never touched.
const chips = (name, options, chosen) => `<div class="chip-opts">${options.map(([value, label]) => `
        <label class="chip-opt"><input type="radio" name="${name}" value="${esc(value)}"${value === chosen ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div>`;

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
    for (const item of palette) (byTopic[item.topic] || (byTopic[item.topic] = [])).push(item);

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
        aside: statePills(['', `${segments.length} segment${segments.length === 1 ? '' : 's'}`]),
    })}
        ${panel('Placeholders', paletteHtml, {
        note: 'Click one to insert it into the segment you last edited. The value beside each name is what it says on this machine right now.',
    })}
        ${panel('Reading and the network', [
        field('Refresh on a timer',
            `Redraw the page and the bar every ${esc(String(Number(cfg.refreshInterval) || 60))} seconds. Off, the expensive pass happens only when you press Reindex.`,
            switchOnly('autoRefresh', cfg.autoRefresh !== false)),
        field('Ask Anthropic for the account limits',
            'The one request this extension makes, at most once a minute per machine. Off, nothing leaves the machine and the limit fields stay empty unless something else has already written the shared cache.',
            switchOnly('fetchLimits', cfg.fetchLimits !== false)),
        field('Check the marketplaces for newer plugin versions',
            'Off by default. Off means the Versions panel compares against the marketplace copy already on this disk.',
            switchOnly('checkPluginUpdates', Boolean(cfg.checkPluginUpdates))),
        field('Monthly budget',
            'Dollars. Above zero, the month is drawn against it and you are told once at 80% and once at 100%. Zero turns both off.',
            `<input type="number" class="num-set" data-set="monthlyBudget" value="${Number(cfg.monthlyBudget) || 0}" min="0" id="monthlyBudget">`,
            'monthlyBudget'),
    ].join(''), {
        note: 'The same switches that sit beside the things they govern — changing one here changes it there, and both write your own settings straight away.',
        aside: statePills(
            ['timer', cfg.autoRefresh !== false ? 'on' : 'off', cfg.autoRefresh === false],
            ['limits', cfg.fetchLimits !== false ? 'on' : 'off', cfg.fetchLimits === false],
            ['marketplaces', cfg.checkPluginUpdates ? 'on' : 'off', !cfg.checkPluginUpdates],
            Number(cfg.monthlyBudget) > 0
                ? ['budget', `$${Number(cfg.monthlyBudget)}`] : ['budget', 'none', true]),
    })}
        ${panel('Behaviour', [
        field('Side of the bar', 'where the items sit',
            cards('alignment', ALIGNMENTS, cfg.alignment || 'right')),
        field('Priority', 'higher means further left',
            `<input id="priority" type="number" value="${Number(cfg.priority) || 100}">`, 'priority'),
        field('Refresh interval', 'seconds between the expensive reads',
            `<input id="refreshInterval" type="number" min="15" value="${Number(cfg.refreshInterval) || 60}">`, 'refreshInterval'),
    ].join(''), {
        aside: statePills(['side', cfg.alignment || 'right'],
            ['priority', String(Number(cfg.priority) || 100)],
            ['every', `${Number(cfg.refreshInterval) || 60}s`]),
    })}
        <div class="save-bar">
          <span class="save-where">Save to</span>
          ${chips('scope', SCOPES, 'global')}
          <span class="dirty" hidden>unsaved changes</span>
          <button class="btn primary save-go" disabled>Save</button>
          <span class="saved" hidden>Saved</span>
        </div>
    </section>`;
}

/**
 * What the extension starts the client with — the half of the old Settings tab
 * that was never about the extension at all.
 *
 * Every choice here carries what it is for, because the names alone do not say:
 * `opus 1M` against `opus`, `xhigh` against `max`, `best` against `opusplan`.
 * Two of them carry more than a sentence — the model, where a rate and a window
 * make the options comparable, and the advisor, where the client's own ranking
 * rule decides which options are live at all.
 */
/**
 * The state pills a panel wears in its heading, the way every panel on Now does:
 * what the thing is set to, before you read a single control. A choice left at
 * "client decides" says so in the muted tone rather than going silent, because a
 * heading with no pill reads as a panel that has nothing to report.
 */
const statePills = (...items) => `<div class="pills">${items.filter(Boolean).map(([text, value, muted]) =>
    `<span class="pill${muted ? ' pill-muted' : ''}">${esc(text)} <b>${esc(value)}</b></span>`).join('')}</div>`;

// What the button types into the terminal it opens. A bare name, resolved by the
// shell's PATH like any other command — no path of ours to go stale.
const CLAUDE_COMMAND = 'claude';

// It lives here rather than beside the button that runs it so that the page can
// write the line out without a second implementation: what the Launch tab shows
// and what the terminal receives are the same string from the same function, and
// a quoting rule cannot hold in one and not the other.

// A value is quoted because it is being written into a shell, and `opus[1m]` is
// the case that decides it: unquoted, zsh reads the brackets as a glob and
// answers `no matches found: opus[1m]` without running anything at all.
const quoted = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

/**
 * The command line the button runs.
 *
 * Flags first, in a fixed order, then whatever the user wrote themselves — their
 * text goes in as typed, because quoting it would break the moment it holds more
 * than one argument.
 */
function claudeCommand({ model, effort, advisor, outputStyle, args } = {}) {
    const parts = [CLAUDE_COMMAND];
    if (model) parts.push('--model', quoted(model));
    if (effort) parts.push('--effort', quoted(effort));
    if (advisor) parts.push('--advisor', quoted(advisor));
    // The client has no `--output-style` flag; `outputStyle` is an ordinary
    // setting, and `--settings` takes JSON that merges with the settings files —
    // "a key you set here overrides the same key in local, project, or user
    // settings, and a key you omit keeps its lower-level value". So one key is
    // sent and everything else the user has configured stays as it was.
    if (outputStyle) parts.push('--settings', quoted(JSON.stringify({ outputStyle })));
    if (args) parts.push(String(args).trim());
    return parts.join(' ');
}

/**
 * The same command as a shell alias, for starting a session outside the editor.
 *
 * The command is quoted a second time on the way in, and that is the whole
 * difficulty: written the obvious way, `alias name='<command>'` breaks the
 * moment the command carries a quote of its own — the inner one closes the
 * outer, and zsh answers `no matches found: opus[1m]`, which is the exact
 * failure the quoting was added to prevent. `quoted` turns each into `'\''`,
 * which survives both levels.
 *
 * The name is held to what a shell accepts for one, because it is typed into a
 * shell by hand: a name with a space in it produces a line nobody can source,
 * and a name with a quote in it produces one nobody should.
 */
function aliasLine(name, launch) {
    const clean = String(name || '').trim();
    if (!clean || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(clean)) return '';
    return `alias ${clean}=${quoted(claudeCommand(launch))}`;
}

// The fence around the one part of a shell file this extension owns. Everything
// outside it is the user's, and comes back byte for byte: this is a file people
// tend by hand for years, and a tool that reordered it once would never be let
// near it again. The markers are on their own lines and unmistakable, so a line
// of theirs that happens to mention us is still theirs.
const ALIAS_OPEN = '# >>> claude-dashboard >>>';
const ALIAS_CLOSE = '# <<< claude-dashboard <<<';

/**
 * A shell file with our alias in it, given the file as it is now.
 *
 * Pure on purpose: the writing is somebody else's job, so what goes into the
 * file can be held against what was in it without a disk anywhere near a test.
 * An empty line removes the block, which is what clearing the name means.
 */
function withAliasBlock(text, line) {
    const body = String(text || '');
    const open = body.indexOf(ALIAS_OPEN);
    const close = body.indexOf(ALIAS_CLOSE);
    // Cut the old block out first, so writing and removing are the same path and
    // a second write cannot leave a second block.
    let rest = body;
    if (open >= 0 && close > open) {
        const after = close + ALIAS_CLOSE.length;
        rest = body.slice(0, open).replace(/\n*$/, '') + body.slice(after).replace(/^\n/, '\n');
    }
    rest = rest.replace(/\s+$/, '');
    if (!String(line || '').trim()) return rest ? `${rest}\n` : '';

    const block = [
        ALIAS_OPEN,
        '# Written by the Claude Dashboard extension, from Setup → Launch.',
        '# Rename or clear the alias name there to change or remove this.',
        line,
        ALIAS_CLOSE,
    ].join('\n');
    return rest ? `${rest}\n\n${block}\n` : `${block}\n`;
}

/**
 * The file this shell reads at startup, or nothing when we do not know.
 *
 * Only the two shells whose `alias` takes this syntax. Fish has aliases too, but
 * spells the rest differently, and a line written in the wrong dialect is worse
 * than no line: it fails at every prompt, in a file the user has to go and fix.
 */
function shellRcFor(shell, home = os.homedir()) {
    const name = String(shell || '').split('/').pop();
    if (name === 'zsh') return path.join(home, '.zshrc');
    if (name === 'bash') return path.join(home, '.bashrc');
    return '';
}

/**
 * The one thing the page can say before any choice is made: what the published
 * measurements settle, and what they leave open. It sits above the options
 * because the choice below it is otherwise made from a price list and a memory
 * of which name sounds strongest — which is exactly how `max` and Fable ended up
 * being carried for weeks against the numbers.
 *
 * Figures are quoted with the date they were checked. A verdict with no date
 * rots silently, and this one is one system card away from being wrong.
 */
const launchCanon = () => `<aside class="canon">
    <h2 class="canon-title">What the measurements settle</h2>
    <ul class="canon-list">
        <li><b>Opus 5 with a Fable advisor</b><i>85.7%</i>
            the most accurate configuration Anthropic has published &mdash; against Opus alone at
            84.4% and Fable alone at <code>medium</code> 83.4%. One run does not separate them.</li>
        <li><b><code>xhigh</code>, not <code>max</code></b><i>44.4% vs 43%</i>
            Opus 5 on FrontierBench. No published measurement puts <code>max</code> above
            <code>xhigh</code>; on most work it only adds cost, and can tip into overthinking.</li>
        <li><b>Opus 5 matches Fable 5</b><i>91.7% vs 91.3%</i>
            on a coding subset both models largely saturate, at about 60% of the cost &mdash;
            inside run-to-run noise. Fable still leads on multimodal work and human preference.</li>
    </ul>
    <p class="canon-set"><span>In the controls below that is
        <b>model</b> <code>opus 1M</code> &middot; <b>effort</b> <code>xhigh</code> &middot;
        <b>advisor</b> <code>fable</code> &mdash; Opus does the work, Fable reads the whole
        conversation and advises it.</span>
        <button type="button" class="canon-apply" data-model="opus[1m]" data-effort="xhigh"
            data-advisor="fable">Apply these</button></p>
    <p class="canon-src">Checked 2026-08-23 against the Claude Opus 5 system card and Anthropic&rsquo;s
        cost-and-intelligence page. The gap in the evidence: Fable alone above <code>medium</code>
        against the pairing &mdash; every published comparison uses Fable at <code>medium</code>.</p>
</aside>`;

function launchTab(config, total, styles) {
    const cfg = config || {};
    const session = tierOf(cfg.model);
    const named = (value, list) => {
        const hit = list.find(([v]) => v === value);
        return hit ? hit[1] : '';
    };

    // The styles on disk, as `cards` takes them. A custom style is named by
    // itself: there is no shorter label to give it, because the name is what
    // travels into `--settings` and what the client will match against.
    //
    // `keep-coding-instructions` is the one thing here worth a warning. It
    // defaults to false, so a style that does not ask for them replaces Claude
    // Code's engineering instructions rather than adding to them — a fact that
    // otherwise announces itself only after the session has started answering.
    // One reading of the choices, used three times: the line that is shown, the
    // alias built from it, and the command the button runs.
    const launch = {
        model: cfg.model, effort: cfg.effort, advisor: cfg.advisor,
        outputStyle: cfg.outputStyle, args: cfg.launchArgs,
    };
    const alias = aliasLine(cfg.aliasName, launch);
    // Named on the button so nobody has to guess which file is about to change.
    // The page cannot see the shell, so the extension's own is the answer, and
    // the fallback is what this project is developed and used on.
    const rcName = (shellRcFor(cfg.shell || process.env.SHELL || '/bin/zsh') || '~/.zshrc')
        .replace(os.homedir(), '~');

    const ownStyles = (styles || []).map((s) => [
        s.name, s.name, s.description || 'A style of your own',
        s.keepCoding ? '' : 'without the coding instructions',
    ]);

    // Each model carries the tier it resolves to, so the advisor list below can
    // be re-ranked in the page when this choice changes rather than only when
    // the page is next drawn.
    const modelOpts = MODELS.map(([value, label]) => {
        const [real, about, meta] = MODEL_ABOUT[value] || ['', '', ''];
        return [value, label, real ? `${real} — ${about}` : about, meta, '',
            { tier: tierOf(value), real: real || label }];
    });

    // An advisor below the session's own tier is refused by the client, so it is
    // dimmed and disabled here with the reason, rather than offered and then
    // rejected by the client.
    const advisorOpts = ADVISORS.map(([value, label]) => {
        if (!value) return [value, label, "No advisor — the client's own setting stands"];
        const [real, rate] = ADVISOR_ABOUT[value];
        const above = session ? Object.keys(TIERS).filter((t) => TIERS[t] > TIERS[session]) : [];
        const ok = !session || TIERS[value] >= TIERS[session];
        const sole = ok && above.length === 1 && above[0] === value;
        const same = ok && session && TIERS[value] === TIERS[session];
        // The sentence without its ranking clause, kept so the page can rewrite
        // the clause when the model changes without losing the sentence.
        const base = `${real} reads the whole conversation and advises`;
        const about = base
            + (sole ? ` — the only tier above ${MODEL_ABOUT[session][0]}` : '')
            + (same ? ' — the same tier: a second opinion rather than a stronger one' : '');
        return [value, label, about, rate,
            ok ? '' : `below ${MODEL_ABOUT[session][0]} — the client refuses this pair`,
            // The page re-ranks this list when the model changes; these are the
            // pieces it needs to rebuild a row's sentence without a round trip.
            { tier: value, rank: String(TIERS[value]), real, base }];
    });

    // Effort is billed as output tokens and its scale is calibrated per model, so
    // the only honest figure is one measured from this machine's own replies at
    // the model the session will start on.
    const seen = effortSpend(total, cfg.model);
    const effortOpts = EFFORTS.map(([value, label]) =>
        [value, label, EFFORT_ABOUT[value], seen[value] || '']);

    const modelMeta = (MODEL_ABOUT[cfg.model || ''] || ['', '', ''])[2];
    const args = (cfg.launchArgs || '').trim();
    const flags = args ? args.split(/\s+/).filter((a) => a.startsWith('-')).length : 0;

    return `<section class="tab" data-tab="launch" hidden>
        ${launchCanon()}
        ${panel('Where it opens', cards('openLocation', PLACES, cfg.openLocation || 'activeGroup'), {
        note: 'What <b>Open Claude Code</b> runs, and where the session lands. <b>Claude: Open Claude Code with…</b> asks for a model and an effort instead, for a single run.',
        aside: statePills(['opens', named(cfg.openLocation || 'activeGroup', PLACES)]),
    })}
        ${panel('Model', cards('model', modelOpts, cfg.model || ''), {
        note: 'The session starts on it, as <code>claude --model</code>. Rates are per million tokens, in and out; the window is what the model is given to remember. Left alone, no flag is passed at all.',
        aside: statePills(['model', named(cfg.model || '', MODELS), !cfg.model],
            modelMeta ? ['', modelMeta] : null),
    })}
        ${panel('Effort', cards('effort', effortOpts, cfg.effort || ''), {
        note: 'How hard the model thinks, as <code>claude --effort</code>. Effort is billed as output tokens, and its scale is calibrated per model — so the figures beside each level are measured from your own replies, not quoted from a table.',
        aside: statePills(['effort', named(cfg.effort || '', EFFORTS), !cfg.effort]),
    })}
        ${panel('Advisor', cards('advisor', advisorOpts, cfg.advisor || ''), {
        note: 'A second model reads the whole conversation and advises the one doing the work, as <code>claude --advisor</code>. It must rank at or above the model it advises — pairings the client would refuse are dimmed here, with the reason, rather than rejected later. The advisor is billed for re-reading the conversation on every call.',
        aside: statePills(['advisor', named(cfg.advisor || '', ADVISORS), !cfg.advisor],
            cfg.advisor ? ['', ADVISOR_ABOUT[cfg.advisor][1]] : null),
    })}
        ${panel('Output style',
        cards('outputStyle', STYLES.map(([v, l]) => [v, l, STYLE_ABOUT[v]]), cfg.outputStyle || '')
        + (ownStyles.length
            ? `<div class="cards-head">Your own</div>${cards('outputStyle', ownStyles, cfg.outputStyle || '')}`
            : ''), {
        note: 'How Claude answers. There is no flag for it — it travels as <code>--settings</code> JSON, which <b>merges</b> with your settings files rather than replacing them. A style of your own is a markdown file in <code>~/.claude/output-styles</code>, named by its <code>name</code> field or by the file; put one there and it appears here.',
        // A custom style is its own label, so the pill reads the same list the
        // cards were built from rather than the client's five.
        // Falling through to the raw value matters when a style is chosen and
        // its file deleted afterwards: the name still travels to the client, so
        // the panel says what is set rather than an empty `style`.
        aside: statePills(['style',
            named(cfg.outputStyle || '', STYLES.concat(ownStyles.map(([v, l]) => [v, l]))) || cfg.outputStyle,
            !cfg.outputStyle]),
    })}
        ${panel('Extra arguments',
        `<input id="launchArgs" class="wide" type="text" spellcheck="false"
                placeholder="--permission-mode acceptEdits --fallback-model sonnet"
                value="${esc(cfg.launchArgs || '')}">`, {
        note: 'Anything else for that command line, written as typed — user settings only.',
        aside: statePills(flags ? ['', `${flags} extra flag${flags === 1 ? '' : 's'}`] : ['', 'none', true]),
    })}
        ${panel('The command', `<div class="cmd"><code id="launchCommand">${esc(claudeCommand(launch))}</code>
          <button class="btn" data-copy="launchCommand">Copy</button></div>
        <div class="cmd-alias">
          <label for="aliasName">Shell alias</label>
          <input id="aliasName" type="text" spellcheck="false" placeholder="claude-vs"
                 value="${esc(cfg.aliasName || '')}">
          <span class="cmd-hint">a name for your own shell, so the same session starts outside the editor</span>
        </div>
        <div class="cmd"><code id="launchAlias"${alias ? '' : ' class="empty-preview"'}>${
        esc(alias || 'Name it above to get a line for your .zshrc')}</code>
          <button class="btn" data-copy="launchAlias"${alias ? '' : ' disabled'}>Copy</button>
          <button class="btn" data-install-alias${alias ? '' : ' disabled'}>Write to ${esc(rcName)}</button></div>
        <div class="cmd-hint">Writing puts it in a block of its own; everything else in that file is
        left as it is, and a copy is kept beside it the first time. A terminal already
        open will not have it — open a new one.</div>`, {
        id: 'command',
        // Written out because six panels of choices add up to one line nobody
        // can hold in their head, and because that line is the thing you paste
        // into a terminal somewhere else. Shown, not typed into: the panels
        // above are the controls, and an editable copy would raise the question
        // of which of the two wins.
        note: 'What <b>Open Claude Code</b> runs with these choices. It follows them as you pick; nothing here is read back, so editing it is not offered.',
    })}
        <div class="save-bar">
          <span class="save-where">Save to</span>
          ${chips('scope', SCOPES, 'global')}
          <span class="dirty" hidden>unsaved changes</span>
          <button class="btn primary save-go" disabled>Save</button>
          <span class="saved" hidden>Saved</span>
        </div>
    </section>`;
}

/**
 * Output per reply at each effort level, for the model a session would start on.
 * A level with too few replies behind it gets no ratio at all: a figure computed
 * from a handful of them reads as a measurement and is a coincidence.
 */
function effortSpend(total, modelAlias) {
    const out = {};
    const efforts = (total && total.efforts) || {};
    const tier = tierOf(modelAlias);
    const rows = [];
    for (const [key, bucket] of Object.entries(efforts)) {
        const [model, effort] = key.split('|');
        if (!effort || !bucket.msgs) continue;
        // Matched on the tier's name inside the model id. For `opusplan` that
        // means the Opus half only, so its figures are the Opus phase rather
        // than the mixture the session would actually run — approximate, and
        // approximate in the expensive direction.
        if (tier && !String(model).includes(tier)) continue;
        rows.push([effort, bucket.msgs, bucket.out / bucket.msgs]);
    }
    if (rows.length < 2) return out;
    // The level with the most replies behind it is the baseline: it is the one
    // whose average is least likely to be a handful of unusual tasks.
    const base = rows.reduce((a, b) => (b[1] > a[1] ? b : a));
    for (const [effort, msgs, per] of rows) {
        out[effort] = msgs < 300
            ? `only ${msgs} replies — too few to compare`
            : `${Math.round(per)} out/reply · ×${(per / base[2]).toFixed(2).replace(/0$/, '')} vs ${base[0]}`;
    }
    return out;
}

// --- page -------------------------------------------------------------------

// The stylesheet lives in dashboard.css and is read from disk rather than
// carried in a template literal here. A backtick inside a CSS comment broke this
// module at require time four times in one session, and the editor gave no
// highlighting, no bracket matching and no stylelint to 700 lines of CSS
// pretending to be a string. `STYLE` is still a string, so both pages, both
// preview tools and the tests that hold rules against the vocabularies are
// untouched by the move.
// Degrade, never guess — and here the difference is the whole extension. This
// read happens at require time, so a missing or unreadable file would throw
// before `activate` is even defined: the status bar, the tree and the sidebar
// would all be gone, over a stylesheet. The fallback keeps the page legible
// enough to say what is wrong instead.
const STYLE = (() => {
    try {
        return fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
    } catch {
        return 'body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);'
            + ' background: var(--vscode-editor-background); padding: 16px; }'
            + ' table { width: 100%; border-collapse: collapse; }'
            + ' .empty::before { content: "dashboard.css is missing from this install — "; }';
    }
})();


/**
 * What the header countdown says, and the deadline it counts to next.
 *
 * A rebuild is what replaces this document, so a counter that has run out and
 * is still on screen means the tick did not happen: the panel was behind
 * another tab, the settings editor was open, or a rebuild was already running.
 * Waiting for a replacement that is not coming is how it sat on "refreshing…"
 * for as long as the tab stayed in the background.
 *
 * The grace is the window a real rebuild takes — an index pass over every
 * transcript plus the marketplace request, seconds rather than milliseconds —
 * during which "refreshing…" is the truth. Past it the deadline rolls forward
 * by one interval, which is when the next tick is due anyway.
 *
 * Defined here rather than inside SCRIPT so a test can call it; its source is
 * interpolated into the page below.
 */
function countdown(due, now, every, grace = 10000) {
    const left = Math.round((due - now) / 1000);
    if (left > 0) return { text: 'next in ' + left + 's', due };
    if (now - due < grace) return { text: 'refreshing…', due };
    const rolled = now + every;
    return { text: 'next in ' + Math.round(every / 1000) + 's', due: rolled };
}

const SCRIPT = `
${String(countdown)}

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
    // The button says what pressing it will do; that the timer is stopped is
    // said by the button's own colour and by the countdown going away, so the
    // two never state the same fact twice.
    pauseEl.textContent = on ? 'Pause' : 'Resume';
    pauseEl.classList.toggle('held', !on);
    pauseEl.title = on
      ? 'Stop rebuilding the page on the timer. The same claudeStatusline.autoRefresh you can set on the Settings tab.'
      : 'Rebuild the page on the timer again.';
    if (!on) { nextEl.textContent = ''; return; }
    const state = countdown(due, Date.now(), every);
    due = state.due;
    nextEl.textContent = ' · ' + state.text;
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
  // A directory: shown in the OS file manager rather than opened as a document.
  const show = e.target.closest('[data-reveal]');
  if (show && api) {
    e.preventDefault();
    e.stopPropagation();
    api.postMessage({ type: 'reveal', path: show.dataset.reveal });
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
  for (const el of document.querySelectorAll('.bars th span, .kv th[scope="row"] span, td.wrap')) {
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

  // The client refuses an advisor ranked below the model it advises, and the
  // page draws that rule when it is built. It has to hold while you are still
  // choosing: picking Opus and watching sonnet stay live until the next redraw
  // is worse than no ranking at all, because the page looked as though it had
  // checked. Everything needed sits in data attributes the markup already
  // carries — no round trip to the extension.
  const rankAdvisors = () => {
    const model = document.querySelector('input[name="model"]:checked');
    const row = model && model.closest('.card-opt');
    const tier = row ? row.dataset.tier : '';
    const real = row ? row.dataset.real : '';
    const rows = [...document.querySelectorAll('.card-opt[data-rank]')];
    if (!rows.length) return;
    // The session's own rank, read off the advisor row that names the same tier.
    const self = rows.find((r) => r.dataset.tier === tier);
    const mine = tier && self ? Number(self.dataset.rank) : 0;
    const above = rows.map((r) => Number(r.dataset.rank)).filter((n) => n > mine);
    for (const r of rows) {
      const rank = Number(r.dataset.rank);
      const ok = !tier || rank >= mine;
      const input = r.querySelector('input');
      // Put it back as well as take it away: a one-way pass would leave an
      // option dead after a single visit to a stronger model.
      input.disabled = !ok;
      r.classList.toggle('card-off', !ok);
      const why = r.querySelector('.card-why');
      if (why) why.textContent = ok ? '' : 'below ' + real + ' — the client refuses this pair';
      // A refused option cannot stay the chosen one.
      if (!ok && input.checked) {
        input.checked = false;
        const off = document.querySelector('input[name="advisor"][value=""]');
        if (off) off.checked = true;
      }
      const about = r.querySelector('.card-about');
      if (about && about.dataset.base) {
        const sole = ok && above.length === 1 && above[0] === rank;
        const same = ok && tier && rank === mine;
        about.textContent = about.dataset.base
          + (sole ? ' — the only tier above ' + real : '')
          + (same ? ' — the same tier: a second opinion rather than a stronger one' : '');
      }
    }
  };
  for (const input of document.querySelectorAll('input[name="model"]')) {
    input.addEventListener('change', rankAdvisors);
  }

  // Every choice on the tab is a radio group now, so the value is whichever of
  // them is checked. The fallback is for a group that somehow has none — a
  // saved settings file naming a value the page does not offer.
  const picked = (name, fallback) => {
    const on = document.querySelector('input[name="' + name + '"]:checked');
    return on ? on.value : fallback;
  };

  // What Save would write, as one string. The comparison is against the state
  // the page was drawn with, so undoing an edit by hand puts the button back to
  // rest rather than leaving it lit for the rest of the visit.
  const formState = () => JSON.stringify(settingsToSave());
  let atRest = formState();
  // One form, two tabs, two bars. The values were never the problem — picked()
  // already reads the whole document — but the listener was bound to the
  // settings tab alone, so a model chosen on Launch left Save disabled with
  // nowhere to write it. Bound by class rather than by id: a third tab of
  // settings would be wired by this code as it stands.
  // (No backticks in here: this script is itself a template literal.)
  const saveBtns = [...document.querySelectorAll('.save-go')];
  const dirtyMarks = [...document.querySelectorAll('.dirty')];
  const settleSave = () => {
    const changed = formState() !== atRest;
    for (const b of saveBtns) b.disabled = !changed;
    for (const d of dirtyMarks) d.hidden = !changed;
  };
  // A radio, a checkbox and a typed character all reach this: the input event
  // covers typing, change covers the rest, and every tab holding a field is part
  // of the same form.
  // The command line under the choices, kept in step with them. It is asked
  // for rather than assembled here: the builder that answers is the one that
  // opens the terminal, so the line shown and the line run cannot drift apart
  // over a quoting rule. Debounced like the segment previews, because typing in
  // the extra arguments would otherwise send a message per keystroke.
  const commandOut = document.getElementById('launchCommand');
  const aliasOut = document.getElementById('launchAlias');
  let commandTimer;
  const askCommand = () => {
    if (!commandOut || !api) return;
    clearTimeout(commandTimer);
    commandTimer = setTimeout(() => api.postMessage({ type: 'launchPreview', settings: settingsToSave() }), 120);
  };

  for (const form of document.querySelectorAll('section.tab[data-tab="settings"], section.tab[data-tab="launch"]')) {
    form.addEventListener('input', () => { settleSave(); askCommand(); });
    form.addEventListener('change', () => { settleSave(); askCommand(); });
  }

  // The banner states a verdict; this puts that verdict into the controls it is
  // about, so reading it and acting on it are not two separate jobs.
  //
  // Model goes first on purpose: rankAdvisors runs off the model's own change
  // event and clears the advisor when the pair would be refused, so setting the
  // advisor before the model would hand it a model it no longer has.
  // Assigning the checked property fires nothing by itself, so each input is
  // told to announce the change: that is what lights Save and re-ranks the
  // advisor rows.
  for (const btn of document.querySelectorAll('.canon-apply')) {
    btn.addEventListener('click', () => {
      for (const name of ['model', 'effort', 'advisor']) {
        const want = btn.dataset[name];
        if (want == null) continue;
        const input = document.querySelector('input[name="' + name + '"][value="' + want + '"]');
        // A value this client no longer offers leaves the row alone rather than
        // clearing it: a stale button must not silently unset a live choice.
        if (!input || input.disabled) continue;
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

  // Through the editor: a webview's own clipboard write is not guaranteed, and
  // handing this line over is the whole reason it is drawn.
  document.addEventListener('click', (e) => {
    const install = e.target.closest('[data-install-alias]');
    if (install && api) {
      // The choices, not the line: the extension builds what it writes, so the
      // page cannot hand a shell file a string of its own.
      api.postMessage({ type: 'installAlias', settings: settingsToSave() });
      return;
    }
    const btn = e.target.closest('[data-copy]');
    if (!btn || !api) return;
    const src = document.getElementById(btn.dataset.copy);
    if (!src) return;
    api.postMessage({ type: 'copy', text: src.textContent });
    const was = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = was; }, 1200);
  });

  for (const btn of saveBtns) {
    btn.addEventListener('click', () => {
      atRest = formState();
      settleSave();
      api.postMessage({
        type: 'save',
        // Both bars carry scope chips under one radio name, so they are a single
        // group the browser keeps in step — reading it per bar would find the
        // unchecked copy and silently fall back to global.
        scope: picked('scope', 'global'),
        settings: settingsToSave(),
      });
    });
  }

  function settingsToSave() {
    return {
        segments: templates().filter((t) => t.trim().length > 0),
        alignment: picked('alignment', 'right'),
        priority: Number(document.getElementById('priority').value) || 100,
        refreshInterval: Number(document.getElementById('refreshInterval').value) || 60,
        openLocation: picked('openLocation', 'activeGroup'),
        model: picked('model', ''),
        effort: picked('effort', ''),
        advisor: picked('advisor', ''),
        outputStyle: picked('outputStyle', ''),
        launchArgs: document.getElementById('launchArgs').value.trim(),
        aliasName: document.getElementById('aliasName').value.trim(),
    };
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'launchPreview') {
      if (commandOut) commandOut.textContent = msg.command || 'claude';
      if (aliasOut) {
        const has = !!msg.alias;
        aliasOut.textContent = has ? msg.alias : 'Name it above to get a line for your .zshrc';
        aliasOut.classList.toggle('empty-preview', !has);
        const btn = document.querySelector('[data-copy="launchAlias"]');
        if (btn) btn.disabled = !has;
      }
      return;
    }
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
      // Both bars acknowledge: the tab that was not being looked at is the one
      // you switch to next, and a bar that never says "Saved" reads as one that
      // did not.
      const badges = [...document.querySelectorAll('.saved')];
      for (const b of badges) b.hidden = false;
      setTimeout(() => { for (const b of badges) b.hidden = true; }, 2000);
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
    // The reference writes its prose in markdown, and the only markup that
    // survives into these sentences is `code`. Escaped first, so the tags are
    // this function's and never the document's.
    const docText = (text) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');

    // What each variable says, written under it rather than hidden in a `title`.
    // The native tooltip put the whole sentence on one line, over the row below
    // it and past the edge of the panel — unreadable exactly where the text
    // mattered, since a name like CLAUDE_CODE_MAX_CONCURRENT_AGENTS explains
    // nothing on its own. The documented default sits beside the value, because
    // the question a set variable raises is what it would have been unset.
    const envTable = (rows, empty) => (rows.length
        ? `<ul class="envrows">${rows.map((r) => `<li class="envrow">
            <div class="envrow-head">
              <span class="envrow-key mono">${esc(r.key)}</span>
              <span class="envrow-val${r.known ? '' : ' undoc'}">${esc(r.value)}</span>
            </div>
            ${r.description || r.default ? `<div class="envrow-about">
              ${r.description ? `<span class="dim">${docText(r.description)}</span>` : ''}
              ${r.default ? `<span class="envrow-def${r.differs ? ' o-failed' : ''}">default ${esc(r.default)}</span>` : ''}
            </div>` : ''}
        </li>`).join('')}</ul>`
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
    // Setup is what is set up: this extension, the session it starts, and how
    // the client is configured. Machine is what is merely happening on the
    // machine right now — observation rather than settings. They were one
    // section of ten tabs, twice the size of any other, and the half that was
    // not settings is what made it unreadable.
    ['setup', 'Setup', [
        ['settings', 'Settings'],
        ['launch', 'Launch'],
        ['client', 'Claude Code'],
        ['context', 'Memory & context'],
        ['health', 'Health'],
        ['changelog', 'Changelog'],
    ]],
    ['machine', 'Machine', [
        ['live', 'Live now'],
        ['jobs', 'Background jobs'],
        ['tasks', 'Task lists'],
        ['disk', 'Disk'],
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
    const modelOrder = modelRows(total.models)
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
<header class="page-head">
  <div class="mark">${MARK}<h1>Claude Dashboard</h1><span class="pill" data-version>v${esc(VERSION)}</span></div>
  <div class="pills">
    <span class="pill">${plural(meta.files, 'transcript')}</span>
    <span class="pill" id="idx"${meta.lastRun ? ` title="Last built ${esc(fmtDateTime(meta.lastRun))}"` : ''}>${
    meta.lastRun ? esc(fmtClock(meta.lastRun)) : 'not built yet'}<i id="next" data-next="${Number(meta.lastRun || 0) + (Number((meta.config || {}).refreshInterval) || 60) * 1000}" data-every="${Number((meta.config || {}).refreshInterval) || 60}"></i></span>
    <span class="head-sep" aria-hidden="true"></span>
    <button id="pause" class="btn head-btn" data-on="${(meta.config || {}).autoRefresh === false ? '0' : '1'}">·</button>
    <button id="refresh" class="btn head-btn primary">Reindex</button>
  </div>
</header>
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
${launchTab(meta.config, total, (meta.system || {}).outputStyles)}
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
    sessionLabel, navHtml, countdown, SECTIONS, CACHE_PARTS,
    overviewTab, agentsTab, healthTab, jobsTab, liveTab, diskTab, contextTab, tasksTab, changelogTab, clientTab, filesTab, settingsTab, launchTab,
    claudeCommand, aliasLine, withAliasBlock, shellRcFor,
    limitsTab, weekLabel, nowTab, sidebarNow, sidebarPage, sidebarSections, paceTrack, statusBlocks, meterTone,
    tile, tiles, panel, shareCell, assignModelColors,
    // The places a session can be opened in — the cards on the Settings tab and,
    // through extension.js, the button's own table of what each one means.
    PLACES,
    // The launch vocabularies, read by the manifest's test, by the Settings tab
    // above and by the quick pick behind **Open Claude Code with…**.
    MODELS, EFFORTS, ADVISORS, STYLES,
    shortModel, tok, bytes, plural, fmtDur, esc,
    // The stylesheet, for the one test that holds this page's `.o-*` rules
    // against the two outcome tables the tree and the hover keep: a word the
    // vocabulary gains and the CSS does not draws as unstyled text here, and
    // nothing else would notice.
    STYLE,
};
