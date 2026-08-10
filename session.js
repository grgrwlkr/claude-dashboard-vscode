// The Claude Code session that belongs to this VS Code window, and everything
// knowable about it from files on disk. No dependency on vscode here, so this
// runs under plain node in tests.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { costOf } = require('./pricing');

const HOME = os.homedir();
const SESSIONS = path.join(HOME, '.claude', 'sessions');
const PROJECTS = path.join(HOME, '.claude', 'projects');

// A quarter-megabyte tail usually covers the last few dozen records, and only
// one of them is needed. Usually is not always: a single record can run to
// hundreds of kilobytes (a large file write, a long tool result), and then the
// whole buffer is one truncated line with nothing parseable in it. So the tail
// grows until a record turns up, or the file runs out.
const TAIL_STEPS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, Infinity];
const TAIL = TAIL_STEPS[0];

// Transcript directory slug: the whole path with every non-alphanumeric
// character turned into a hyphen (underscores included — easy to get wrong).
const slugFor = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function listSessions() {
    let names;
    try { names = fs.readdirSync(SESSIONS); } catch { return []; }
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const s = readJson(path.join(SESSIONS, name));
        if (s && s.sessionId && s.pid) out.push(s);
    }
    return out;
}

// Parents of the candidates in a single ps call: there are only a handful of
// sessions on a machine, and only those are of interest — not the whole tree.
function parentsOf(pids) {
    if (pids.length === 0) return new Map();
    // `ps` with these flags is POSIX. On Windows the call would throw on every
    // tick and land in the catch below anyway — this only spares the spawn, and
    // the caller already has fallbacks for "no parent map".
    if (process.platform === 'win32') return new Map();
    let out;
    try {
        out = execFileSync('ps', ['-o', 'pid=,ppid=', '-p', pids.join(',')],
            { encoding: 'utf8', timeout: 3000 });
    } catch { return new Map(); }
    const map = new Map();
    for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) map.set(Number(m[1]), Number(m[2]));
    }
    return map;
}

/**
 * The session belonging to this window. The panel's process is a direct child of
 * the extension host — this very process — so the window maps to its own session
 * exactly. Terminal sessions in the same repository do not match that test.
 * Fallbacks, for when ps is unavailable or the panel has not been opened yet:
 * a VS Code session with the same cwd, then the most recent live session there.
 */
function findOwnSession(workspace, myPid = process.pid) {
    const live = listSessions().filter((s) => alive(s.pid));
    if (live.length === 0) return null;

    const parents = parentsOf(live.map((s) => s.pid));
    const mine = live.filter((s) => parents.get(s.pid) === myPid);
    if (mine.length > 0) return newest(mine);

    if (!workspace) return null;
    const here = live.filter((s) => s.cwd === workspace);
    const vscode = here.filter((s) => s.entrypoint === 'claude-vscode');
    if (vscode.length > 0) return newest(vscode);
    return here.length > 0 ? newest(here) : null;
}

// Several panels in one window: take the one with the latest activity.
function newest(sessions) {
    return sessions.reduce((a, b) => (stamp(b) > stamp(a) ? b : a));
}

// The registry's own timestamps are unreliable — a session can sit there with no
// updatedAt at all, and then every candidate scores zero and the "latest" one is
// whatever the directory listing happened to return first. The transcript's
// mtime is the honest signal: it moves on every write, so it says which session
// is actually being used right now.
function stamp(s) {
    const registry = Date.parse(s.updatedAt || s.statusUpdatedAt || s.startedAt || '') || 0;
    let written = 0;
    if (s.cwd && s.sessionId) {
        try { written = fs.statSync(transcriptPath(s.cwd, s.sessionId)).mtimeMs; } catch { /* not started yet */ }
    }
    return Math.max(registry, written);
}

function transcriptPath(workspace, sessionId) {
    return path.join(PROJECTS, slugFor(workspace), `${sessionId}.jsonl`);
}

// The last record carrying usage. Subagent records are skipped: they have their
// own window and would hijack the main thread's.
//
// Reading grows in steps rather than fixing one buffer size, because a miss and
// a genuinely empty transcript look identical from a fixed window — and the miss
// showed up as a silently absent context indicator, not as an error.
function readTail(file) {
    let size;
    try { size = fs.statSync(file).size; } catch { return null; }

    for (const step of TAIL_STEPS) {
        const length = Math.min(step, size);
        const found = scanTail(file, size, length);
        if (found) return found;
        if (length >= size) break; // the whole file has been read; nothing there
    }
    return null;
}

function scanTail(file, size, length) {
    const buf = Buffer.alloc(length);
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, length, size - length);
    } catch { return null; } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    }

    let last = null;
    for (const line of buf.toString('utf8').split('\n')) {
        if (line.length < 50 || line[0] !== '{') continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r.message || !r.message.usage) continue;
        if (r.agentId || r.workflowId || r.isSidechain) continue;
        if (!last || Date.parse(r.timestamp) >= Date.parse(last.timestamp)) last = r;
    }
    return last;
}

