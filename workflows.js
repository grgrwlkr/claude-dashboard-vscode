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
const { projectName, INTERESTING } = require('./indexer');
const { costOf } = require('./pricing');

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
        // `tokens` means what the agent spent, at every stage of the pipeline,
        // and nothing here can know that — only the priced `usage` records can,
        // and they are read later. The client's own number goes to the name that
        // says whose it is: it measures the agent's context at its last reply,
        // not its spend, and the two differ by a factor of 29 on this machine.
        tokens: 0,
        reportedTokens: entry.tokens || 0,
        toolCalls: entry.toolCalls || 0,
        durationMs: entry.durationMs || 0,
        lastToolName: entry.lastToolName || '',
        // Bounded here, the way system.js bounds a hook command and a job detail:
        // the size of a row is ours to decide, not the client's to hand us.
        promptPreview: clip(entry.promptPreview),
        resultPreview: clip(entry.resultPreview),
        // The two fields a live agent also carries, so one renderer draws both
        // kinds of row. `agentType` is on 17 of the 1356 entries here — a
        // workflow agent usually has none, and the ones that do name a dispatched
        // subagent ("general-purpose"). `lastProgressAt` is on all 1356 and is
        // epoch milliseconds, the same clock the live side reads off an mtime.
        agentType: entry.agentType || '',
        lastActivity: entry.lastProgressAt || 0,
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
            // Zero until something prices this run, for the same reason an
            // agent's is: the snapshot's own total is a sum of the contexts it
            // lists — verified equal to it on all 74 snapshots here — and that
            // is not a quantity a price can come out of.
            tokens: 0,
            reportedTokens: raw.totalTokens || 0,
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

// The head grows in steps rather than sitting at one size, the way session.js
// reads a transcript tail and for the same reason: the first record is the
// agent's entire brief on a single JSON line, and those lines have a long tail —
// half fit in 4.6 KB, one in ten needs more than 15 KB, and the longest here is
// 293 KB. A fixed window is the worst of both: it misses on the long ones, where
// the miss is indistinguishable from an agent that has no prompt at all, and it
// still pays its full size on every agent that would have fit in 8 KB. Measured
// over 1470 real transcripts these steps read every prompt at 23.6 KB per agent,
// against 32 KB per agent for a fixed 32 KB window that reaches 98.1 %.
const HEAD_STEPS = [8 * 1024, 64 * 1024, 512 * 1024];

