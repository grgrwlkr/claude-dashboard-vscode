// The third renderer of the same sections.
//
// `status.js` answers what the bar knows as data — sections of typed blocks —
// and two renderers already walk it: the status-bar hover and the dashboard's
// Now tab. This is the terminal's turn. Nothing here decides what a number
// means or how it is worded; it decides only how a block looks in a fixed-width
// grid.
//
// No dependency on vscode, and none on a TUI library: the blocks are tables,
// bars and short lines of text, and a library would replace the hundred lines
// below with a hundred lines of adapter plus a runtime the extension packages
// with `--no-dependencies`.

const { bar } = require('./usage');
const { paint } = require('./terminal');

// The width to draw at when nothing says otherwise. 80 is the terminal that
// every terminal is at least as wide as.
const DEFAULT_WIDTH = 80;

// A label column wider than this makes the values start too far right to scan.
const MAX_LABEL = 24;

// Meaning, not appearance — the same vocabulary status.js uses, mapped onto the
// two tones the terminal renderer paints with. `safe`, `active` and `update`
// are news rather than warnings and stay unpainted, exactly as they do in the
// status bar, where only a threshold colours an item.
const TONE = { alarm: 'alarm', warn: 'warn' };

const visibleLength = (s) => s.replace(/\u001b\[[0-9;]*m/g, '').length;

// Cut to width, counting only what is printed: an escape costs columns in the
// string and none on the screen.
function clip(text, width) {
    if (visibleLength(text) <= width) return text;
    if (!text.includes('\u001b')) return text.slice(0, Math.max(0, width - 1)) + '…';
    // A painted string is cut on its visible characters and then closed, or the
    // colour runs on into the prompt.
    let out = '';
    let seen = 0;
    for (let i = 0; i < text.length; i++) {
        const esc = /^\u001b\[[0-9;]*m/.exec(text.slice(i));
        if (esc) { out += esc[0]; i += esc[0].length - 1; continue; }
        if (seen >= width - 1) break;
        out += text[i];
        seen++;
    }
    return `${out}…\u001b[0m`;
}

const pad = (text, width) => text + ' '.repeat(Math.max(0, width - visibleLength(text)));

/**
 * Break text on spaces to fit a width, as lines.
 *
 * A word longer than the whole width is cut rather than looped over: a hash or
 * a path with no space in it would otherwise never fit and never terminate.
 */
function wrap(text, width) {
    if (width < 1) return [text];
    const out = [];
    let line = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
        if (!line) {
            line = word.length > width ? word.slice(0, width) : word;
            if (word.length > width) { out.push(line); line = ''; }
            continue;
        }
        if (line.length + 1 + word.length <= width) { line += ` ${word}`; continue; }
        out.push(line);
        line = word.length > width ? '' : word;
        if (!line) out.push(word.slice(0, width));
    }
    if (line) out.push(line);
    return out.length ? out : [''];
}

// Two columns, sized to the widest label and never past MAX_LABEL. Ragged
// columns are what makes a terminal table unreadable.
function twoColumn(rows, width, colour) {
    const labels = rows.map(([label]) => String(label ?? ''));
    const size = Math.min(MAX_LABEL, Math.max(0, ...labels.map((l) => l.length)));
    return rows.map(([label, value]) => clip(
        `  ${pad(clip(String(label ?? ''), size), size)}  ${String(value ?? '')}`,
        width,
    ));
}

// A share as the same block characters the status bar draws, so one week looks
// the same in all three places. `plan` is the notch an even pace would be at.
const track = (pct, plan) => (Number.isFinite(pct) ? bar(pct, Number.isFinite(plan) ? plan : pct) : '');

const BLOCKS = {
    pills: () => [], // drawn on the heading, by renderSection

    gauge(block, width, colour) {
        const out = [];
        // The figure on the left, what it is a share of on the right — the same
        // split the page uses for the headline of a panel.
        out.push(`  ${row(bold(block.headline || '', colour), block.value || '', width - 2)}`);
        // A track across the whole panel, not the seven cells the status line
        // has room for. The plan is a notch on it.
        if (Number.isFinite(block.pct)) out.push(`  ${meter(block.pct, width - 2, { plan: block.plan })}`);
        if (block.sub) out.push(`  ${clip(dim(block.sub, colour), width - 2)}`);
        const chips = (block.chips || []).filter(Boolean);
        if (chips.length) out.push(`  ${clip(dim(chips.join('  ·  '), colour), width - 2)}`);
        return out;
    },

    meters(block, width, colour) {
        const rows = (block.rows || []);
        if (!rows.length) return [];
        // Label, bar, share — the share pinned right so a column of them reads
        // down the edge, the way the page stacks them.
        const labelW = Math.min(MAX_LABEL, Math.max(0, ...rows.map((r) => String(r.label || '').length)));
        const shareW = Math.max(0, ...rows.map((r) => String(r.value || '').length));
        const barW = Math.max(4, width - labelW - shareW - 8);
        const out = [];
        for (const r of rows) {
            const head = `  ${pad(clip(String(r.label || ''), labelW), labelW)}  `
                + (Number.isFinite(r.pct) ? meter(r.pct, barW) : ' '.repeat(barW));
            out.push(row(head, String(r.value || ''), width));
            // The note goes under the meter rather than after it: crammed onto
            // the same line it either pushes the share off the edge or cuts
            // itself in half, and it is the line that says when.
            if (r.note) out.push(`  ${' '.repeat(labelW)}  ${clip(dim(r.note, colour), width - labelW - 4)}`);
        }
        return out;
    },

    parts(block, width, colour) {
        const out = [];
        if (block.caption) out.push(clip(`  ${block.caption}`, width));
        out.push(...twoColumn(
            (block.rows || []).map((r) => [
                r.label,
                [r.figure, r.value, r.note].filter(Boolean).join('  '),
            ]),
            width, colour,
        ));
        return out;
    },

    table(block, width, colour) {
        const rows = block.rows || [];
        const out = [];
        if (block.head) out.push(...twoColumn([block.head.slice(0, 2)], width, colour));
        // A row wider than two cells is joined rather than dropped: the head-wide
        // form carries its own columns and this is a fixed-width page.
        out.push(...twoColumn(rows.map((r) => (r.length > 2 ? [r[0], r.slice(1).join('  ')] : r)), width, colour));
        return out;
    },

    band(block, width, colour) {
        const facts = (block.facts || []).filter(Boolean);
        const line = [facts.join('  ·  '), block.chip && block.chip.text].filter(Boolean).join('  ·  ');
        // The footer is a sentence as often as it is a list — "estimated from
        // public rates, not a bill" — so it wraps rather than losing its end.
        return line ? wrap(line, width - 2).map((l) => `  ${dim(l, colour)}`) : [];
    },

    subtitle(block, width, colour) {
        // Small caps and quiet, the way the page marks a heading inside a panel:
        // it separates what follows without competing with the panel's title.
        return ['', clip(`  ${dim(String(block.text || '').toUpperCase(), colour)}`, width)];
    },

    note(block, width, colour) {
        if (!block.text) return [];
        // Wrapped, not clipped. A note is the sentence a section exists to
        // deliver — the forecast, the reason a figure is marked estimated — and
        // cutting it at the column drops the half that says what it means.
        return wrap(block.text, width - 2).map(
            (line) => `  ${paint(line, TONE[block.tone] || null, colour)}`,
        );
    },
};

function renderSection(section, width, colour) {
    const pills = (section.blocks || [])
        .filter((b) => b.kind === 'pills')
        .flatMap((b) => b.items || [])
        .map((p) => paint([p.text, p.value].filter(Boolean).join(' '), TONE[p.tone] || null, colour));

    const heading = [section.title, pills.length ? pills.join('  ') : ''].filter(Boolean).join('   ');
    const out = [clip(heading, width)];

    for (const block of section.blocks || []) {
        const draw = BLOCKS[block.kind];
        // status.js grows block kinds; one this renderer has not learned yet
        // must not take the rest of the section down with it.
        if (!draw) continue;
        try { out.push(...draw(block, width, colour)); } catch { /* degrade, never guess */ }
    }
    return out;
}

/**
 * The sections as lines to print.
 *
 * @param {Array}  sections  what `statusSections` returned
 * @param {object} opts      `width` in columns, `colour` false to drop escapes
 */
function renderSections(sections, opts = {}) {
    const width = opts.width || DEFAULT_WIDTH;
    const colour = opts.colour !== false;
    const out = [];
    for (const section of sections || []) {
        if (out.length) out.push('');
        out.push(...renderSection(section, width, colour));
    }
    return out;
}

// --- the page furniture ---------------------------------------------------
//
// The dashboard's four components, in a fixed-width grid: the strip of headline
// tiles, the panel that everything else lives in, the meter under a figure, and
// the right-aligned row. The page and this draw the same things from the same
// numbers; what differs is that here a column is a character.

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const OFF = '\u001b[0m';

const dim = (text, colour) => (colour ? `${DIM}${text}${OFF}` : text);
const bold = (text, colour) => (colour ? `${BOLD}${text}${OFF}` : text);

/**
 * One line with something pinned to each edge.
 *
 * When the two do not fit, the left is cut: the right-hand side carries the
 * figure, and a figure cut in half is worse than a label cut in half.
 */
function row(left, right, width) {
    const r = String(right ?? '');
    const room = Math.max(0, width - visibleLength(r) - 1);
    const l = clip(String(left ?? ''), room);
    return `${l}${' '.repeat(Math.max(0, width - visibleLength(l) - visibleLength(r)))}${r}`;
}

// The bar under a figure. `usage.bar()` draws the seven-cell version the status
// line uses; this one takes whatever width the layout can spare, and marks the
// plan with a different glyph rather than with a colour, so it survives
// --no-color and a screenshot.
function meter(pct, width, opts = {}) {
    const w = Math.max(1, width);
    const share = Math.max(0, Math.min(100, Number(pct) || 0));
    const filled = Math.round((share * w) / 100);
    const cells = Array.from({ length: w }, (_, i) => (i < filled ? '█' : '░'));
    if (Number.isFinite(opts.plan)) {
        const at = Math.min(w - 1, Math.max(0, Math.round((opts.plan * w) / 100) - 1));
        cells[at] = cells[at] === '█' ? '▓' : '▒';
    }
    return cells.join('');
}

// The narrowest a tile can be and still hold a label like WEEKLY WINDOW beside
// its divider. Four of these fit an 80-column terminal, which is the layout the
// page has and the width most terminals open at.
const TILE_MIN = 20;

/**
 * The headline strip: label, figure, meter, sub line — every tile a column, the
 * way the page lays them across the top.
 *
 * Tiles wrap into another strip rather than shrinking below what a figure needs,
 * because four unreadable columns are worse than two readable ones.
 */
function tiles(items, width, colour = true) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return [];
    const perRow = Math.max(1, Math.min(list.length, Math.floor(width / TILE_MIN)));
    const out = [];
    for (let i = 0; i < list.length; i += perRow) {
        const group = list.slice(i, i + perRow);
        const col = Math.floor(width / group.length);
        const cell = (text) => clip(String(text ?? ''), col - 3);
        // A rule between columns, the way the page rules between its tiles:
        // without it four figures read as one row of numbers.
        const pad2 = (text, last) => pad(cell(text), col - 3) + (last ? '' : dim(' │ ', colour));
        if (out.length) out.push('');
        const last = (i2) => i2 === group.length - 1;
        out.push(group.map((t, j) => pad2(dim(String(t.label || '').toUpperCase(), colour), last(j))).join('').trimEnd());
        out.push(group.map((t, j) => pad2(bold(t.value, colour), last(j))).join('').trimEnd());
        // A row of blanks reads as meters that failed to draw, so the row is
        // skipped entirely when nothing in the group is a share.
        if (group.some((t) => Number.isFinite(t.pct))) {
            out.push(group.map((t, j) => pad2(
                Number.isFinite(t.pct) ? meter(t.pct, col - 5, { plan: t.plan }) : '', last(j),
            )).join('').trimEnd());
        }
        out.push(group.map((t, j) => pad2(dim(t.sub || '', colour), last(j))).join('').trimEnd());
    }
    return out;
}

