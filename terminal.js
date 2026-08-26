// The terminal half of the same status line.
//
// Claude Code runs a command and prints what it writes to stdout, handing it a
// JSON object on stdin. That object already carries what the extension has to
// dig out of `~/.claude` — the context window, both rate limits, the session's
// cost — so this module maps it onto the shape `segments.js` reads and lets the
// field registry, the templates and the formulas do the rest. One grammar, one
// set of thresholds, two renderers.
//
// No dependency on vscode, and none on the network either: the limits arrive in
// the payload, so unlike `usage.js` nothing here reads a credential.

const u = require('./usage');
const seg = require('./segments');

// The client multiplies a fraction by 100 before serialising it, and IEEE754
// turns 0.29 into 28.999999999999996 — a bare floor then reports 28%. The
// epsilon removes that noise without rounding a real 28.9 up. Three values were
// caught this way in statusline.sh (0.29, 0.57, 0.58); the fix is ported rather
// than rediscovered.
const pct = (n) => (Number.isFinite(n) ? Math.floor(n + 1e-9) : null);

// A limit window as `usage.js` describes one, so `pace()` and `bar()` take it
// unchanged. `scope` stays null: the payload reports the two account-wide
// windows and says nothing about per-model ones.
function limit(row) {
    if (!row || !Number.isFinite(row.used_percentage)) return null;
    return { pct: pct(row.used_percentage), reset: row.resets_at || 0, scope: null };
}

// Under a minute an hourly rate is arithmetic, not information: forty cents in
// thirty seconds extrapolates to $48/h. The floor is the one statusline.sh uses.
const BURN_MIN_MS = 60000;

function money(cost) {
    if (!cost) return null;
    const ms = cost.total_duration_ms || 0;
    const apiMs = cost.total_api_duration_ms || 0;
    return {
        cost: cost.total_cost_usd || 0,
        burn: ms > BURN_MIN_MS ? (cost.total_cost_usd || 0) / (ms / 3600000) : null,
        durationMs: ms,
        apiPct: ms > 0 ? Math.floor((apiMs / ms) * 100) : -1,
        added: cost.total_lines_added || 0,
        removed: cost.total_lines_removed || 0,
    };
}

// What the extension's `contextOf` builds from the last transcript record, built
// instead from the client's own accounting. `estimated` is false because the
// window size is reported rather than looked up: `windowFor` guesses only when
// it meets a model it does not know, and here nobody has to guess.
function context(input) {
    const cw = input.context_window;
    if (!cw || !Number.isFinite(cw.total_input_tokens)) return null;
    const tokens = cw.total_input_tokens;
    const window = cw.context_window_size || 200000;
    const cacheRead = cw.current_usage?.cache_read_input_tokens || 0;
    return {
        tokens,
        window,
        estimated: false,
        // floor, not round, matching `contextOf`: rounding up reads as a full
        // window at ninety-nine and a half.
        pct: Math.min(100, Math.floor((tokens / window) * 100)),
        // A share of what is in the window, not of the window. -1 rather than 0
        // on an empty one, because `pct()` in segments.js reads -1 as "nothing
        // to say" and 0 as a number worth printing.
        cachePct: tokens > 0 ? Math.floor((cacheRead / tokens) * 100) : -1,
        model: input.model?.id || '',
        effort: input.effort?.level || '',
        advisor: '',
        // The client reports the worktree it is in, which is the branch name for
        // an ordinary checkout — the same string the extension reads off
        // `gitBranch` in a transcript record.
        branch: input.workspace?.git_worktree || '',
        at: 0,
    };
}

/**
 * The client's payload as the data object every field in `segments.js` reads.
 *
 * Everything here is derived from the argument alone — no file is opened and no
 * request is made — so a status line built from it costs one process start.
 * Fields the payload cannot answer (peers, the task list, workflow runs) are
 * absent rather than empty, and the fields that would print them stay silent.
 */
