// Incremental index over every Claude Code transcript on the machine.
//
// Two things make a full rescan unnecessary. A transcript is append-only, so a
// file whose size and mtime are unchanged cannot have new records in it; and the
// per-file aggregate is small, so keeping one per file costs a couple of
// megabytes and turns a rescan into "re-read only what grew".
//
// No dependency on vscode — the storage directory is passed in, so this runs
// under plain node in tests.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { costOf, cacheSplit, cacheSaving } = require('./pricing');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');

// Bump on every change to the shape of a per-file aggregate. A file whose size
// and mtime are unchanged is never re-read, so without a bump the old shape is
// reused forever and the new fields stay empty for everything already indexed.
// 4: skill buckets carry `last`, the newest reply attributed to them. A stored
// aggregate of shape 3 has no such field and would read as "never used".
const INDEX_VERSION = 4;

// Subagent transcripts live under <slug>/<sessionId>/subagents/, and workflow
// agents one level deeper under .../workflows/<wfId>/. The path is the only
// place that relationship is recorded, so it is parsed rather than guessed.
const SUBAGENT_RE = /\/([^/]+)\/subagents\/(?:workflows\/([^/]+)\/)?agent-([^/]+)\.jsonl$/;

function emptyAgg() {
    return {
        days: {},        // YYYY-MM-DD → bucket
        models: {},      // model id → bucket
        branches: {},    // git branch → bucket
        skills: {},      // attributionSkill → bucket
        hours: {},       // 0..23 → bucket
        efforts: {},     // model and effort in one key → bucket
        entrypoints: {}, // cli | claude-vscode | sdk-py | … → bucket
        speeds: {},      // usage.speed, i.e. standard vs fast mode → bucket
        tools: {},       // tool name → { calls, errors, denials }
        files: {},       // absolute path → { edits, added, removed }
        friction: emptyFriction(),
        sessions: [],    // one row per file
        prompts: emptyPrompts(),
    };
}

// Everything that went sideways. None of it is priced: a rejected tool call
// still cost the tokens that proposed it, and those are already counted as
// spend — this is the record of what that spend ran into.
function emptyFriction() {
    return {
        toolErrors: 0,
        denials: {},          // toolDenialKind → count
        interrupts: 0,        // tool results the user stopped mid-run
        hookErrors: 0,
        shutdowns: 0,         // work cut off by the client going away
        compactions: {},      // compactMetadata.trigger → count
        droppedTokens: 0,     // context thrown away by those compactions
        compactMs: 0,
    };
}

// The tool name a result belongs to is not in the result: a tool_result carries
// only the id of the call. The mapping lives in the assistant record that made
// the call, so it is collected per file as the pass goes and looked up when the
// result turns up a few records later.
const UNKNOWN_TOOL = 'unknown';

// Prompt statistics, never prompt text. Only counts, lengths and word tallies
// are stored, so the index cannot leak what was written — and nothing here
// leaves the machine in any case.
function emptyPrompts() {
    return { count: 0, chars: 0, longest: 0, byHour: {}, bySource: {}, words: {}, lens: {} };
}

// Length buckets, labelled by their lower bound.
const LEN_BUCKETS = [0, 100, 500, 2000, 10000];
function lenBucket(n) {
    let pick = LEN_BUCKETS[0];
    for (const edge of LEN_BUCKETS) if (n >= edge) pick = edge;
    return String(pick);
}

const WORD_RE = /\p{L}{5,}/gu;
const TOP_WORDS_PER_FILE = 30;

// Text of a user turn, whether the content is a bare string or a block array.
function promptText(message) {
    if (!message) return '';
    const c = message.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join(' ');
}

// Words of five letters or more, counted case-insensitively. No stop-word list:
// a list would have to be per-language, and the dashboard drops words that occur
// in nearly every session anyway, which removes filler in any language.
function tallyWords(text, into) {
    const seen = text.toLowerCase().match(WORD_RE);
    if (!seen) return;
    for (const w of seen) into[w] = (into[w] || 0) + 1;
}

