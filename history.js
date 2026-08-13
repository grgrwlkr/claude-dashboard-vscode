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

// Three to five months of ordinary use, measured rather than guessed (checked
// 2026-08-12): full days in the two histories on this machine carry 139, 162,
// 253 and 255 rows, so 20000 rows is 78–144 days and the trim first fires,
// at 1.2x, somewhere between day 94 and day 173. The comment here used to say
// "about two years", which would need 27 rows a day — below every day observed,
// including a partial one. The file is trimmed from the front when it grows past
// this, so the chart loses its oldest weeks rather than the disk filling up
// unattended.
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

// The endpoint answers the same window with a reset that wanders by a second or
// two between calls, so the raw value cannot key a window: one week arrives as
// three. Readings this close together are the same window — real ones are a
// week apart, some two thousand times further out than this slack.
const RESET_SLACK_S = 300;

/**
 * Split the readings into weekly windows, keyed by the reset they belong to.
 * Each point carries how far into its own window it sits, which is what makes
 * two different weeks comparable on one chart: the x axis is "day of window",
 * not a date.
 */
function weeklyWindows(rows, limit = 6) {
    const windows = [];
    for (const r of rows) {
        if (!r.reset) continue;
        // Membership is judged against the reading's own reset, before any
        // canonicalisation, so a point is never dropped for a discrepancy the
        // grouping introduced.
        const elapsed = r.at - (r.reset * 1000 - WEEK_MS);
        // A reading whose timestamp falls outside its own window means the
        // clock or the reset moved under us; there is nothing sensible to plot.
        if (elapsed < 0 || elapsed > WEEK_MS) continue;

        let w = windows.find((x) => Math.abs(x.reset - r.reset) <= RESET_SLACK_S);
        if (!w) windows.push(w = { reset: r.reset, points: [] });
        // The latest reset in the group names the window: the drift is noise,
        // but the label still has to match what the account page says.
        else if (r.reset > w.reset) w.reset = r.reset;
        w.points.push({ at: r.at, pct: r.weekly });
    }

    // `day` is derived last, from the window's settled start, so every point in
    // one window is measured from the same origin.
    for (const w of windows) {
        w.start = w.reset * 1000 - WEEK_MS;
        w.points = w.points.map((p) => ({ ...p, day: (p.at - w.start) / WEEK_MS * 7 }));
    }
    return windows.sort((a, b) => a.reset - b.reset).slice(-limit);
}

// When a week ran out, one line per window.
//
// This is the one fact on the week bar that cannot be recomputed. The forecast
// runs on `(100 - pct) / pct`, so at 100% it collapses onto the present and says
// "now" forever after: the moment the quota actually ended is only knowable to
// whoever wrote it down at the time. The reading history above would answer it —
// but it is trimmed at MAX_ROWS, and a window that ran out is exactly the window
// worth remembering after the readings behind it are gone.
//
// Kept apart from the readings for that reason: a handful of lines that no trim
// touches, against a log that is rotated by design.
const MARKS = 'week-marks.json';
const marksPath = (dir) => path.join(dir, MARKS);

/** Every window that ran out, oldest first. */
function readMarks(dir) {
    try {
        const rows = JSON.parse(fs.readFileSync(marksPath(dir), 'utf8'));
        return Array.isArray(rows) ? rows.filter((r) => r && r.reset > 0).sort((a, b) => a.reset - b.reset) : [];
    } catch { return []; }
}

/** The mark for one window, matched with the same slack as the grouping above. */
function markFor(marks, reset) {
    return (marks || []).find((m) => Math.abs(m.reset - reset) <= RESET_SLACK_S) || null;
}

/**
 * Write the moment this window ran out — once. A later call for the same window
 * changes nothing: the first sighting is the answer, and every one after it is
 * the same 100% seen again a minute later.
 *
 * `plan` is stored beside it because it is the other half of the fact: 100%
 * reached when only 54% of the week had elapsed is a different week from 100%
 * reached on the last evening, and by the time anyone looks, the plan has moved
 * on and cannot be recovered either.
 */
function recordMark(dir, { reset, at, plan }, limit = 26) {
    if (!reset || !at) return { written: false, reason: 'incomplete' };
    const marks = readMarks(dir);
    if (markFor(marks, reset)) return { written: false, reason: 'already-marked' };

    const kept = [...marks, { reset, at, plan: Number.isFinite(plan) ? plan : null }]
        .sort((a, b) => a.reset - b.reset)
        .slice(-limit);
    const tmp = `${marksPath(dir)}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(kept));
        fs.renameSync(tmp, marksPath(dir));
    } catch {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        return { written: false, reason: 'write-failed' };
    }
    return { written: true, reason: 'marked' };
}

/**
 * The moment a window first read 100%, recovered from the readings — the
 * fallback for a window that ran out before this extension started marking
 * them, and the way the very first mark of all gets its date.
 *
 * Returns null when the readings do not reach back to it: if the oldest one this
 * window has is already 100%, the moment is older than the record, and a date
 * invented from the first row would be a lie about a fact this bar states.
 */
function ranOutAt(rows, reset) {
    const window = (rows || [])
        .filter((r) => r.reset && Math.abs(r.reset - reset) <= RESET_SLACK_S && typeof r.weekly === 'number')
        .sort((a, b) => a.at - b.at);
    if (window.length === 0 || window[0].weekly >= 100) return null;
    const hit = window.find((r) => r.weekly >= 100);
    return hit ? hit.at : null;
}

/** The 5-hour session limit over time — a sawtooth, one tooth per session. */
function sessionSeries(rows, sinceMs = 0) {
    return rows.filter((r) => r.at >= sinceMs && typeof r.session === 'number')
        .map((r) => ({ at: r.at, pct: r.session }));
}

module.exports = {
    FILE, MARKS, HEARTBEAT_MS, MAX_ROWS, WEEK_MS,
    historyPath, readHistory, recordLimits, pointOf, weeklyWindows, sessionSeries,
    marksPath, readMarks, recordMark, markFor, ranOutAt,
};
