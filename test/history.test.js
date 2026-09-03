const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../history');

const T0 = Date.parse('2026-08-08T10:00:00Z');
const RESET = Math.floor((T0 + 3 * 86400000) / 1000); // three days out

function store(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-hist-'));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const limits = (weekly, session = 10, scoped = []) => ({
    weekly: { pct: weekly, reset: RESET },
    session: { pct: session, reset: RESET },
    scoped,
});

test('a reading is recorded once and not repeated while it stands', () => store((dir) => {
    assert.equal(h.recordLimits(dir, limits(27), T0).written, true);
    assert.equal(h.recordLimits(dir, limits(27), T0 + 60000).written, false);
    assert.equal(h.recordLimits(dir, limits(28), T0 + 120000).written, true);
    assert.equal(h.readHistory(dir).length, 2);
}));

test('an unchanged reading is still recorded once the heartbeat elapses', () => store((dir) => {
    h.recordLimits(dir, limits(27), T0);
    assert.equal(h.recordLimits(dir, limits(27), T0 + h.HEARTBEAT_MS - 1).written, false);
    assert.equal(h.recordLimits(dir, limits(27), T0 + h.HEARTBEAT_MS).written, true);
}));

test('a per-model window moving is a change even when the overall one has not', () => store((dir) => {
    const withModel = (pct) => limits(27, 10, [{ scope: 'Opus', pct, reset: RESET }]);
    assert.equal(h.recordLimits(dir, withModel(40), T0).written, true);
    assert.equal(h.recordLimits(dir, withModel(40), T0 + 60000).written, false);
    assert.equal(h.recordLimits(dir, withModel(41), T0 + 120000).written, true);
    assert.equal(h.readHistory(dir)[1].models.Opus, 41);
}));

test('nothing is written when there are no limits to write', () => store((dir) => {
    assert.equal(h.recordLimits(dir, null, T0).written, false);
    assert.equal(h.recordLimits(dir, { weekly: null, scoped: [] }, T0).written, false);
    assert.equal(h.readHistory(dir).length, 0);
}));

test('a torn line does not take the rest of the history with it', () => store((dir) => {
    h.recordLimits(dir, limits(27), T0);
    fs.appendFileSync(h.historyPath(dir), '{"at":123,"weekly"\n');
    h.recordLimits(dir, limits(30), T0 + 60000);
    const rows = h.readHistory(dir);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.weekly), [27, 30]);
}));

test('readHistory drops what is older than the caller asked for', () => store((dir) => {
    h.recordLimits(dir, limits(10), T0);
    h.recordLimits(dir, limits(20), T0 + 86400000);
    assert.equal(h.readHistory(dir, T0 + 1000).length, 1);
}));

test('weeklyWindows places each reading by how far into its own window it sits', () => {
    const start = RESET * 1000 - h.WEEK_MS;
    const rows = [
        { at: start + h.WEEK_MS / 7, weekly: 12, reset: RESET },       // day 1
        { at: start + h.WEEK_MS / 2, weekly: 47, reset: RESET },       // day 3.5
        { at: start - 1000, weekly: 90, reset: RESET },                // before its window
        { at: start + h.WEEK_MS + 1000, weekly: 3, reset: RESET + 604800 }, // the next window
    ];
    const windows = h.weeklyWindows(rows);
    assert.equal(windows.length, 2);
    const first = windows.find((w) => w.reset === RESET);
    assert.equal(first.points.length, 2);
    assert.ok(Math.abs(first.points[0].day - 1) < 1e-9);
    assert.ok(Math.abs(first.points[1].day - 3.5) < 1e-9);
});

// The endpoint answered one live window with three resets a second apart, and
// keying on the raw value drew it as three separate weeks in three colours.
test('weeklyWindows treats a reset that drifts by seconds as one window', () => {
    const start = RESET * 1000 - h.WEEK_MS;
    const rows = [
        { at: start + h.WEEK_MS / 7, weekly: 12, reset: RESET - 1 },
        { at: start + h.WEEK_MS / 4, weekly: 20, reset: RESET },
        { at: start + h.WEEK_MS / 2, weekly: 47, reset: RESET + 1 },
    ];
    const windows = h.weeklyWindows(rows);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].points.length, 3);
    // The freshest reset wins, so the label matches the account page rather
    // than whichever answer happened to arrive first.
    assert.equal(windows[0].reset, RESET + 1);
    // One origin for every point: days are measured from the settled start.
    assert.ok(windows[0].points.every((p, i, a) => i === 0 || p.day > a[i - 1].day));
});