// Only the head of the tally survives into the index — the tail is noise and
// would multiply the index size by the vocabulary of every transcript.
function trimWords(words, limit = TOP_WORDS_PER_FILE) {
    const top = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, limit);
    const out = {};
    for (const [w, n] of top) out[w] = n;
    return out;
}

// cw1h and cw5m split cacheWrite by TTL — the two are billed at different
// multiples of the input rate, so a total alone cannot be re-priced later.
// `saved` is what the reads in this bucket would have cost as fresh input.
function bucket() {
    return {
        in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
        cw1h: 0, cw5m: 0, saved: 0, cost: 0, msgs: 0,
    };
}

const BUCKET_FIELDS = ['in', 'out', 'cacheRead', 'cacheWrite', 'cw1h', 'cw5m', 'saved', 'cost', 'msgs'];

function add(map, key, usage, model) {
    if (!key) return null;
    const b = map[key] || (map[key] = bucket());
    const cache = cacheSplit(usage);
    b.in += usage.input_tokens || 0;
    b.out += usage.output_tokens || 0;
    b.cacheRead += usage.cache_read_input_tokens || 0;
    b.cacheWrite += cache.total;
    b.cw1h += cache.hour;
    b.cw5m += cache.min5;
    b.saved += cacheSaving(model, usage);
    b.cost += costOf(model, usage);
    b.msgs++;
    return b;
}

function mergeBucket(target, key, src) {
    const b = target[key] || (target[key] = bucket());
    // Aggregates written by an older index version lack the newer fields; the
    // index version guards against that, but a missing field must still add
    // zero rather than turn the total into NaN.
    for (const f of BUCKET_FIELDS) b[f] += src[f] || 0;
    if (src.last) b.last = Math.max(b.last || 0, src.last);
}

function mergeFriction(target, src) {
    if (!src) return;
    target.toolErrors += src.toolErrors || 0;
    target.interrupts += src.interrupts || 0;
    target.hookErrors += src.hookErrors || 0;
    target.shutdowns += src.shutdowns || 0;
    target.droppedTokens += src.droppedTokens || 0;
    target.compactMs += src.compactMs || 0;
    for (const [k, n] of Object.entries(src.denials || {})) target.denials[k] = (target.denials[k] || 0) + n;
    for (const [k, n] of Object.entries(src.compactions || {})) target.compactions[k] = (target.compactions[k] || 0) + n;
}

function mergeTools(target, src) {
    for (const [name, t] of Object.entries(src || {})) {
        const into = target[name] || (target[name] = { calls: 0, errors: 0, denials: 0 });
        into.calls += t.calls || 0;
        into.errors += t.errors || 0;
        into.denials += t.denials || 0;
    }
}

function mergeFiles(target, src) {
    for (const [file, f] of Object.entries(src || {})) {
        const into = target[file] || (target[file] = { edits: 0, added: 0, removed: 0 });
        into.edits += f.edits || 0;
        into.added += f.added || 0;
        into.removed += f.removed || 0;
    }
}

const dayKey = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// What the path itself tells us: project slug, and for subagents the parent
// session, the workflow, and the agent id. The root is a parameter rather than
// the constant, so an index over a different tree still resolves slugs.
function describeFile(file, root = PROJECTS) {
    const rel = file.startsWith(root) ? file.slice(root.length + 1) : file;
    const slug = rel.split(path.sep)[0] || '';
    const sub = SUBAGENT_RE.exec(file);
    if (sub) {
        return {
            slug,
            kind: sub[2] ? 'workflow' : 'agent',
            sessionId: sub[1],
            workflowId: sub[2] || '',
            agentId: sub[3],
        };
    }
    return {
        slug,
        kind: 'main',
        sessionId: path.basename(file, '.jsonl'),
        workflowId: '',
        agentId: '',
    };
}

