// What the status bar knows right now, as data rather than as markdown.
//
// The same four answers are shown twice: as the tooltip behind a status-bar
// item, and as the Now tab of the dashboard. Written twice they would drift —
// the tooltip would learn a number the page never got, or the two would explain
// the same threshold in different words. So the wording lives here once and the
// two renderers walk the same structure.
//
// A section is `{ id, title, blocks }`, and a block is one of:
//   { kind: 'table', head?, rows }   rows are [label, value] or a head-wide array
//   { kind: 'meters', rows }         [{ label, value, pct, note }] — a share of
//                                    something, drawn as a bar or written as one
//   { kind: 'subtitle', text }       a heading inside the section
//   { kind: 'note', text, tone }     a sentence under the rows
// `tone` is meaning, not appearance: the tooltip turns it into a codicon and the
// page into a colour, and neither has to know what the other picked.
//
// No dependency on vscode: formatting helpers are passed in, the way the
// segment registry takes them.

const { ratesFor } = require('./pricing');

/**
 * @param {object} d    the collector's data — the same object the segments read
 * @param {object} h    formatting helpers: fmtCost, fmtLeft, fmtAbs, fmtWhen,
 *                      fmtDuration, tok, shortModel
 * @param {object} env  what only the caller knows: whether the limit cache is
 *                      stale, and when it was last written
 */
function statusSections(d = {}, h = {}, env = {}) {
    return [limits(d, h, env), context(d, h), money(d, h), work(d, h)].filter(Boolean);
}

function limits(d, h, env) {
    const lim = d.limits;
    if (!lim || !d.weekly) return null;
    const now = d.now;
    const blocks = [];

    // A window is a share of something, and a share wants a bar beside it —
    // written with blocks in a tooltip, drawn as a meter on a page. The number
    // travels as a number so each renderer can do that its own way.
    const row = (label, pct, reset) => ({
        label,
        value: `${pct}%`,
        pct,
        note: reset ? `${h.fmtLeft(reset, now)} → ${h.fmtAbs(reset)}` : '',
    });
    const rows = [];
    if (lim.session) rows.push(row('5h', lim.session.pct, lim.session.reset));
    if (lim.weekly) rows.push(row('7d', lim.weekly.pct, lim.weekly.reset));
    // Per-model windows almost always reset together with the overall weekly
    // one; repeating that date on every row would turn the table into noise.
    for (const scoped of lim.scoped || []) {
        const own = Math.abs(scoped.reset - (lim.weekly ? lim.weekly.reset : 0)) > 60 ? scoped.reset : 0;
        rows.push(row(scoped.scope.toLowerCase(), scoped.pct, own));
    }
    blocks.push({ kind: 'meters', rows });

    const pc = d.pace;
    if (pc && lim.weekly) {
        // Pace as a sentence: spend against plan is a comparison, and a
        // comparison squeezed into a row label is what was hard to read.
        const diff = lim.weekly.pct - pc.plan;
        // "behind", not "under": the track header says the same thing in the
        // same words, and a verdict assembled in two files may not drift.
        const verdict = diff > 0 ? `${diff}% ahead of plan` : diff < 0 ? `${-diff}% behind plan` : 'exactly on plan';
        blocks.push({
            kind: 'note',
            tone: 'plain',
            label: 'Pace',
            text: `${lim.weekly.pct}% spent, ${pc.plan}% of the window elapsed: ${verdict}`,
        });

        // The forecast is stated even when it lands past the reset. "You will
        // not run out" is worth far more with the date that would have been.
        if (pc.dryAt && pc.elapsed >= 1800 && lim.weekly.pct >= 2) {
            const when = `${h.fmtWhen(pc.dryAt)}, in ${h.fmtLeft(pc.dryAt, now)}`;
            // The same two lengths the week track draws, said in words: how long
            // the quota lasts, then how long the week runs on without it. Both
            // are cut out of the time left, so they add up to the reset.
            const left = Math.max(0, lim.weekly.reset - now);
            const alive = Math.min(left, Math.max(0, pc.dryAt - now));
            const without = h.fmtLeft(now + Math.max(0, left - alive), now);
            if (pc.beforeReset && alive < 60) {
                blocks.push({ kind: 'note', tone: 'alarm', label: 'Forecast', text: `out of quota — ${without} until the window resets` });
            } else if (pc.beforeReset) {
                blocks.push({ kind: 'note', tone: 'alarm', label: 'Forecast', text: `100% around ${when}, then ${without} without quota before the window resets` });
            } else {
                blocks.push({ kind: 'note', tone: 'safe', label: 'Forecast', text: `100% would be ${when}, which is after the reset: you do not get there` });
            }
        }
    }

    // Credits are the one figure here that is money rather than an estimate, so
    // they are stated without a tilde and said plainly when they have run out.
    const cr = lim.credits;
    if (cr) {
        // In the currency the endpoint stated, not in the dollars the rest of
        // this file assumes: everything else is priced from published
        // per-million rates, which are dollars by definition, and this is the one
        // line that is somebody's actual bill. Intl carries every symbol and the
        // right number of decimals; an unknown code falls back to printing itself
        // rather than borrowing a `$`.
        const money = (amount) => {
            try {
                return new Intl.NumberFormat('en-US', {
                    style: 'currency', currency: cr.currency || 'USD', currencyDisplay: 'narrowSymbol',
                }).format(amount);
            } catch { return `${amount.toFixed(2)} ${cr.currency}`; }
        };
        blocks.push({
            kind: 'note',
            tone: cr.enabled ? 'plain' : 'warn',
            label: 'Credits',
            text: cr.enabled
                ? `${money(cr.used)} spent past the plan${cr.limit > 0 ? ` of ${money(cr.limit)}, ${cr.pct}%` : ''} — billed, not estimated`
                : `${money(cr.used)} spent past the plan, and credits are off${cr.reason === 'out_of_credits' ? ': none left' : ''} — work stops at the limit rather than continuing on credit`,
        });
    }

    if (env.stale) blocks.push({ kind: 'note', tone: 'warn', text: 'showing cached data — refresh failed' });
    if (env.updatedAt) blocks.push({ kind: 'note', tone: 'muted', text: `updated ${h.fmtAbs(env.updatedAt)}` });
    return { id: 'limits', title: 'Limits', blocks };
}