function clientData(input = {}, now = Math.floor(Date.now() / 1000)) {
    const rl = input.rate_limits || {};
    const weekly = limit(rl.seven_day);
    const session = limit(rl.five_hour);
    const pace = weekly ? u.pace(weekly, now) : null;
    return {
        now,
        ctx: context(input),
        weekly,
        session,
        scoped: [],
        pace,
        // Before the window has settled, comparing spend against itself draws
        // the fill and no plan zone — the same guard `collectSlow` applies, for
        // the same reason: a fresh week is not "ahead of schedule".
        bar: weekly && pace ? u.bar(weekly.pct, pace.settled ? pace.plan : weekly.pct) : '',
        stats: money(input.cost),
        settings: {
            thinking: input.thinking?.enabled === true,
            outputStyle: input.output_style?.name || '',
            advisor: '',
        },
        version: { current: input.version || '' },
        sessionId: input.session_id || '',
        transcriptPath: input.transcript_path || '',
        projectDir: input.workspace?.project_dir || input.cwd || '',
    };
}

// The two tones as ANSI, matching the plain branch of statusline.sh's palette so
// the line does not change colour on the day it changes implementation. They are
// written as escapes rather than as literal control bytes: a raw ESC in a source
// file survives an editor but not every diff, grep or patch it passes through.
const TONES = { alarm: '\u001b[31m', warn: '\u001b[33m' };
const RESET = '\u001b[0m';

// `$(gear)` is a codicon: the status bar draws it as an icon, a terminal prints
// it as seven characters of source. The default templates carry one, and so does
// any template written for the bar and pointed at this renderer, so they are
// removed here rather than forbidden in the grammar. A lone `$` is left alone —
// it is a dollar sign, and this line is often about money.
const ICON_RE = /\$\([a-zA-Z0-9~-]+\)/g;
const stripIcons = (text) => text.replace(ICON_RE, '').replace(/\s{2,}/g, ' ').trim();

/**
 * Wrap text in the colour a tone earns. No tone is no escape at all, rather than
 * a default colour: an unremarkable line should be drawn in whatever foreground
 * the rest of the prompt uses.
 */
function paint(text, tone, colour = true) {
    if (!colour || !tone || !TONES[tone]) return text;
    // The reset is not optional. Without it the prompt drawn underneath inherits
    // the colour and the terminal stays red until something else clears it.
    return `${TONES[tone]}${text}${RESET}`;
}

/**
 * The templates as lines to print, one per segment.
 *
 * A segment whose placeholders all came back empty is dropped rather than
 * printed blank: in the status bar an empty item hides itself, but in a terminal
 * an empty line still takes a row and pushes the prompt up.
 */
function renderLines(templates, d, registry, opts = {}) {
    const colour = opts.colour !== false;
    const out = [];
    for (const template of templates) {
        const rendered = seg.renderSegment(template, d, registry);
        const text = stripIcons(rendered.text);
        // Two different kinds of empty: a segment whose placeholders all came
        // back blank, and one that was nothing but an icon. Both would print a
        // bare row.
        if (!rendered.visible || !text) continue;
        out.push(paint(text, seg.worstTone(rendered.topics, d), colour));
    }
    return out;
}

// --- the same state, read from disk --------------------------------------
//
// The status line never opens a file: the client hands it everything. The
// dashboard has no such payload, so it reads what the extension's slow tick
// reads — the limit cache shared with `statusline.sh`, and the transcript of
// whichever session asked.

const s = require('./session');

/**
 * The transcript of a session, wherever it was started.
 *
 * One directory listing per project rather than a walk: the file is named by
 * the session id, so its presence is a `stat`, not a search of the contents.
 */