const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };

/**
 * A framed block of the page: title and pills on the top edge, the body inside,
 * an optional note as the last thing before the bottom edge.
 *
 * Every line is exactly `width` wide, so two panels can sit side by side.
 */
function panel(title, body, opts = {}) {
    const width = opts.width || DEFAULT_WIDTH;
    const colour = opts.colour !== false;
    const inner = Math.max(0, width - 2);

    // The title rides on the top edge, so that edge is drawn as a row rather
    // than as a run of dashes. Pills are dropped from the right, one at a time,
    // until the title fits: the title says which panel this is, a pill is a
    // detail about it.
    const head = ` ${bold(title, colour)} `;
    let kept = (opts.pills || []).filter(Boolean);
    let pills = kept.length ? `${kept.map((p) => dim(`[${p}]`, colour)).join(' ')} ` : '';
    while (kept.length && visibleLength(head) + visibleLength(pills) > inner) {
        kept = kept.slice(0, -1);
        pills = kept.length ? `${kept.map((p) => dim(`[${p}]`, colour)).join(' ')} ` : '';
    }
    const out = [BOX.tl + row(head, pills, inner) + BOX.tr];

    for (const line of body || []) out.push(BOX.v + pad(clip(line, inner), inner) + BOX.v);
    if (opts.note) {
        out.push(BOX.v + pad('', inner) + BOX.v);
        for (const line of wrap(opts.note, inner - 2)) {
            out.push(BOX.v + pad(` ${dim(line, colour)}`, inner) + BOX.v);
        }
    }
    out.push(BOX.bl + BOX.h.repeat(inner) + BOX.br);
    return out;
}

