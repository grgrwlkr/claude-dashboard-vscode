// The registry behind the Client tab: what Claude Code can be told, what each
// key defaults to, and what it means.
//
// None of that is on this machine. The client ships no schema, and the hundreds
// of `CLAUDE_CODE_*` strings inside its bundle are internal flags with no
// defaults and no descriptions — enumerable, but not answerable. The documented
// documentation is the only source that carries all three, so this parses it:
// one `### `key`` section per setting in docs/en/settings-reference.md, and the
// `## Variables` table in docs/en/env-vars.md, both served as raw markdown.
//
// The settings page was a table under `### Available settings` until 2026-08,
// when it became a reference page of per-key sections and the table moved to an
// index of links. The two shapes carry the same facts in different places: what
// was one cell of prose is now a paragraph plus **Scope**, **Type** and
// **Default** bullets — better to read, and the reason `typeOf` no longer has to
// guess a type from the shape of a default.
//
// A snapshot of the result is committed as claude-settings-registry.json and
// carries the date it was taken; the same parser runs again when the network
// toggle is on, so a machine online sees today's table and a machine offline
// sees a dated one. Settings ship near-daily — a registry without a date would
// read as current forever.
//
// No dependency on vscode: this is fed strings and returns data.

// Markdown escapes a literal pipe inside a cell as `\|`, which is the only
// reason splitting on the separator is safe at all.
function splitRow(line) {
    const cells = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
        if (ch === '|') { cells.push(cur); cur = ''; continue; }
        cur += ch;
    }
    cells.push(cur);
    // A row is written `| a | b |`, so the split leaves an empty cell at each end.
    if (cells.length && !cells[0].trim()) cells.shift();
    if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
    return cells.map((c) => c.trim());
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * The lines under a heading, up to the next heading of the same level or higher.
 * Returns [] when the heading is not there — which is the failure a restructured
 * docs page produces, and the caller is expected to notice rather than ship it.
 */
function sectionLines(md, title) {
    const lines = md.split('\n');
    let depth = 0;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        const m = HEADING.exec(lines[i]);
        if (!m) continue;
        if (start < 0) {
            if (m[2].trim() === title) { depth = m[1].length; start = i + 1; }
            continue;
        }
        if (m[1].length <= depth) return lines.slice(start, i);
    }
    return start < 0 ? [] : lines.slice(start);
}

const SEPARATOR = /^\|?[\s:|-]+\|[\s:|-]*$/;

function tableRows(lines) {
    const rows = [];
    let inTable = false;
    for (const line of lines) {
        if (!line.trimStart().startsWith('|')) { inTable = false; continue; }
        if (SEPARATOR.test(line.trim())) { inTable = true; continue; }
        if (!inTable) continue;      // the header row, which precedes the separator
        rows.push(splitRow(line.trim()));
    }
    return rows;
}

