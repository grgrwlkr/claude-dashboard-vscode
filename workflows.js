// Workflow runs, read from the two trees Claude Code writes them to.
//
// A finished run leaves one snapshot: <session>/workflows/<runId>.json, written
// once when the run ends. A live run leaves nothing there — only the journal and
// the agent transcripts under <session>/subagents/workflows/<runId>/. The `wf_`
// prefix belongs to the run id itself, not to the naming of those paths, so
// joining one never prepends it: 73 of 73 snapshots on this machine have
// `runId === basename(file, '.json')`. Both trees are undocumented internals of a
// client that ships almost daily, so every field here is optional and a parse
// failure yields nothing rather than a wrong number.
//
// No dependency on vscode: the roots are parameters, so this runs under plain node.

const fs = require('fs');
const path = require('path');

// The client writes a capped preview as 400 characters plus an ellipsis — 2590 of
// them are exactly that on this machine — but that is its habit, not a promise,
// and a run with dozens of agents would carry all of it into a panel.
const PREVIEW_CHARS = 400;

// Cut at the same 400 and put the ellipsis back, which leaves the client's own
// 401-character preview exactly as it was and marks anything we cut ourselves.
// The marker is the point: a preview is read as prose, and prose broken off
// mid-word without one reads as something the agent actually wrote.
function clip(text) {
    const s = text || '';
    return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}…` : s;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// One entry of workflowProgress, in the shape the rest of the extension uses.
// `state` is the client's own word for it: done, start, progress and error are
// what 1356 live entries hold, and the list is open — mapping it to a vocabulary
// of ours would turn the next word the client invents into a blank cell, so it is
// passed through and rendered as it comes.
function agentOf(entry) {
    if (!entry || entry.type !== 'workflow_agent' || !entry.agentId) return null;
    return {
        agentId: String(entry.agentId),
        label: entry.label || '',
        phase: entry.phaseTitle || '',
        model: entry.model || '',
        state: entry.state || '',
        tokens: entry.tokens || 0,
        toolCalls: entry.toolCalls || 0,
        durationMs: entry.durationMs || 0,
        lastToolName: entry.lastToolName || '',
        // Bounded here, the way system.js bounds a hook command and a job detail:
        // the size of a row is ours to decide, not the client's to hand us.
        promptPreview: clip(entry.promptPreview),
        resultPreview: clip(entry.resultPreview),
    };
}

/**
 * The final snapshot of one run, read from <session>/workflows/<runId>.json —
 * the path arrives fully formed, so nothing here knows about that layout. Returns
 * null only when the file cannot be read or parsed at all: a snapshot missing half
 * its fields still describes a run, and hiding it would lose the record entirely.
 */
function readFinal(jsonPath) {
    const raw = readJson(jsonPath);
    // An array parses as an object, and a file holding one would otherwise become
    // a phantom run with a name taken from its own filename.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const progress = Array.isArray(raw.workflowProgress) ? raw.workflowProgress : [];
    const agents = progress.map(agentOf).filter(Boolean);
    const phases = (Array.isArray(raw.phases) ? raw.phases : [])
        .filter((p) => p && p.title)
        .map((p) => ({ title: String(p.title), detail: p.detail ? String(p.detail) : '' }));

    return {
        runId: raw.runId || path.basename(jsonPath, '.json'),
        name: raw.workflowName || '',
        status: raw.status || '',
        durationMs: raw.durationMs || 0,
        phases,
        agents,
        scriptPath: raw.scriptPath || '',
        totals: {
            // Two counts, because they genuinely differ: a killed run was seen
            // claiming 74 agents while carrying 13 usable entries — the rest were
            // queued and never got an id. `agents` is what a list can actually
            // show, `reported` is what the client counted, and the gap between
            // them is a fact about the run, not an error to paper over.
            agents: agents.length,
            reported: raw.agentCount || 0,
            tokens: raw.totalTokens || 0,
            toolCalls: raw.totalToolCalls || 0,
        },
    };
}

// The `meta` block of a workflow script is a pure literal by contract — no
// variables, no calls, no interpolation — which is what makes reading it with a
// regular expression sound. It is still someone else's file, so nothing is
// evaluated: a script is code, and code from disk does not get run to draw a
// tree label.
//
// The key quotes are optional because both spellings ship: a hand-written script
// writes `title:`, while the workflows Claude Code itself ships (/code-review,
// /deep-research) serialize their meta as JSON and write `"title":`. Six of the
// 64 scripts on this machine are the latter — the six every user has.
const META_RE = /export\s+const\s+meta\s*=\s*\{/;
const PHASES_RE = /phases\s*:\s*\[([\s\S]*?)\]/;
const ENTRY_RE = /\{[^{}]*\}/g;
// Group 1 is the quote around the key, present only to force it to be symmetric;
// the value is group 3. A key must start at `{`, `,` or whitespace, or `subtitle:`
// would answer to `title:` — and reading the wrong value is worse than reading
// none.
const TITLE_RE = /(?:^|[{,\s])(?:title|(['"`])title\1)\s*:\s*(['"`])(.*?)\2/;
const DETAIL_RE = /(?:^|[{,\s])(?:detail|(['"`])detail\1)\s*:\s*(['"`])(.*?)\2/;

// The text of the `meta` literal, from the brace META_RE stopped on to the one
// that closes it. Everything below reads this and not the file, because a script
// that declares no phases has none: without the bound, the first `phases:` its
// own code happens to log becomes the answer, and an invented phase is the one
// failure this module must never produce.
//
// Counting depth means walking the text, and walking it means honouring string
// literals — a brace written in prose is a character, not a level — and honouring
// an escape inside one, or a quote the script escaped would end the string early.
// Comments are not skipped: an apostrophe in one would swallow the rest of the
// literal, which costs the phases and never fabricates any.
function metaBody(text, open) {
    let depth = 0;
    let quote = '';
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = '';
        } else if (c === "'" || c === '"' || c === '`') quote = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return text.slice(open, i + 1);
    }
    // Truncated file, or a literal that never closes: there is nothing to read.
    return '';
}

/**
 * The phases of a run whose snapshot does not exist yet — title and detail, in
 * the order the literal lists them. Live runs have nowhere else to get them.
 */
function phasesFromScript(text) {
    const body = String(text || '');
    const meta = META_RE.exec(body);
    if (!meta) return [];
    const block = PHASES_RE.exec(metaBody(body, meta.index + meta[0].length - 1));
    if (!block) return [];
    const out = [];
    for (const entry of block[1].match(ENTRY_RE) || []) {
        const title = TITLE_RE.exec(entry);
        if (!title) continue;
        const detail = DETAIL_RE.exec(entry);
        out.push({ title: title[3], detail: detail ? detail[3] : '' });
    }
    return out;
}

module.exports = { readFinal, phasesFromScript };
