# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A VS Code extension that reads Claude Code's own on-disk state (`~/.claude/**`) and the OAuth usage
endpoint, and renders five status-bar items, a workflow tree and a usage dashboard. `README.md` documents the
user-facing behaviour and every data source in detail — read it before changing what a number means.

## Commands

```bash
node --test test/*.test.js                                  # whole suite
node --test test/usage.test.js                                # one file
node --test --test-name-pattern 'pace' test/usage.test.js     # one test by name
npx @vscode/vsce package                                      # build the .vsix
code --install-extension claude-statusline-*.vsix             # install it
```

No build step, no lint config, no npm scripts — plain CommonJS run by VS Code and by `node --test`.
Bump `version` in `package.json` on every rebuild: a same-version reinstall leaves the old code live
in the extension host. Reloading the window is the user's action, never yours — other Claude sessions
may be alive in it.

**Add a dependency when it makes the work easier. Do not reimplement what already exists.** The tree
happens to have none today; that is a fact about it, not a rule against them. Before writing a
utility, look for one that already does the job — a built-in first (`Intl`, `URL`, `node:*` ship in
the runtime and cost nothing), then npm — and if it removes real work, install it: `npm i <pkg>`,
and `vsce` packs production dependencies into the `.vsix` by itself. Verify what you are adding
instead of recalling it — `npm view <pkg> version time.modified license dependencies
dist.unpackedSize` — and prefer one with no transitive dependencies.

The test is whether it saves work, in both directions. Hand-rolling a date library, a diff, a parser
or a scheduler because "no dependencies" sounds tidy is the failure this rule exists to prevent.
Adding a package for something already written here is the other one: `pluralize` would ship a
dictionary of English irregulars for sixteen nouns that are spelled out in our own source, so it buys
nothing — while a package that replaced a hundred lines of parsing would buy a great deal. Ask which
one you are looking at, and say so in the commit.

**A version bump rides inside the commit that caused it.** Raise `version` in `package.json` as part
of the change — bump, package, install, then one commit containing both the code and the new
version. A standalone `chore(release): 0.15.1` is for the case where there is nothing else to
commit: a rebuild of unchanged code, a republish, a bump asked for on its own. Splitting an ordinary
change into "the fix" plus "the version" is the failure this rule names — it doubled sixteen
releases into thirty-two commits, and the release halves said nothing the feature commits did not
already say.

The reason to commit at all is that the installed `.vsix` is built from the **working tree**: a
bumped-but-uncommitted tree means the editor runs code that exists nowhere in git, and nothing can
be reverted to it, diffed against it, or explained by it. Installing without committing is how a
dozen versions once ended up as one uncommitted pile. So: package, install, commit — in that order,
without waiting to be asked.

## Architecture

`extension.js` is the **only** module allowed to `require('vscode')`. `usage.js`, `session.js`,
`indexer.js`, `pricing.js`, `history.js`, `system.js`, `segments.js`, `status.js`, `workflows.js` and
`dashboard.js` are
deliberately vscode-free so `node --test` can cover them without a harness — put new logic there, not in
`extension.js`. `workflows.js` owns everything about a workflow run — the walk, the three states, the money,
the tree nodes and the words on a row — because the tree, the dashboard tab and the bar fields must not
disagree about the same run.

**Two trees are read, and only one is ours.** `indexer.js` and `system.js` read `~/.claude`, which
belongs to Claude Code: never write there. Anything of ours — the index, the limit history — goes in
the extension's `globalStorage`. **One credential is touched, in exactly one place:** `usage.js`
asks the Keychain for the Claude Code OAuth token and falls back to
`~/.claude/.credentials.json`'s `claudeAiOauth.accessToken` only when the Keychain says no — it
goes into one `Authorization` header for the limits request and is never logged, cached or written
anywhere. `claudeStatusline.fetchLimits` turns that request off entirely, and off means the token
is never read either: `limitsWanted()` in `extension.js` guards both call sites, the slow tick and
the refresh command, and a test asserts neither is reached. Everything else
stays clear of it: `system.js` has tests asserting that neither `.credentials.json` nor the
`authToken` of an IDE lock file reaches its output. Say it that way — the older wording here
claimed the file was never read at all, which `usage.js:43` has always contradicted, and in a
public repository a false promise about secrets costs more than the feature is worth.

**The bar is a template, not a layout.** `claudeStatusline.segments` is a list of strings; each one
becomes a status-bar item. `segments.js` holds the grammar (`{field}`, `[optional group]`, backslash
escape) and the field registry — a new number in the bar is a new entry there plus, if it needs data
nothing else reads, a line in `collectFast`/`collectSlow`. Fields declare a `topic`, which picks both
the tooltip sections and the colour source. Collection is driven by `state.needs`, so a field no
segment mentions is never read.

**One answer, two renderings.** What the status-bar tooltips say lives in `status.js` as sections of
`{ kind: 'table' | 'meters' | 'subtitle' | 'note' }` — never markdown, never codicons. `extension.js`
renders them as a hover and the dashboard's Now tab renders the same list as panels; a `tone` on a
note says what it means (`alarm`, `safe`, `warn`, `update`, `active`, `muted`) and each side picks
its own icon or colour. A `meters` row carries its share as a **number**, so the hover can write it
with the same block characters `usage.js bar()` puts in the status bar while the page draws it as a
fill. Wording goes there, not into either renderer. `statusMetrics` is the same state as bare
numbers, for the headline tiles and the week track, which draw rather than read.

