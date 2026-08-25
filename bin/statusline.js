#!/usr/bin/env node
//
// The status line Claude Code draws under the prompt, built from the same field
// registry, the same templates and the same thresholds as the VS Code status
// bar. Wire it up in `~/.claude/settings.json`:
//
//   "statusLine": { "type": "command", "command": "node /path/to/bin/statusline.js" }
//
// Templates are given as arguments, so the whole layout lives in that one line:
//
//   "command": "node .../statusline.js '✻ 7d {weekly} {weeklyBar}' '▤ {ctx} {ctxTokens}'"
//
// With no arguments it falls back to CLAUDE_STATUSLINE_SEGMENTS (a JSON array)
// and then to the extension's own defaults. `--no-color` and a set NO_COLOR both
// drop the escapes.
//
// Everything it prints comes from the JSON on stdin. No file is opened, no
// request is made, and no credential is read.

const term = require('../terminal');
const seg = require('../segments');
const u = require('../usage');
const s = require('../session');
const wfm = require('../workflows');
const dashboard = require('../dashboard');
const { fmtCost } = require('../pricing');

// The same helpers the extension hands the registry, from the same modules. A
// second set of formatters here is how a figure comes to be spelled two ways.
const registry = seg.fields({
    fmtCost,
    fmtDry: (ts) => u.fmtDry(ts),
    fmtLeft: u.fmtLeft,
    fmtAbs: (ts) => u.fmtAbs(ts),
    fmtDuration: s.fmtDuration,
    tok: wfm.tokenLabel,
    shortModel: (model) => (model ? dashboard.shortModel(model) : ''),
});

function templatesFrom(argv) {
    const args = argv.filter((a) => a !== '--no-color');
    if (args.length) return args;
    const fromEnv = process.env.CLAUDE_STATUSLINE_SEGMENTS;
    if (fromEnv) {
        try {
            const parsed = JSON.parse(fromEnv);
            if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
        } catch { /* a malformed variable falls through to the defaults */ }
    }
    return seg.DEFAULT_SEGMENTS;
}

function read(stream) {
    return new Promise((resolve) => {
        let buf = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => { buf += chunk; });
        stream.on('end', () => resolve(buf));
        // A status line that never resolves hangs the client's own refresh, so a
        // stream that errors is an empty payload rather than a pending promise.
        stream.on('error', () => resolve(''));
    });
}

async function main() {
    const raw = await read(process.stdin);
    let input;
    try {
        input = JSON.parse(raw);
    } catch {
        // The payload is the only source of every number here. Printing nothing
        // is the honest answer to an unreadable one; printing a template with
        // dashes in it would look like a reading.
        return;
    }

    const colour = !process.argv.includes('--no-color') && !process.env.NO_COLOR;
    const d = term.clientData(input);
    for (const line of term.renderLines(templatesFrom(process.argv.slice(2)), d, registry, { colour })) {
        process.stdout.write(`${line}\n`);
    }
}

main().catch(() => {
    // Same contract as every read in this repository: degrade to silence rather
    // than to a wrong number, and never to a stack trace in the status line.
    process.exitCode = 0;
});