/** Two panels side by side, the shorter padded so the bottom edge is level. */
function pair(left, right, gap = 2) {
    const height = Math.max(left.length, right.length);
    const lw = Math.max(0, ...left.map(visibleLength));
    const rw = Math.max(0, ...right.map(visibleLength));
    const out = [];
    for (let i = 0; i < height; i++) {
        const l = pad(left[i] || '', lw);
        const r = right[i] || '';
        // No padding past the shorter panel: a run of spaces to the right edge
        // shows up in a copy-paste and in a screenshot as a ragged block.
        out.push((l + ' '.repeat(gap) + r).replace(/\s+$/, ''));
    }
    return out;
}

// --- the Now page ---------------------------------------------------------

// How many panels fit across. Below the first a panel has no room for a figure
// and its meter side by side, so one column beats two squeezed ones.
const PAIR_MIN = 84;
const TRIPLE_MIN = 126;

/**
 * The four figures the dashboard leads with, as a tile strip.
 *
 * A tile whose number is not known is left out rather than drawn empty: on a
 * fresh machine there is no week yet, and a column of dashes reads as a reading
 * of zero.
 */
function nowTiles(d = {}, helpers = {}, width = DEFAULT_WIDTH, colour = true) {
    const out = [];
    const money = (n) => (helpers.fmtCost ? helpers.fmtCost(n) : `$${n}`);
    const tok = helpers.tok || ((n) => String(n));

    if (d.weekly) {
        out.push({
            label: 'weekly window',
            value: `${d.weekly.pct}%`,
            pct: d.weekly.pct,
            plan: d.pace && d.pace.settled ? d.pace.plan : null,
            sub: d.pace && d.pace.settled ? `${d.pace.plan}% of the week gone` : 'the week is young',
        });
    }
    if (d.session) {
        out.push({
            label: '5-hour window',
            value: `${d.session.pct}%`,
            pct: d.session.pct,
            sub: d.session.reset && helpers.fmtLeft ? `resets in ${helpers.fmtLeft(d.session.reset, d.now)}` : '',
        });
    }
    if (d.ctx) {
        out.push({
            label: 'context',
            value: `${d.ctx.pct}%`,
            pct: d.ctx.pct,
            sub: `${tok(d.ctx.tokens)} of ${tok(d.ctx.window)}`,
        });
    }
    if (d.stats && Number.isFinite(d.stats.cost)) {
        out.push({
            label: 'this session',
            value: money(d.stats.cost),
            pct: null,
            sub: Number.isFinite(d.stats.burn) && d.stats.burn ? `${money(d.stats.burn)} an hour` : '',
        });
    }
    return tiles(out, width, colour);
}

