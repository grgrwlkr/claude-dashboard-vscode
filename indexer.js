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
const { costOf, cacheSplit, cacheSaving, advisorUsages, usageTotal, responseKey, SYNTHETIC_MODEL } = require('./pricing');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');

// Bump on every change to the shape of a per-file aggregate. A file whose size
// and mtime are unchanged is never re-read, so without a bump the old shape is
// reused forever and the new fields stay empty for everything already indexed.
// 4: skill buckets carry `last`, the newest reply attributed to them. A stored
// aggregate of shape 3 has no such field and would read as "never used".
// 5: word tallies count prompts rather than occurrences, drop paths and
// identifiers, and keep sixty per file rather than thirty — a stored tally of
// shape 4 is a different measurement wearing the same field name.
// 6: a response is charged once rather than once per content block. The shape is
// unchanged and every number in it is different — an aggregate of shape 5 holds
// the inflated figures and would keep them forever, since its file has not moved.
// 7: Sonnet 5 is repriced $3/$15 → $2/$10. Money is baked into the aggregate at
// index time, so a rate fix reprices nothing already stored — same reason as 6.
// 8: Bedrock, Vertex and gateway model ids canonicalise to the model they name,
// so what was billed at the Opus fallback is billed at its own rate — a rate fix
// again, and stored aggregates keep the old money without a bump.
// 9: Fable 5.1 and Mythos 5.1 get a rate, a cache read is priced per model, and
// an advisor's consultation — an `advisor_message` entry of `usage.iterations`,
// left out of the record's own counters — is priced at the advisor's rate. All
// three are money, and money is baked in.
// 10: the consultation moves to the advisor's own row of `models` and
// `efforts`; an index of 9 holds it on the executor's row.
// 11: a session row lists the advisor among its models and drops `<synthetic>`
// from them; an index of 10 has the list the other way round.
const INDEX_VERSION = 11;

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
        agents: {},      // agentType → bucket
        hours: {},       // 0..23 → bucket
        efforts: {},     // model and effort in one key → bucket
        entrypoints: {}, // cli | claude-vscode | sdk-py | … → bucket
        speeds: {},      // usage.speed, i.e. standard vs fast mode → bucket
        tools: {},       // tool name → { calls, errors, denials }
        files: {},       // absolute path → { edits, added, removed }
        friction: emptyFriction(),
        breaks: emptyBreaks(),
        sessions: [],    // one row per file
        prompts: emptyPrompts(),
    };
}

// A reply whose input did not come from the cache. Some of that is unavoidable —
// the first request of a session has nothing to read — but a large one in the
// middle of a run means the cache was rebuilt rather than reused, and that is
// the expensive direction. Counted for everything, kept in full only for the
// worst, since the tail of small ones says nothing a total does not.
const CACHE_BREAK_TOKENS = 100000;
const BREAKS_PER_FILE = 5;
const BREAKS_KEPT = 20;

// Longer than this between two records and the session was not working, it was
// sitting there. Five minutes is the same threshold Anthropic's own session
// analyzer uses, and it is long enough that a slow reply is never mistaken for
// an idle one.
const IDLE_GAP_MS = 5 * 60 * 1000;

function emptyBreaks() {
    return { count: 0, tokens: 0, top: [] };
}