// The saved workflow script, read only for its `meta` literal, which every one of
// the 64 scripts here opens with. Its own constant because its size answers a
// different question than a transcript's head does, and the two would otherwise
// move together for no reason.
const SCRIPT_BYTES = 8 * 1024;

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
function readChunk(file, { fromEnd = false, length = fromEnd ? TAIL_BYTES : HEAD_STEPS[0] } = {}) {
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

// A slice of a file between two byte offsets. The tail and head readers above
// answer "what does this agent look like"; this one answers "what has it written
// since I last looked", which is a different question and a different range.
function readSlice(file, start, end) {
    const size = end - start;
    if (size <= 0) return '';
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
    const size = statOf(file)?.size || 0;
    for (const step of HEAD_STEPS) {
        const length = Math.min(step, size);
        for (const r of parsedLines(readChunk(file, { length }))) {
            if (r.type !== 'user' || !r.message) continue;
            const c = r.message.content;
            const text = typeof c === 'string' ? c
                : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ') : '');
            if (text) return clip(text, LIVE_PREVIEW_CHARS);
        }
        if (length >= size) break; // the whole file has been read; nothing there
    }
    return '';
}

// Model, effort and current tool, from the newest complete record in the tail.
// `effort` sits on the record rather than inside `message`, beside the model it
// was requested with — an agent dispatched at a tier its lead never named
// inherits the session's, and this is the only place that shows which.
function tailOf(file) {
    const records = parsedLines(readChunk(file, { fromEnd: true }));
    const out = { model: '', effort: '', lastToolName: '' };
    for (const r of records) {
        if (r.type !== 'assistant' || !r.message) continue;
        if (r.message.model) out.model = r.message.model;
        if (r.effort) out.effort = String(r.effort);
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
 *
 * `known` maps an agent id to what the caller was told about it last time, and
 * is how a repeating reader stops paying for what has not changed. A prompt is
 * the first thing the agent was told and never changes at all; the model and the
 * tool change only when the agent writes, and an mtime equal to the one already
 * recorded says it has not. Without it every look costs the head and the tail of
 * every transcript — 64 KB plus up to half a megabyte each, 208 of them on the
 * widest run here, on a tick that repeats every ten seconds.
 */
function readLive(runDir, { known = null } = {}) {
    const entries = listDir(runDir);
    if (entries.length === 0) return null;

    const started = [];
    const done = new Set();
    for (const r of parsedLines(readChunk(path.join(runDir, 'journal.jsonl'), { length: JOURNAL_BYTES }))) {
        if (!r.agentId) continue;
        // Read as a string wherever it came from, exactly as agentOf reads the
        // snapshot's: this roster is matched against ids taken out of file names,
        // and everything downstream slices it to make a label. A number here
        // would list one agent twice and throw the moment a row was drawn for it.
        const id = String(r.agentId);
        if (r.type === 'started' && !started.includes(id)) started.push(id);
        if (r.type === 'result') done.add(id);
    }
    // A transcript can exist for an agent the journal has not recorded yet.
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const id = (/^agent-(.+)\.jsonl$/.exec(entry.name) || [])[1];
        if (id && !started.includes(id)) started.push(id);
    }

    const agents = started.map((agentId) => {
        const file = path.join(runDir, `agent-${agentId}.jsonl`);
        const meta = readJson(path.join(runDir, `agent-${agentId}.meta.json`)) || {};
        const st = statOf(file);
        const was = (known && known.get(agentId)) || null;
        // The file has not been written to since it was last read, so what was
        // read from it then is what is in it now.
        const still = Boolean(was && st && was.lastActivity === st.mtimeMs);
        const tail = still ? { model: was.model, effort: was.effort || '', lastToolName: was.lastToolName }
            : (st ? tailOf(file) : { model: '', effort: '', lastToolName: '' });
        // An empty preview counts as none: the agent may simply not have written
        // its first line yet, and next time it will have.
        const told = (was && was.promptPreview) || '';
        return {
            agentId,
            // The runtime knows the label and the phase; the disk does not learn
            // either until the snapshot is written, so both stay empty rather
            // than being guessed from the prompt.
            label: '',
            phase: '',
            model: tail.model,
            // An agent dispatched without a tier inherits the session's, and
            // the transcript is the only place that says which one it got.
            effort: tail.effort,
            state: done.has(agentId) ? 'done' : 'running',
            lastToolName: tail.lastToolName,
            promptPreview: told || (st ? promptOf(file) : ''),
            // The same keys a snapshot's agent has, so one renderer draws both.
            // The zeros are absences, not unread data: a result exists only once
            // the agent returns, and totalling a running transcript would mean
            // reading all of it — the one thing this must not do.
            resultPreview: '',
            agentType: meta.agentType || '',
            tokens: 0,
            // The client writes no figure for an agent until the run ends, so
            // there is nothing to report yet — the key exists so both kinds of
            // agent carry the same fields.
            reportedTokens: 0,
            toolCalls: 0,
            durationMs: st ? Math.max(0, st.mtimeMs - (st.birthtimeMs || st.mtimeMs)) : 0,
            lastActivity: st ? st.mtimeMs : 0,
        };
    });

    // Intersected with the roster, so the count can never read "3 of 2": a
    // `result` for an agent that has neither a `started` line nor a transcript is
    // not something this format produces today, and the guard costs one pass.
    return { agents, done: started.filter((id) => done.has(id)).length, total: started.length };
}

// "review-changes-wf_a01fe790-8b6.js" → "review-changes".
function nameFromScriptPath(scriptPath) {
    if (!scriptPath) return '';
    return path.basename(scriptPath, '.js').replace(/-wf_[A-Za-z0-9-]+$/, '');
}

/**
 * Where the snapshot of a run that was going is, or '' while it has none. A
 * running run has no jsonPath — that field is filled by the scan, and the scan
 * is exactly what the fast tick must not do — so the file is looked for beside
 * the run's own directory instead of being asked for.
 *
 * Only that one session is asked, because a run id does not identify a run: two
 * attempts of one workflow keep one id on purpose — `resumeFromRunId` needs it —
 * and one such pair exists here, killed with 7 agents and 880255 ms in one
 * session against completed with 65 agents and 3047744 ms in another. Searching
 * the project would let either of them read the other's verdict, agent list and
 * duration off a file that is not about it. An mtime guard does not separate
 * them: those two snapshots are an hour apart and the wrong one still passes.
 *
 * The cost of the narrow lookup is the five runs on this machine whose snapshot
 * lands in a sibling session — 65 of 70 keep it in their own — and they lose
 * nothing but immediacy: the full scan pairs the halves by `slug/runId`, and it
 * is the only reader that knows which pairs are halves and which are attempts.
 */
function snapshotPath(run) {
    if (run.jsonPath) return statOf(run.jsonPath) ? run.jsonPath : '';
    if (!run.runDir) return '';
    // <slug>/<session>/subagents/workflows/<runId>: three levels up is the session.
    const session = path.dirname(path.dirname(path.dirname(run.runDir)));
    const file = path.join(session, 'workflows', `${run.runId}.json`);
    return statOf(file) ? file : '';
}

/**
 * The run as its own snapshot describes it, for a caller that has just noticed
 * that snapshot appear. Null when there is none yet or it cannot be read at all,
 * and then the run is left exactly as it was — still going, for the next full
 * scan to classify by the same rule as any other unreadable snapshot.
 *
 * The status is read here rather than left for that scan because the file the
 * status lives in is the same file whose existence proves the run is over: a
 * record marked finished with no status is a run nobody can say anything about,
 * and up to a minute of "how did it end" is exactly what a panel is watched for.
 * The phases, the real agent labels and the duration come along for free.
 *
 * What the run has cost rides across agent by agent. Money comes from `usage`
 * records and is settled by whoever prices runs; the snapshot carries no figure
 * that may become dollars, so dropping what was already priced would empty the
 * money columns until the next pricing pass.
 */
function finishRun(run) {
    const jsonPath = snapshotPath(run);
    const final = jsonPath ? readFinal(jsonPath) : null;
    if (!final) return null;

    const priced = new Map((run.agents || []).map((a) => [a.agentId, a]));
    const agents = final.agents.map((agent) => {
        const was = priced.get(agent.agentId);
        return was ? { ...agent, cost: was.cost || 0, tokens: was.tokens || 0 } : agent;
    });
    const endedAt = statOf(jsonPath)?.mtimeMs || 0;
    const totals = run.totals || {};
    return {
        ...run,
        state: 'finished',
        jsonPath,
        endedAt,
        lastActivity: Math.max(run.lastActivity || 0, endedAt),
        // A live run is named after its script file; the snapshot's own name is
        // the authority once there is one, and an empty one changes nothing.
        name: final.name || run.name,
        status: final.status,
        durationMs: final.durationMs,
        phases: final.phases,
        agents,
        totals: {
            ...totals,
            ...final.totals,
            done: settledCount(agents, 'finished'),
            // The snapshot's own totals are context sizes and counts, never
            // money — so the two priced figures stay at what the last pricing
            // pass found instead of being reset to the zeros readFinal ships.
            cost: totals.cost || 0,
            tokens: totals.tokens || 0,
        },
    };
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

// An agent that will not move again, however it got there: it finished, it
// crashed, or the run was cut from under it. Counting these is what makes
// `totals.done` mean one thing on both kinds of run — the journal's roll call
// while the run is going, each agent's last recorded state once it is over. A
// word we have never seen stays out of the count rather than being read as
// success, exactly as in outcomeOf.
const SETTLED = new Set(['done', 'failed', 'stopped']);

function settledCount(agents, runState) {
    return agents.filter((a) => SETTLED.has(outcomeOf(a.state, runState))).length;
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
 * the state machine is testable without touching the clock. `known` maps a run
 * id to what a previous scan learned about its agents, and is handed to readLive
 * for the runs that are still going — see there for what it saves.
 */
function scanRuns({ root = PROJECTS, liveSessions = new Set(), now = Date.now(), known = null } = {}) {
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
        const live = state === 'running' && run.runDir
            ? readLive(run.runDir, { known: known ? known.get(run.runId) : null })
            : null;
        const script = !final && run.scriptPath ? readChunk(run.scriptPath, { length: SCRIPT_BYTES }) : '';

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
            // The same five counts whether or not a snapshot exists, so a caller
            // reading a total off a running run gets a zero rather than
            // undefined. `done` is the one that has to be built twice, because
            // the two states record it in different places: the journal's roll
            // call while the run is going, each agent's own last state after.
            totals: final
                ? { ...final.totals, done: settledCount(final.agents, state) }
                : {
                    agents: live ? live.total : 0, reported: 0,
                    tokens: 0, reportedTokens: 0, toolCalls: 0,
                    done: live ? live.done : 0,
                },
        };
    });
}

// A run's own numbers cannot be priced. `totalTokens` and the `tokens` of a
// snapshot's agent are lump sums with no input/output/cache-read/cache-write
// split, and those four are billed at four different rates — any price derived
// from them would be a guess wearing a dollar sign. The priced records are the
// `usage` blocks in the transcripts, and the index has already walked every one
// of them, so a price is looked up there rather than recomputed.

/**
 * Every workflow agent the index knows, keyed `runId/agentId` — the pair a run
 * record joins on. The index takes `workflowId` from the run directory's own
 * name, which is the run id, so the two sides meet without either having to
 * guess the other's path.
 *
 * Two rows can land on one key: one run id can own a directory under two
 * sessions, and the same agent id could appear beneath both. They are added
 * rather than overwritten, because the key stands for everything the index
 * attributes to that agent of that run, and dropping one of them would lose
 * money that was spent. No pair on this machine does this today.
 */
function costIndex(index) {
    const byAgent = new Map();
    for (const entry of Object.values((index && index.files) || {})) {
        // A transcript with nothing in it is stored with no aggregate at all.
        for (const row of ((entry && entry.agg && entry.agg.sessions) || [])) {
            if (row.kind !== 'workflow' || !row.workflowId || !row.agentId) continue;
            const key = `${row.workflowId}/${row.agentId}`;
            const at = byAgent.get(key) || { cost: 0, tokens: 0, out: 0, msgs: 0 };
            at.cost += row.cost || 0;
            at.tokens += row.tokens || 0;
            at.out += row.out || 0;
            at.msgs += row.msgs || 0;
            byAgent.set(key, at);
        }
    }
    return byAgent;
}

// What has been counted in one transcript so far: how far it was read, which
// file that was, the last stretch of what was counted, and the money and tokens
// found up to there.
const NOTHING_READ = { size: 0, mtime: 0, ino: 0, edge: '', cost: 0, tokens: 0 };

// How much of the counted region is re-read to prove it is still the same text.
// A file rewritten in place and left longer passes every test `stat` can make —
// same inode, same direction of growth — and its bytes are the only witness
// left. Sixty-four of them are one read of nothing, and two transcripts that
// agree over the last sixty-four bytes before an identical offset are not
// something this format produces.
const EDGE_BYTES = 64;

function edgeOf(file, size) {
    const back = Math.min(EDGE_BYTES, size);
    return back > 0 ? readSlice(file, size - back, size) : '';
}

// Is what was counted still describing the file at this path? Size answers how
// much has been appended and nothing else: a transcript replaced by another one
// at least as long would be read from the middle of a text whose beginning
// nobody counted. The inode catches a file swapped in under the name, and the
// mtime catches the case both of those miss — a rewrite in place that lands at
// exactly the same length, where nothing grew and so nothing would be read.
function sameFile(prev, st) {
    if (!prev || prev.size > st.size) return false;
    if (prev.ino !== st.ino) return false;
    return prev.size < st.size || prev.mtime === st.mtimeMs;
}

/**
 * Add up what a transcript has spent since it was last looked at. A transcript
 * is append-only, so only the bytes that appeared since `prev.size` are read —
 * which is what makes pricing a live agent affordable on a repeating tick, where
 * reading the file whole would mean megabytes per agent per minute. The first
 * look has nothing carried and reads all of it, once per agent.
 *
 * The records are picked the way indexer.js picks them, so the two sides of the
 * join price the same transcript identically: same line filter, same `usage`
 * block, same rate table.
 */
function accrue(file, prev = null) {
    const st = statOf(file);
    // Nothing to read from, and nothing to correct: what was counted stays.
    if (!st) return prev || NOTHING_READ;
    // Anything that is not the same file starts the count over, because adding
    // to a total whose records are gone is adding to nothing.
    let carried = sameFile(prev, st) ? prev : NOTHING_READ;
    if (carried.size === st.size) return carried;

    // The read starts a little before the boundary, on the stretch that was
    // counted last time: if it does not come back word for word, this is not the
    // text that was counted, whatever its size and its inode say, and the whole
    // file is counted afresh.
    const back = Math.min(EDGE_BYTES, carried.size);
    let text = readSlice(file, carried.size - back, st.size);
    if (back > 0) {
        if (text.startsWith(carried.edge)) text = text.slice(carried.edge.length);
        else {
            carried = NOTHING_READ;
            text = readSlice(file, 0, st.size);
        }
    }

    // The read ends wherever the file happened to end, which is rarely a line
    // boundary: the last record may be half written. Everything up to the final
    // newline is whole, and the size is remembered up to exactly there — so the
    // remainder is read again next time and counted once, never twice and never
    // lost. The byte count comes from the text rather than the slice length,
    // since a transcript is UTF-8 and its characters are not one byte each.
    const cut = text.lastIndexOf('\n');
    if (cut < 0) return carried;
    const whole = text.slice(0, cut);

    let { cost, tokens } = carried;
    for (const line of whole.split('\n')) {
        if (line.length < 50 || line[0] !== '{' || !INTERESTING.test(line)) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        const usage = r.message && r.message.usage;
        if (!usage) continue;
        cost += costOf(r.message.model || '', usage);
        tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0)
            + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    }
    const size = carried.size + Buffer.byteLength(whole, 'utf8') + 1;
    return {
        size,
        // Recorded from the stat this read was planned against, not from a
        // second one: the file may have grown again while it was being read,
        // and claiming that mtime would skip whatever arrived in between.
        mtime: st.mtimeMs,
        ino: st.ino,
        edge: edgeOf(file, size),
        cost,
        tokens,
    };
}

