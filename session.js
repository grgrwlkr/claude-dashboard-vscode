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

// The last `length` bytes of a file, as text. Shared by the two scanners below
// so that growing the window is one decision made in one place.
function readChunk(file, size, length) {
    const buf = Buffer.alloc(length);
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, length, size - length);
    } catch { return null; } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    return buf.toString('utf8');
}

function scanTail(file, size, length) {
    const text = readChunk(file, size, length);
    if (text === null) return null;

    let last = null;
    for (const line of text.split('\n')) {
        if (line.length < 50 || line[0] !== '{') continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r.message || !r.message.usage) continue;
        if (r.agentId || r.workflowId || r.isSidechain) continue;
        if (!last || Date.parse(r.timestamp) >= Date.parse(last.timestamp)) last = r;
    }
    return last;
}

/**
 * The title the client shows for a session — the generated one, or the one the
 * user typed, which wins.
 *
 * It is written as a record of its own and rewritten as the session goes on, so
 * the last one in the file is the current one. Measured on a 5.5 MB transcript:
 * 76 title records, roughly one per 70 KB, the last of them 3 KB from the end —
 * which is why this reads the tail and grows the window only if that misses,
 * exactly as `readTail` does for usage.
 */
function titleOf(workspace, sessionId) {
    if (!workspace || !sessionId) return '';
    return titleIn(transcriptPath(workspace, sessionId));
}

// The same read against a transcript by path — where the work is, and the half a
// test can drive without a project tree around it.
function titleIn(file) {
    let size;
    try { size = fs.statSync(file).size; } catch { return ''; }

    for (const step of TAIL_STEPS) {
        const length = Math.min(step, size);
        const found = scanTitle(file, size, length);
        if (found) return found;
        if (length >= size) break;
    }
    return '';
}

function scanTitle(file, size, length) {
    const text = readChunk(file, size, length);
    if (text === null) return '';

    let title = '';
    for (const line of text.split('\n')) {
        if (line[0] !== '{' || !line.includes('Title"')) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        // A record carries one or the other; `customTitle` is what the user
        // typed and outranks the generated one when both have been written.
        if (r.aiTitle) title = r.aiTitle;
        if (r.customTitle) title = r.customTitle;
    }
    return title;
}

/**
 * The live session running inside a given shell — the pid of a terminal, and the
 * `claude` process is its direct child (verified against the process table:
 * every session in the registry has a `/bin/zsh` parent).
 *
 * No fallback on purpose. `findOwnSession` above may guess by workspace because
 * a window has exactly one panel session; a window can hold any number of
 * terminals, and a guess there would label one tab with another tab's session.
 */
