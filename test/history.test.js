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
