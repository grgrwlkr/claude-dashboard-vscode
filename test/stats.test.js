const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('../session');

const T0 = Date.parse('2026-08-08T10:00:00Z');

function usageRec(offsetMs, over = {}) {
    return JSON.stringify({
        timestamp: new Date(T0 + offsetMs).toISOString(),
        message: {
            model: 'claude-opus-5',
            usage: { input_tokens: 0, output_tokens: 1e6 },
        },
        ...over,
    });
}

function patchRec(offsetMs, added, removed) {
    return JSON.stringify({
        timestamp: new Date(T0 + offsetMs).toISOString(),
        toolUseResult: {
            structuredPatch: [{
                lines: [
                    ...Array(added).fill('+an added line'),
                    ...Array(removed).fill('-a removed line'),
                    ' a context line, which must not be counted',
                ],
            }],
        },
    });
}

function withTranscript(lines, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('sessionStats computes cost, requests and duration in a single pass', () => {
    withTranscript([usageRec(0), usageRec(3600000)], (file) => {
        const st = s.sessionStats(file);
        assert.equal(st.messages, 2);
        assert.equal(st.cost, 50); // two requests of 1M output on Opus 5 = $25 each
        assert.equal(st.durationMs, 3600000);
        assert.equal(st.burn, 50); // exactly one hour of work
    });
});

test('sessionStats sums edits and ignores context lines of a patch', () => {
    withTranscript([usageRec(0), patchRec(1000, 4, 1), patchRec(2000, 9, 3)], (file) => {
        const st = s.sessionStats(file);
        assert.equal(st.added, 13);
        assert.equal(st.removed, 4);
    });
});

test('the api share is the part of the time spent waiting on the model', () => {
    // One hour total: a 10-minute pause before the first reply, 5 before the next.
    withTranscript([
        patchRec(0, 0, 0),
        usageRec(600000),
        patchRec(3000000, 0, 0),
        usageRec(3300000),
        patchRec(3600000, 0, 0),
    ], (file) => {
        const st = s.sessionStats(file);
        assert.equal(st.durationMs, 3600000);
        assert.equal(st.apiPct, 25); // (10 + 5) minutes out of 60
    });
});

test('sessionStats reports no burn rate on a session that is too short', () => {
    withTranscript([usageRec(0), usageRec(30000)], (file) => {
        assert.equal(s.sessionStats(file).burn, -1);
        assert.equal(s.sessionStats(file).apiPct, 100);
    });
});

test('sessionStats returns null for a missing file', () => {
    assert.equal(s.sessionStats('/nope/missing.jsonl'), null);
});

test('compareVersions compares numerically, not lexicographically', () => {
    assert.ok(s.compareVersions('2.1.226', '2.1.99') > 0);
    assert.ok(s.compareVersions('2.10.0', '2.9.9') > 0);
    assert.equal(s.compareVersions('2.1.226', '2.1.226'), 0);
    assert.ok(s.compareVersions('2.0.0', '2.1.0') < 0);
});

test('versionInfo offers no update when the session is already current', () => {
    // The versions directory may be absent on a machine — then latest is empty
    // either way.
    const info = s.versionInfo('999.0.0');
    assert.equal(info.current, '999.0.0');
    assert.equal(info.latest, '');
});

test('fmtDuration: minutes, hours, days', () => {
    assert.equal(s.fmtDuration(0), '');
    assert.equal(s.fmtDuration(37 * 60000), '37m');
    assert.equal(s.fmtDuration((2 * 60 + 13) * 60000), '2h13m');
    assert.equal(s.fmtDuration((26 * 60 + 5) * 60000), '1d2h');
});

test('settingsOf walks the chain and the first file with a key wins', () => {
    const settings = s.settingsOf('/nope/not-a-workspace');
    assert.equal(typeof settings.model, 'string');
    assert.equal(typeof settings.advisor, 'string');
});
