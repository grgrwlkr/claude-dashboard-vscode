// A local record of the account limits over time.
//
// The usage endpoint answers one question — how much of the window is gone
// right now — and keeps no history, so a week's shape can only be known by
// someone who wrote the answers down. This is that someone. No dependency on
// vscode: the directory is passed in, so it runs under plain node in tests.

const fs = require('fs');
const path = require('path');

const FILE = 'limits-history.jsonl';

// A row per change, not a row per tick. The percentages arrive as integers, so
// between two changes there is nothing to record and a minute-by-minute log
// would be a thousand copies of the same number every day.
//
// The heartbeat exists for the other direction: with no rows at all, a flat
// stretch and a closed laptop look identical on the chart.
const HEARTBEAT_MS = 6 * 3600 * 1000;

// About two years of ordinary use. The file is trimmed from the front when it
// grows past this, so the chart loses its oldest weeks rather than the disk
// filling up unattended.
const MAX_ROWS = 20000;
const TRIM_SLACK = 1.2;

const WEEK_MS = 604800 * 1000;

function historyPath(dir) {
    return path.join(dir, FILE);
}

function parseRows(text) {
    const rows = [];
    for (const line of text.split('\n')) {
        if (!line || line[0] !== '{') continue;
        try {
            const r = JSON.parse(line);
            if (r && typeof r.at === 'number') rows.push(r);
        } catch { /* a torn last line: the next write appends after it */ }
    }
    return rows;
}

/** Every recorded point, oldest first. `sinceMs` drops anything older. */
function readHistory(dir, sinceMs = 0) {
    let text;
    try { text = fs.readFileSync(historyPath(dir), 'utf8'); } catch { return []; }
    const rows = parseRows(text).filter((r) => r.at >= sinceMs);
    rows.sort((a, b) => a.at - b.at);
    return rows;
}

function sameReading(a, b) {
    if (!a || !b) return false;
    if (a.weekly !== b.weekly || a.session !== b.session || a.reset !== b.reset) return false;
    const ka = Object.keys(a.models || {});
    const kb = Object.keys(b.models || {});
    if (ka.length !== kb.length) return false;
    return ka.every((k) => a.models[k] === b.models[k]);
}

// The shape `limitsOf` returns, flattened to what a chart needs.
function pointOf(lim, nowMs) {
    if (!lim || !lim.weekly) return null;
    const models = {};
    for (const s of lim.scoped || []) {
        if (s && s.scope) models[s.scope] = s.pct;
    }
    return {
        at: nowMs,
        weekly: lim.weekly.pct,
        session: lim.session ? lim.session.pct : null,
        reset: lim.weekly.reset,
        models,
    };
}

/**
 * Append one reading if it says something the last one did not. Returns what
 * happened, so a caller can tell "nothing changed" from "the write failed"
 * instead of treating silence as success.
 */
function recordLimits(dir, lim, nowMs = Date.now()) {
    const point = pointOf(lim, nowMs);
    if (!point) return { written: false, reason: 'no-limits' };

    const rows = readHistory(dir);
    const last = rows[rows.length - 1];
    if (sameReading(last, point) && nowMs - last.at < HEARTBEAT_MS) {
        return { written: false, reason: 'unchanged' };
    }

    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(historyPath(dir), JSON.stringify(point) + '\n');
    } catch { return { written: false, reason: 'write-failed' }; }

    if (rows.length + 1 > MAX_ROWS * TRIM_SLACK) trim(dir, [...rows, point]);
    return { written: true, reason: last ? 'changed' : 'first' };
}

// Rewritten whole rather than truncated in place: a partial write here would
// corrupt the file the extension reads on every dashboard open.
function trim(dir, rows) {
    const keep = rows.slice(-MAX_ROWS);
    const tmp = `${historyPath(dir)}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + '\n');
        fs.renameSync(tmp, historyPath(dir));
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    }
}

/**
 * Split the readings into weekly windows, keyed by the reset they belong to.
 * Each point carries how far into its own window it sits, which is what makes
 * two different weeks comparable on one chart: the x axis is "day of window",
 * not a date.
 */
function weeklyWindows(rows, limit = 6) {
    const byReset = new Map();
    for (const r of rows) {
        if (!r.reset) continue;
        const start = r.reset * 1000 - WEEK_MS;
        const elapsed = r.at - start;
        // A reading whose timestamp falls outside its own window means the
        // clock or the reset moved under us; there is nothing sensible to plot.
        if (elapsed < 0 || elapsed > WEEK_MS) continue;
        const w = byReset.get(r.reset) || { reset: r.reset, start, points: [] };
        w.points.push({ at: r.at, day: elapsed / WEEK_MS * 7, pct: r.weekly });
        byReset.set(r.reset, w);
    }
    return [...byReset.values()].sort((a, b) => a.reset - b.reset).slice(-limit);
}

/** The 5-hour session limit over time — a sawtooth, one tooth per session. */
function sessionSeries(rows, sinceMs = 0) {
    return rows.filter((r) => r.at >= sinceMs && typeof r.session === 'number')
        .map((r) => ({ at: r.at, pct: r.session }));
}

module.exports = {
    FILE, HEARTBEAT_MS, MAX_ROWS, WEEK_MS,
    historyPath, readHistory, recordLimits, pointOf, weeklyWindows, sessionSeries,
};
