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
//   { kind: 'pills', items }         the state of whatever the section is about,
//                                    [{ text, value?, tone? }] — drawn beside the
//                                    section's own heading, never as rows
//   { kind: 'gauge', headline,       the one figure a section exists for:
//           value, sub, pct, plan,   `headline` is it, `value` and `sub` are the
//           chips }                  two lines beside it, `pct` draws a track
//                                    (null for a figure that is not a share),
//                                    `plan` a notch on it, `chips` the dim facts
//                                    under it
//   { kind: 'parts', caption,        the components of that gauge, one line each:
//           figure?, rows }          [{ label, note, figure, value, pct }] —
//                                    `figure` is the size, `value` the share
//   { kind: 'band', facts, chip? }   the footer: short facts, and at most one
//                                    chip for the thing that wants an action
//   { kind: 'subtitle', text }       a heading inside the section
//   { kind: 'note', text, tone }     a sentence under the rows
//
// `meters` and `parts` are both shares and are still two kinds of fact: meters
// are unrelated windows that happen to be drawn alike, parts are pieces of one
// gauge above them. Drawn identically the total reads as one more component of
// itself, which is what the context block looked like before.
//
// Every section is the same five moves in the same order — heading and pills,
// one gauge, what it is made of, the facts, a footer — so three panels that used
// to solve each of those their own way now read as one page.
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
    // Collected as they are found and hoisted to the front at the end: they are
    // drawn beside the heading, and the heading is above everything here.
    const pills = [];

    // A window is a share of something, and a share wants a bar beside it —
    // written with blocks in a tooltip, drawn as a meter on a page. The number
    // travels as a number so each renderer can do that its own way.
    const row = (label, pct, reset) => ({
        label,
        value: `${pct}%`,
        pct,
        note: reset ? `${h.fmtLeft(reset, now)} → ${h.fmtAbs(reset)}` : '',
    });
    const pc = d.pace;

    // The week is the window that actually stops the work, so it is the gauge
    // and the others are rows under it. Drawn as three equal meters — which is
    // what this was — the one that matters is found by reading all three.
    const rows = [];
    if (lim.weekly) {
        blocks.push({
            kind: 'gauge',
            headline: `${lim.weekly.pct}%`,
            value: '7 days',
            sub: `${h.fmtLeft(lim.weekly.reset, now)} left · resets ${h.fmtAbs(lim.weekly.reset)}`,
            pct: lim.weekly.pct,
            // The plan is where an evenly spent week would be by now, and it is
            // the only mark on this track that is not the spend itself.
            plan: pc && pc.settled ? pc.plan : null,
            chips: [],
        });
    } else if (lim.session) {
        rows.push(row('5h', lim.session.pct, lim.session.reset));
    }
    if (lim.weekly && lim.session) rows.push(row('5h', lim.session.pct, lim.session.reset));
    // Per-model windows almost always reset together with the overall weekly
    // one; repeating that date on every row would turn the table into noise.
    for (const scoped of lim.scoped || []) {
        const own = Math.abs(scoped.reset - (lim.weekly ? lim.weekly.reset : 0)) > 60 ? scoped.reset : 0;
        rows.push(row(scoped.scope.toLowerCase(), scoped.pct, own));
    }
    if (rows.length) blocks.push({ kind: 'meters', rows });
    // `settled` gates the comparison the same way it gates the bar and the
    // {drift} field: in the first half hour the plan is 0% and the sentence
    // below would open a fresh week with "1% ahead of plan".
    if (pc && pc.settled && lim.weekly) {
        // Pace as a sentence: spend against plan is a comparison, and a
        // comparison squeezed into a row label is what was hard to read.
        // Against `planW`, not `plan`: the clock says how much of the window is
        // gone, the profile says how much of the WORK is gone, and only the
        // second one can be overspent. On a night-shaped week the two disagree
        // by enough to flip the verdict and its colour.
        const planned = Number.isFinite(pc.planW) ? pc.planW : pc.plan;
        const diff = lim.weekly.pct - planned;
        // "behind", not "under": the track header says the same thing in the
        // same words, and a verdict assembled in two files may not drift.
        // The same two words the week track uses, and the same colours: spending
        // faster than the window elapses is `over` and is a warning, spending
        // slower is `under` and is not. Written as "ahead of plan" it read as
        // success and was drawn green — for the state that runs the quota out
        // early. Two panels on one screen said the opposite of each other.
        const verdict = diff > 0 ? `${diff}% over` : diff < 0 ? `${-diff}% under` : 'exactly on plan';
        // The verdict is the pill and the measurement is the note: one fact, one
        // place. Written in both they read as two findings that happen to agree.
        pills.push({ text: verdict, tone: diff > 0 ? 'warn' : 'safe' });
        blocks.push({
            kind: 'note',
            tone: 'plain',
            label: 'Pace',
            // Both facts, because they answer different questions: what the
            // plan expected by now, and how much of the week is behind us.
            // Identical without a profile, so the sentence stays the old one.
            text: pc.weighted
                ? `${lim.weekly.pct}% spent, plan ${planned}% (window ${pc.plan}% elapsed)`
                : `${lim.weekly.pct}% spent, ${pc.plan}% of the window elapsed`,
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
        // The switch is the pill and the money is the note — the same split the
        // pace verdict gets. Said in both, "credits are off" read as two
        // findings that happen to agree, which is what the pill was meant to
        // stop rather than to add to.
        if (!cr.enabled) pills.push({ text: 'credits off', tone: 'warn' });
        blocks.push({
            kind: 'note',
            tone: cr.enabled ? 'plain' : 'warn',
            label: 'Credits',
            text: cr.enabled
                ? `${money(cr.used)} spent past the plan${cr.limit > 0 ? ` of ${money(cr.limit)}, ${cr.pct}%` : ''} — billed, not estimated`
                : `${money(cr.used)} spent past the plan${cr.reason === 'out_of_credits' ? ', and none are left' : ''} — work stops at the limit rather than continuing on credit`,
        });
    }

    if (env.stale) blocks.push({ kind: 'note', tone: 'warn', text: 'showing cached data — refresh failed' });
    if (env.updatedAt) blocks.push({ kind: 'band', facts: [`updated ${h.fmtAbs(env.updatedAt)}`] });
    if (pills.length) blocks.unshift({ kind: 'pills', items: pills });
    return { id: 'limits', title: 'Limits', blocks };
}

/**
 * What the window is full of, as far as this side can tell.
 *
 * `/context` in the client draws the same thing from figures it holds in memory
 * and never writes down. Four of its rows leave a trace in the transcript — the
 * skill listing, the deferred tool names, the agent listing, the MCP
 * instructions — and the memory files are on disk, so those are weighed here,
 * each at four characters to a token and each marked as the estimate it is.
 *
 * The rest is one row called `rest in use`, and it is the honest part of this
 * panel: the system prompt and the tool schemas are the largest thing in a real
 * window and none of it reaches the transcript. Splitting the difference among
 * the rows that *can* be measured would make every one of them wrong; leaving it
 * out would draw a window emptier than it is. So the rows always add up to what
 * is in use, and the unmeasurable part carries its own name.
 *
 * What is *not* here is free space and the window total: those are the gauge
 * this list hangs under. A row of parts and a row for the whole they are parts
 * of are two different facts, and drawn as one run of meters — which is what
 * this was — the total reads as one more component of itself.
 */
function breakdown(d, h) {
    const ctx = d.ctx;
    const parts = d.contextParts;
    if (!ctx || !parts || !ctx.window) return null;

    const window = ctx.window;
    const rows = [];
    const add = (label, tokens, note = '') => {
        if (tokens <= 0) return;
        const pct = Math.round((tokens / window) * 1000) / 10;
        rows.push({
            label,
            // The share is the emphasis and the size is the number to act on, so
            // they are separate fields rather than one string: the page gives
            // each its own column and the hover writes them side by side.
            value: `~${pct < 0.1 ? '<0.1' : pct}%`,
            figure: h.tok(tokens),
            pct,
            tokens,
            note,
        });
    };

    // Labels are one word wherever a word will do: the column is narrow in the
    // sidebar, and a label that wraps pushes its own row onto a second line.
    add('memory', d.memoryTokens || 0, 'instruction files');
    add('skills', parts.skills);
    add('agents', parts.agents);
    add('mcp', parts.mcp, 'server instructions');
    add('tools', parts.tools, 'names only');
    add('hooks', parts.hooks);

    // What this setup costs every prompt, before a word is typed. It is the one
    // number here anybody can act on — the rows above are the bill for skills,
    // agents, servers and instruction files somebody chose to load — so it goes
    // in the caption rather than being left for the reader to add up.
    const measured = rows.reduce((sum, r) => sum + r.tokens, 0);
    const share = Math.round((measured / window) * 1000) / 10;

    // The remainder, and it is deliberately not called "messages". The
    // conversation, the system prompt and the tool schemas arrive as one number
    // — the input the last reply was billed for — and nothing on disk separates
    // them. Naming this row after the conversation alone would be a guess
    // presented as a measurement; naming what is in it is not.
    add('rest in use', Math.max(0, ctx.tokens - measured), 'chat, system prompt, tool schemas');
    // Biggest share first: the rows worth seeing are the largest ones, and a
    // fixed order buries them under whichever parts happen to be measurable.
    rows.sort((a, b) => b.tokens - a.tokens);
    if (!rows.length) return null;

    // Two facts about the whole, on the line that introduces the parts: what the
    // setup costs, and where the client will compact. Both qualify the bar right
    // under them, and as rows of their own they were the reason this panel used
    // to end in a table nobody read.
    const figure = [];
    if (measured > 0) figure.push(`your setup ~${share < 0.1 ? '<0.1' : share}%`);
    if (d.compactPct > 0) {
        figure.push(d.compactPct > ctx.pct
            ? `compact at ${d.compactPct}%`
            : `compact due at ${d.compactPct}%`);
    }
    return [{
        kind: 'parts',
        // "in use", because that is what these rows add up to — the window is
        // the gauge above and the free space is the empty end of this bar.
        caption: 'in use',
        figure: figure.join(' · '),
        rows,
    }];
}

function context(d, h) {
    const ctx = d.ctx;
    if (!ctx) return null;
    const settings = d.settings || {};
    const version = d.version || {};
    const blocks = [];

    // Effort, thinking, advisor and output style are how this session is set up,
    // not measurements of it — one line of state beside the model's name rather
    // than four labelled rows above everything else, which is what pushed the
    // window itself below the fold. The value carries the emphasis where there
    // is one to carry: `advisor fable 5`, not `advisor: fable 5`.
    // In the order they survive a narrow sidebar, where the renderer drops the
    // tail: effort and advisor decide what the session costs and how hard it
    // thinks, and the two after them are settings you already know you set.
    const advisor = ctx.advisor || settings.advisor;
    const pills = [];
    if (ctx.effort) pills.push({ text: ctx.effort, tone: 'active' });
    if (advisor) pills.push({ text: 'advisor', value: h.shortModel(advisor) });
    // The setting, not the last reply: an answer that is a tool call carries no
    // thinking block even while the model thinks on every turn. Summaries being
    // hidden is worth saying — the reasoning still happens and simply never
    // appears, here or anywhere else.
    pills.push({
        text: 'thinking',
        value: settings.thinking
            ? (settings.thinkingSummaries ? 'on' : 'on · summaries hidden')
            : 'off',
    });
    // Labelled, like the advisor beside it: on the page a bare "explanatory"
    // reads as a state of something, but in the hover's one line of pills it is
    // a word with no subject at all.
    if (settings.outputStyle) pills.push({ text: 'style', value: settings.outputStyle });
    blocks.push({ kind: 'pills', items: pills });

    // The window as one headline rather than a meter row indistinguishable from
    // the parts under it. Everything that only qualifies the window — how much
    // is left, how much of it came from cache, where auto-compact waits — rides
    // under the bar as chips: as rows they were three more lines of label and
    // value between the reader and the breakdown, each repeating a word already
    // in the heading above them.
    const left = Math.max(0, ctx.window - ctx.tokens);
    const sub = [];
    if (left > 0) sub.push(`${h.tok(left)} free`);
    if (ctx.cachePct >= 0) sub.push(`${ctx.cachePct}% cached`);
    if (ctx.estimated) sub.push('window size is a guess for this model');
    // The share still travels — it is what turns the headline red as the window
    // fills — but this one draws no track of its own: the breakdown's colour bar
    // right under it is the same measurement, and two bars of one number stacked
    // on each other is the repetition this layout exists to remove.
    // Worked out before the gauge, because whether the gauge draws its own track
    // depends on whether this exists: the breakdown is null when the transcript
    // could not be read at all, and a panel with neither bar is a percentage
    // floating over nothing.
    const parts = (breakdown(d, h) || []).filter((block) => block.rows.length);
    blocks.push({
        kind: 'gauge',
        headline: `${ctx.estimated ? '~' : ''}${ctx.pct}%`,
        value: `${h.tok(ctx.tokens)} / ${h.tok(ctx.window)}`,
        sub: sub.join(' · '),
        pct: ctx.pct,
        bar: parts.length === 0,
        chips: [],
    });
    blocks.push(...parts);

    // Where this session runs, as the footer it always was: two facts nobody
    // reads twice, and — only when there is one — the update, which is the one
    // thing on this panel that asks to be acted on.
    const facts = [];
    if (ctx.branch) facts.push(ctx.branch);
    if (version.current) facts.push(`v${version.current}`);
    const band = { kind: 'band', facts };
    // The chip is the whole statement, not a headline over a sentence saying the
    // same thing again: an update that is "ready" here is one already unpacked
    // on disk, which the README explains once instead of every render.
    if (version.latest) band.chip = { label: 'update', value: version.latest, tail: 'ready', tone: 'update' };
    if (facts.length || band.chip) blocks.push(band);
    return { id: 'context', title: h.shortModel(ctx.model) || 'Session', blocks };
}

function money(d, h) {
    const stats = d.stats;
    if (!stats) return null;
    const blocks = [];

    // Burn rate and today's spend are the state of the wallet, not two more
    // measurements of the session — they sit beside the heading, and the figure
    // this panel exists for gets the room they used to take.
    const pills = [{ text: 'today', value: `~${h.fmtCost(d.todayUsd || 0)}` }];
    if (stats.burn > 0) pills.unshift({ text: 'burn', value: `~${h.fmtCost(stats.burn)}/h` });
    blocks.push({ kind: 'pills', items: pills });

    // No track: money is not a share of anything the extension knows — the plan
    // is a token allowance, not a budget in dollars.
    blocks.push({
        kind: 'gauge',
        headline: `~${h.fmtCost(stats.cost)}`,
        value: 'this session',
        sub: stats.durationMs > 0 ? `${h.fmtDuration(stats.durationMs)} of work` : '',
        pct: null,
        chips: [],
    });

    const rows = [];
    if (stats.durationMs > 0) rows.push(['duration', h.fmtDuration(stats.durationMs)]);
    rows.push(['requests', String(stats.messages)]);
    if (stats.apiPct >= 0) rows.push(['waiting on model', `~${stats.apiPct}% of that time`]);
    if (stats.added || stats.removed) rows.push(['edits', `+${stats.added} / −${stats.removed} lines`]);
    blocks.push({ kind: 'subtitle', text: 'What it took' }, { kind: 'table', rows });

    // An unpriced model is charged at Opus rates, and a figure that says so is
    // worth more than one that quietly rounds up.
    const known = d.ctx ? ratesFor(d.ctx.model).known : true;
    blocks.push({
        kind: 'band',
        facts: [known
            ? 'estimated from public rates — not a bill'
            : 'estimated at Opus rates: this model has no published rate'],
    });
    return { id: 'money', title: 'Spend', blocks };
}

function work(d) {
    const { peers, todo } = d;
    if (!todo && !(peers && peers.total > 0)) return null;
    const blocks = [];

    // The other sessions on this machine are state, not a table: how many are
    // open and how many are working right now, in the two words each needs.
    const pills = [];
    if (peers && peers.total > 0) {
        pills.push({ text: `${peers.total} ${peers.total === 1 ? 'session' : 'sessions'}` });
        if (peers.busy > 0) pills.push({ text: `${peers.busy} busy`, tone: 'active' });
    }
    if (pills.length) blocks.push({ kind: 'pills', items: pills });

    // The count is the figure and the share is beside it: "4/7" is what anyone
    // asks for, and it used to live in the section's own title with a separate
    // meter under it saying the same thing from the other end.
    if (todo && todo.total > 0) {
        const pct = Math.round((todo.done / todo.total) * 100);
        blocks.push({
            kind: 'gauge',
            headline: `${todo.done}/${todo.total}`,
            value: `${pct}% done`,
            sub: `${todo.total - todo.done} left`,
            pct,
            chips: [],
        });
    }
    if (todo && todo.active) blocks.push({ kind: 'note', tone: 'active', label: 'in progress', text: todo.active });
    return {
        id: 'work',
        // Not the count: the gauge under it carries that, and a title that
        // answers its own panel leaves the panel with nothing to say.
        title: todo ? 'Tasks' : 'Other sessions here',
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
            // Whether this window is old enough to be compared against its plan
            // at all — decided once, in pace(), for the bar, the drift field
            // and this page alike.
            settled: Boolean(d.pace && d.pace.settled),
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
