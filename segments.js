// The status bar as a template rather than a fixed layout.
//
// A segment is one status-bar item written as a string: literal text, `{field}`
// placeholders, and `[optional groups]` that disappear whole when a field
// inside them has nothing to say. That last part is what makes one template
// work in every state — `[ dry {dry}]` is silent in the first half hour of a
// window, when there is no forecast to make, and appears by itself later.
//
// No dependency on vscode: this builds strings, the extension turns them into
// items, and `node --test` covers the whole grammar.

// Which tooltip a segment gets, and which threshold colours it. A segment that
// mentions fields from two topics gets both tooltips, in the order the fields
// appear.
const TOPICS = ['limits', 'context', 'money', 'work', 'workflow'];

const pct = (n) => (Number.isFinite(n) && n >= 0 ? `${n}%` : '');
const usd = (n, fmt) => (Number.isFinite(n) && n > 0 ? fmt(n) : '');

// The run to talk about when several are going: the one that started last, which
// is the one the user just launched and is waiting on.
const newestRun = (d) => {
    const active = (d.workflows && d.workflows.active) || [];
    if (active.length === 0) return null;
    return active.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
};

/**
 * Every field a template may use. `topic` picks the tooltip and the colour
 * source; `doc` is what the placeholder-help command shows. A field returns an
 * empty string when it has nothing to say, and emptiness is what drives both
 * optional groups and hiding a segment entirely.
 */
