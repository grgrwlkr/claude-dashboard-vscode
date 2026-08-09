// Workflow runs, read from the two trees Claude Code writes them to.
//
// A finished run leaves one snapshot: <session>/workflows/<runId>.json, written
// once when the run ends. A live run leaves nothing there — only the journal and
// the agent transcripts under <session>/subagents/workflows/<runId>/. The `wf_`
// prefix belongs to the run id itself, not to the naming of those paths, so
// joining one never prepends it: 73 of 73 snapshots on this machine have
// `runId === basename(file, '.json')`. Both trees are undocumented internals of a
// client that ships almost daily, so every field here is optional and a parse
// failure yields nothing rather than a wrong number.
//
// Walking the tree is this module's job too, and one run is not always in one
// place: five runs on this machine keep their directory under one session id and
// their snapshot under another, matching to about 20 ms at both ends. So a run is
// identified by `slug/runId` rather than by the session that happens to hold a
// half of it — but only complementary halves are folded together, at most one
// snapshot and one directory each. Two snapshots under one run id are two
// attempts, not two halves: one such pair here reads killed with 7 agents against
// completed with 65, and merging them would hand a run the other's numbers.
//
// No dependency on vscode: the roots are parameters, so this runs under plain node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectName } = require('./indexer');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');

// The client writes a capped preview as 400 characters plus an ellipsis — 2590 of
// them are exactly that on this machine — but that is its habit, not a promise,
// and a run with dozens of agents would carry all of it into a panel.
const PREVIEW_CHARS = 400;