// Which record gets to claim a shared row first. Two records can carry one run
// id — two attempts of the same workflow, kept apart on purpose — and the second
// attempt writes into the first one's directory, so the index files both under
// one workflow id. One transcript is one payment, so the record holding the
// directory is asked first: that is where the transcripts physically are.
// Sorting is stable, so records that are equal here stay in the order they came.
function claimOrder(runs) {
    return runs.map((_, i) => i).sort((a, b) => (runs[a].runDir ? 0 : 1) - (runs[b].runDir ? 0 : 1));
}

// The index refreshes when the dashboard is opened, which can land in the middle
// of a run: the row it wrote then is a photograph of a file that is still
// growing. So a run that is going is read from its transcripts when the caller
// pays for that, and the index answers for everything that has stopped moving —
// including an agent of a live run whose transcript is not in this directory,
// which is what a run resumed into someone else's directory looks like.
function freshOf(run, agentId, live, carried) {
    if (!live || run.state !== 'running' || !run.runDir) return null;
    const key = `${run.runId}/${agentId}`;
    const next = accrue(path.join(run.runDir, `agent-${agentId}.jsonl`), carried.get(key));
    carried.set(key, next);
    // Nothing read means no transcript here at all — an agent of a run resumed
    // into someone else's directory — and the index answers for it instead.
    return next.size > 0 ? { cost: next.cost, tokens: next.tokens } : null;
}