function fields(helpers = {}) {
    const { fmtCost = (n) => `$${n.toFixed(2)}`, fmtDry = () => '', fmtLeft = () => '',
        fmtAbs = () => '', fmtDuration = () => '', tok = (n) => String(n), shortModel = (m) => m } = helpers;

    return {
        // --- limits ---------------------------------------------------------
        weekly: { topic: 'limits', doc: 'weekly limit used, e.g. 33%', get: (d) => pct(d.weekly?.pct) },
        weeklyBar: { topic: 'limits', doc: 'spend-against-plan bar for the week', get: (d) => d.bar || '' },
        plan: { topic: 'limits', doc: 'share of the weekly window already elapsed', get: (d) => pct(d.pace?.plan) },
        drift: {
            topic: 'limits',
            doc: 'distance from an even pace (+ is ahead of plan, − is behind it)',
            get: (d) => {
                // Silent until the window can be judged at all: `pace.settled`
                // is the same half hour and 2% that gate the forecast, and
                // without it a fresh week reads `+1%` against a plan of zero.
                if (!d.weekly || !d.pace || !d.pace.settled) return '';
                const diff = d.weekly.pct - d.pace.plan;
                return diff === 0 ? '0%' : `${diff > 0 ? '+' : ''}${diff}%`;
            },
        },
        dry: { topic: 'limits', doc: 'when the weekly window runs out at this pace, blank if that is after the reset', get: (d) => (d.pace?.dry ? fmtDry(d.pace.dry) : '') },
        dryAt: { topic: 'limits', doc: 'the same forecast even when it lands past the reset', get: (d) => (d.pace?.dryAt ? fmtDry(d.pace.dryAt) : '') },
        dryLeft: { topic: 'limits', doc: 'how long until that forecast, e.g. 2d4h', get: (d) => (d.pace?.dry ? fmtLeft(d.pace.dry, d.now) : '') },
        reset: { topic: 'limits', doc: 'clock time the weekly window resets', get: (d) => (d.weekly?.reset ? fmtAbs(d.weekly.reset) : '') },
        resetLeft: { topic: 'limits', doc: 'time left until the weekly reset', get: (d) => (d.weekly?.reset ? fmtLeft(d.weekly.reset, d.now) : '') },
        session5h: { topic: 'limits', doc: 'the rolling five-hour limit', get: (d) => pct(d.session?.pct) },
        session5hLeft: { topic: 'limits', doc: 'time left in the five-hour window', get: (d) => (d.session?.reset ? fmtLeft(d.session.reset, d.now) : '') },
        scoped: {
            topic: 'limits',
            doc: 'per-model windows; {scoped} lists all, {scoped:Opus} picks one',
            get: (d, arg) => {
                const rows = d.scoped || [];
                if (!arg) return rows.map((r) => `${r.scope.toLowerCase()} ${r.pct}%`).join(' ');
                const hit = rows.find((r) => r.scope.toLowerCase().startsWith(arg.toLowerCase()));
                return hit ? `${hit.pct}%` : '';
            },
        },

        // --- context --------------------------------------------------------
        ctx: { topic: 'context', doc: 'share of the context window in use', get: (d) => (d.ctx ? `${d.ctx.estimated ? '~' : ''}${d.ctx.pct}%` : '') },
        ctxTokens: { topic: 'context', doc: 'tokens in the context window, e.g. 294k', get: (d) => (d.ctx ? tok(d.ctx.tokens) : '') },
        ctxWindow: { topic: 'context', doc: 'size of the context window, e.g. 1M', get: (d) => (d.ctx ? tok(d.ctx.window) : '') },
        ctxCache: { topic: 'context', doc: 'share of the context served from cache', get: (d) => pct(d.ctx?.cachePct) },
        compact: { topic: 'context', doc: 'auto-compact threshold as a share of the window', get: (d) => pct(d.compactPct) },
        model: { topic: 'context', doc: 'model of the last reply, e.g. opus 5', get: (d) => (d.ctx?.model ? shortModel(d.ctx.model) : '') },
        effort: { topic: 'context', doc: 'reasoning effort of the last reply', get: (d) => d.ctx?.effort || '' },
        advisor: { topic: 'context', doc: 'advisor model, when one is configured', get: (d) => (d.settings?.advisor ? shortModel(d.settings.advisor) : '') },
        // The setting rather than the last reply: a reply that is a tool call
        // carries no thinking block even when the model is thinking on every
        // turn, so reading it off the transcript reported "off" almost always.
        thinking: { topic: 'context', doc: 'the word "thinking" while the client is set to think on every turn', get: (d) => (d.settings?.thinking ? 'thinking' : '') },
        outputStyle: { topic: 'context', doc: 'output style in force', get: (d) => d.settings?.outputStyle || '' },
        branch: { topic: 'context', doc: 'git branch recorded on the last request', get: (d) => d.ctx?.branch || '' },
        version: { topic: 'context', doc: 'client version of this session', get: (d) => d.version?.current || '' },
        update: { topic: 'context', doc: 'a newer client version already unpacked and waiting', get: (d) => d.version?.latest || '' },

        // --- money ----------------------------------------------------------
        cost: { topic: 'money', doc: 'estimated spend of this session', get: (d) => usd(d.stats?.cost, fmtCost) },
        burn: { topic: 'money', doc: 'estimated spend per hour', get: (d) => usd(d.stats?.burn, fmtCost) },
        today: { topic: 'money', doc: "today's spend across every project on the machine", get: (d) => usd(d.todayUsd, fmtCost) },
        requests: { topic: 'money', doc: 'requests made in this session', get: (d) => (d.stats?.messages > 0 ? String(d.stats.messages) : '') },
        duration: { topic: 'money', doc: 'wall-clock length of this session', get: (d) => fmtDuration(d.stats?.durationMs || 0) },
        apiShare: { topic: 'money', doc: 'share of the session spent waiting on the model', get: (d) => pct(d.stats?.apiPct) },
        added: { topic: 'money', doc: 'lines added during this session', get: (d) => (d.stats?.added > 0 ? `+${d.stats.added}` : '') },
        removed: { topic: 'money', doc: 'lines removed during this session', get: (d) => (d.stats?.removed > 0 ? `-${d.stats.removed}` : '') },

        // --- work -----------------------------------------------------------
        peers: { topic: 'work', doc: 'other live sessions in this repository', get: (d) => (d.peers?.total > 0 ? String(d.peers.total) : '') },
        peersBusy: { topic: 'work', doc: 'how many of those are busy right now', get: (d) => (d.peers?.busy > 0 ? String(d.peers.busy) : '') },
        todo: { topic: 'work', doc: "this session's task list as done/total", get: (d) => (d.todo ? `${d.todo.done}/${d.todo.total}` : '') },
        todoActive: { topic: 'work', doc: 'the task currently in progress', get: (d) => d.todo?.active || '' },
        jobs: { topic: 'work', doc: 'background jobs still working, machine-wide', get: (d) => (d.machine?.jobs > 0 ? String(d.machine.jobs) : '') },
        sessions: { topic: 'work', doc: 'live Claude sessions on the whole machine', get: (d) => (d.machine?.sessions > 0 ? String(d.machine.sessions) : '') },
        openTasks: { topic: 'work', doc: 'unfinished task-list items across every session', get: (d) => (d.machine?.openTasks > 0 ? String(d.machine.openTasks) : '') },

        // --- workflow -------------------------------------------------------
        wfName: {
            topic: 'workflow',
            doc: 'name of the workflow running right now',
            get: (d) => newestRun(d)?.name || '',
        },
        wfAgents: {
            topic: 'workflow',
            doc: 'agents of that run as done/total, e.g. 5/14',
            get: (d) => {
                const run = newestRun(d);
                if (!run) return '';
                // Whether an agent counts as finished — it returned, it crashed,
                // or the run was cut from under it — is settled where the run is
                // read, and `totals.done` is that answer for both a live run and
                // a finished one. Counting the state words again here is how the
                // bar and the panel end up disagreeing about the same run.
                const done = run.totals?.done;
                const total = run.totals?.agents || (run.agents || []).length;
                return total > 0 && Number.isFinite(done) ? `${done}/${total}` : '';
            },
        },
        wfElapsed: {
            topic: 'workflow',
            doc: 'how long that run has been going',
            get: (d) => {
                const run = newestRun(d);
                return run && run.startedAt ? fmtDuration(Date.now() - run.startedAt) : '';
            },
        },
        wfCost: {
            topic: 'workflow',
            doc: 'estimated spend of that run so far',
            get: (d) => usd(newestRun(d)?.totals?.cost, fmtCost),
        },
        wfRuns: {
            topic: 'workflow',
            doc: 'how many workflows are running at once, when it is more than one',
            get: (d) => {
                const n = ((d.workflows && d.workflows.active) || []).length;
                return n > 1 ? String(n) : '';
            },
        },
    };
}