// A project slug is the absolute path with separators replaced; the last
// meaningful segment is close enough to a readable name.
function projectName(slug) {
    const parts = slug.split('-').filter(Boolean);
    return parts[parts.length - 1] || slug;
}

// Which lines are worth a JSON.parse. The bulk of a transcript is tool traffic
// that carries none of these markers, and skipping it is what keeps a full pass
// in the tens of milliseconds per file. One alternation scans each line once;
// a chain of includes() calls would scan it once per marker.
const INTERESTING = /"usage"|"promptSource"|"is_error":true|"toolDenialKind"|"compactMetadata"|"aiTitle"|"customTitle"|"interrupted":true|"interruptedByShutdown":true|"hookErrors":\[\{|"structuredPatch"/;

/**
 * Aggregate a single transcript. Only records matching INTERESTING are parsed,
 * which is what makes a full pass over a gigabyte of transcripts affordable.
 */
function indexFile(file, root = PROJECTS) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

    const meta = describeFile(file, root);
    const agg = emptyAgg();
    const row = {
        id: meta.sessionId,
        agentId: meta.agentId,
        workflowId: meta.workflowId,
        kind: meta.kind,
        project: projectName(meta.slug),
        slug: meta.slug,
        title: '',
        entrypoint: '',
        start: 0,
        end: 0,
        msgs: 0,
        cost: 0,
        tokens: 0,
        out: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tools: 0,
        errors: 0,
        models: [],
        efforts: [],
        branch: '',
    };

    const models = new Set();
    const efforts = new Set();
    const toolNames = new Map();

    const rawWords = {};

    for (const line of text.split('\n')) {
        if (line.length < 50 || line[0] !== '{') continue;
        if (!INTERESTING.test(line)) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }

        // A title is written as its own record and rewritten as the session goes
        // on; the last one is the one the client shows. A title the user typed
        // wins over the generated one, which is why both are read.
        if (r.aiTitle) row.title = r.aiTitle;
        if (r.customTitle) row.title = r.customTitle;
        if (r.entrypoint) row.entrypoint = r.entrypoint;

        noteFriction(agg, r, toolNames, row);
        noteEdit(agg, r);

        // A prompt is a user turn that carries promptSource — that is what
        // separates something typed from a tool result replayed as a user turn.
        if (r.type === 'user' && r.promptSource) {
            const body = promptText(r.message);
            const p = agg.prompts;
            p.count++;
            p.chars += body.length;
            if (body.length > p.longest) p.longest = body.length;
            p.bySource[r.promptSource] = (p.bySource[r.promptSource] || 0) + 1;
            // A mean is useless here: one pasted file drags it past every typed
            // line. A histogram shows what a prompt usually looks like.
            const b = lenBucket(body.length);
            p.lens[b] = (p.lens[b] || 0) + 1;
            const at = Date.parse(r.timestamp) || 0;
            if (at) {
                const h = String(new Date(at).getHours());
                p.byHour[h] = (p.byHour[h] || 0) + 1;
            }
            tallyWords(body, rawWords);
        }

        const usage = r.message && r.message.usage;
        if (!usage) continue;

        const at = Date.parse(r.timestamp) || 0;
        const model = r.message.model || '';
        const cost = costOf(model, usage);
        const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
            + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);

        if (at) {
            add(agg.days, dayKey(at), usage, model);
            add(agg.hours, String(new Date(at).getHours()), usage, model);
            if (!row.start || at < row.start) row.start = at;
            if (at > row.end) row.end = at;
        }
        add(agg.models, model, usage, model);
        if (r.gitBranch) { add(agg.branches, r.gitBranch, usage, model); row.branch = r.gitBranch; }
        if (r.attributionSkill) {
            const b = add(agg.skills, r.attributionSkill, usage, model);
            // When it last ran, which is the difference between "installed and
            // idle" and "was useful in June". A max rather than a sum, so it
            // travels beside BUCKET_FIELDS rather than in it.
            if (b) b.last = Math.max(b.last || 0, at || 0);
        }
        // The reasoning tier is recorded per reply, so a session that switched
        // effort mid-way is counted honestly on both sides of the switch. Model
        // and effort share a key because neither is meaningful without the other.
        add(agg.efforts, effortKey(model, r.effort), usage, model);
        if (r.entrypoint) add(agg.entrypoints, r.entrypoint, usage, model);
        if (usage.speed) add(agg.speeds, usage.speed, usage, model);

        noteTools(agg, r.message.content, toolNames, row);

        models.add(model);
        efforts.add(r.effort || '');
        row.msgs++;
        row.cost += cost;
        row.tokens += tokens;
        row.out += usage.output_tokens || 0;
        row.cacheRead += usage.cache_read_input_tokens || 0;
        row.cacheWrite += usage.cache_creation_input_tokens || 0;
    }

    if (row.msgs === 0 && agg.prompts.count === 0) return null;
    row.models = [...models].filter(Boolean);
    row.efforts = [...efforts].filter(Boolean);
    agg.prompts.words = trimWords(rawWords);
    agg.sessions.push(row);
    return agg;
}

