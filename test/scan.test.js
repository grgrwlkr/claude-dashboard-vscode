// One read of a transcript answers both questions asked of it, and the next
// read starts where this one stopped. The transcript only ever grows, so a tick
// that re-reads it from the top is re-reading a file it has already seen.

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
        requestId: `req-${offsetMs}`,
        message: { model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: 1e6 } },
        ...over,
    });
}

function skillRec(names, content) {
    return JSON.stringify({
        timestamp: new Date(T0).toISOString(),
        attachment: { type: 'skill_listing', isInitial: true, names, content },
    });
}

function withDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsl-scan-'));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function write(file, lines) { fs.writeFileSync(file, lines.join('\n') + '\n'); }
function append(file, lines) { fs.appendFileSync(file, lines.join('\n') + '\n'); }

test('scanTranscript answers money and window from a single read', () => {
    withDir((dir) => {
        const file = path.join(dir, 'a.jsonl');
        write(file, [usageRec(0), skillRec(['one', 'two'], 'x'.repeat(80)), usageRec(3600000)]);
        s.forgetTranscript(file);

        const scan = s.scanTranscript(file);
        assert.equal(scan.stats.messages, 2);
        assert.equal(scan.stats.cost, 50);
        assert.equal(scan.parts.counts.skills, 2);
        assert.equal(scan.read.bytes, fs.statSync(file).size);
        assert.equal(scan.read.from, 0);
    });
});

test('a transcript that has not moved is not read again', () => {
    withDir((dir) => {
        const file = path.join(dir, 'b.jsonl');
        write(file, [usageRec(0)]);
        s.forgetTranscript(file);

        s.scanTranscript(file);
        const again = s.scanTranscript(file);
        assert.equal(again.read.bytes, 0);
        assert.equal(again.stats.messages, 1);
        assert.equal(again.stats.cost, 25);
    });
});

test('a grown transcript is read only from where the last look stopped', () => {
    withDir((dir) => {
        const file = path.join(dir, 'c.jsonl');
        write(file, [usageRec(0)]);
        s.forgetTranscript(file);
        const first = s.scanTranscript(file);
        const wasSize = fs.statSync(file).size;

        append(file, [usageRec(3600000), skillRec(['s'], 'y'.repeat(40))]);
        const grown = s.scanTranscript(file);

        assert.equal(grown.read.from, wasSize);
        assert.equal(grown.read.bytes, fs.statSync(file).size - wasSize);
        // The incremental answer is the answer a full pass would have given.
        s.forgetTranscript(file);
        const whole = s.scanTranscript(file);
        assert.deepEqual(grown.stats, whole.stats);
        assert.deepEqual(grown.parts, whole.parts);
        assert.ok(first.stats.cost < grown.stats.cost);
    });
});

test('a transcript rewritten under the same name is read from the top', () => {
    withDir((dir) => {
        const file = path.join(dir, 'd.jsonl');
        write(file, [usageRec(0), usageRec(1000), usageRec(2000)]);
        s.forgetTranscript(file);
        s.scanTranscript(file);

        // Shorter than before: the stored offset points past the end now.
        write(file, [usageRec(5000)]);
        const after = s.scanTranscript(file);
        assert.equal(after.read.from, 0);
        assert.equal(after.stats.messages, 1);
    });
});

test('a transcript replaced by another of the same size is read from the top', () => {
    withDir((dir) => {
        const file = path.join(dir, 'e.jsonl');
        write(file, [usageRec(0, { sessionId: 'one' })]);
        s.forgetTranscript(file);
        const before = s.scanTranscript(file);

        // Same length, different content: only the head of the file says so.
        const other = usageRec(0, { sessionId: 'two' });
        assert.equal(other.length, usageRec(0, { sessionId: 'one' }).length);
        write(file, [other]);
        const after = s.scanTranscript(file);

        assert.equal(after.read.from, 0);
        assert.equal(after.stats.cost, before.stats.cost);
    });
});

test('sessionStats and contextParts share the one read', () => {
    withDir((dir) => {
        const file = path.join(dir, 'f.jsonl');
        write(file, [usageRec(0), skillRec(['a'], 'z'.repeat(100))]);
        s.forgetTranscript(file);

        const stats = s.sessionStats(file);
        const second = s.scanTranscript(file);
        assert.equal(second.read.bytes, 0, 'the second question re-reads nothing');
        assert.equal(stats.messages, 1);
        assert.ok(s.contextParts(file).skills > 0);
    });
});

test('a record still being written is counted once, when it is whole', () => {
    withDir((dir) => {
        const file = path.join(dir, 'j.jsonl');
        write(file, [usageRec(0)]);
        s.forgetTranscript(file);
        s.scanTranscript(file);

        // Half a record on disk: the writer has not reached its newline yet.
        const whole = usageRec(3600000);
        fs.appendFileSync(file, whole.slice(0, 40));
        const mid = s.scanTranscript(file);
        assert.equal(mid.stats.messages, 1, 'a truncated line is not a record');

        fs.appendFileSync(file, whole.slice(40) + '\n');
        const done = s.scanTranscript(file);
        assert.equal(done.stats.messages, 2, 'and it lands whole on the next look');
        assert.equal(done.stats.cost, 50);
    });
});

test('a missing transcript answers nothing, as it always did', () => {
    assert.equal(s.scanTranscript('/nope/missing.jsonl'), null);
    assert.equal(s.sessionStats('/nope/missing.jsonl'), null);
    assert.equal(s.contextParts('/nope/missing.jsonl'), null);
});

test('readLines carries a record that spans several chunks', () => {
    withDir((dir) => {
        const file = path.join(dir, 'g.jsonl');
        const long = usageRec(0, { note: 'q'.repeat(5000) });
        write(file, [long, usageRec(1000)]);

        const seen = [];
        s.readLines(file, 0, fs.statSync(file).size, (line) => seen.push(line), 64);
        assert.equal(seen.length, 2);
        assert.equal(seen[0], long);
        assert.equal(JSON.parse(seen[0]).note.length, 5000);
    });
});

test('readLines does not cut a multi-byte character at a chunk edge', () => {
    withDir((dir) => {
        const file = path.join(dir, 'h.jsonl');
        // Cyrillic and an emoji: two and four bytes, landing on every offset as
        // the chunk size walks past them.
        const line = JSON.stringify({ text: 'привет 🚀 мир' });
        write(file, [line]);
        for (let chunk = 1; chunk <= 40; chunk++) {
            const seen = [];
            s.readLines(file, 0, fs.statSync(file).size, (l) => seen.push(l), chunk);
            assert.equal(seen.length, 1, `chunk ${chunk}`);
            assert.equal(JSON.parse(seen[0]).text, 'привет 🚀 мир', `chunk ${chunk}`);
        }
    });
});

test('a big transcript is not held in memory as one string', () => {
    withDir((dir) => {
        const file = path.join(dir, 'i.jsonl');
        // Past the one-megabyte chunk, so the reader has to take more than one.
        const lines = [];
        for (let i = 0; i < 700; i++) lines.push(usageRec(i * 1000, { pad: 'p'.repeat(2000) }));
        write(file, lines);
        s.forgetTranscript(file);

        const scan = s.scanTranscript(file);
        assert.equal(scan.stats.messages, 700);
        // The whole file went through the reader in chunks, not in one buffer.
        assert.ok(scan.read.chunks > 1, `read in ${scan.read.chunks} chunk(s)`);
    });
});