/**
 * The Now tab: the tile strip, then every section as a panel — two across when
 * the terminal is wide enough for it, stacked when it is not.
 */
function nowPage(opts) {
    const { sections = [], d = {}, helpers = {}, width = DEFAULT_WIDTH, colour = true } = opts;
    const out = [...nowTiles(d, helpers, width, colour)];

    const across = width >= TRIPLE_MIN ? 3 : (width >= PAIR_MIN ? 2 : 1);
    const panelWidth = Math.floor((width - 2 * (across - 1)) / across);
    const drawn = sections.map((section) => {
        // The heading and the pills belong to the frame now, so the body is the
        // section drawn without its own title line.
        const pills = (section.blocks || [])
            .filter((b) => b.kind === 'pills')
            .flatMap((b) => b.items || [])
            .map((p) => [p.text, p.value].filter(Boolean).join(' '));
        const body = renderSection({ ...section, title: '' }, panelWidth - 2, colour).slice(1);
        return panel(section.title, body, { pills, width: panelWidth, colour });
    });

    if (out.length) out.push('');
    for (let i = 0; i < drawn.length; i += across) {
        const group = drawn.slice(i, i + across);
        out.push(...group.reduce((acc, p) => (acc ? pair(acc, p, 2) : p), null), '');
    }
    return out;
}