function pricedRun(run, known, claimed, live, carried) {
    let cost = 0;
    let tokens = 0;

    const agents = run.agents.map((agent) => {
        const key = `${run.runId}/${agent.agentId}`;
        // Claimed by an earlier record, so this one is looking at an agent whose
        // single transcript has already been paid for.
        const priced = claimed.has(key)
            ? null
            : (freshOf(run, agent.agentId, live, carried) || known.get(key) || null);
        if (!priced) return { ...agent, cost: 0, tokens: 0 };

        claimed.add(key);
        cost += priced.cost;
        tokens += priced.tokens;
        return { ...agent, cost: priced.cost, tokens: priced.tokens };
    });

    // `reportedTokens` rides through untouched on both levels: the client's
    // figure is put there when the run is read, so nothing here has to guess
    // whether it is looking at a fresh record or one it already priced.
    return { ...run, agents, totals: { ...run.totals, cost, tokens } };
}

// What the index attributes to a run id that no agent of it accounted for,
// summed per run. A run's price is the sum over the agents it lists, and a run
// directory can hold transcripts no snapshot names — 175 of them here, $120.00,
// and on wf_19cbc05e-1c7 that is $88.45 beside the $107.65 the run itself shows.
// Reporting only the second number would present a run at 55 % of what its
// directory spent, so the remainder is carried in the open rather than folded
// into a total whose meaning is "the agents you can see".
function unlistedByRun(known, claimed) {
    const left = new Map();
    for (const [key, row] of known) {
        if (claimed.has(key)) continue;
        const runId = key.slice(0, key.lastIndexOf('/'));
        left.set(runId, (left.get(runId) || 0) + row.cost);
    }
    return left;
}