function keepBreak(breaks, entry, limit) {
    breaks.top.push(entry);
    breaks.top.sort((a, b) => b.uncached - a.uncached);
    if (breaks.top.length > limit) breaks.top.length = limit;
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
const TOP_WORDS_PER_FILE = 60;

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
// Once per prompt, not once per occurrence. A pasted file carries `const` four
// hundred times and a typed sentence carries a word once, so counting every
// occurrence answered "what did you paste" — 220k Latin occurrences against 12k
// Cyrillic on this machine, in prompts that are written in Russian. Counting
// prompts instead is the question the panel actually asks: in how many of the
// things you wrote does this word appear.
// What is not a word you used: a path, a tool-use id, a snake_case identifier.
// These arrive inside prompts by the hundred — a screenshot injects its own
// path, a tool result its id — and each of them beat prose to the per-file top
// thirty, which is why a machine driven in Russian showed an English cloud made
// of `users`, `develop`, the account name and `toolu`.
const NOT_PROSE = /(?:\[image #\d+\])|(?:[\w.-]*\/[\w./-]+)|(?:\btoolu_\w+)|(?:\b\w*_\w+\b)|(?:\b[0-9a-f]{8,}\b)/gi;

function tallyWords(text, into) {
    const seen = text.toLowerCase().replace(NOT_PROSE, ' ').match(WORD_RE);
    if (!seen) return;
    // Once per prompt, not once per occurrence — see above.
    for (const w of new Set(seen)) into[w] = (into[w] || 0) + 1;
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

function add(map, key, usage, model, advisor = '') {
    if (!key) return null;
    const b = map[key] || (map[key] = bucket());
    const cache = cacheSplit(usage);
    b.in += usage.input_tokens || 0;
    b.out += usage.output_tokens || 0;
    b.cacheRead += usage.cache_read_input_tokens || 0;
    b.cacheWrite += cache.total;
    b.cw1h += cache.hour;
    b.cw5m += cache.min5;
    b.saved += cacheSaving(model, usage, advisor);
    b.cost += costOf(model, usage, advisor);
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

// What kind of agent a subagent transcript belongs to is not written anywhere
// inside it. The client puts it in a sibling `<agent>.meta.json`, together with
// the model the dispatch asked for and where the agent sat in the spawn tree —
// which is the only place the difference between a requested model and the one
// that actually replied can be seen.
function readAgentMeta(file) {
    try {
        const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
        return {
            agentType: typeof m.agentType === 'string' ? m.agentType : '',
            askedModel: typeof m.model === 'string' ? m.model : '',
            parentAgentId: typeof m.parentAgentId === 'string' ? m.parentAgentId : '',
            spawnDepth: Number.isFinite(m.spawnDepth) ? m.spawnDepth : 0,
        };
    } catch {
        // Older transcripts predate the meta file; the agent still counts, it
        // just has no type to be grouped under.
        return { agentType: '', askedModel: '', parentAgentId: '', spawnDepth: 0 };
    }
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
        agentType: '',
        askedModel: '',
        parentAgentId: '',
        spawnDepth: 0,
        activeMs: 0,
    };

    if (meta.kind !== 'main') Object.assign(row, readAgentMeta(file));

    const models = new Set();
    const efforts = new Set();
    const toolNames = new Map();
    // One entry per response, keyed by request id — charged after the file is
    // read, because the last record of a response is the one that says what it
    // cost. See `holdResponse`.
    const pending = new Map();
    let prevAt = 0;

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
            // Only what a person typed. `sdk` is a program driving Claude,
            // `system` is the client's own text, `queued` and
            // `suggestion_accepted` are neither typed nor prose — and together
            // they are more than half the prompts on this machine, which is why
            // the cloud was full of words like `notification` and `summary`
            // that nobody has ever written.
            if (r.promptSource === 'typed') tallyWords(body, rawWords);
        }

        const usage = r.message && r.message.usage;
        if (!usage) continue;

        const at = Date.parse(r.timestamp) || 0;
        if (at) {
            if (!row.start || at < row.start) row.start = at;
            if (at > row.end) row.end = at;
            // A gap shorter than the threshold is the session thinking; a longer
            // one is a session left open. Measured between the records this pass
            // already parses, which is every reply and every prompt — tool
            // traffic in between changes nothing, since it sits inside a gap
            // that is counted whole either way.
            const gap = at - prevAt;
            if (prevAt && gap > 0 && gap < IDLE_GAP_MS) row.activeMs += gap;
            if (at > prevAt) prevAt = at;
        }

        // The records of one reply are not copies of each other: the reply is
        // split one record per content block, and a tool call lives in exactly
        // one of them. So calls are counted from every record, and only the
        // money below is held to one charge per response.
        noteTools(agg, r.message.content, toolNames, row);

        // Held rather than charged here: what a response actually cost is not
        // known until every record of it has been read. See `holdResponse`.
        holdResponse(pending, r, usage, at);
    }

    for (const held of pending.values()) charge(agg, row, held, meta, models, efforts);

    if (row.msgs === 0 && agg.prompts.count === 0) return null;
    row.models = [...models].filter(Boolean);
    row.efforts = [...efforts].filter(Boolean);
    agg.prompts.words = trimWords(rawWords);
    agg.sessions.push(row);
    return agg;
}

/**
 * One response arrives as several records — one per content block — and they do
 * not agree with each other. Two shapes occur on this machine: every record
 * repeating the response's final `usage`, and a running counter where the early
 * records carry a partial output and only the last one is the answer (3, 3, 3,
 * 1185 on a real reply here). Adding them all charges a reply once per block;
 * taking whichever came first throws away a third of the output — 31.5M against
 * 47.1M across these transcripts, and 25.5% of responses affected.
 *
 * So a response is held until the file has been read and charged once, from its
 * fullest record — the one whose usage totals the most.
 *
 * Not "the last record": here the last one is strictly below the maximum for 2
 * responses of 51 075, so last is an approximation that is right almost always
 * and is strictly worse. Not per-field maxima either: `cache_creation` is a
 * nested object holding the TTL split, so assembling a usage from the best of
 * each field would build one no reply ever had and drop that nesting. And not
 * `output_tokens` alone: it picks the same record as the total on all 51 078
 * responses here, but only because the fields move together, which nothing
 * documents and no test could notice breaking.
 *
 * The fields around the usage are merged rather than taken from that record, and
 * `speed` is held beside the usage rather than inside it: it appears only on the
 * record that closes a response, while the skill and effort are on the opening
 * one, and the charged record is neither by construction.
 */
function holdResponse(pending, r, usage, at) {
    // A record with no request id belongs to no group and is charged alone.
    const key = responseKey(r, String(pending.size));
    const held = pending.get(key);
    if (!held) {
        pending.set(key, {
            usage, at, model: r.message.model || '', skill: r.attributionSkill || '',
            branch: r.gitBranch || '', effort: r.effort || '', entrypoint: r.entrypoint || '',
            speed: usage.speed || '', advisor: r.advisorModel || '',
        });
        return;
    }
    if (usageTotal(usage) > usageTotal(held.usage)) {
        held.usage = usage;
        // With the usage, because the price is computed from it: a model taken
        // from one record and a usage from another can disagree, and two
        // responses here do carry two ids — a real one and `<synthetic>`.
        if (r.message.model) held.model = r.message.model;
    }
    // Not moved to the charged record: this is when the response began, which is
    // the hour a person was working in. 78 responses here span an hour boundary
    // and 12 span midnight; they are filed on the earlier side on purpose.
    if (!held.at) held.at = at;
    if (!held.model) held.model = r.message.model || '';
    if (!held.skill) held.skill = r.attributionSkill || '';
    if (!held.branch) held.branch = r.gitBranch || '';
    if (!held.effort) held.effort = r.effort || '';
    if (!held.entrypoint) held.entrypoint = r.entrypoint || '';
    if (!held.advisor) held.advisor = r.advisorModel || '';
    // Beside the usage rather than inside it. `speed` rides on the record that
    // closes a response, and the charged record is whichever is fullest —
    // nothing makes those the same one, so a field kept inside `usage` would be
    // dropped by the next replacement of it.
    if (!held.speed) held.speed = usage.speed || '';
}

/** One held response, into every bucket that counts it. */
function charge(agg, row, held, meta, models, efforts) {
    const { usage, at, model, advisor } = held;
    const tokens = usageTotal(usage);

    // A consultation is the advisor's spend. The buckets keyed by model — models
    // and efforts — book it to the advisor's own row, under no effort, and the
    // reply to the executor's without it; every other bucket keeps the whole
    // reply, consultation included, because the day, the branch and the skill
    // paid for both.
    const { iterations, ...own } = usage;
    const consults = advisorUsages(usage, advisor);

    if (at) {
        add(agg.days, dayKey(at), usage, model, advisor);
        add(agg.hours, String(new Date(at).getHours()), usage, model, advisor);
    }

    const uncached = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    if (uncached > CACHE_BREAK_TOKENS) {
        agg.breaks.count++;
        agg.breaks.tokens += uncached;
        keepBreak(agg.breaks, {
            at, uncached, session: meta.sessionId, project: row.project, kind: meta.kind,
        }, BREAKS_PER_FILE);
    }
    add(agg.models, model, own, model);
    for (const it of consults) {
        add(agg.models, it.model || 'advisor', it, it.model);
        add(agg.efforts, effortKey(it.model || 'advisor', ADVISOR_TIER), it, it.model);
    }
    if (held.branch) { add(agg.branches, held.branch, usage, model, advisor); row.branch = held.branch; }
    if (held.skill) {
        const b = add(agg.skills, held.skill, usage, model, advisor);
        // When it last ran, which is the difference between "installed and idle"
        // and "was useful in June". A max rather than a sum, so it travels
        // beside BUCKET_FIELDS rather than in it.
        if (b) b.last = Math.max(b.last || 0, at || 0);
    }
    // The reasoning tier is recorded per reply, so a session that switched effort
    // mid-way is counted honestly on both sides of the switch. Model and effort
    // share a key because neither is meaningful without the other.
    add(agg.efforts, effortKey(model, held.effort), own, model);
    if (row.agentType) add(agg.agents, row.agentType, usage, model, advisor);
    if (held.entrypoint) add(agg.entrypoints, held.entrypoint, usage, model, advisor);
    if (held.speed) add(agg.speeds, held.speed, usage, model, advisor);

    // The models that answered in this session: the executor and whichever
    // advisor it consulted. `<synthetic>` is the client's stand-in for a reply
    // that never came, a message but not a model — it stays out of the list.
    if (model !== SYNTHETIC_MODEL) models.add(model);
    for (const it of consults) if (it.model) models.add(it.model);
    efforts.add(held.effort || '');
    row.msgs++;
    row.cost += costOf(model, usage, advisor);
    row.tokens += tokens;
    row.out += usage.output_tokens || 0;
    row.cacheRead += usage.cache_read_input_tokens || 0;
    row.cacheWrite += usage.cache_creation_input_tokens || 0;
}

// Model and effort in one key, with a separator that cannot occur in either.
// A consultation has no effort and is not a reply that forgot to send one, so
// the advisor's row carries a tier of its own rather than the empty one.
const EFFORT_SEP = '|';
const ADVISOR_TIER = 'advisor';
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
    // Not `path`: that is the module this file imports, and shadowing it here
    // leaves a trap for whoever next needs path.join inside this function.
    const file = res.filePath || (res.file && res.file.filePath);
    if (!file) return;
    const f = agg.files[file] || (agg.files[file] = { edits: 0, added: 0, removed: 0 });
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
        days: {}, models: {}, branches: {}, skills: {}, agents: {}, hours: {},
        efforts: {}, entrypoints: {}, speeds: {}, tools: {}, files: {}, friction: emptyFriction(),
        breaks: emptyBreaks(), sessions: [], projects: {}, prompts: emptyPrompts(),
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
        for (const [k, v] of Object.entries(agg.agents || {})) mergeBucket(total.agents, k, v);
        for (const [k, v] of Object.entries(agg.hours)) mergeBucket(total.hours, k, v);
        for (const [k, v] of Object.entries(agg.efforts || {})) mergeBucket(total.efforts, k, v);
        for (const [k, v] of Object.entries(agg.entrypoints || {})) mergeBucket(total.entrypoints, k, v);
        for (const [k, v] of Object.entries(agg.speeds || {})) mergeBucket(total.speeds, k, v);
        mergeTools(total.tools, agg.tools);
        mergeFiles(total.files, agg.files);
        mergeFriction(total.friction, agg.friction);
        if (agg.breaks) {
            total.breaks.count += agg.breaks.count || 0;
            total.breaks.tokens += agg.breaks.tokens || 0;
            for (const b of agg.breaks.top || []) keepBreak(total.breaks, b, BREAKS_KEPT);
        }
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

/**
 * The index as something another program can read. JSON is the whole summary;
 * CSV is one row per transcript, because that is the shape a spreadsheet wants
 * and the totals can be re-derived from it. Both are built from the same
 * summary the page draws, so an export cannot disagree with what was on screen.
 */
function exportJson(index, total) {
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        transcripts: total.sessions.length,
        spend: Object.values(total.days).reduce((a, b) => a + b.cost, 0),
        days: total.days,
        models: total.models,
        projects: total.projects,
        branches: total.branches,
        skills: total.skills,
        tools: total.tools,
        sessions: total.sessions,
    }, null, 2);
}