// --- the tabbed screen ----------------------------------------------------
//
// One screen is a tab bar, a body, and a footer, drawn to an exact height so
// the alternate screen buffer can be repainted without clearing it first — a
// clear between frames is what makes a TUI flicker.

const ACTIVE = '\u001b[7m'; // reverse video: the terminal's own idea of "selected"

/**
 * The row of tabs. The active one is bracketed as well as highlighted, because
 * a screenshot, a pipe and `--no-color` all lose the highlight and the bar has
 * to still say where you are.
 */
function tabBar(tabs, active, width, colour = true) {
    const parts = tabs.map((tab, i) => {
        const text = i === active ? `[${tab.title}]` : ` ${tab.title} `;
        return colour && i === active ? `${ACTIVE}${text}\u001b[0m` : text;
    });
    return clip(parts.join(' '), width);
}

/** Which tab a key moves to. Digits pick outright; arrows wrap at both ends. */
function nextTab(active, key, count) {
    if (count < 1) return active;
    if (key === 'right') return (active + 1) % count;
    if (key === 'left') return (active - 1 + count) % count;
    if (/^[1-9]$/.test(key)) {
        const want = Number(key) - 1;
        return want < count ? want : active;
    }
    return active;
}

/**
 * A full frame: tab bar, a blank line, the body window, then the footer pinned
 * to the last row. Always exactly `height` lines, padded when the body is short.
 */
function screen(opts) {
    const { tabs = [], active = 0, width = DEFAULT_WIDTH, height = 24, body = [], footer = '', colour = true } = opts;
    // `bars` is the two-level form: a row of sections and a row of that
    // section's tabs. A section holding one tab contributes no second row, and
    // the empty string it returns is dropped rather than drawn as a blank line.
    const head = Array.isArray(opts.bars)
        ? opts.bars.filter((b) => b !== '')
        : [tabBar(tabs, active, width, colour)];
    const out = [...head, ''];
    const room = Math.max(0, height - out.length - (footer ? 2 : 0));
    // A body shorter than the window is never scrolled: the top of a short page
    // is the page.
    const top = Math.max(0, Math.min(opts.scroll || 0, Math.max(0, body.length - room)));
    const window = body.slice(top, top + room).map((line) => clip(line, width));
    out.push(...window, ...Array(Math.max(0, room - window.length)).fill(''));
    if (footer) out.push('', clip(footer, width));
    return out.slice(0, height);
}

// --- the same map of the dashboard ----------------------------------------
//
// The page's own SECTIONS, kept in the same order and with the same words, so
// that "Work → Skills" means one thing wherever it is read. Two levels rather
// than one row of 24: a bar of every tab would take three lines and still
// leave you guessing which of them belong together.

const SECTIONS = [
    { id: 'now', title: 'Now', tabs: [{ id: 'now', title: 'Now' }] },
    {
        id: 'spend',
        title: 'Spend',
        tabs: [
            { id: 'overview', title: 'Overview' },
            { id: 'sessions', title: 'Sessions' },
            { id: 'projects', title: 'Projects' },
            { id: 'branches', title: 'Branches' },
        ],
    },
    {
        id: 'work',
        title: 'Work',
        tabs: [
            { id: 'agents', title: 'Agents' },
            { id: 'tools', title: 'Tools & MCP' },
            { id: 'files', title: 'Files' },
            { id: 'skills', title: 'Skills' },
            { id: 'content', title: 'Content' },
        ],
    },
    {
        id: 'efficiency',
        title: 'Efficiency',
        tabs: [
            { id: 'models', title: 'Models & effort' },
            { id: 'cache', title: 'Cache' },
            { id: 'friction', title: 'Friction' },
            { id: 'limits', title: 'Limits' },
        ],
    },
    {
        id: 'setup',
        title: 'Setup',
        tabs: [
            { id: 'settings', title: 'Settings' },
            { id: 'launch', title: 'Launch' },
            { id: 'client', title: 'Claude Code' },
            { id: 'context', title: 'Memory' },
            { id: 'health', title: 'Health' },
            { id: 'changelog', title: 'Changelog' },
        ],
    },
    {
        id: 'machine',
        title: 'Machine',
        tabs: [
            { id: 'live', title: 'Live now' },
            { id: 'jobs', title: 'Background jobs' },
            { id: 'tasks', title: 'Task lists' },
            { id: 'disk', title: 'Disk' },
        ],
    },
];

