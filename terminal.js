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

module.exports = { clientData, paint, renderLines, TONES, RESET };