// Cut at the same 400 and put the ellipsis back, which leaves the client's own
// 401-character preview exactly as it was and marks anything we cut ourselves.
// The marker is the point: a preview is read as prose, and prose broken off
// mid-word without one reads as something the agent actually wrote.
function clip(text, max = PREVIEW_CHARS) {
    const s = text || '';
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listDir(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function statOf(file) {
    try { return fs.statSync(file); } catch { return null; }
}

// One entry of workflowProgress, in the shape the rest of the extension uses.
// `state` is the client's own word for it: done, start, progress and error are
// what 1356 live entries hold, and the list is open — mapping it to a vocabulary
// of ours would turn the next word the client invents into a blank cell, so it is
// passed through and rendered as it comes.
function agentOf(entry) {
    if (!entry || entry.type !== 'workflow_agent' || !entry.agentId) return null;
    return {
        agentId: String(entry.agentId),
        label: entry.label || '',
        phase: entry.phaseTitle || '',
        model: entry.model || '',
        state: entry.state || '',
        tokens: entry.tokens || 0,
        toolCalls: entry.toolCalls || 0,
        durationMs: entry.durationMs || 0,
        lastToolName: entry.lastToolName || '',
        // Bounded here, the way system.js bounds a hook command and a job detail:
        // the size of a row is ours to decide, not the client's to hand us.
        promptPreview: clip(entry.promptPreview),
        resultPreview: clip(entry.resultPreview),
    };
}

/**
 * The final snapshot of one run, read from <session>/workflows/<runId>.json —
 * the path arrives fully formed, so nothing here knows about that layout. Returns
 * null only when the file cannot be read or parsed at all: a snapshot missing half
 * its fields still describes a run, and hiding it would lose the record entirely.
 */
function readFinal(jsonPath) {
    const raw = readJson(jsonPath);
    // An array parses as an object, and a file holding one would otherwise become
    // a phantom run with a name taken from its own filename.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const progress = Array.isArray(raw.workflowProgress) ? raw.workflowProgress : [];
    const agents = progress.map(agentOf).filter(Boolean);
    const phases = (Array.isArray(raw.phases) ? raw.phases : [])
        .filter((p) => p && p.title)
        .map((p) => ({ title: String(p.title), detail: p.detail ? String(p.detail) : '' }));

    return {
        runId: raw.runId || path.basename(jsonPath, '.json'),
        name: raw.workflowName || '',
        status: raw.status || '',
        durationMs: raw.durationMs || 0,
        phases,
        agents,
        scriptPath: raw.scriptPath || '',
        totals: {
            // Two counts, because they genuinely differ: a killed run was seen
            // claiming 74 agents while carrying 13 usable entries — the rest were
            // queued and never got an id. `agents` is what a list can actually
            // show, `reported` is what the client counted, and the gap between
            // them is a fact about the run, not an error to paper over.
            agents: agents.length,
            reported: raw.agentCount || 0,
            tokens: raw.totalTokens || 0,
            toolCalls: raw.totalToolCalls || 0,
        },
    };
}

// The `meta` block of a workflow script is a pure literal by contract — no
// variables, no calls, no interpolation — which is what makes reading it with a
// regular expression sound. It is still someone else's file, so nothing is
// evaluated: a script is code, and code from disk does not get run to draw a
// tree label.
//
// The key quotes are optional because both spellings ship: a hand-written script
// writes `title:`, while the workflows Claude Code itself ships (/code-review,
// /deep-research) serialize their meta as JSON and write `"title":`. Six of the
// 64 scripts on this machine are the latter — the six every user has.
const META_RE = /export\s+const\s+meta\s*=\s*\{/;
const PHASES_RE = /phases\s*:\s*\[([\s\S]*?)\]/;
const ENTRY_RE = /\{[^{}]*\}/g;
// Group 1 is the quote around the key, present only to force it to be symmetric;
// the value is group 3. A key must start at `{`, `,` or whitespace, or `subtitle:`
// would answer to `title:` — and reading the wrong value is worse than reading
// none.
const TITLE_RE = /(?:^|[{,\s])(?:title|(['"`])title\1)\s*:\s*(['"`])(.*?)\2/;
const DETAIL_RE = /(?:^|[{,\s])(?:detail|(['"`])detail\1)\s*:\s*(['"`])(.*?)\2/;

// The text of the `meta` literal, from the brace META_RE stopped on to the one
// that closes it. Everything below reads this and not the file, because a script
// that declares no phases has none: without the bound, the first `phases:` its
// own code happens to log becomes the answer, and an invented phase is the one
// failure this module must never produce.
//
// Counting depth means walking the text, and walking it means honouring string
// literals — a brace written in prose is a character, not a level — and honouring
// an escape inside one, or a quote the script escaped would end the string early.
// Comments are not skipped: an apostrophe in one would swallow the rest of the
// literal, which costs the phases and never fabricates any.
function metaBody(text, open) {
    let depth = 0;
    let quote = '';
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = '';
        } else if (c === "'" || c === '"' || c === '`') quote = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return text.slice(open, i + 1);
    }
    // Truncated file, or a literal that never closes: there is nothing to read.
    return '';
}

/**
 * The phases of a run whose snapshot does not exist yet — title and detail, in
 * the order the literal lists them. Live runs have nowhere else to get them.
 */
function phasesFromScript(text) {
    const body = String(text || '');
    const meta = META_RE.exec(body);
    if (!meta) return [];
    const block = PHASES_RE.exec(metaBody(body, meta.index + meta[0].length - 1));
    if (!block) return [];
    const out = [];
    for (const entry of block[1].match(ENTRY_RE) || []) {
        const title = TITLE_RE.exec(entry);
        if (!title) continue;
        const detail = DETAIL_RE.exec(entry);
        out.push({ title: title[3], detail: detail ? detail[3] : '' });
    }
    return out;
}

// How much of an agent transcript is read to describe what it is doing. The last
// record carries the model and the tool; the first carries the prompt. Reading
// whole transcripts here would mean megabytes on every tick — the largest one on
// this machine is 8.4 MB, and a single run holds 208 of them — while the tick
// that draws the tree runs every ten seconds.
const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 8 * 1024;

// A live agent's prompt is the whole brief it was dispatched with, not the
// client's own capped preview, so it is cut far shorter than a snapshot's: it
// stands in for a label in one row, it is not text anyone reads here.
const LIVE_PREVIEW_CHARS = 160;

// The journal is a roll call, but every `result` entry carries the agent's whole
// return value, so it grows with the work: 557 KB is the largest here. A run that
// outgrows this cap loses the tail of the roll call, which leaves agents reading
// as still working — the roster itself survives, since a transcript on disk
// counts as an agent whether or not the journal got that far.
const JOURNAL_BYTES = 1024 * 1024;

// One end of a file, without reading the rest of it. A cut lands mid-record at
// both ends, and that record is dropped rather than repaired: half a line of JSON
// is not evidence of anything.
function readChunk(file, { fromEnd = false, length = TAIL_BYTES } = {}) {
    const st = statOf(file);
    if (!st || st.size === 0) return '';
    const size = Math.min(length, st.size);
    const start = fromEnd ? st.size - size : 0;
    const buf = Buffer.alloc(size);
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        fs.readSync(fd, buf, 0, size, start);
    } catch { return ''; } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
    return buf.toString('utf8');
}

function parsedLines(text) {
    const out = [];
    for (const line of text.split('\n')) {
        if (line.length < 2 || line[0] !== '{') continue;
        try { out.push(JSON.parse(line)); } catch { /* a chunk boundary cut this one */ }
    }
    return out;
}

// The first thing said to an agent, which is the only description a live agent
// has: its label exists solely in the runtime and reaches disk with the final
// snapshot, long after anyone wanted to know what this agent is for.
function promptOf(file) {
    for (const r of parsedLines(readChunk(file, { length: HEAD_BYTES }))) {
        if (r.type !== 'user' || !r.message) continue;
        const c = r.message.content;
        const text = typeof c === 'string' ? c
            : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ') : '');
        if (text) return clip(text, LIVE_PREVIEW_CHARS);
    }
    return '';
}

// Model and current tool, from the newest complete record in the tail.
function tailOf(file) {
    const records = parsedLines(readChunk(file, { fromEnd: true }));
    const out = { model: '', lastToolName: '' };
    for (const r of records) {
        if (r.type !== 'assistant' || !r.message) continue;
        if (r.message.model) out.model = r.message.model;
        for (const block of (Array.isArray(r.message.content) ? r.message.content : [])) {
            if (block && (block.type === 'tool_use' || block.type === 'server_tool_use')) {
                out.lastToolName = block.name || out.lastToolName;
            }
        }
    }
    return out;
}

/**
 * What a run looks like while it is still going. The journal is the roster —
 * every agent that started and every one that returned — and the transcripts
 * fill in what each of them is doing right now. Null when the directory holds
 * nothing at all, which is also what a path that does not exist looks like.
 */
function readLive(runDir) {
    const entries = listDir(runDir);
    if (entries.length === 0) return null;

    const started = [];
    const done = new Set();
    for (const r of parsedLines(readChunk(path.join(runDir, 'journal.jsonl'), { length: JOURNAL_BYTES }))) {
        if (!r.agentId) continue;
        if (r.type === 'started' && !started.includes(r.agentId)) started.push(r.agentId);
        if (r.type === 'result') done.add(r.agentId);
    }
    // A transcript can exist for an agent the journal has not recorded yet.
    for (const entry of entries) {
        const id = (/^agent-(.+)\.jsonl$/.exec(entry.name) || [])[1];
        if (id && !started.includes(id)) started.push(id);
    }

    const agents = started.map((agentId) => {
        const file = path.join(runDir, `agent-${agentId}.jsonl`);
        const meta = readJson(path.join(runDir, `agent-${agentId}.meta.json`)) || {};
        const st = statOf(file);
        const tail = st ? tailOf(file) : { model: '', lastToolName: '' };
        return {
            agentId,
            // The runtime knows the label and the phase; the disk does not learn
            // either until the snapshot is written, so both stay empty rather
            // than being guessed from the prompt.
            label: '',
            phase: '',
            model: tail.model,
            state: done.has(agentId) ? 'done' : 'running',
            lastToolName: tail.lastToolName,
            promptPreview: st ? promptOf(file) : '',
            // The same keys a snapshot's agent has, so one renderer draws both.
            // The counts are not among them: totalling a running transcript means
            // reading all of it, which is the one thing this must not do.
            resultPreview: '',
            agentType: meta.agentType || '',
            tokens: 0,
            toolCalls: 0,
            durationMs: st ? Math.max(0, st.mtimeMs - (st.birthtimeMs || st.mtimeMs)) : 0,
            lastActivity: st ? st.mtimeMs : 0,
        };
    });

    return { agents, done: done.size, total: started.length };
}

// "review-changes-wf_a01fe790-8b6.js" → "review-changes".
function nameFromScriptPath(scriptPath) {
    if (!scriptPath) return '';
    return path.basename(scriptPath, '.js').replace(/-wf_[A-Za-z0-9-]+$/, '');
}

// Where a run's snapshot will appear: two levels up from the run directory, in
// the session's own workflows folder. A running run has no jsonPath yet — that
// field is filled by the scan, and the scan is exactly what the fast tick must
// not do — so the path is derived instead of looked up.
function snapshotPath(run) {
    if (run.jsonPath) return run.jsonPath;
    if (!run.runDir) return '';
    const session = path.dirname(path.dirname(path.dirname(run.runDir)));
    return path.join(session, 'workflows', `${run.runId}.json`);
}

/** Has the run that was going written its snapshot yet? */
function snapshotArrived(run) {
    const file = snapshotPath(run);
    return Boolean(file && statOf(file));
}

// How long a run directory may sit untouched before it stops counting as live.
// An agent on a high effort tier can think for minutes between writes, so a
// tighter window would flicker; a live parent session is the second, independent
// witness that keeps this from marking a slow run dead.
const RUN_STALE_MS = 10 * 60 * 1000;

// Creation time, falling back to mtime on filesystems that do not keep one.
// The run directory is created when the run starts and never rewritten, so its
// birth is the only trustworthy start time — the snapshot's own startTime is off
// by up to hours on a third of the runs on this machine.
function birthOf(file) {
    const st = statOf(file);
    if (!st) return 0;
    return st.birthtimeMs || st.mtimeMs || 0;
}

// The newest mtime anywhere in the run directory: the journal grows on every
// agent boundary, the transcripts on every reply, so the maximum of the two is
// "when this run last did anything".
function lastTouch(dir) {
    let newest = birthOf(dir);
    for (const entry of listDir(dir)) {
        const st = statOf(path.join(dir, entry.name));
        if (st && st.mtimeMs > newest) newest = st.mtimeMs;
    }
    return newest;
}

// The client's own word for what an agent is doing, mapped to the three things
// a panel can draw. The vocabulary was read off 1356 live records — done, start,
// progress, error — and it is not documented anywhere, so a word we have never
// seen becomes "unknown" rather than being guessed into success: painting a
// crashed agent with a checkmark is the failure this function exists to prevent.
const RUNNING_STATES = new Set(['start', 'progress', 'running', 'queued']);
const DONE_STATES = new Set(['done', 'complete', 'completed']);
const FAILED_STATES = new Set(['error', 'failed', 'killed']);

function outcomeOf(state, runState) {
    const word = String(state || '').toLowerCase();
    if (DONE_STATES.has(word)) return 'done';
    if (FAILED_STATES.has(word)) return 'failed';
    if (RUNNING_STATES.has(word)) {
        // A run that is over has no agent still working in it, whatever its last
        // record says: 28 agents on this machine sit at `progress` or `start`
        // inside runs killed weeks ago. That is not `failed` — nothing crashed,
        // the run was cut from outside and this agent never got to finish — and
        // it is not `running` either, so it gets its own word. The run's state is
        // optional, and without it the answer is what it always was.
        return runState && runState !== 'running' ? 'stopped' : 'running';
    }
    return 'unknown';
}

// Everything one session knows about one run. A run can appear in one tree and
// not the other: a snapshot outlives its directory, and a directory without a
// snapshot is a run that never finished — or a run whose snapshot landed in a
// sibling session, which is what `mergeHalves` sorts out afterwards.
function collect(root) {
    const runs = new Map();
    const at = (slug, session, runId) => {
        const key = `${slug}/${session}/${runId}`;
        if (!runs.has(key)) {
            runs.set(key, {
                runId, sessionId: session, slug, project: projectName(slug),
                runDir: '', jsonPath: '', scriptPath: '',
            });
        }
        return runs.get(key);
    };

    for (const slugDir of listDir(root)) {
        if (!slugDir.isDirectory()) continue;
        const slug = slugDir.name;
        for (const sessionDir of listDir(path.join(root, slug))) {
            if (!sessionDir.isDirectory()) continue;
            const session = sessionDir.name;
            const base = path.join(root, slug, session);

            for (const entry of listDir(path.join(base, 'workflows'))) {
                if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                const runId = path.basename(entry.name, '.json');
                at(slug, session, runId).jsonPath = path.join(base, 'workflows', entry.name);
            }
            for (const entry of listDir(path.join(base, 'workflows', 'scripts'))) {
                if (!entry.isFile()) continue;
                // Scripts are named <workflow-name>-<runId>.js — the id is the tail.
                const runId = (/(wf_[A-Za-z0-9-]+)\.js$/.exec(entry.name) || [])[1];
                if (runId) at(slug, session, runId).scriptPath = path.join(base, 'workflows', 'scripts', entry.name);
            }
            for (const entry of listDir(path.join(base, 'subagents', 'workflows'))) {
                if (!entry.isDirectory() || !entry.name.startsWith('wf_')) continue;
                at(slug, session, entry.name).runDir = path.join(base, 'subagents', 'workflows', entry.name);
            }
        }
    }
    return [...runs.values()];
}

// One run out of the halves the sessions hold, but only where the halves
// genuinely complement each other: at most one snapshot and at most one
// directory. Anything else is two attempts that share a run id — `resumeFromRunId`
// keeps it — and they stay two rows, because their numbers are not each other's.
// The record is named after the session that wrote the snapshot, since that is
// the session a reader will recognise, while `sessions` keeps every session the
// run touched: liveness has to ask all of them, as the directory and the snapshot
// belong to different ones and either may still be alive.
function mergeHalves(halves) {
    const groups = new Map();
    for (const half of halves) {
        const key = `${half.slug}/${half.runId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(half);
    }

    const out = [];
    for (const group of groups.values()) {
        const withJson = group.filter((h) => h.jsonPath);
        const withDir = group.filter((h) => h.runDir);
        if (withJson.length > 1 || withDir.length > 1) {
            for (const half of group) out.push({ ...half, sessions: [half.sessionId] });
            continue;
        }
        const dir = withDir[0] || null;
        const json = withJson[0] || null;
        const named = json || dir || group[0];
        out.push({
            runId: named.runId,
            sessionId: named.sessionId,
            sessions: group.map((h) => h.sessionId),
            slug: named.slug,
            project: named.project,
            runDir: dir ? dir.runDir : '',
            jsonPath: json ? json.jsonPath : '',
            // The script is written beside the directory, not beside the
            // snapshot, on all five pairs here — so the directory's half is asked
            // first and the rest is a fallback, not a coin toss.
            scriptPath: (dir && dir.scriptPath) || (group.find((h) => h.scriptPath) || {}).scriptPath || '',
        });
    }
    return out;
}

/**
 * Every workflow run on the machine with its state. `liveSessions` holds the ids
 * of sessions whose process is alive, and `now` is passed in rather than read so
 * the state machine is testable without touching the clock.
 */
function scanRuns({ root = PROJECTS, liveSessions = new Set(), now = Date.now() } = {}) {
    return mergeHalves(collect(root)).map((run) => {
        // A snapshot too broken to parse leaves `final` null while `jsonPath`
        // stays set, so such a run degrades into the freshness branch and reads
        // as abandoned. That is the contract — a dash beats a wrong number — and
        // the non-empty `jsonPath` is the only sign of what happened.
        const final = run.jsonPath ? readFinal(run.jsonPath) : null;
        // Only the freshness test needs this, and it walks every file in the run
        // directory — up to 417 of them here. A finished run already has its
        // answer, so it does not pay for one.
        const touched = !final && run.runDir ? lastTouch(run.runDir) : 0;
        const fresh = touched > 0 && now - touched < RUN_STALE_MS;
        const written = final && run.jsonPath ? (statOf(run.jsonPath)?.mtimeMs || 0) : 0;

        // A snapshot is proof the run ended — it is written once, at the end.
        // Without one, a run counts as live only while one of its sessions is
        // alive and its files are still moving; anything else is a run whose
        // client died and will never write a snapshot.
        const state = final ? 'finished'
            : (fresh && run.sessions.some((s) => liveSessions.has(s)) ? 'running' : 'abandoned');

        // The two places a run without a snapshot describes itself: the roster
        // and the transcripts for its agents, the saved script for its name and
        // its phases. Only a running run pays for the first — it opens a file per
        // agent, 208 of them on the biggest run here — while the second is one
        // bounded read, so an abandoned run still gets a name instead of a blank.
        const live = state === 'running' && run.runDir ? readLive(run.runDir) : null;
        const script = !final && run.scriptPath ? readChunk(run.scriptPath, { length: HEAD_BYTES }) : '';

        return {
            ...run,
            state,
            // Without a directory there is no honest start: the snapshot is
            // written at the end, so its own timestamps would put a 53-minute run
            // at a single point in time. Zero, and the display draws a dash.
            startedAt: run.runDir ? birthOf(run.runDir) : 0,
            endedAt: written,
            lastActivity: Math.max(touched, written),
            // A live run has no name of its own on disk; the script file carries
            // it in front of the run id, which is the only place it exists before
            // the snapshot is written.
            name: final ? final.name : nameFromScriptPath(run.scriptPath),
            status: final ? final.status : '',
            durationMs: final ? final.durationMs : 0,
            phases: final ? final.phases : phasesFromScript(script),
            agents: final ? final.agents : (live ? live.agents : []),
            // The four counts keep their shape whether or not a snapshot exists,
            // so a caller reading a total off a running run gets a zero rather
            // than undefined. `done` is the exception and only a running run has
            // it: a finished one carries each agent's own state instead, and
            // counting that here would be a second answer to the same question.
            totals: final ? final.totals
                : { agents: live ? live.total : 0, reported: 0, tokens: 0, toolCalls: 0, done: live ? live.done : 0 },
        };
    });
}

module.exports = {
    readFinal, phasesFromScript, readLive, scanRuns, outcomeOf, snapshotArrived, PROJECTS, RUN_STALE_MS,
};