// Model and effort in one key, with a separator that cannot occur in either.
const EFFORT_SEP = '|';
const effortKey = (model, effort) => `${model}${EFFORT_SEP}${effort || ''}`;
const splitEffort = (key) => {
    const at = key.indexOf(EFFORT_SEP);
    return at < 0 ? { model: key, effort: '' } : { model: key.slice(0, at), effort: key.slice(at + 1) };
};

// Tool calls, from the reply that made them. They ride along in records the
// pass already parses for usage, so counting them costs nothing extra — and the
// id→name map they build is what lets a failed result be blamed on a tool.
function noteTools(agg, content, toolNames, row) {
    if (!Array.isArray(content)) return;
    for (const block of content) {
        if (!block || (block.type !== 'tool_use' && block.type !== 'server_tool_use')) continue;
        const name = block.name || UNKNOWN_TOOL;
        if (block.id) toolNames.set(block.id, name);
        const t = agg.tools[name] || (agg.tools[name] = { calls: 0, errors: 0, denials: 0 });
        t.calls++;
        row.tools++;
    }
}

/**
 * Which files were written, and by how much. The result of an edit carries the
 * absolute path and the patch, which is a truer record than `~/.claude/file-
 * history`: the backups there are named by a hash of the path, so the tree
 * cannot say what it is holding without reading the transcripts anyway.
 */
function noteEdit(agg, r) {
    const res = r.toolUseResult;
    if (!res || typeof res !== 'object') return;
    const path = res.filePath || (res.file && res.file.filePath);
    if (!path) return;
    const f = agg.files[path] || (agg.files[path] = { edits: 0, added: 0, removed: 0 });
    f.edits++;
    for (const hunk of (Array.isArray(res.structuredPatch) ? res.structuredPatch : [])) {
        for (const line of hunk.lines || []) {
            if (line[0] === '+') f.added++;
            else if (line[0] === '-') f.removed++;
        }
    }
}

// Everything that went wrong, from whichever record records it.
function noteFriction(agg, r, toolNames, row) {
    const f = agg.friction;

    if (r.toolDenialKind) {
        f.denials[r.toolDenialKind] = (f.denials[r.toolDenialKind] || 0) + 1;
        blameTool(agg, r, toolNames, 'denials');
    }
    if (r.interruptedByShutdown) f.shutdowns++;
    if (Array.isArray(r.hookErrors) && r.hookErrors.length) f.hookErrors += r.hookErrors.length;
    if (r.toolUseResult && r.toolUseResult.interrupted === true) f.interrupts++;

    const c = r.compactMetadata;
    if (c) {
        const trigger = c.trigger || 'unknown';
        f.compactions[trigger] = (f.compactions[trigger] || 0) + 1;
        // What compaction actually costs is the context it throws away: those
        // tokens were paid for once and have to be paid for again on the way
        // back in. cumulativeDroppedTokens is the client's own count of it.
        f.droppedTokens += c.cumulativeDroppedTokens
            || Math.max(0, (c.preTokens || 0) - (c.postTokens || 0));
        f.compactMs += c.durationMs || 0;
    }

    // A failed tool result is a user record: the error travels back in as the
    // content of the turn that answers the call.
    const content = r.message && r.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
        if (!block || block.type !== 'tool_result' || block.is_error !== true) continue;
        f.toolErrors++;
        row.errors++;
        const name = toolNames.get(block.tool_use_id) || UNKNOWN_TOOL;
        const t = agg.tools[name] || (agg.tools[name] = { calls: 0, errors: 0, denials: 0 });
        t.errors++;
    }
}

