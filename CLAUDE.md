# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A VS Code extension that reads Claude Code's own on-disk state (`~/.claude/**`) and the OAuth usage
endpoint, and renders four status-bar items plus a usage dashboard. `README.md` documents the
user-facing behaviour and every data source in detail — read it before changing what a number means.

## Commands

```bash
node --test 'test/*.test.js'                                  # whole suite
node --test test/usage.test.js                                # one file
node --test --test-name-pattern 'pace' test/usage.test.js     # one test by name
npx @vscode/vsce package                                      # build the .vsix
code --install-extension claude-statusline-*.vsix             # install it
```

No dependencies, no build step, no lint config, no npm scripts — plain CommonJS run by VS Code and
by `node --test`. Bump `version` in `package.json` on every rebuild: a same-version reinstall leaves
the old code live in the extension host. Reloading the window is the user's action, never yours —
other Claude sessions may be alive in it.

## Architecture

`extension.js` is the **only** module allowed to `require('vscode')`. `usage.js`, `session.js`,
`indexer.js`, `pricing.js`, `history.js`, `system.js`, `segments.js` and `dashboard.js` are deliberately vscode-free
so `node --test` can cover them without a harness — put new logic there, not in `extension.js`.

**Two trees are read, and only one is ours.** `indexer.js` and `system.js` read `~/.claude`, which
belongs to Claude Code: never write there. Anything of ours — the index, the limit history — goes in
the extension's `globalStorage`. `.credentials.json` and the `authToken` in an IDE lock file are
never read at all; `system.js` has tests that assert both stay out of its output.

**The bar is a template, not a layout.** `claudeStatusline.segments` is a list of strings; each one
becomes a status-bar item. `segments.js` holds the grammar (`{field}`, `[optional group]`, backslash
escape) and the field registry — a new number in the bar is a new entry there plus, if it needs data
nothing else reads, a line in `collectFast`/`collectSlow`. Fields declare a `topic`, which picks both
the tooltip sections and the colour source. Collection is driven by `state.needs`, so a field no
segment mentions is never read.

**Two ticks, one state object.** `slowTick` (default 60 s) owns everything expensive: the network
call for limits, the full-transcript pass in `sessionStats`, `costToday` across every project. The
fast tick (10 s) only re-reads the transcript tail and the session registry. New expensive reads go
on the slow tick.

**Cross-process contract with `~/.claude/statusline.sh`.** Both share the cache file
`~/.claude/statusline-usage.json` and its `.stamp` stampede guard — the stamp is touched *before* the
request, the cache written atomically via tmp+rename. The pace/`dry` formulas and the 50/80 %
colour thresholds are ports of that script and were checked against it on live data; keep both sides
producing the same numbers.

**Indexer fingerprints.** `refreshIndex` reuses a file's stored aggregate whenever `(size, mtime)`
are unchanged. Changing the shape of a per-file aggregate therefore requires bumping `INDEX_VERSION`
in `indexer.js`, or stale-shaped aggregates are silently reused forever. This is the least
discoverable trap in the repo.

**Dashboard** is HTML and SVG assembled as strings under a strict CSP, coloured only from
`--vscode-*` theme variables. Everything interpolated must go through `esc()`. Zero dependencies is
a policy, not an accident — no charting library.

## Conventions specific to this repo

- **Degrade, never guess.** The transcript and session-registry formats are private to Claude Code.
  Every read is wrapped so a parse failure yields a dash or a hidden item, never a wrong number. The
  pervasive `try/catch → null` is the design, not defensive clutter.
- **A new model needs two edits**: a rate in `RATES` (`pricing.js`) and a context window in
  `windowFor` (`session.js`). Unknown models are priced at Opus rates and flagged as estimated.
- Every user-visible estimate carries a tilde: spend, burn rate, `dry`, the api-wait share.
- Comments explain *why* a formula or threshold is what it is; they are unusually dense here on
  purpose, because most constants encode a compatibility decision. Match that register.