function findTranscript(sessionId, opts = {}) {
    if (!sessionId) return null;
    const projects = opts.projects || s.PROJECTS;
    let slugs;
    try { slugs = fs.readdirSync(projects); } catch { return null; }
    for (const slug of slugs) {
        const file = path.join(projects, slug, `${sessionId}.jsonl`);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

/**
 * What `collectSlow` collects, without vscode and without a session registry.
 *
 * `sessionId` is the session to describe — `$CLAUDE_CODE_SESSION_ID` names the
 * one this command was launched from. Every read degrades to null on its own,
 * because a transcript format that belongs to another program is a format that
 * can change without notice.
 */
function collectFromDisk(opts = {}) {
    const now = opts.now || Math.floor(Date.now() / 1000);
    const payload = u.readCache(now);
    const limits = payload ? u.limitsOf(payload) : null;
    const weekly = limits && limits.weekly ? limits.weekly : null;
    const pace = weekly ? u.pace(weekly, now) : null;

    let ctx = null;
    let stats = null;
    if (opts.sessionId) {
        try {
            // The directory the session was started in decides the slug its
            // transcript lives under, and the dashboard is run from wherever
            // the user happens to be. Try the current directory first — it is
            // one `stat` — and fall back to a search by id, which is unique
            // across every project.
            const guess = opts.cwd ? s.transcriptPath(opts.cwd, opts.sessionId) : null;
            const file = (guess && fs.existsSync(guess)) ? guess : findTranscript(opts.sessionId);
            if (!file) throw new Error('no transcript');
            ctx = s.contextOf(s.readTail(file));
            // A whole-transcript pass. The extension keeps this off its fast
            // tick; a command someone ran can afford it.
            stats = s.sessionStats(file);
        } catch { /* a dash rather than a wrong number */ }
    }

    let todayUsd = null;
    // A walk over every project directory on the machine, so it is opt-out.
    if (opts.today !== false) {
        try { todayUsd = s.costToday().usd; } catch { /* degrade to no figure */ }
    }

    return {
        now,
        limits,
        weekly,
        session: limits && limits.session ? limits.session : null,
        scoped: limits ? limits.scoped : [],
        pace,
        bar: weekly && pace ? u.bar(weekly.pct, pace.settled ? pace.plan : weekly.pct) : '',
        ctx,
        stats,
        todayUsd,
        settings: { thinking: false, outputStyle: '', advisor: '' },
        version: { current: '' },
    };
}

// --- linking this renderer to the client ---------------------------------
//
// The extension copies the six files this entry needs into its own
// globalStorage and points the client's `statusLine` at the copy. globalStorage
// is ours to write and its path carries no version number, so the command
// written here survives an update of the extension.

const fs = require('node:fs');
const path = require('node:path');

// Where the plugin puts this repository once `/plugin install` has run. The
// last segment is the plugin's version, so the path is different after every
// update — which is why the command below resolves it at run time instead of
// having it written into the settings file once.
const PLUGIN_CACHE = '"$HOME"/.claude/plugins/cache';
const PLUGIN_REL = 'dashnlines/dashnlines/*/bin/statusline.js';
const pluginGlob = (root) => `${root || PLUGIN_CACHE}/${PLUGIN_REL}`;

// The script inside a tree laid out like this repository, for a checkout run
// straight from disk. The entry requires its neighbours as `../terminal`, so
// what matters is that `bin/` sits beside them.
const scriptIn = (dir) => path.join(dir, 'bin', 'statusline.js');

const BACKUP_SUFFIX = '.claude-dashboard.bak';

// Single quotes, not double. A path is interpolated into a shell command, and
// inside double quotes `$(...)`, backticks and `$VAR` all still execute — a
// directory named `x$(touch /tmp/w)y` runs that command every time the status
// line refreshes. Inside single quotes nothing expands; an embedded quote is
// closed, escaped and reopened, which is the only sequence sh accepts there.
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// The one deliberate expansion, written as a literal rather than passed through
// `q`: `$HOME` has to expand, because this same command replicates to machines
// whose home directory is not this one. Nothing user-supplied reaches it.
const DEFAULT_FALLBACK = '"$HOME/.claude/statusline.sh"';

/**
 * The shell command the client is told to run.
 *
 * `if` rather than `A && B || C`: stdin can be read once, and a copy that exits
 * non-zero — half-updated, or written by a newer extension against an older
 * node — would already have consumed it, leaving the fallback to render an
 * empty payload. Deciding first means exactly one program ever reads the
 * stream. `command -v node` covers a machine whose non-interactive PATH has no
 * node.
 */
function commandFor(opts = {}) {
    const fallback = opts.fallback ? q(opts.fallback) : DEFAULT_FALLBACK;
    // A checkout given explicitly wins; otherwise the installed plugin, whose
    // version is resolved on every run. `sort -V` because versions are numbers
    // per component: lexically, 6.10.0 sorts below 6.3.0.
    const find = opts.dir
        ? `S=${q(scriptIn(opts.dir))}`
        : `S=$(ls -d ${pluginGlob(opts.pluginRoot && q(opts.pluginRoot))} 2>/dev/null | sort -V | tail -1)`;
    return `${find}; if [ -f "$S" ] && command -v node >/dev/null 2>&1; then exec node "$S"; `
        + `else exec ${fallback}; fi`;
}

// What marks a command as written by us, in either form.
const MARKERS = ['plugins/cache/dashnlines/dashnlines', 'bin/statusline.js'];

/**
 * Whose status line is configured: ours, someone else's, or none.
 *
 * Matched on the script path rather than on the whole command, so a user who
 * edited the fallback or the padding is still recognised as running ours.
 */
function statusLineState(settings) {
    const command = settings && settings.statusLine && settings.statusLine.command;
    if (!command) return 'none';
    return MARKERS.some((m) => command.includes(m)) ? 'ours' : 'other';
}

// The client writes this file too — `/model` lands in it — so it is read inside
// the same call that writes it rather than at render time, and replaced by
// rename so a reader never sees half a file.
function editSettings(file, edit) {
    let settings = {};
    let raw = null;
    try {
        raw = fs.readFileSync(file, 'utf8');
        settings = JSON.parse(raw);
    } catch { /* an unreadable or absent file is an empty one to write over */ }

    const result = edit(settings);
    if (result === false) return null;

    // The client keeps this file owner-only and its `env` block routinely holds
    // tokens. `writeFileSync` with no mode creates 0644, so both the copy and
    // the replacement would hand the file to every account on the machine —
    // quietly, since the name and the contents are unchanged. Whatever the file
    // is now, the copy and the replacement are that or tighter.
    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch { /* a new file starts owner-only */ }

    // Kept once, before the first rewrite, the way the alias writer keeps one
    // beside `.zshrc`.
    const backup = `${file}${BACKUP_SUFFIX}`;
    if (raw !== null && !fs.existsSync(backup)) {
        try { fs.writeFileSync(backup, raw, { mode }); } catch { /* a backup is a courtesy, not a gate */ }
    }

    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    // `mode` on writeFileSync is masked by the umask; chmod is not, and the
    // rename carries the mode with it.
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
    return result;
}

/**
 * Point the client at the copied script. Returns the `statusLine` block that was
 * there before, or null when there was none — the caller keeps it so switching
 * the toggle off can put it back.
 */
function linkStatusLine(file, opts = {}) {
    let previous = null;
    editSettings(file, (settings) => {
        previous = settings.statusLine ? { ...settings.statusLine } : null;
        const next = { type: 'command', command: commandFor(opts) };
        // Padding and refresh are the user's, not the toggle's: silently
        // changing the cadence is not what switching renderer means.
        if (previous && Number.isFinite(previous.padding)) next.padding = previous.padding;
        if (previous && Number.isFinite(previous.refreshInterval)) next.refreshInterval = previous.refreshInterval;
        settings.statusLine = next;
        return true;
    });
    return previous;
}

/**
 * Put back whatever the toggle replaced — but only while the key is still ours.
 * A command edited by hand after the toggle went on belongs to the user, and
 * restoring over it would throw their edit away.
 */
function unlinkStatusLine(file, previous) {
    return editSettings(file, (settings) => {
        if (statusLineState(settings) !== 'ours') return false;
        if (previous) settings.statusLine = previous;
        else delete settings.statusLine;
        return true;
    });
}

module.exports = {
    clientData, paint, renderLines, TONES, RESET,
    commandFor, statusLineState, linkStatusLine, unlinkStatusLine, scriptIn, BACKUP_SUFFIX, pluginGlob, PLUGIN_REL,
    collectFromDisk, findTranscript,
};