**The dashboard redraws on the slow tick.** `refreshDashboard` rebuilds the open panel from the
reading the tick just took, silently — `buildIndex({ silent: true })` skips the progress notification,
which belongs to an open the user asked for. It backs off for a hidden panel, a rebuild already in
flight, and the Settings tab, whose unsaved fields a redraw would discard; the webview reports the
open tab so the extension knows. A rebuild is a fresh document, so the page saves its section, tab
and scroll through `getState`/`setState` and restores them — read the wanted tab out *before*
restoring the section, or opening the section overwrites it with its own first tab.

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
`--vscode-*` theme variables. Everything interpolated must go through `esc()`.

**Every tab is built from four components, and nothing else.** `tile`/`tiles` is the headline strip
— label, a big monospace figure, an optional meter, a sub line pinned to the bottom so a tile
without a meter still lines up with its neighbours. `panel(title, body, { note, flush, id })` is a
block of the page: a `<h2>` outside a panel is a bug, and every tab is a stack of them. `flush` is
for a wide table — the panel keeps its border and the table runs edge to edge inside it instead of
paying for padding twice. `shareCell(text, share)` is a figure that is also a share of its column,
drawn as a rule under it. `.pair` puts two panels side by side, `.cols` packs a set of them into
balanced columns. **`title` is escaped here; `note` and `body` are markup** the caller has already
run through `esc()`.

**Colour follows the entity, never its rank.** `assignModelColors(modelOrder)` runs once per render
and fixes each model's hue; `modelColor` consults it. Keying on the row index — which is what it did
— meant the stacked chart and the list beside it agreed only because their two sort orders happen to
match. A `barList` is one hue, because it draws one measure; `byModel: true` is the exception, where
the hue carries a model's identity from the chart above it.

**Verify a page change by driving it, not by reading it.** The page is static SVG and markup, so a
dead script still looks right, a `max-width` on a table cell is silently ignored, and a track painted
in the surface colour is invisible only on the surface it sits on. Every one of those shipped and was
caught by a screenshot. `tools/preview.js` renders the page outside the editor — `--demo` renders it
from `tools/demo-index.js`, which is the only data that may be photographed for a listing — and
writes an overflow probe beside it: it walks every tab and compares each element's
`getBoundingClientRect` against the panel it lives in and against the window, exempting containers
that actually scroll. Run it at 1500/1280/1000/910/800/700/620/520 px and screenshot both themes
before calling a change done.

**A checking tool is checked against a known-bad input, or it is not a tool (2026-08-11).** The probe
above replaced one that compared `documentElement.scrollWidth` to `clientWidth` — structurally zero
on a page whose body carries `overflow-x: hidden`, so it returned "clean" at every width from the day
it was written while content was visibly clipped. What is cut off by `overflow: hidden` does not scroll and does not
widen the document; it disappears, and only geometry sees it. The replacement was not trusted for
finding two overflows either: it was run against the revision before that fix, where it reports 92
findings at 910 px and 40 at 800 px, and only then believed on a clean tree. "It found something" is
not evidence that it finds everything.

That revision is named here by its commit message rather than by a hash, and the difference is not
pedantry — the hash this paragraph used to carry died when the history was rewritten before
publication, taking the recipe with it:

```bash
BAD=$(git rev-parse --short "$(git log --format='%h %s' | rg -m1 'give the charts a scale' | cut -d' ' -f1)^")
git show "$BAD:tools/preview.js" | rg -c scrollWidth   # 1 — the probe that could not fail
```

**No charting library — measured, not assumed (checked 2026-08-10).** The CSP is not the reason: it
allows inline script, and `asWebviewUri` + `script-src ${cspSource}` is the documented path anyway.
The reasons are that a library replaces 99 of the 182 lines of chart code here and no more — the
calendar heatmap is not a chart any of them draws (uPlot has none, Chart.js needs the `matrix`
plugin), and `barList`, `hourChart` and `matrixTable` are HTML tables; that these charts are static
SVG in the markup, so they still render when the webview script fails, as it did the day
`acquireVsCodeApi` was called twice; and that `currentColor` and `var(--vscode-*)` follow the editor
theme for free, where a library needs a palette handed to it per theme. Against that, uPlot is 51 KB
of minified JS on a page that is already 400 KB.

Take one the day the charts need what they do best — zoom and pan over time, filtering legends,
dozens of series, brushing. uPlot is the candidate: MIT, zero dependencies, 51 KB. The rest of the
field is heavier or drags an ecosystem: Chart.js 6 MB unpacked with a dependency, D3 30 of them.

## Conventions specific to this repo

- **Degrade, never guess.** The transcript and session-registry formats are private to Claude Code.
  Every read is wrapped so a parse failure yields a dash or a hidden item, never a wrong number. The
  pervasive `try/catch → null` is the design, not defensive clutter.
- **Workflow money comes from `usage` records only** — the index for an agent that has stopped, a direct
  count over the growing transcript for one still running. `totalTokens` and `workflowProgress[].tokens`
  from the final snapshot are never priced: they are context sizes, not spend, and the two differ by ~29x
  on this machine (86.1M vs 2476.1M over the same agents).
- **A new model needs two edits**: a rate in `RATES` (`pricing.js`) and a context window in
  `windowFor` (`session.js`). Unknown models are priced at Opus rates and flagged as estimated.
- Every user-visible estimate carries a tilde: spend, burn rate, `dry`, the api-wait share.
- Comments explain *why* a formula or threshold is what it is; they are unusually dense here on
  purpose, because most constants encode a compatibility decision. Match that register.