/**
 * Attach money to every run. Agents that have stopped are looked up in the
 * index; the agents of a run that is still going are priced from their own
 * transcripts, but only when `live` is set — the index is a photograph taken
 * when the dashboard was last opened, and a run in flight has moved since.
 *
 * `carried` is the caller's accumulator, keyed `runId/agentId`: what each live
 * transcript has cost and how far it has been read. It is updated in place and
 * outlives the call, which is what turns every later look into a read of the
 * few kilobytes that appeared since. Without one, every call reads every live
 * transcript whole — correct, and affordable only once.
 */
function withCost(runs, { index = null, live = false, carried = new Map() } = {}) {
    const known = costIndex(index);
    const claimed = new Set();
    const order = claimOrder(runs);
    const out = new Array(runs.length);
    for (const i of order) out[i] = pricedRun(runs[i], known, claimed, live, carried);

    // The leftovers can only be counted once every record has taken what it
    // lists, and they go to one record per run id — the same one that claimed
    // first — so that summing the runs still adds up to what the index holds.
    const left = unlistedByRun(known, claimed);
    const taken = new Set();
    for (const i of order) {
        const { runId } = runs[i];
        out[i].totals.unlisted = taken.has(runId) ? 0 : (left.get(runId) || 0);
        taken.add(runId);
    }
    return out;
}