const CSV_COLUMNS = ['end', 'project', 'branch', 'kind', 'entrypoint', 'title',
    'models', 'efforts', 'start', 'msgs', 'tokens', 'out', 'cacheRead', 'cacheWrite', 'cost'];

// A field is quoted whenever it could be misread — a session title carries
// commas, quotes and newlines, and one unescaped quote shifts every column
// after it on that row.
const csvCell = (v) => {
    const text = Array.isArray(v) ? v.join(' ') : String(v ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function exportCsv(total) {
    const rows = total.sessions.map((s) => CSV_COLUMNS.map((c) => csvCell(s[c])).join(','));
    return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

/**
 * How many sessions were running at the same moment, per day. A day's total says
 * how much was done; this says how wide it was — one session for nine hours and
 * nine sessions for one hour are the same total and nothing like each other.
 *
 * Ten-minute buckets: finer than that measures the overlap of two transcripts
 * that happened to write in the same second, which is not a session running
 * beside another one. A session spanning midnight counts toward every day it
 * touches, because on each of them it was genuinely open.
 */
const PARALLEL_BUCKET_MS = 10 * 60 * 1000;
const BUCKETS_PER_DAY = 144;

function peakParallel(sessions) {
    const days = {};
    for (const s of sessions || []) {
        if (!s.start || !s.end || s.end < s.start) continue;
        for (let at = s.start; ; at += PARALLEL_BUCKET_MS) {
            const capped = Math.min(at, s.end);
            const key = dayKey(capped);
            const day = days[key] || (days[key] = { buckets: new Array(BUCKETS_PER_DAY).fill(0), sessions: 0, peak: 0, at: 0 });
            const midnight = new Date(capped).setHours(0, 0, 0, 0);
            const slot = Math.min(BUCKETS_PER_DAY - 1, Math.floor((capped - midnight) / PARALLEL_BUCKET_MS));
            day.buckets[slot]++;
            if (capped >= s.end) break;
        }
    }
    for (const [key, day] of Object.entries(days)) {
        day.peak = Math.max(...day.buckets);
        day.at = day.buckets.indexOf(day.peak) * PARALLEL_BUCKET_MS;
        day.sessions = (sessions || []).filter((s) => s.start && s.end
            && s.end >= s.start && overlapsDay(s, key)).length;
        delete day.buckets;
    }
    return days;
}

function overlapsDay(s, key) {
    for (let at = s.start; ; at += PARALLEL_BUCKET_MS) {
        const capped = Math.min(at, s.end);
        if (dayKey(capped) === key) return true;
        if (capped >= s.end) return false;
    }
}

/**
 * The calendar month so far, and where it lands if the rest of it looks like
 * the part that has happened. Days come from the index, which already keys them
 * `YYYY-MM-DD`, so this costs nothing beyond the summary the page already has —
 * walking transcripts for a month of spend would be the one expensive read this
 * dashboard refuses to put on a tick.
 */
function monthToDate(total, nowMs = Date.now()) {
    const now = new Date(nowMs);
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-`;
    let spent = 0;
    let active = 0;
    for (const [day, b] of Object.entries(total.days || {})) {
        if (!day.startsWith(prefix)) continue;
        spent += b.cost || 0;
        if (b.cost > 0) active++;
    }
    const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const elapsed = now.getDate();
    // Against the days gone, not the days worked: a month with weekends off
    // still has to be paid for by the month's end, and dividing by active days
    // alone forecasts a figure nobody will ever be billed.
    const projected = elapsed > 0 ? (spent / elapsed) * days : 0;
    return { spent, projected, elapsed, days, active };
}

module.exports = {
    monthToDate, peakParallel, exportJson, exportCsv,
    PROJECTS, INDEX_VERSION, SUBAGENT_RE, INTERESTING,
    describeFile, projectName, indexFile, walk, loadIndex, freshIndex, saveIndex, refreshIndex,
    summarize, dayKey, bucket, emptyAgg, emptyFriction, emptyBreaks, effortKey, splitEffort, ADVISOR_TIER,
    CACHE_BREAK_TOKENS, readAgentMeta,
    promptText, tallyWords, trimWords, lenBucket, LEN_BUCKETS,
};