function context(d, h) {
    const ctx = d.ctx;
    if (!ctx) return null;
    const settings = d.settings || {};
    const version = d.version || {};
    const blocks = [];

    // The terminal packs model, effort, thinking and advisor into one line
    // because it has one line. Here each is a labelled row: the values are
    // unrelated to each other, and reading them as a run of dot-separated words
    // means parsing the separator rather than the fact.
    const advisor = ctx.advisor || settings.advisor;
    const model = [];
    if (ctx.effort) model.push(['effort', ctx.effort]);
    // The setting, not the last reply: an answer that is a tool call carries no
    // thinking block even while the model thinks on every turn. Summaries being
    // hidden is worth saying — the reasoning still happens and simply never
    // appears, here or anywhere else.
    model.push(['thinking', settings.thinking
        ? (settings.thinkingSummaries ? 'on' : 'on · summaries hidden')
        : 'off']);
    if (advisor) model.push(['advisor', h.shortModel(advisor)]);
    if (settings.outputStyle) model.push(['output style', settings.outputStyle]);
    blocks.push({ kind: 'table', rows: model });

    blocks.push({ kind: 'subtitle', text: 'Context' }, {
        kind: 'meters',
        rows: [{
            label: 'window',
            value: `${ctx.estimated ? '~' : ''}${ctx.pct}%`,
            pct: ctx.pct,
            note: `${h.tok(ctx.tokens)} / ${h.tok(ctx.window)}`,
        }],
    });
    const fill = [];
    if (ctx.estimated) fill.push(['note', 'window size unknown for this model']);
    if (ctx.cachePct >= 0) fill.push(['from cache', `${ctx.cachePct}%`]);
    if (d.compactPct > 0) {
        const left = d.compactPct - ctx.pct;
        fill.push(['auto-compact', left > 0 ? `at ${d.compactPct}% — ${left}% away` : `at ${d.compactPct}% — due`]);
    }
    if (fill.length) blocks.push({ kind: 'table', rows: fill });

    const envRows = [];
    if (ctx.branch) envRows.push(['branch', ctx.branch]);
    if (version.current) envRows.push(['client', `v${version.current}`]);
    if (envRows.length) blocks.push({ kind: 'subtitle', text: 'Environment' }, { kind: 'table', rows: envRows });

    if (version.latest) {
        blocks.push({ kind: 'note', tone: 'update', text: `${version.latest} is unpacked and starts with the next launch` });
    }
    return { id: 'context', title: h.shortModel(ctx.model) || 'Session', blocks };
}