/**
 * How a run ended, as the word to print and the outcome to draw it with. The
 * word is the client's own — "completed" is what a clean run writes — and a run
 * that never wrote a snapshot has none at all, so it says what it is doing or
 * only that nobody recorded an end for it. Any other word the client writes is a
 * failure rather than a word guessed into success.
 *
 * No word at all is a different thing from a bad one, and it gets the question
 * mark: every field of a snapshot is optional, and a run whose end was noticed
 * before its status could be read has none yet either. Reading that silence as a
 * crash is the one lie this function can tell — it paints a clean run red — and
 * "degrade, never guess" cuts the other way here: unknown, not failed.
 *
 * The outcome is the same five-word vocabulary `outcomeOf` answers an agent in,
 * which is what lets one icon table and one set of colours serve a run and its
 * agents alike — and what keeps the tree's icon and the dashboard's chip from
 * disagreeing about the same run.
 */
function verdictOf(run) {
    if (run.state === 'running') return { word: 'running', outcome: 'running' };
    if (run.state === 'abandoned') return { word: 'no snapshot', outcome: 'stopped' };
    if (!run.status) return { word: '', outcome: 'unknown' };
    return { word: run.status, outcome: run.status === 'completed' ? 'done' : 'failed' };
}

// Read through outcomeOf and verdictOf, never off a raw word. The client writes
// `error` and has never once written `failed`, and an agent of a killed run
// stays recorded as working forever — a table keyed on the state itself would
// draw both of those with a checkmark. Icons are named here and constructed in
// extension.js, which is the only file that knows what a ThemeIcon is.
const OUTCOME_ICONS = {
    running: 'sync~spin', done: 'check', failed: 'error',
    stopped: 'circle-slash', unknown: 'question',
};

const runIcon = (run) => OUTCOME_ICONS[verdictOf(run).outcome];
const agentIcon = (agent, run) => OUTCOME_ICONS[outcomeOf(agent.state, run.state)];