// Model context window. A [1m] suffix forces a million; Haiku and anything
// unrecognised get 200k, and such a percentage is flagged as approximate.
function windowFor(model) {
    const m = (model || '').toLowerCase();
    if (m.includes('[1m]')) return { tokens: 1e6, estimated: false };
    if (/opus-[5-9]|opus-4-[6-9]|sonnet-[5-9]|sonnet-4-6|fable|mythos/.test(m)) {
        return { tokens: 1e6, estimated: false };
    }
    if (/haiku/.test(m)) return { tokens: 200000, estimated: false };
    return { tokens: 200000, estimated: true };
}

/** Context, model and settings from the last transcript record. */
function contextOf(record) {
    if (!record) return null;
    const u = record.message.usage;
    const input = u.input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    const tokens = input + cacheRead + cacheWrite;
    const win = windowFor(record.message.model);
    return {
        tokens,
        window: win.tokens,
        estimated: win.estimated,
        // floor, not round, the way statusline.sh does it: rounding up would
        // read as "cache 100%" at ninety-nine and a half.
        pct: Math.min(100, Math.floor((tokens / win.tokens) * 100)),
        cachePct: tokens > 0 ? Math.floor((cacheRead / tokens) * 100) : -1,
        model: record.message.model || '',
        effort: record.effort || '',
        advisor: record.advisorModel || '',
        branch: record.gitBranch || '',
        at: Date.parse(record.timestamp) || 0,
    };
}

// Everything that needs the whole transcript is computed in a single pass: cost,
// duration, share of time spent waiting on the model, edits, message count. A
// 5 MB file parses in ~20 ms, so this runs on the slow tick, not on every draw.
function sessionStats(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

    let cost = 0;
    let messages = 0;
    let added = 0;
    let removed = 0;
    let first = 0;
    let last = 0;
    let waiting = 0;
    let prev = 0;

    for (const line of text.split('\n')) {
        if (line.length < 50 || line[0] !== '{') continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }

        const at = Date.parse(r.timestamp) || 0;
        if (at) {
            if (!first) first = at;
            last = at;
        }

        if (r.message && r.message.usage) {
            cost += costOf(r.message.model, r.message.usage);
            messages++;
            // The gap before a model reply is the wait for that reply. There is
            // no exact api_duration_ms on disk, so the share is an estimate.
            if (prev && at > prev) waiting += at - prev;
        }
        if (at) prev = at;

        const patch = r.toolUseResult && r.toolUseResult.structuredPatch;
        if (Array.isArray(patch)) {
            for (const hunk of patch) {
                for (const l of hunk.lines || []) {
                    if (l[0] === '+') added++;
                    else if (l[0] === '-') removed++;
                }
            }
        }
    }

    const duration = first && last ? last - first : 0;
    return {
        cost,
        messages,
        added,
        removed,
        durationMs: duration,
        // Share of wall-clock time spent waiting on model replies.
        apiPct: duration > 0 ? Math.min(100, Math.round((waiting / duration) * 100)) : -1,
        burn: duration > 60000 ? cost / (duration / 3600000) : -1,
    };
}

// Compatibility with the earlier call site: cost only.
function costOfSession(file) {
    const stats = sessionStats(file);
    return stats ? stats.cost : 0;
}

// Today's spend across every project. Files are picked by mtime and records
// inside them by date: a session started yesterday and continued today lives in
// a file named yesterday but carries a fresh mtime.
function costToday(nowMs = Date.now()) {
    const midnight = new Date(nowMs);
    midnight.setHours(0, 0, 0, 0);
    const since = midnight.getTime();
    let total = 0;
    let files = 0;

    let slugs;
    try { slugs = fs.readdirSync(PROJECTS); } catch { return { usd: 0, files: 0 }; }
    for (const slug of slugs) {
        const dir = path.join(PROJECTS, slug);
        let names;
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
            if (!name.endsWith('.jsonl')) continue;
            const file = path.join(dir, name);
            let st;
            try { st = fs.statSync(file); } catch { continue; }
            if (st.mtimeMs < since) continue;
            files++;
            total += costSince(file, since);
        }
    }
    return { usd: total, files };
}

function costSince(file, since) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
    let total = 0;
    for (const line of text.split('\n')) {
        if (line.length < 50 || line[0] !== '{') continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r.message || !r.message.usage) continue;
        if ((Date.parse(r.timestamp) || 0) < since) continue;
        total += costOf(r.message.model, r.message.usage);
    }
    return total;
}

// Neighbours in this repository: how many live sessions besides ours, and how
// many of them are busy.
function peersOf(workspace, ownSessionId) {
    const live = listSessions().filter(
        (s) => alive(s.pid) && s.cwd === workspace && s.sessionId !== ownSessionId,
    );
    return { total: live.length, busy: live.filter((s) => s.status === 'busy').length };
}