// A denial record names no tool either, but it answers one call — the id is on
// the result block it carries.
function blameTool(agg, r, toolNames, field) {
    const content = r.message && r.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
        if (!block || block.type !== 'tool_result') continue;
        const name = toolNames.get(block.tool_use_id) || UNKNOWN_TOOL;
        const t = agg.tools[name] || (agg.tools[name] = { calls: 0, errors: 0, denials: 0 });
        t[field]++;
    }
}

// Every transcript on disk, main and subagent alike.
function walk(dir, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
}

function indexPath(storageDir) {
    return path.join(storageDir, 'index.json');
}

function loadIndex(storageDir) {
    try {
        const idx = JSON.parse(fs.readFileSync(indexPath(storageDir), 'utf8'));
        if (idx && idx.version === INDEX_VERSION && idx.files) return idx;
    } catch { /* no usable index yet */ }
    return { version: INDEX_VERSION, files: {} };
}

// The last parse of each storage directory, and the mtime it came from.
const lastParse = new Map();

/**
 * The index on disk, parsed again only when the file behind it has moved. The
 * same object comes back until it does, so a caller on a repeating tick can ask
 * every time: it is 5.6 MB on this machine and ~40 ms to parse, while the file
 * itself changes only when the dashboard rebuilds it. Deciding that here is what
 * keeps the reading of it — and the path it lives at — inside this module.
 */
function freshIndex(storageDir) {
    let at = 0;
    try { at = fs.statSync(indexPath(storageDir)).mtimeMs; } catch { /* not built yet */ }
    const seen = lastParse.get(storageDir);
    if (seen && seen.at === at) return seen.index;
    const index = loadIndex(storageDir);
    lastParse.set(storageDir, { at, index });
    return index;
}