/**
 * How many agents a run stands for, in the words every surface uses. Two facts,
 * and at most one of them is ever true: a run still going has no count of its
 * own yet — `reported` is filled from the snapshot, which is written at the end —
 * and a run that is over has nothing left working.
 *
 *   - while it runs: how many of its agents have settled, out of how many exist;
 *   - once it ends: the client's own counter, but only where it exceeds the list.
 *     On one killed run here it read 74 against 13 usable entries, and 13 rows
 *     under a heading of 74 would say the run finished everything it began.
 *
 * The plain count is the one thing the two surfaces read differently, hence
 * `always`: it is silence in a tree row that lists the agents underneath it, and
 * a number in a table cell whose column is headed "Agents".
 */
function countLabel(run, { always = false } = {}) {
    const totals = run.totals || {};
    const listed = (run.agents || []).length;
    if (totals.reported > listed) return `${listed} of ${totals.reported}`;
    if (run.state === 'running') return `${totals.done || 0}/${totals.agents || listed}`;
    return always ? String(totals.agents || listed) : '';
}

// How much of a prompt fits on a row before the panel starts eliding it itself.
const LABEL_CHARS = 60;

// A live agent has no label: it is computed in the runtime and reaches the disk
// only with the final snapshot. The first line of what it was told stands in for
// one, the same stand-in the hover uses, and an agent that has not written even
// that is named by its id rather than by an empty row.
function agentLabel(agent) {
    const first = String(agent.promptPreview || '').split('\n')[0].trim();
    return agent.label || first.slice(0, LABEL_CHARS) || agent.agentId.slice(0, 8);
}

// A token count as both the bar and the tree write it: thousands up to a
// million, millions above, and a round one reads "1M" rather than "1.0M" — the
// way ~/.claude/statusline.sh writes it. It lives here and not beside the bar
// because extension.js is the one module allowed to require vscode, so nothing
// may import it: anything two sides share has to sit on the vscode-free side of
// that line. Most workflow agents land in the millions — what is counted is
// every cache read they made.
function tokenLabel(n) {
    if (n < 1e6) return `${Math.round(n / 1000)}k`;
    const m = n / 1e6;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
}

// A node id has to be unique across the tree and stable between draws: VS Code
// keys a row's expanded state on it. The run id is not enough — two attempts of
// one workflow keep one id, and mergeHalves leaves them as two records on
// purpose — so a node is keyed the way collect() keys a record, by the session
// holding it.
const runKey = (run) => `${run.slug || ''}/${run.sessionId || ''}/${run.runId}`;

// How many finished runs the tree draws, from the design: "the last 50 finished
// are shown, abandoned ones always". The panel is for what is happening and what
// just happened, while the finished half of the list is the history of the
// machine and only grows — the 74 runs here would be 1513 rows uncapped, and
// nothing ever takes a run off the disk. Running and abandoned runs are never
// cut: the first is the point of the panel, and the second is a handful worth
// knowing about.
const TREE_FINISHED = 50;

/**
 * The run list as a three-level tree: run → phase → agent. Runs with no phases
 * carry their agents directly, because an empty grouping level is a click that
 * buys nothing — and no run has phases until either its snapshot or its script
 * has been read. Only the newest TREE_FINISHED finished runs reach the tree;
 * everything still going and everything abandoned does.
 *
 * Nothing here touches disk or vscode: a node is a plain object, and the icon is
 * a name rather than an object, so every decision the panel makes is testable
 * under plain node.
 */