function money(d, h) {
    const stats = d.stats;
    if (!stats) return null;
    const blocks = [];

    const spend = [['today', `~${h.fmtCost(d.todayUsd || 0)}`]];
    if (stats.burn > 0) spend.push(['burn rate', `~${h.fmtCost(stats.burn)}/h`]);
    blocks.push({ kind: 'table', rows: spend });

    const rows = [];
    if (stats.durationMs > 0) rows.push(['duration', h.fmtDuration(stats.durationMs)]);
    rows.push(['requests', String(stats.messages)]);
    if (stats.apiPct >= 0) rows.push(['waiting on model', `~${stats.apiPct}% of that time`]);
    if (stats.added || stats.removed) rows.push(['edits', `+${stats.added} / −${stats.removed} lines`]);
    blocks.push({ kind: 'subtitle', text: 'This session' }, { kind: 'table', rows });

    // An unpriced model is charged at Opus rates, and a figure that says so is
    // worth more than one that quietly rounds up.
    const known = d.ctx ? ratesFor(d.ctx.model).known : true;
    blocks.push({
        kind: 'note',
        tone: 'muted',
        text: known
            ? 'estimated from public rates — not a bill'
            : 'estimated at Opus rates: this model has no published rate',
    });
    return { id: 'money', title: `~${h.fmtCost(stats.cost)} this session`, blocks };
}

function work(d) {
    const { peers, todo } = d;
    if (!todo && !(peers && peers.total > 0)) return null;
    const blocks = [];
    // How far along the list is, as a share — the title counts the tasks, so
    // this says the thing counting them cannot: how much of it is behind you.
    if (todo && todo.total > 0) {
        blocks.push({
            kind: 'meters',
            rows: [{
                label: 'done',
                value: `${Math.round((todo.done / todo.total) * 100)}%`,
                pct: Math.round((todo.done / todo.total) * 100),
                note: '',
            }],
        });
    }
    if (todo && todo.active) blocks.push({ kind: 'note', tone: 'active', text: todo.active });
    if (peers && peers.total > 0) {
        const rows = [['sessions', String(peers.total)]];
        if (peers.busy > 0) rows.push(['busy right now', String(peers.busy)]);
        // Without a task list the neighbours are what this section is, and the
        // title already says so — a subtitle here would print it twice.
        if (todo) blocks.push({ kind: 'subtitle', text: 'Other sessions here' });
        blocks.push({ kind: 'table', rows });
    }
    return {
        id: 'work',
        title: todo ? `Tasks ${todo.done}/${todo.total}` : 'Other sessions here',
        blocks,
    };
}

const WEEK_S = 604800;

/**
 * The same state as numbers rather than sentences, for the parts of a page that
 * draw rather than read: a meter needs a fraction, not "52%".
 *
 * `dryAt` is returned as a position in the window — 0 at its start, 1 at the
 * reset, past 1 when the forecast lands after it. That single number is what
 * lets a track show spend, now and the forecast on one line, which is the thing
 * neither the bar nor the tooltip can say.
 */
function statusMetrics(d = {}) {
    const out = {};
    const w = d.weekly;
    if (w && w.reset > 0) {
        const start = w.reset - WEEK_S;
        const pos = (ts) => (ts ? (ts - start) / WEEK_S : null);
        out.weekly = {
            pct: w.pct,
            plan: d.pace ? d.pace.plan : null,
            now: Math.max(0, Math.min(1, (d.now - start) / WEEK_S)),
            dry: d.pace ? pos(d.pace.dryAt) : null,
            beforeReset: Boolean(d.pace && d.pace.beforeReset),
            resetIn: Math.max(0, w.reset - d.now),
            // The window as dates rather than as fractions: the bar writes both
            // of its ends and the forecast in full, and a position cannot be
            // turned back into a timestamp without the origin.
            opened: start,
            reset: w.reset,
            at: d.now,
            dryAt: d.pace ? d.pace.dryAt : null,
            // Filled by the caller from the marks file: the moment this window
            // ran out, which no formula here can recover — see history.js.
            ranOut: null,
            ranOutPlan: null,
        };
    }
    if (d.session) out.session5h = { pct: d.session.pct, resetIn: Math.max(0, d.session.reset - d.now) };
    if (d.ctx) {
        out.context = {
            pct: d.ctx.pct, tokens: d.ctx.tokens, window: d.ctx.window,
            estimated: d.ctx.estimated, compactAt: d.compactPct > 0 ? d.compactPct : null,
        };
    }
    if (d.stats) out.spend = { cost: d.stats.cost, burn: d.stats.burn, today: d.todayUsd || 0 };
    return out;
}

module.exports = { statusSections, statusMetrics, limits, context, money, work };