// `[text](/docs/en/thing)` says nothing useful in a table cell whose links
// cannot be followed, and `<Note>` blocks are page furniture.
function plainText(md) {
    return md
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// The default is written as a sentence, not a column: "**Default**: `30` days,
// minimum `1`." — so the whole sentence comes out, the backticked value becomes
// the default and whatever qualified it becomes a note. Taking only the
// backticks left "days, minimum `1`." at the head of the description.
const DEFAULT_RE = /\*\*Defaults?\*\*:?\s*`([^`]*)`([^.]*)\.?/;
const SINCE_RE = /(?:Requires |Applies in |Claude Code )v?(\d+\.\d+\.\d+)(?:\s+(?:or later|and later))?/;
const MANAGED_RE = /\(Managed settings only\)/i;
// The whole sentence a version gate is written as, so it can be removed rather
// than trimmed: "Requires Claude Code v2.1.242 or later."
const REQUIREMENT_RE = /\s*(?:Requires|Applies in) (?:Claude Code )?v?\d+\.\d+\.\d+(?:\s+(?:or later|and later))?\.?/i;

// The type is read off the default rather than declared anywhere: `true` is a
// boolean, `30` a number, `"latest"` a string. A key with no documented default
// keeps type '' — saying "string" because it looks like one would be a guess,
// and the tab has to distinguish "no default" from "defaults to empty".
function typeOf(def) {
    if (def === 'true' || def === 'false') return 'boolean';
    if (/^-?\d+(\.\d+)?$/.test(def)) return 'number';
    if (/^".*"$/.test(def)) return 'string';
    if (def === '{}' ) return 'object';
    if (def === '[]') return 'array';
    return def ? 'string' : '';
}

function entryFrom(key, descCell, file) {
    const raw = descCell || '';
    const def = DEFAULT_RE.exec(raw);
    const since = SINCE_RE.exec(raw);
    let text = plainText(raw.replace(DEFAULT_RE, '').replace(MANAGED_RE, ''));
    text = text.replace(/^[.\s:]+/, '');
    return {
        key,
        file,
        type: typeOf(def ? def[1] : ''),
        default: def ? def[1] : '',
        defaultNote: def ? plainText(def[2] || '').replace(/^[,\s]+/, '') : '',
        description: text,
        managedOnly: MANAGED_RE.test(raw),
        since: since ? since[1] : '',
    };
}

const KEY_CELL = /^`([^`]+)`$/;

function parseTable(md, heading, file) {
    const out = [];
    for (const cells of tableRows(sectionLines(md, heading))) {
        const m = KEY_CELL.exec(cells[0] || '');
        if (!m) continue;                       // a continuation row, or prose
        out.push(entryFrom(m[1], cells[1], file));
    }
    return out;
}

const KEY_HEADING = /^###\s+`([^`]+)`\s*$/;
const BULLET = /^\*\s+\*\*([A-Za-z ]+)\*\*:\s*(.*)$/;    // top level only: a nested one is indented

// One `### `key`` section: the paragraph is the description, the bullets are the
// facts. Everything below the bullets — examples, JSON blocks, tables of allowed
// values — belongs to the page, not to the tab, and is dropped.
function entryFromSection(key, lines) {
    const prose = [];
    const bullets = {};
    for (const line of lines) {
        const b = BULLET.exec(line);
        if (b) { bullets[b[1].trim().toLowerCase()] = b[2].trim(); continue; }
        if (Object.keys(bullets).length) {
            // A bullet can carry its own nested list — **Type**: Boolean spells
            // out `true` and `false` underneath — and the bullets we want come
            // after it. Only unindented prose ends the block: an example, a JSON
            // fence, a table. Breaking on the first nested line lost every
            // bullet below it, `**Default**` included.
            if (!line.trim() || /^\s/.test(line)) continue;
            break;
        }
        if (line.startsWith('#')) break;
        prose.push(line);
    }
    const scope = plainText(bullets.scope || '').replace(/`/g, '');
    const rawDefault = bullets.default || '';
    // `**Default**: `30`` gives a value; `**Default**: unset, so sessions run
    // where they are launched` gives none, and saying the default is the word
    // "unset" would read as a value the key can be set to.
    const valued = /^`([^`]*)`\s*(.*)$/.exec(rawDefault);
    const description = plainText(prose.join(' '));
    const whole = `${description} ${plainText(rawDefault)} ${scope}`;
    const since = SINCE_RE.exec(whole);
    return {
        key,
        file: /global config/i.test(scope) ? '~/.claude.json' : 'settings.json',
        type: plainText(bullets.type || '') || typeOf(valued ? valued[1] : ''),
        default: valued ? valued[1] : '',
        defaultNote: valued ? plainText(valued[2] || '') : plainText(rawDefault),
        // The gate has its own field, so the sentence that states it comes out of
        // the description whole — cutting only what SINCE_RE matched left the
        // word "Requires" dangling at the end.
        description: description.replace(REQUIREMENT_RE, '').replace(/\s{2,}/g, ' ').trim(),
        // A key the page marks `Managed` cannot be set from a user's own file at
        // all, which is what the tab needs to say — the old page marked the same
        // thing with a `(Managed settings only)` prefix in the cell.
        managedOnly: /^managed$/i.test(scope) || MANAGED_RE.test(description),
        since: since ? since[1] : '',
    };
}

// Every documented key, wherever on the page it sits. The `All settings` table
// at the top indexes the same keys as links, so it is deliberately not read:
// the sections carry the facts, the index carries none of them.
function parseKeySections(md) {
    const lines = md.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const m = KEY_HEADING.exec(lines[i]);
        if (!m) continue;
        const body = [];
        for (let j = i + 1; j < lines.length; j++) {
            if (/^#{1,3}\s/.test(lines[j])) break;
            body.push(lines[j]);
        }
        out.push(entryFromSection(m[1], body));
    }
    return out;
}

// Two files, one page. `worktree.*` keys sit under their own topic but live in
// the same settings.json; the global-config keys are a different file entirely —
// the page says a key from it put into settings.json is silently ignored, which
// is precisely the mistake the tab should let you see rather than repeat.
function parseSettingsDoc(md) {
    return parseKeySections(md || '').filter((e) => e.file === 'settings.json');
}

function parseGlobalConfigDoc(md) {
    return parseKeySections(md || '').filter((e) => e.file === '~/.claude.json');
}

function parseEnvDoc(md) {
    return parseTable(md, 'Variables', 'env');
}

// A parser that returns nothing looks exactly like a page with nothing on it.
// These floors are far below the real counts (≈120 settings, ≈290 variables at
// the time of writing) and exist so a restructured docs page fails loudly here
// rather than shipping an empty tab that reads as "you have configured
// everything".
const MIN_SETTINGS = 40;
const MIN_ENV = 60;

function buildRegistry({ settingsMd, envMd, checkedAt, source }) {
    const settings = parseSettingsDoc(settingsMd || '');
    const globalConfig = parseGlobalConfigDoc(settingsMd || '');
    const env = parseEnvDoc(envMd || '');
    // Both are reported together. Checked one at a time, a page that lost two
    // headings names only the first, and the second surfaces on the next run as
    // if it had just broken.
    const short = [];
    if (settings.length < MIN_SETTINGS) short.push(`settings table yielded ${settings.length} rows, expected at least ${MIN_SETTINGS}`);
    if (env.length < MIN_ENV) short.push(`env table yielded ${env.length} rows, expected at least ${MIN_ENV}`);
    if (short.length) throw new Error(short.join('; '));
    const byKey = (a, b) => a.key.localeCompare(b.key);
    settings.sort(byKey);
    globalConfig.sort(byKey);
    env.sort(byKey);
    return { checkedAt: checkedAt || '', source: source || {}, settings, globalConfig, env };
}

module.exports = {
    buildRegistry, parseSettingsDoc, parseGlobalConfigDoc, parseEnvDoc, parseKeySections,
    sectionLines, tableRows, splitRow, plainText, entryFrom,
};