test('weeklyWindows keeps only the most recent windows', () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
        const reset = RESET + i * 604800;
        rows.push({ at: reset * 1000 - h.WEEK_MS / 2, weekly: i, reset });
    }
    const windows = h.weeklyWindows(rows, 3);
    assert.equal(windows.length, 3);
    assert.equal(windows[2].reset, RESET + 9 * 604800);
});

test('sessionSeries ignores readings that carried no session limit', () => {
    const rows = [
        { at: T0, session: 40, weekly: 10, reset: RESET },
        { at: T0 + 1000, session: null, weekly: 10, reset: RESET },
    ];
    assert.deepEqual(h.sessionSeries(rows), [{ at: T0, pct: 40 }]);
});

// The one path that rewrites the file whole, and the only one with nothing
// covering it. On this machine's own data it first runs about a year in, which
// is a bad moment for its first execution to be in production: it replaces a
// history nobody can get back.
test('a reading older than KEEP_MS is dropped when the file is rewritten', () => store((dir) => {
    // Fifty-four weeks of readings, one every six hours; the oldest fortnight
    // is past the year plus the slack that lets the file grow between rewrites.
    const step = 6 * 3600 * 1000;
    const n = Math.ceil((54 * h.WEEK_MS) / step);
    const now = T0 + n * step;
    const rows = Array.from({ length: n }, (_, i) => (
        { at: T0 + i * step, weekly: 10, session: 10, reset: RESET, models: {} }
    ));
    fs.writeFileSync(h.historyPath(dir), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    // A reading that differs, so it is recorded and the trim is reached.
    assert.equal(h.recordLimits(dir, limits(99), now).written, true);

    const kept = h.readHistory(dir);
    assert.ok(kept.length < rows.length, 'the file is cut, not left to grow');
    assert.ok(kept[0].at >= now - h.KEEP_MS, 'nothing older than a year survives');
    assert.ok(kept[0].at - step < now - h.KEEP_MS, 'the cut is at the year, not deeper');
    assert.equal(kept[kept.length - 1].weekly, 99, 'the newest reading survives');
    // Rewritten via tmp+rename, so nothing of the temporary file is left behind.
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
}));

test('the file is left alone while its oldest reading is within the year', () => store((dir) => {
    const step = 6 * 3600 * 1000;
    const n = Math.ceil((52 * h.WEEK_MS) / step);
    const now = T0 + n * step;
    const rows = Array.from({ length: n }, (_, i) => (
        { at: T0 + i * step, weekly: 10, session: 10, reset: RESET, models: {} }
    ));
    fs.writeFileSync(h.historyPath(dir), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(h.recordLimits(dir, limits(99), now).written, true);
    assert.equal(h.readHistory(dir).length, n + 1, 'a year of readings is kept whole');
}));

test('weeklyWindows keeps every window unless told a limit', () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
        const reset = RESET + i * 604800;
        rows.push({ at: reset * 1000 - h.WEEK_MS / 2, weekly: i, reset });
    }
    assert.equal(h.weeklyWindows(rows).length, 10);
});

// The mark: the one fact about a week that cannot be recomputed afterwards.
test('a window that ran out is marked once, with the plan of that moment', () => store((dir) => {
    assert.equal(h.recordMark(dir, { reset: RESET, at: T0, plan: 43 }).written, true);
    // Every tick after the first sees the same 100% and must not move the date.
    assert.equal(h.recordMark(dir, { reset: RESET, at: T0 + 3600000, plan: 61 }).written, false);

    const marks = h.readMarks(dir);
    assert.equal(marks.length, 1);
    assert.deepEqual(marks[0], { reset: RESET, at: T0, plan: 43 });
    // The reset the endpoint reports wanders by a second or two between calls,
    // which must not read as a second window.
    assert.ok(h.markFor(marks, RESET + 4));
    assert.equal(h.markFor(marks, RESET + 604800), null, 'next week is not this one');
}));