const sectionAt = (at) => SECTIONS[at.section] || SECTIONS[0];

/** The tab a position names, or the first one when the position is nonsense. */
function tabAt(at) {
    const section = sectionAt(at);
    return section.tabs[at.tab] || section.tabs[0];
}

/** The row of sections, the one you are in marked as well as highlighted. */
function sectionBar(active, width, colour = true) {
    return tabBar(SECTIONS, active, width, colour);
}

/**
 * The row of tabs inside a section — and nothing at all for a section holding
 * one, where a bar of a single entry is a line spent saying nothing.
 */
function tabBarFor(section, tab, width, colour = true) {
    const tabs = (SECTIONS[section] || SECTIONS[0]).tabs;
    if (tabs.length < 2) return '';
    return `  ${tabBar(tabs, tab, width - 2, colour)}`;
}

/**
 * A chunk of terminal input, split into the keys it holds.
 *
 * stdin delivers whatever has arrived, not one key per press: an arrow held
 * down, or two presses in quick succession, come through together as
 * `\u001b[C\u001b[C`. Compared whole, such a chunk equals no key at all and
 * every press in it is dropped — which is exactly what "the arrows stopped
 * working" looks like from the other side.
 */
function keysFrom(chunk) {
    const out = [];
    const text = String(chunk || '');
    let i = 0;
    while (i < text.length) {
        // CSI: escape, `[`, digits or semicolons, then the letter that ends it.
        const m = text[i] === '\u001b' && text[i + 1] === '['
            ? /^\u001b\[[0-9;]*[A-Za-z~]/.exec(text.slice(i))
            : null;
        if (m) { out.push(m[0]); i += m[0].length; continue; }
        out.push(text[i]);
        i += 1;
    }
    return out;
}

/** Tab and Shift-Tab walk the sections, wrapping, and start at the first tab. */
function moveSection(at, dir) {
    const count = SECTIONS.length;
    const next = dir === 'prev' ? (at.section - 1 + count) % count : (at.section + 1) % count;
    return { section: next, tab: 0 };
}

/**
 * The arrows walk every tab of the dashboard in order, crossing from the last
 * tab of one section into the first of the next; a digit picks a tab of the
 * section you are in.
 *
 * Arrows confined to a section are dead on the screen the dashboard opens on:
 * `Now` holds one tab, and the first key anyone presses does nothing.
 */
function moveTab(at, key) {
    const tabs = sectionAt(at).tabs;
    if (/^[1-9]$/.test(key)) return { section: at.section, tab: nextTab(at.tab, key, tabs.length) };
    if (key !== 'right' && key !== 'left') return at;

    const flat = SECTIONS.flatMap((s, si) => s.tabs.map((_, ti) => ({ section: si, tab: ti })));
    const now = flat.findIndex((p) => p.section === at.section && p.tab === at.tab);
    const step = key === 'right' ? 1 : -1;
    return flat[(now + step + flat.length) % flat.length];
}

// --- what each tab shows --------------------------------------------------

const { shortModel, realModels } = require('./pricing');

// A tab with nothing behind it says why, rather than drawing an empty frame:
// an index that has never been built and a week with no spend look identical
// otherwise.
const EMPTY = (what) => [`  Nothing to show — ${what}.`];

/**
 * The top rows of a `summarize` bucket, as a two-column list.
 *
 * A bucket is an object keyed by name — `{ '2026-08-25': { cost, tokens } }` —
 * which is the shape `indexer.summarize` returns and `dashboard.js` walks.
 * `order` decides what "top" means: spend for a model, the calendar for a day.
 */
function topRows(bucket, width, helpers, opts = {}) {
    const entries = Object.entries(bucket || {});
    if (!entries.length) return null;
    const { label = (key) => key, order = 'cost', limit = 12 } = opts;
    const rank = (v) => {
        if (order !== 'plain') return v[order] || 0;
        if (typeof v === 'number') return v;
        // A bucket broken down by reason ranks by what it adds up to.
        return v && typeof v === 'object' ? Object.values(v).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
    };
    const sorted = order === 'key'
        ? entries.sort((a, b) => String(b[0]).localeCompare(String(a[0])))
        : entries.sort((a, b) => rank(b[1]) - rank(a[1]));
    const figure = opts.figure || ((v, h) => [
        Number.isFinite(v.cost) ? h.fmtCost(v.cost) : '',
        Number.isFinite(v.tokens) ? h.tok(v.tokens) : '',
        Number.isFinite(v.count) ? `×${v.count}` : '',
    ].filter(Boolean).join('   '));
    return twoColumn(sorted.slice(0, limit).map(([key, v]) => [
        label(key, v),
        figure(v, helpers, key),
    ]), width, false);
}

// A tab the terminal has no business drawing: an editor, a form. Saying where
// it lives beats leaving it blank, which reads as an index that failed to load.
const ELSEWHERE = (what) => [
    '',
    `  ${what} is an editor rather than a reading.`,
    '  Open it in the VS Code extension: Claude dashnlines → the same tab.',
];

// One list per tab, from the bucket `summarize` fills. `order` is what "top"
// means for that tab, `label` how a key is spelled, `unit` what the count is a
// count of.
// One list per tab, over the buckets `summarize` fills. Each names how a key is
// spelled and what its figure is, because the buckets are not one shape: a tool
// counts calls and errors, a file counts edits, a project costs money.
const LISTS = {
    overview: [
        ['By day', 'days', { order: 'key', figure: 'money' }],
        ['By model', 'models', { model: true, figure: 'money' }],
    ],
    sessions: [['Sessions', 'sessions', { session: true, figure: 'money' }]],
    projects: [['Projects', 'projects', { figure: 'money' }]],
    branches: [['Branches', 'branches', { figure: 'money' }]],
    agents: [['Agents', 'agents', { figure: 'money' }]],
    tools: [['Tools & MCP', 'tools', { order: 'calls', figure: 'calls' }]],
    files: [['Files', 'files', { order: 'edits', figure: 'edits', path: true }]],
    skills: [['Skills', 'skills', { figure: 'money' }]],
    content: [['Prompts by length', 'prompts', { order: 'plain', figure: 'plain' }]],
    models: [
        ['By model', 'models', { model: true, figure: 'money' }],
        ['By effort', 'efforts', { figure: 'money' }],
    ],
    friction: [['Friction', 'friction', { order: 'plain', figure: 'friction' }]],
    limits: [['By hour of day', 'hours', { order: 'key', figure: 'money' }]],
};

// What the right-hand column of a row says, per bucket shape.
const FIGURES = {
    money: (v, h) => [
        Number.isFinite(v.cost) ? h.fmtCost(v.cost) : '',
        Number.isFinite(v.msgs) ? `${v.msgs} msgs` : '',
    ].filter(Boolean).join('   '),
    calls: (v) => [
        Number.isFinite(v.calls) ? `${v.calls} calls` : '',
        v.errors ? `${v.errors} errors` : '',
        v.denials ? `${v.denials} denied` : '',
    ].filter(Boolean).join('   '),
    edits: (v) => [
        Number.isFinite(v.edits) ? `${v.edits} edits` : '',
        v.added || v.removed ? `+${v.added || 0} / −${v.removed || 0}` : '',
    ].filter(Boolean).join('   '),
    // A bucket that is a bare number rather than an object.
    plain: (v) => (typeof v === 'number' ? String(v) : ''),

    // Friction counts three different kinds of thing under one roof: tokens
    // thrown away, milliseconds spent compacting, and plain tallies. Printed
    // raw they read as one scale, and 21128022 reads as nothing at all.
    friction: (v, h, key) => {
        // Two of these are broken down by reason rather than counted flat —
        // denials into rejected and rule-blocked, compactions into manual and
        // automatic — so they print their parts instead of a bare total.
        if (v && typeof v === 'object') {
            return Object.entries(v).map(([k, n]) => `${n} ${k}`).join('   ');
        }
        if (typeof v !== 'number') return '';
        if (/token/i.test(key)) return h.tok(v);
        if (/ms$/i.test(key)) return h.fmtDuration(v);
        return String(v);
    },
};

/** The body of one tab, as lines. */
function bodyFor(id, ctx) {
    const { summary = {}, helpers = {}, width = DEFAULT_WIDTH, colour = true } = ctx;
    const heading = (text) => ['', `  ${dim(String(text).toUpperCase(), colour)}`, ''];

    if (id === 'now') {
        return (ctx.sections || []).length
            ? nowPage({ sections: ctx.sections, d: ctx.d || {}, helpers, width, colour })
            : EMPTY('no limits have been read on this machine yet');
    }
    if (id === 'settings') return ELSEWHERE('Settings');
    if (id === 'launch') return ELSEWHERE('Launch');

    const lists = LISTS[id];
    if (lists) {
        const out = [];
        for (const [title, key, opts] of lists) {
            // `<synthetic>` is not a model; the filter lives in pricing.js so
            // every surface that lists models drops it the same way.
            const bucket = opts.model ? realModels(summary[key]) : summary[key];
            const rows = topRows(bucket, width, helpers, {
                order: opts.order || 'cost',
                figure: FIGURES[opts.figure] || FIGURES.money,
                label: opts.model ? shortModel
                    : opts.session ? ((k, v) => v.title || v.project || String(k).slice(0, 8))
                        // A path is read from its end: the file, and the folder
                        // that tells you which of the four `index.js` it is.
                        : opts.path ? ((k) => String(k).split('/').slice(-2).join('/'))
                            : undefined,
            });
            if (rows) out.push(...heading(title), ...rows);
        }
        if (out.length) return out;
        // An index that is absent and an index that is merely empty look the
        // same from here, and the fix for both is the same one command.
        return [
            '',
            '  Nothing under this tab yet — the usage index is empty.',
            '',
            '  Build it:  dashnlines --reindex',
            '  It reads every transcript once and takes a few minutes; after that',
            '  it only reads what has changed.',
        ];
    }

    // Cache, Memory, Health, Changelog, and everything under Machine read state
    // this build does not collect yet. They are listed rather than hidden, so
    // the map matches the page and the gap is visible.
    return [
        '',
        `  Not read by the terminal build yet.`,
        '  The VS Code extension has this tab; the reading is on its way here.',
    ];
}

/**
 * The tabs of the terminal dashboard, each with its body already drawn.
 *
 * Bodies are lines rather than a nested structure so the screen can scroll one
 * without knowing what is in it.
 */
function tabsFor(opts) {
    const { sections = [], summary = {}, helpers, width = DEFAULT_WIDTH, colour = true } = opts;
    const heading = (text) => ['', `  ${text}`, ''];

    const spend = [];
    // Days run newest first — "what did today cost" is the question — while
    // every other bucket runs dearest first, so the row that explains the bill
    // is the one at the top.
    const days = topRows(summary.days, width, helpers, { order: 'key' });
    if (days) spend.push(...heading('By day'), ...days);
    const models = topRows(summary.models, width, helpers, { label: shortModel });
    if (models) spend.push(...heading('By model'), ...models);

    const agents = topRows(summary.agents, width, helpers);
    const sessions = topRows(summary.sessions, width, helpers, {
        label: (key, v) => v.project || String(key).slice(0, 8),
    });

    return [
        {
            id: 'now',
            title: 'Now',
            body: sections.length
                ? nowPage({ sections, d: opts.d || {}, helpers, width, colour })
                : EMPTY('no limits have been read on this machine yet'),
        },
        { id: 'spend', title: 'Spend', body: spend.length ? spend : EMPTY('the usage index is empty') },
        { id: 'agents', title: 'Agents', body: agents || EMPTY('no subagent has run on this machine') },
        { id: 'sessions', title: 'Sessions', body: sessions || EMPTY('no session has been indexed') },
    ];
}

module.exports = {
    row, meter, tiles, panel, pair, nowTiles, nowPage,
    SECTIONS, sectionBar, tabBarFor, moveSection, moveTab, tabAt, bodyFor, keysFrom,
    renderSections, renderSection, clip, wrap, visibleLength, DEFAULT_WIDTH,
    tabBar, nextTab, screen, tabsFor,
};