function treeNodes(runs) {
    const ordered = [...runs].sort((a, b) => {
        // What is happening now goes on top; everything else is the history of
        // the machine, newest first. Sorting is stable, so runs that agree here
        // stay in the order the scan produced.
        if ((a.state === 'running') !== (b.state === 'running')) return a.state === 'running' ? -1 : 1;
        return (b.lastActivity || 0) - (a.lastActivity || 0);
    });

    // The cut is taken after the sort, so the fifty that survive are the fifty
    // most recent rather than the fifty the scan happened to walk first.
    const shown = [];
    let finished = 0;
    for (const run of ordered) {
        if (run.state === 'finished' && ++finished > TREE_FINISHED) continue;
        shown.push(run);
    }

    return shown.map((run) => {
        const key = runKey(run);
        // Read once and guarded once: this is exported, so a caller may hand it
        // a record the scan did not build. The field is always filled by
        // scanRuns; a half-built one draws an empty run rather than throwing.
        const agents = run.agents || [];
        const agentNode = (agent) => ({
            kind: 'agent',
            id: `${key}/${agent.agentId}`,
            label: agentLabel(agent),
            description: [agent.model, agent.tokens ? tokenLabel(agent.tokens) : '']
                .filter(Boolean).join(' · '),
            icon: agentIcon(agent, run),
            state: agent.state,
            children: [],
            run,
            agent,
        });

        // Every agent is drawn once, under the first phase that names it, and
        // `drawn` is what enforces it. A script is free to write one title
        // twice — which is also why phases are numbered rather than titled — and
        // an agent hanging under both would carry one node id twice. A repeated
        // id does not duplicate a row: VS Code refuses to register it and the
        // whole view stops drawing until the window is reloaded.
        const drawn = new Set();
        const claim = (list, agent) => {
            const node = agentNode(agent);
            if (drawn.has(node.id)) return;
            drawn.add(node.id);
            list.push(node);
        };

        const phases = [];
        (run.phases || []).forEach((phase, i) => {
            const mine = [];
            for (const agent of agents) if (agent.phase === phase.title) claim(mine, agent);
            if (mine.length === 0) return;
            phases.push({
                kind: 'phase',
                id: `${key}#${i}`,
                label: phase.title,
                description: phase.detail || '',
                icon: '',
                children: mine,
                run,
            });
        });

        // Agents the phase list does not account for still have to appear: the
        // live phases come from the script and the final ones from the snapshot,
        // so a title can move between them, and losing an agent is worse than an
        // extra row.
        const loose = [];
        for (const agent of agents) claim(loose, agent);

        return {
            kind: 'run',
            id: key,
            label: run.name || run.runId,
            description: [
                // How far a live run has got, or the gap between the client's
                // own counter and the list underneath — countLabel decides which,
                // and stays silent where a plain number would only repeat the
                // rows already hanging under this one.
                countLabel(run),
                run.project,
            ].filter(Boolean).join(' · '),
            icon: runIcon(run),
            state: run.state,
            children: [...phases, ...loose],
            run,
        };
    });
}

/**
 * Everything the tree would draw, flattened into one string, so a caller can
 * tell a reading that changed something from one that changed nothing. A
 * collector that rebuilds its list every minute hands out a new object each time
 * whether or not anything moved, and comparing objects then means redrawing
 * hundreds of rows for nothing.
 *
 * Taken from the nodes rather than from the runs on purpose: a fingerprint of
 * the inputs would have to be kept in step with every rule about what a row
 * says, and the first rule that changed without it would freeze the panel on
 * stale text. The agent previews are in it because they are what a row's hover
 * shows — the one part of a node that is not already in its own fields.
 */
function treeStamp(runs) {
    const parts = [];
    const walk = (nodes) => {
        for (const node of nodes) {
            parts.push(node.id, node.label, node.description, node.icon,
                node.agent ? `${node.agent.promptPreview || ''} → ${node.agent.resultPreview || ''}` : '');
            walk(node.children);
        }
    };
    walk(treeNodes(runs || []));
    // Joined on a separator rather than concatenated: two fields sliding into
    // one another would let two different trees stamp the same.
    return parts.join(' | ');
}

module.exports = {
    readFinal, phasesFromScript, readLive, scanRuns, outcomeOf, snapshotPath, finishRun,
    costIndex, withCost, accrue, treeNodes, treeStamp, tokenLabel, PROJECTS, RUN_STALE_MS,
    // The vocabulary itself, so a test can hold the three tables that draw an
    // outcome — this one, the hover's and the dashboard's stylesheet — against
    // each other: a word added here and nowhere else draws as nothing at all.
    OUTCOME_ICONS, TREE_FINISHED,
    // Read by the dashboard as well as by the tree: one rule about a run cannot
    // live in two files, and dashboard.js may not require vscode, so it lives on
    // this side of that line.
    verdictOf, countLabel, agentLabel,
};