test('marks are kept per window, oldest dropped past the limit', () => store((dir) => {
    for (let i = 0; i < 4; i++) {
        h.recordMark(dir, { reset: RESET + i * 604800, at: T0 + i * 604800000, plan: 50 + i }, 3);
    }
    const marks = h.readMarks(dir);
    assert.equal(marks.length, 3, 'the limit is honoured');
    assert.deepEqual(marks.map((m) => m.reset), [RESET + 604800, RESET + 2 * 604800, RESET + 3 * 604800]);
}));

// The fallback for a window that ran out before this extension started marking
// them — and the reason a mark is written at all, since this one can go away.
test('the moment is recovered from the readings, and refused when they start too late', () => store((dir) => {
    h.recordLimits(dir, limits(96), T0);
    h.recordLimits(dir, limits(99), T0 + 3600000);
    h.recordLimits(dir, limits(100), T0 + 7200000);
    h.recordLimits(dir, limits(100), T0 + 10800000);
    assert.equal(h.ranOutAt(h.readHistory(dir), RESET), T0 + 7200000, 'the first sighting, not the latest');

    // Readings that begin at 100% cannot say when it started: the window was
    // already spent when the record opens, and a date taken from the first row
    // would be a fact this bar states out loud.
    const late = h.readHistory(dir).filter((r) => r.weekly >= 100);
    assert.equal(h.ranOutAt(late, RESET), null);
    assert.equal(h.ranOutAt([], RESET), null);
}));

// --- hour-of-day spend profile -------------------------------------------
// The plan the status bar compares spend against should follow the rhythm the
// person actually works to. The percentages already on disk are the cheapest
// possible source for it: same unit as the plan, already account-wide, and no
// transcript pass.
test('hourlyProfile: counts each rise under the local hour it happened in', () => {
    const at = (h, m = 0) => new Date(2026, 7, 10, h, m, 0).getTime();
    const reset = Math.floor(new Date(2026, 7, 13, 15, 0, 0).getTime() / 1000);
    const rows = [
        { at: at(2), weekly: 10, reset },
        { at: at(3), weekly: 16, reset },     // +6 in the 02:00 hour
        { at: at(4), weekly: 20, reset },     // +4 in the 03:00 hour
        { at: at(14), weekly: 21, reset },    // +1 earned somewhere across ten hours
    ];
    const p = h.hourlyProfile(rows);
    assert.equal(p[2], 6);
    assert.equal(p[3], 4);
    // A rise is reported when it is noticed, not when it happened, so a long
    // gap spreads rather than landing on its first hour. It costs little to get
    // this wrong either way: measured on the history on this machine, the median
    // gap between readings is 3 minutes, the 90th percentile 12, and intervals
    // longer than two hours carry 4.5% of all the rise there is.
    assert.ok(Math.abs(p[4] - 0.1) < 1e-9);
    assert.ok(Math.abs(p[13] - 0.1) < 1e-9);
    assert.equal(p[14], 0);
});

test('hourlyProfile: a reset is not a spend of minus ninety percent', () => {
    const at = (d, hh) => new Date(2026, 7, d, hh, 0, 0).getTime();
    const r1 = Math.floor(new Date(2026, 7, 13, 15, 0, 0).getTime() / 1000);
    const r2 = r1 + 7 * 86400;
    const rows = [
        { at: at(13, 14), weekly: 95, reset: r1 },
        { at: at(13, 16), weekly: 2, reset: r2 },   // new window: a drop, not a rise
        { at: at(13, 17), weekly: 5, reset: r2 },   // +3 in the 16:00 hour
    ];
    const p = h.hourlyProfile(rows);
    assert.equal(p[16], 3);
    assert.ok(Object.values(p).every((v) => v >= 0));
});

test('hourlyProfile: too little history returns nothing, so the plan stays linear', () => {
    assert.equal(h.hourlyProfile([]), null);
    assert.equal(h.hourlyProfile(null), null);
});

test('hourlyProfile: two readings sharing a timestamp are counted once', () => {
    const at = new Date(2026, 7, 10, 9, 0, 0).getTime();
    const reset = Math.floor(new Date(2026, 7, 13, 15, 0, 0).getTime() / 1000);
    const p = h.hourlyProfile([
        { at, weekly: 10, reset },
        { at, weekly: 14, reset },
    ]);
    assert.equal(p[9], 4);
    assert.equal(Object.values(p).reduce((a, b) => a + b, 0), 4);
});
