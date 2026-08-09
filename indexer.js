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
const { costOf } = require('./pricing');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const INDEX_VERSION = 1;

// Subagent transcripts live under <slug>/<sessionId>/subagents/, and workflow
// agents one level deeper under .../workflows/<wfId>/. The path is the only
// place that relationship is recorded, so it is parsed rather than guessed.
const SUBAGENT_RE = /\/([^/]+)\/subagents\/(?:workflows\/([^/]+)\/)?agent-([^/]+)\.jsonl$/;

function emptyAgg() {
    return {
        days: {},      // YYYY-MM-DD → bucket
        models: {},    // model id → bucket
        branches: {},  // git branch → bucket
        skills: {},    // attributionSkill → bucket
        hours: {},     // 0..23 → bucket
        sessions: [],  // one row per file
        prompts: emptyPrompts(),
    };
}

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

function bucket() {
    return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, msgs: 0 };
}

function add(map, key, usage, model) {
    if (!key) return;
    const b = map[key] || (map[key] = bucket());
    b.in += usage.input_tokens || 0;
    b.out += usage.output_tokens || 0;
    b.cacheRead += usage.cache_read_input_tokens || 0;
    b.cacheWrite += usage.cache_creation_input_tokens || 0;
    b.cost += costOf(model, usage);
    b.msgs++;
}

function mergeBucket(target, key, src) {
    const b = target[key] || (target[key] = bucket());
    b.in += src.in;
    b.out += src.out;
    b.cacheRead += src.cacheRead;
    b.cacheWrite += src.cacheWrite;
    b.cost += src.cost;
    b.msgs += src.msgs;
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

/**
 * Aggregate a single transcript. Only records carrying usage matter, so lines
 * are pre-filtered by substring before JSON.parse — that alone roughly halves
 * the cost of a full pass.
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
        start: 0,
        end: 0,
        msgs: 0,
        cost: 0,
        tokens: 0,
        models: [],
        branch: '',
    };

    const models = new Set();

    const rawWords = {};

    for (const line of text.split('\n')) {
        if (line.length < 50 || line[0] !== '{') continue;
        // Two kinds of record matter: model replies (usage) and typed prompts
        // (promptSource). Pre-filtering by substring keeps JSON.parse off the
        // tool-result traffic, which is the bulk of a transcript.
        const hasUsage = line.includes('"usage"');
        const hasPrompt = line.includes('"promptSource"');
        if (!hasUsage && !hasPrompt) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }

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
        if (r.attributionSkill) add(agg.skills, r.attributionSkill, usage, model);

        models.add(model);
        row.msgs++;
        row.cost += cost;
        row.tokens += tokens;
    }

    if (row.msgs === 0 && agg.prompts.count === 0) return null;
    row.models = [...models].filter(Boolean);
    agg.prompts.words = trimWords(rawWords);
    agg.sessions.push(row);
    return agg;
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
    PROJECTS, INDEX_VERSION, SUBAGENT_RE,
    describeFile, projectName, indexFile, walk, loadIndex, saveIndex, refreshIndex,
    summarize, dayKey, bucket, emptyAgg, promptText, tallyWords, trimWords, lenBucket, LEN_BUCKETS,
};