// `{name}` or `{name:argument}`; `[...]` marks a group that stands or falls
// with the fields inside it. A backslash escapes any of the four characters.
const TOKEN_RE = /\\(.)|\{([a-zA-Z0-9]+)(?::([^}]*))?\}|\[([^\][]*)\]/g;

/**
 * Render one segment. Returns the text, which topics it touched, and whether
 * anything was actually filled in — a segment whose every field came back empty
 * is hidden rather than shown as punctuation with no numbers in it.
 */
function renderSegment(template, data, registry) {
    const topics = [];
    let filled = 0;
    let placeholders = 0;

    const substitute = (text) => text.replace(TOKEN_RE, (m, escaped, name, arg, group) => {
        if (escaped !== undefined) return escaped;
        if (group !== undefined) {
            const before = filled;
            const seen = placeholders;
            const inner = substitute(group);
            // A group holding no placeholders is literal text and always stays;
            // one whose placeholders all came back empty disappears whole.
            if (placeholders > seen && filled === before) return '';
            return inner;
        }
        const field = registry[name];
        if (!field) return m; // an unknown name is left visible rather than eaten
        placeholders++;
        const value = String(field.get(data, arg) ?? '');
        if (value) {
            filled++;
            if (!topics.includes(field.topic)) topics.push(field.topic);
        }
        return value;
    });

    const text = substitute(template).replace(/\s{2,}/g, ' ').trim();
    return { text, topics, filled, placeholders, visible: text.length > 0 && (placeholders === 0 || filled > 0) };
}

/** The default bar: what the extension showed before any of this was settable. */
const DEFAULT_SEGMENTS = [
    // drift is in the default because it is the one number that says whether the
    // week is going well: 50% spent is fine on day five and alarming on day one.
    // The forecast stays conditional — `{dry}` is silent when running out would
    // happen after the reset, which is to say never.
    '✻ 7d {weekly}[ {drift}] {weeklyBar}[ dry {dry}]',
    '▤ {ctx} {ctxTokens}/{ctxWindow}',
    '[~{cost}][ {burn}/h]',
    '[⧉ {peers}][ ▸ {todo}]',
    // Every part optional, so the whole item disappears while no workflow runs.
    '[$(gear) {wfName}][ {wfAgents}][ {wfElapsed}][ ×{wfRuns}]',
];

// Placeholders alone, groups ignored: this scans for names wherever they sit,
// including inside an optional group, which TOKEN_RE swallows as one token.
const NAME_RE = /\{([a-zA-Z0-9]+)(?::([^}]*))?\}/g;

/**
 * Ready-made bars, offered in the settings tab so nobody has to assemble one
 * from an empty field to find out what the placeholders do. Each is a complete
 * answer to a different question — "am I going to run out", "what is this
 * costing", "what is running on this machine" — rather than a variation in
 * punctuation. Picking one fills the editor; it is saved only when the user
 * says so.
 */