function saveIndex(storageDir, index) {
    try {
        fs.mkdirSync(storageDir, { recursive: true });
        const tmp = `${indexPath(storageDir)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(index));
        fs.renameSync(tmp, indexPath(storageDir));
        return true;
    } catch { return false; }
}

/**
 * Bring the index up to date. Files whose size and mtime match the stored
 * fingerprint are reused as-is; only new or grown files are re-read. Returns
 * counts so the caller can show honest progress instead of a fake spinner.
 *
 * `onProgress(done, total)` is called as work proceeds — the first run over a
 * gigabyte of transcripts takes seconds and should not look like a freeze.
 */
function refreshIndex(storageDir, { root = PROJECTS, onProgress } = {}) {
    const index = loadIndex(storageDir);
    const files = walk(root);
    const seen = new Set();
    let reused = 0;
    let parsed = 0;
    let bytes = 0;

    files.forEach((file, i) => {
        seen.add(file);
        let st;
        try { st = fs.statSync(file); } catch { return; }
        const prev = index.files[file];
        if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
            reused++;
        } else {
            const agg = indexFile(file, root);
            index.files[file] = { size: st.size, mtime: st.mtimeMs, agg };
            parsed++;
            bytes += st.size;
        }
        if (onProgress && (i % 100 === 0 || i === files.length - 1)) onProgress(i + 1, files.length);
    });

    // Deleted transcripts must leave the index, or their spend haunts the totals.
    let removed = 0;
    for (const known of Object.keys(index.files)) {
        if (!seen.has(known)) { delete index.files[known]; removed++; }
    }

    saveIndex(storageDir, index);
    return { index, stats: { total: files.length, reused, parsed, removed, bytes } };
}

/** Fold every per-file aggregate into the shape the dashboard renders. */
function summarize(index) {
    const total = {
        days: {}, models: {}, branches: {}, skills: {}, hours: {},
        efforts: {}, entrypoints: {}, speeds: {}, tools: {}, files: {}, friction: emptyFriction(),
        sessions: [], projects: {}, prompts: emptyPrompts(),
    };
    // How many files each word appeared in — the basis for dropping filler.
    const wordFiles = {};
    let filesWithPrompts = 0;

    for (const entry of Object.values(index.files)) {
        const agg = entry && entry.agg;
        if (!agg) continue;
        for (const [k, v] of Object.entries(agg.days)) mergeBucket(total.days, k, v);
        for (const [k, v] of Object.entries(agg.models)) mergeBucket(total.models, k, v);
        for (const [k, v] of Object.entries(agg.branches)) mergeBucket(total.branches, k, v);
        for (const [k, v] of Object.entries(agg.skills)) mergeBucket(total.skills, k, v);
        for (const [k, v] of Object.entries(agg.hours)) mergeBucket(total.hours, k, v);
        for (const [k, v] of Object.entries(agg.efforts || {})) mergeBucket(total.efforts, k, v);
        for (const [k, v] of Object.entries(agg.entrypoints || {})) mergeBucket(total.entrypoints, k, v);
        for (const [k, v] of Object.entries(agg.speeds || {})) mergeBucket(total.speeds, k, v);
        mergeTools(total.tools, agg.tools);
        mergeFiles(total.files, agg.files);
        mergeFriction(total.friction, agg.friction);
        for (const row of agg.sessions) {
            total.sessions.push(row);
            const p = total.projects[row.project] || (total.projects[row.project] = bucket());
            p.cost += row.cost;
            p.msgs += row.msgs;
            p.in += row.tokens; // projects only need a single token total
        }

        const pr = agg.prompts;
        if (!pr) continue;
        total.prompts.count += pr.count;
        total.prompts.chars += pr.chars;
        total.prompts.longest = Math.max(total.prompts.longest, pr.longest || 0);
        for (const [h, n] of Object.entries(pr.byHour || {})) {
            total.prompts.byHour[h] = (total.prompts.byHour[h] || 0) + n;
        }
        for (const [src, n] of Object.entries(pr.bySource || {})) {
            total.prompts.bySource[src] = (total.prompts.bySource[src] || 0) + n;
        }
        for (const [b, n] of Object.entries(pr.lens || {})) {
            total.prompts.lens[b] = (total.prompts.lens[b] || 0) + n;
        }
        if (pr.count > 0) filesWithPrompts++;
        for (const [w, n] of Object.entries(pr.words || {})) {
            total.prompts.words[w] = (total.prompts.words[w] || 0) + n;
            wordFiles[w] = (wordFiles[w] || 0) + 1;
        }
    }

    // A word present in most sessions carries no signal about any of them —
    // that is filler in whichever language it happens to be.
    if (filesWithPrompts > 4) {
        const ceiling = filesWithPrompts * 0.6;
        for (const w of Object.keys(total.prompts.words)) {
            if (wordFiles[w] > ceiling) delete total.prompts.words[w];
        }
    }
    total.prompts.words = trimWords(total.prompts.words, 60);

    total.sessions.sort((a, b) => b.end - a.end);
    return total;
}

module.exports = {
    PROJECTS, INDEX_VERSION, SUBAGENT_RE, INTERESTING,
    describeFile, projectName, indexFile, walk, loadIndex, freshIndex, saveIndex, refreshIndex,
    summarize, dayKey, bucket, emptyAgg, emptyFriction, effortKey, splitEffort,
    promptText, tallyWords, trimWords, lenBucket, LEN_BUCKETS,
};