// The current session's task list — the same source the agent's own todo uses.
function todoOf(sessionId) {
    const dir = path.join(HOME, '.claude', 'tasks', sessionId);
    let names;
    try { names = fs.readdirSync(dir); } catch { return null; }
    let done = 0; let total = 0; let active = '';
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const t = readJson(path.join(dir, name));
        if (!t || !t.status) continue;
        total++;
        if (t.status === 'completed') done++;
        else if (t.status === 'in_progress' && !active) active = t.activeForm || t.subject || '';
    }
    return total > 0 ? { done, total, active } : null;
}

// Auto-compact threshold as a share of the window: the effective window minus
// the reply reserve (capped at 20k) minus 13k — the same arithmetic as
// statusline.sh. Reads the settings chain the client reads; the first file with
// the key wins. `||` is wrong for autoCompactEnabled — false is meaningful there.
function autoCompactPct(workspace, windowTokens) {
    if (!(windowTokens > 0)) return -1;
    const files = [
        path.join(workspace, '.claude', 'settings.local.json'),
        path.join(workspace, '.claude', 'settings.json'),
        path.join(HOME, '.claude', 'settings.local.json'),
        path.join(HOME, '.claude', 'settings.json'),
    ];
    let enabled = true;
    let limit = 0;
    let seenEnabled = false;
    let seenLimit = false;
    for (const file of files) {
        const cfg = readJson(file);
        if (!cfg) continue;
        if (!seenEnabled && cfg.autoCompactEnabled !== undefined && cfg.autoCompactEnabled !== null) {
            enabled = cfg.autoCompactEnabled !== false;
            seenEnabled = true;
        }
        if (!seenLimit && cfg.autoCompactWindow) { limit = cfg.autoCompactWindow; seenLimit = true; }
    }
    if (!enabled) return -1;
    const effective = limit > 0 && limit < windowTokens ? limit : windowTokens;
    const threshold = effective - 20000 - 13000;
    return threshold > 0 ? Math.round((threshold / windowTokens) * 100) : -1;
}

// This session's client version and whichever one is already unpacked next to
// it: the client stages a new binary in versions/ before a session moves to it,
// so a mismatch means an update is waiting — the same read statusline.sh does.
function versionInfo(sessionVersion) {
    const dir = path.join(HOME, '.local', 'share', 'claude', 'versions');
    let names;
    try { names = fs.readdirSync(dir); } catch { return { current: sessionVersion || '', latest: '' }; }
    let latest = '';
    for (const name of names) {
        if (!/^\d+\.\d+\.\d+$/.test(name)) continue;
        if (!latest || compareVersions(name, latest) > 0) latest = name;
    }
    const newer = sessionVersion && latest && compareVersions(latest, sessionVersion) > 0;
    return { current: sessionVersion || '', latest: newer ? latest : '' };
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
}

// Settings the transcript does not carry — output style and advisor model — read
// from the same chain the client reads; the first file with the key wins.
function settingsOf(workspace) {
    const files = [
        path.join(workspace || '', '.claude', 'settings.local.json'),
        path.join(workspace || '', '.claude', 'settings.json'),
        path.join(HOME, '.claude', 'settings.local.json'),
        path.join(HOME, '.claude', 'settings.json'),
    ];
    const out = { outputStyle: '', advisor: '', model: '', thinking: true, thinkingSummaries: true };
    // `||` cannot resolve the two booleans: false is a real answer there, and
    // the first file that states one wins, exactly as the client resolves them.
    let seenThinking = false;
    let seenSummaries = false;
    for (const file of files) {
        const cfg = readJson(file);
        if (!cfg) continue;
        if (!out.outputStyle && cfg.outputStyle) out.outputStyle = cfg.outputStyle;
        if (!out.advisor && cfg.advisorModel) out.advisor = cfg.advisorModel;
        if (!out.model && cfg.model) out.model = cfg.model;
        if (!seenThinking && cfg.alwaysThinkingEnabled !== undefined && cfg.alwaysThinkingEnabled !== null) {
            out.thinking = cfg.alwaysThinkingEnabled !== false;
            seenThinking = true;
        }
        if (!seenSummaries && cfg.showThinkingSummaries !== undefined && cfg.showThinkingSummaries !== null) {
            out.thinkingSummaries = cfg.showThinkingSummaries !== false;
            seenSummaries = true;
        }
    }
    return out;
}

function fmtDuration(ms) {
    if (!(ms > 0)) return '';
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`;
    if (h > 0) return `${h}h${m % 60}m`;
    return `${m}m`;
}

module.exports = {
    SESSIONS, PROJECTS, TAIL,
    slugFor, listSessions, findOwnSession, transcriptPath, readTail, contextOf,
    windowFor, sessionStats, costOfSession, costToday, costSince, peersOf, todoOf,
    autoCompactPct, versionInfo, compareVersions, settingsOf, fmtDuration,
};