const PRESETS = [
    {
        id: 'default',
        name: 'Default',
        about: 'What the extension ships with: limits, context, spend, work, workflows.',
        segments: DEFAULT_SEGMENTS,
    },
    {
        id: 'default-forecast',
        name: 'Default + forecast',
        // Plain text, not markdown: the Settings tab prints `about` through
        // esc(), so a backtick here is drawn as a backtick.
        about: 'The default bar with the forecast date always on it. {dry} warns only when running out comes before the reset; {dryAt} names the day either way, so the date is there even when you are not going to reach it.',
        // Built from the default rather than copied, so the four lines below the
        // first one cannot drift away from it.
        segments: ['✻ 7d {weekly}[ {drift}] {weeklyBar}[ dry {dryAt}]', ...DEFAULT_SEGMENTS.slice(1)],
    },
    {
        id: 'minimal',
        name: 'Minimal',
        about: 'One item, three numbers. Everything else lives in the tooltip.',
        segments: ['✻{weekly} ▤{ctx} ~{cost}'],
    },
    {
        id: 'pace',
        name: 'Pace watcher',
        about: 'Built around the weekly window: how far ahead of an even burn you are, and when it runs out.',
        segments: [
            '✻ 7d {weekly} {weeklyBar}[ {drift}]',
            '[dry {dry}][ · resets {resetLeft}]',
            '[5h {session5h}]',
        ],
    },
    {
        id: 'limits',
        name: 'Limits, in full',
        about: 'Every window at once, and the forecast date whether or not you would reach it — {dryAt} names the day even when the reset arrives first.',
        segments: [
            '✻ 7d {weekly}[ {drift}] {weeklyBar}',
            '[dry {dryAt}][ · resets {resetLeft}]',
            '[5h {session5h}][ · {session5hLeft} left]',
            '[{scoped}]',
        ],
    },
    {
        id: 'money',
        name: 'Spend',
        about: 'This session against the whole day, with the work behind the number.',
        segments: [
            '[~{cost}][ {burn}/h]',
            '[today ~{today}]',
            '[{requests} req][ · {apiShare} waiting]',
        ],
    },
    {
        id: 'session',
        name: 'Session',
        about: 'What this window is running: model, effort, how full the context is and when it compacts.',
        segments: [
            '[{model}][ {effort}][ · {thinking}]',
            '▤ {ctx} {ctxTokens}/{ctxWindow}[ · compact {compact}]',
            '[cache {ctxCache}][ · {branch}]',
        ],
    },
    {
        id: 'machine',
        name: 'Whole machine',
        about: 'Not this window but every session on the machine, and what they left unfinished.',
        segments: [
            '[$(server) {sessions} live][ · {jobs} running]',
            '[$(checklist) {openTasks} open]',
            '[today ~{today}]',
        ],
    },
    {
        id: 'workflows',
        name: 'Workflows',
        about: 'For a machine that runs fan-outs: the live run, its agents, and what it has cost so far.',
        segments: [
            '[$(gear) {wfName}][ {wfAgents}][ {wfElapsed}]',
            '[~{wfCost}][ · ×{wfRuns}]',
            '✻ 7d {weekly}',
        ],
    },
    {
        id: 'works',
        name: 'The works',
        about: 'Every number this extension has, in ten items: both limit windows and the forecast, the context and the model driving it, the spend, the work behind it, the machine, and any running workflow. Wide — VS Code drops the rightmost items when the bar runs out of room.',
        segments: [
            '✻ 7d {weekly}[ {drift}] {weeklyBar}[ · dry {dryAt}]',
            '[5h {session5h}][ · {session5hLeft} left][ · resets {resetLeft}]',
            '[{scoped}]',
            '▤ {ctx} {ctxTokens}/{ctxWindow}[ · cache {ctxCache}][ · compact {compact}]',
            '[{model}][ {effort}][ · {thinking}][ · advisor {advisor}]',
            '[~{cost}][ {burn}/h][ · today ~{today}]',
            '[{requests} req][ · {duration}][ · {apiShare} waiting][ · {added}/{removed}]',
            '[⧉ {peers}][ ▸ {todo}]',
            '[$(server) {sessions}][ · {jobs} running][ · {openTasks} open]',
            '[$(gear) {wfName}][ {wfAgents}][ {wfElapsed}][ · ~{wfCost}][ · ×{wfRuns}]',
        ],
    },
    {
        id: 'dense',
        name: 'Everything, one line',
        about: 'One item carrying every headline number. Long, but nothing is hidden.',
        segments: [
            '✻{weekly}[ {drift}] ▤{ctx}[ ~{cost}][ ⧉{peers}][ ▸{todo}][ $(gear){wfAgents}]',
        ],
    },
];

/** Field names a set of templates actually uses — the extension skips
 *  collecting what nothing asks for. */
function usedFields(templates, registry) {
    const used = new Set();
    for (const tpl of templates || []) {
        for (const m of String(tpl).matchAll(NAME_RE)) {
            if (registry[m[1]]) used.add(m[1]);
        }
    }
    return used;
}

module.exports = { TOPICS, DEFAULT_SEGMENTS, PRESETS, fields, renderSegment, usedFields, TOKEN_RE, NAME_RE };