function sessionForShell(shellPid) {
    if (!shellPid) return null;
    const live = listSessions().filter((s) => alive(s.pid));
    if (live.length === 0) return null;
    const parents = parentsOf(live.map((s) => s.pid));
    const mine = live.filter((s) => parents.get(s.pid) === shellPid);
    return mine.length > 0 ? newest(mine) : null;
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

// Four characters to a token, the same rate the memory files are weighed at in
// `system.js`. Right in the first digit, which is all a "what is my window full
// of" figure needs.
const CHARS_PER_TOKEN = 4;

/**
 * What is in the context window besides the conversation, as far as the
 * transcript admits.
 *
 * `/context` computes its breakdown in memory and writes none of it down, but
 * four of its rows leave a trace: the client records the skill listing, the
 * deferred tool names, the agent listing and each MCP server's instructions as
 * attachments, because those are the blocks it adds to the prompt.
 *
 * They are deltas, and that is the trap. A listing repeats and grows over a long
 * session, so adding up every record counts the same skill many times over — on
 * this machine that reads ~93k tokens of skills where the client says ~10k. What
 * is in the window is the state at the end of the file: a listing marked
 * `isInitial` replaces what came before it, everything else adds and removes by
 * name.
 *
 * What this cannot see is worth saying out loud: the system prompt, and the tool
 * schemas themselves — the transcript carries tool *names*, not their
 * definitions, so the largest row of `/context` is not here. The caller reports
 * the difference as unaccounted rather than pretending the window is smaller.
 */
function contextParts(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

    const skills = new Map();
    const tools = new Map();
    const agents = new Map();
    const mcp = new Map();
    let hooks = 0;

    // Each block arrives with the text that was added; where a delta names more
    // entries than it carries lines, the name itself is what reached the prompt.
    const put = (into, names, lines) => {
        (names || []).forEach((name, i) => {
            const line = (lines || [])[i];
            into.set(name, typeof line === 'string' ? line.length : String(name).length);
        });
    };
    const drop = (from, names) => { (names || []).forEach((name) => from.delete(name)); };

    for (const line of text.split('\n')) {
        if (line.length < 40 || line[0] !== '{') continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        // One file holds several contexts. A subagent's records sit in the same
        // transcript and carry listings of their own: an `isInitial` one from an
        // agent would wipe the state built for this window, and its tools would
        // be counted into a window they were never in. The same three markers
        // `readTail` has always skipped.
        if (record.agentId || record.workflowId || record.isSidechain) continue;
        const a = record.attachment;
        if (!a || typeof a !== 'object') continue;

        if (a.type === 'skill_listing') {
            if (a.isInitial) skills.clear();
            const names = a.names || [];
            // One listing, one block of text: it is split evenly rather than
            // guessed per skill, because the text is written as a whole.
            const each = (a.content || '').length / Math.max(1, names.length);
            names.forEach((name) => skills.set(name, each));
        } else if (a.type === 'deferred_tools_delta') {
            drop(tools, a.removedNames);
            put(tools, a.addedNames, a.addedLines);
            (a.readdedNames || []).forEach((name) => {
                if (!tools.has(name)) tools.set(name, String(name).length);
            });
        } else if (a.type === 'agent_listing_delta') {
            if (a.isInitial) agents.clear();
            drop(agents, a.removedTypes);
            put(agents, a.addedTypes, a.addedLines);
        } else if (a.type === 'mcp_instructions_delta') {
            drop(mcp, a.removedNames);
            put(mcp, a.addedNames, a.addedBlocks);
        } else if (a.type === 'hook_additional_context') {
            hooks += (a.content || []).reduce((sum, c) => sum + String(c).length, 0);
        }
    }

    const tok = (map) => Math.round([...map.values()].reduce((a, b) => a + b, 0) / CHARS_PER_TOKEN);
    return {
        skills: tok(skills),
        tools: tok(tools),
        agents: tok(agents),
        mcp: tok(mcp),
        hooks: Math.round(hooks / CHARS_PER_TOKEN),
        counts: { skills: skills.size, tools: tools.size, agents: agents.size, mcp: mcp.size },
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

// The settings files, highest precedence first — one definition, because three
// readers walk this list and a fourth is a page that reports which file won.
// Order is the documented one: managed settings override everything, then the
// project's local file, the project's shared file, and the user's.
//
// `~/.claude/settings.local.json` is the one entry the precedence list does not
// mention. It is read anyway — it exists on machines that never created it by
// hand, holds ordinary settings keys, and statusline.sh reads it too — but it
// is flagged `documented: false` so a page can say so rather than presenting a
// guess as the client's own order.
const MANAGED = process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : '/etc/claude-code/managed-settings.json';

function settingsFiles(workspace) {
    const ws = workspace || '';
    return [
        { scope: 'managed', path: MANAGED, documented: true },
        ...(ws ? [
            { scope: 'local', path: path.join(ws, '.claude', 'settings.local.json'), documented: true },
            { scope: 'project', path: path.join(ws, '.claude', 'settings.json'), documented: true },
        ] : []),
        { scope: 'user local', path: path.join(HOME, '.claude', 'settings.local.json'), documented: false },
        { scope: 'user', path: path.join(HOME, '.claude', 'settings.json'), documented: true },
    ];
}

/**
 * The chain with each file's contents attached: `{ scope, path, documented,
 * exists, data }`, highest precedence first. A file that is missing or
 * unparseable comes back with `data: null` and is skipped by every reader —
 * the page shows it as a file that is not there rather than dropping the row.
 */
function settingsChain(workspace) {
    return settingsFiles(workspace).map((f) => {
        const data = readJson(f.path);
        return { ...f, exists: data !== null, data };
    });
}

/**
 * The first file that states `key`, and every other file that also states it.
 * `undefined` and `null` do not count as stating it — which is the whole reason
 * this is not a `||` chain: `false` is an answer and `autoCompactEnabled: false`
 * must beat a `true` further down.
 */
function resolveSetting(chain, key) {
    let winner = null;
    const alsoIn = [];
    for (const file of chain) {
        if (!file.data) continue;
        const value = file.data[key];
        if (value === undefined || value === null) continue;
        if (!winner) winner = { value, from: file.scope, path: file.path };
        else alsoIn.push({ value, from: file.scope, path: file.path });
    }
    return winner ? { ...winner, alsoIn } : null;
}

// Auto-compact threshold as a share of the window: the effective window minus
// the reply reserve (capped at 20k) minus 13k — the same arithmetic as
// statusline.sh, down to the constant.
//
// The client's reserve is min(max_output_tokens, 20k), so the cap is real; it is
// written here as a flat 20000 because every model anyone works in has a larger
// max_output_tokens, which means the cap always binds. Both implementations
// folded it the same way on purpose — a different number here and the two stop
// agreeing. That reasoning lived only in the shell script, which is not in this
// repository.
function autoCompactPct(workspace, windowTokens, chain) {
    if (!(windowTokens > 0)) return -1;
    const files = chain || settingsChain(workspace);
    const enabledAt = resolveSetting(files, 'autoCompactEnabled');
    const limitAt = resolveSetting(files, 'autoCompactWindow');
    const enabled = enabledAt ? enabledAt.value !== false : true;
    const limit = limitAt && limitAt.value > 0 ? limitAt.value : 0;
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

/**
 * The output style a running session was started with, out of its own command
 * line. The client has no `--output-style` flag, so this extension launches a
 * session by putting the style in `--settings` JSON — and that is the one place
 * it exists: the transcript does not carry it, and neither does the session
 * registry. Reading it back out of the settings chain alone left the pill blank
 * for every session the extension itself had started.
 *
 * Parsed by walking the braces rather than by a regular expression, so a value
 * containing `}` cannot end the object early.
 */
function styleFromArgs(args) {
    const line = String(args || '');
    const flag = line.indexOf('--settings');
    if (flag < 0) return '';
    const open = line.indexOf('{', flag);
    if (open < 0) return '';
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let i = open; i < line.length; i++) {
        const c = line[i];
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) return '';
    try {
        const parsed = JSON.parse(line.slice(open, end));
        return typeof parsed.outputStyle === 'string' ? parsed.outputStyle : '';
    } catch { return ''; }
}

// One `ps` for one session, on the pattern `parentsOf` above already sets: the
// same POSIX flags, the same early return on Windows, the same timeout, and a
// failure that costs a blank rather than an exception.
function styleOfSession(pid) {
    if (!pid || process.platform === 'win32') return '';
    try {
        return styleFromArgs(execFileSync('ps', ['-o', 'args=', '-p', String(pid)],
            { encoding: 'utf8', timeout: 3000 }));
    } catch { return ''; }
}

/**
 * Settings the transcript does not carry, read from the same chain the client
 * reads. The advisor is here for the session panel's convenience rather than
 * from necessity — the transcript states `advisorModel` too, and `contextOf`
 * takes it from there.
 *
 * `argStyle` is what the session was actually started with, and it beats the
 * file. Not a tie-break: the client compiles the style into the system prompt
 * at session start and does not reload it, so a file edited since then states
 * what the next session will get, not what this one is running.
 */
function settingsOf(workspace, chain, argStyle) {
    const files = chain || settingsChain(workspace);
    const at = (key) => resolveSetting(files, key);
    const thinking = at('alwaysThinkingEnabled');
    const summaries = at('showThinkingSummaries');
    return {
        outputStyle: argStyle || at('outputStyle')?.value || '',
        advisor: at('advisorModel')?.value || '',
        model: at('model')?.value || '',
        thinking: thinking ? thinking.value !== false : true,
        thinkingSummaries: summaries ? summaries.value !== false : true,
    };
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
    slugFor, listSessions, findOwnSession, sessionForShell, titleOf, titleIn,
    transcriptPath, readTail, contextOf,
    windowFor, sessionStats, contextParts, costToday, costSince, peersOf, todoOf,
    autoCompactPct, versionInfo, compareVersions, settingsOf, fmtDuration,
    settingsFiles, settingsChain, resolveSetting, styleFromArgs, styleOfSession, MANAGED,
};
