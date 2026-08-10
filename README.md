# Statusline for Claude Code

Claude Code limits, session context and spend — in the VS Code status bar.

> Unofficial. Not affiliated with, endorsed by or sponsored by Anthropic, PBC.
> "Claude" and "Claude Code" are their trademarks; this extension only reads what
> the tool leaves on your own disk.

The Claude Code extension does not execute the `statusLine` command from
`~/.claude/settings.json`: the native panel has no status line at all, and the
upstream requests for parity with the CLI were closed as stale
([#55643](https://github.com/anthropics/claude-code/issues/55643),
[#21265](https://github.com/anthropics/claude-code/issues/21265)). This
extension covers the part that does not need the CLI.

```text
✻ 7d 27% ▒▒░░░░ dry 12.08 ~13h    ▤ 29% 294k/1M    ~$114.29 $5.18/h    ⧉ 2 ▸ 3/6
```

Four independent items — each one colours and hides on its own — plus a fifth
that appears only while a workflow is running.

**Limits.** `7d` is the share of the weekly limit. The bar shows spend against a
linear plan for the window: `▓` are cells ahead of plan, `·` are plan cells not
yet reached, `▒` is spend on schedule. `dry` is when you hit 100% if the pace
holds — an hour rather than a minute, because `percent` arrives as an integer
while the forecast scales with `(100−p)/p`, so a single unit of rounding moves
the answer by hours. That is what the tilde says. When the forecast lands after
the reset, the item stays quiet and the tooltip says so in words.

**Session context.** How full the window is for the Claude session open in *this*
VS Code window. Hovering shows the model, effort, thinking, advisor, the share of
context served from cache, the auto-compact threshold, the output style, the
branch, and the client version — including one already unpacked and waiting.

**Spend.** An estimate for the session with a burn rate. Hovering adds today's
spend, duration, the share of time spent waiting on the model, the request count,
and the lines added and removed during the session.

**Work.** `⧉` counts other live sessions in this repository (busy ones in
parentheses), `▸` tracks the current session's task list.

**Workflow.** While a workflow runs anywhere on the machine, this names it and
counts the agents that have settled against the ones it dispatched, with how
long it has been going. Between runs it has nothing to say and is not drawn.

## Requirements

- **Claude Code** installed and used on this machine — the extension reads its
  state and asks nothing of the CLI.
- **VS Code 1.100** or newer. Cursor, Windsurf, VSCodium and Gitpod install it
  from Open VSX.
- **macOS or Linux.** Windows is not supported: the token lives behind the macOS
  Keychain or in the credentials file, and session ownership is resolved with
  POSIX `ps`. On Windows the extension degrades quietly — items stay hidden
  rather than showing wrong numbers — but that is tolerance, not support.

## Configuring the bar

The items above are just the default value of `claudeStatusline.segments`.
One string is one status-bar item, left to right:

```jsonc
"claudeStatusline.segments": [
  "✻ 7d {weekly}[ {drift}] {weeklyBar}[ dry {dry}]",
  "▤ {ctx} {ctxTokens}/{ctxWindow}",
  "[~{cost}][ {burn}/h]",
  "[⧉ {peers}][ ▸ {todo}]",
  "[$(gear) {wfName}][ {wfAgents}][ {wfElapsed}][ ×{wfRuns}]"
]
```

Anything outside `{…}` is literal, so the icons and separators are yours to
choose — including VS Code's own `$(flame)` codicons. Square brackets mark an
**optional group**: it disappears whole when a placeholder inside it has nothing
to say, which is how `[ dry {dry}]` stays silent for the first half hour of a
window and appears by itself once a forecast exists. A segment whose
placeholders are *all* empty hides itself — which is the whole of the last line
above: every part of it is optional, so it stays invisible until a workflow
starts. A segment of pure text always shows. A backslash escapes `{`, `}`, `[`
and `]`.

There are two ways to write one without editing JSON by hand. **Setup →
Settings** in the dashboard is an editor: a field per segment, a preview under
each one rendered by the extension itself, buttons to reorder and remove, and a
palette of every placeholder with the value it has this minute — clicking one
inserts it at the caret. Saving writes the same settings keys, into your own
settings or the workspace's, and the bar redraws immediately.

It opens with eleven ready-made bars, each shown with what it would say on this
machine right now — **Default**, **Default + forecast** (the same bar with the
date always on it), **Minimal** (one item, three numbers), **Pace watcher** (how far ahead of an even burn you are and when the window runs out),
**Limits, in full** (every window plus the forecast date whether or not you
would reach it), **Spend**, **Session** (model, effort, context, compaction),
**Whole machine** (every session, not this one), **Workflows**, **The works**
(every number there is, in ten items), and **Everything, one line**. Picking one
fills the editor; nothing is written until you press Save.

Two placeholders answer "when do I run out", and the difference matters:
`{dry}` is silent when the forecast lands after the reset — running out then
never happens — while `{dryAt}` names the date either way. The default bar
carries `{dry}`; **Default + forecast** is that same bar with `{dryAt}` in its
place, and **Limits, in full** carries it too.

Outside the dashboard, **Claude Statusline: List status-bar placeholders** shows
the same list in a quick pick and copies whichever you choose.

| Group | Placeholders |
| --- | --- |
| Limits | `{weekly}` `{weeklyBar}` `{plan}` `{drift}` `{dry}` `{dryAt}` `{dryLeft}` `{reset}` `{resetLeft}` `{session5h}` `{session5hLeft}` `{scoped}` `{scoped:Opus}` |
| Session | `{ctx}` `{ctxTokens}` `{ctxWindow}` `{ctxCache}` `{compact}` `{model}` `{effort}` `{advisor}` `{thinking}` `{outputStyle}` `{branch}` `{version}` `{update}` |
| Spend | `{cost}` `{burn}` `{today}` `{requests}` `{duration}` `{apiShare}` `{added}` `{removed}` |
| Work | `{peers}` `{peersBusy}` `{todo}` `{todoActive}` `{jobs}` `{sessions}` `{openTasks}` |
| Workflow | `{wfName}` `{wfAgents}` `{wfElapsed}` `{wfCost}` `{wfRuns}` |

A few worked examples:

```jsonc
// One dense item instead of four
["✻{weekly} ▤{ctx} ~{cost}[ ⧉{peers}]"]

// Pace and per-model windows, which the default bar leaves to the tooltip
["7d {weekly} ({drift})[ · opus {scoped:Opus}]", "resets {resetLeft}"]

// Machine-wide rather than session-scoped
["$(server) {sessions}[ · {jobs} running][ · {openTasks} open]", "today ~{today}"]
```

Tooltips are not configurable and do not need to be: each segment gets the full
tooltip of every topic it mentions, so hiding a number from the bar never hides
it from the hover. Colour follows the same rule — a segment carrying a limit or
a context fill turns yellow past 50 % and red past 80 %.

Reading is lazy: a field no segment mentions is never collected, so a bar
without `{today}` does not pay for the walk across every project it needs.

## Usage dashboard

Click any status-bar item, or run **Claude: Open usage dashboard**. Twenty-two
tabs in five sections: one for the state of Claude right now, three drawn from an
index of every transcript on the machine, and one that reads the installation
itself.

Every tab is built the same way: a strip of headline figures across the top, then
one panel per answer — a title, the sentence that explains it, and the thing
itself. A figure that is a share of something is drawn as one rather than only
written: a meter under a headline number, a fill in a list, a rule under a figure
in a table so a list sorted by time can still be ranked by eye. Colours come from
the editor's own theme and follow the entity they name, so a model keeps its
colour across every chart on the page.

**Now** — the state of Claude as the page was opened:

| Tab | What it answers |
| --- | --- |
| Now | the four numbers that decide the next hour as headline tiles, the week as a track with spend, now and the forecast on one line, and under them the four status-bar tooltips at full width — both limit windows with pace and forecast, the model and how full its context is, the session's spend and the work behind it, the task list and the neighbours — plus a line per running workflow |

Those four panels are not a copy of the tooltips: both are rendered from the
same sections in `status.js`, so the page cannot fall behind the hover, and a
number squeezed out of a narrow bar is still here in full. A window is a share
of something, so it is drawn as one on both sides — a fill on the page, and in
the hover the same six block characters the status bar itself uses.

The track above them is the one thing neither the bar nor a hover can say: the
week as a length, with what has been spent measured from its left edge, a notch
at this moment, and a flag where the forecast runs out. A forecast that lands
past the reset draws no flag — the window refills before it arrives, and the
foot says so instead.

The whole page refreshes on `claudeStatusline.refreshInterval` — the same
interval the bar uses, so both show one reading of the machine. It redraws in
place and puts you back where you were: same section, same tab, same scroll
position. Three things hold it back: a panel in a background tab, a rebuild
still running, and the **Settings** tab, where a redraw would throw away
half-typed segments. Press **Reindex** for an immediate rebuild.

**Spend** — where the money went:

| Tab | What it answers |
| --- | --- |
| Overview | spend all-time / 30d / 7d / today, daily stacked chart by model, a calendar heatmap, model breakdown, hour-of-day profile |
| Sessions | every transcript as a row: its own title, project, kind, entrypoint, models and effort, duration, requests, tokens, spend |
| Projects | which repository the money went to |
| Branches | spend per git branch, accumulated across sessions |

**Work** — what it was spent on:

| Tab | What it answers |
| --- | --- |
| Agents & workflows | main vs subagent vs workflow spend, what one agent costs (median, p90, max output tokens), agents per workflow run, and every run on the machine — its name, how it ended, its phases and its spend, with the prompt and the answer of each of its agents one click away |
| Tools & MCP | which tools were called and how often, which of them fail, which MCP servers earn their place in the config, how many advisor consultations there were |
| Files | every file an edit or write touched, by edit count and by lines changed, plus the per-project numbers the client keeps for itself |
| Skills | which skill was driving when the tokens burned, from the transcript's own `attributionSkill` |
| Content | prompt counts, length histogram, where prompts came from, the words you use, and the client's own prompt log in aggregate |

**Efficiency** — whether it was spent well:

| Tab | What it answers |
| --- | --- |
| Models & effort | spend as a model × effort matrix, which client the requests came from (`cli`, `claude-vscode`, `sdk-py`), output per request per tier |
| Cache | share served from cache, what the reads saved, reads per token written, the 1h/5m TTL split, tokens by day |
| Friction | failed tool calls, denials, compactions and the context they dropped, sessions with the most failures |
| Limits | the weekly window over time, one line per week, overlaid against the even-spend diagonal |

**Setup** — the installation rather than its usage, read live from `~/.claude`:

| Tab | What it answers |
| --- | --- |
| Settings | the extension's own settings, edited here rather than in `settings.json`: eight ready-made bars to start from, the segment editor with a live preview of each line, the placeholder palette with current values, and where to save |
| Health | settings as they resolve, MCP servers, plugins and what each ships — each marked used or idle by whether anything of it appears in the transcripts — hooks, permission rules |
| Background jobs | every background agent: state, tokens burned, the session it holds, and the scratch directory it never cleaned up |
| Live now | sessions whose process is alive, editors attached, daemon workers — and registry entries left by sessions that crashed |
| Task lists | todo lists left behind by sessions, and what is still open in them |
| Disk | every directory under `~/.claude` by size, with the leftovers named: a finished job's scratch, abandoned marketplace clones, superseded plugin copies |
| Context budget | the files loaded into every prompt — `CLAUDE.md`, `rules/`, project memory — sized in tokens and priced across every request made |
| Changelog | the client's own changelog, cut at the version currently running |

Nothing in the Setup section writes to `~/.claude`, and there is no delete
button anywhere in it: the numbers are the point, the decision is the user's.
Nothing in it reads a credential either — neither `.credentials.json` nor the
`authToken` an IDE lock file carries, and `system.js` has tests asserting both
stay out of its output. The single place a credential is touched at all is the
limits request; [Privacy](#privacy) describes it exactly.

The Agents tab is the reason this exists: subagents and workflow agents write
their own transcripts, so on a machine that runs them their spend is the larger
half — and it is invisible in the terminal statusline, which only ever sees one
session. The Models & effort tab answers the question next to it: a subagent
dispatched without an explicit model or effort silently inherits the session's,
and nothing else on the machine shows that it happened.

**Indexing.** The first run reads every transcript — about 1.1 GB and 4–5 s on
the machine this was built on — behind a progress notification. After that a
file whose size and mtime are unchanged is reused as-is, so a refresh costs tens
of milliseconds. The index lives in the extension's global storage, holds only
aggregates, and is rebuilt from scratch by **Claude: Rebuild the usage index**.

Only a fraction of the lines in a transcript are parsed: a line is JSON-decoded
only if it carries a marker that matters (usage, a typed prompt, a failed tool
result, a denial, a compaction, a title). The rest — the bulk of the file, tool
traffic — is skipped by a single regex test.

**The Content tab never stores prompt text** — only counts, a length histogram
and word tallies. Words shorter than five letters are ignored, and anything
appearing in most sessions is dropped as filler, which works in any language
without a stop-word list. Nothing leaves the machine.

## Workflow runs

The `/workflows` progress tree lives in the terminal and dies with it. What
survives is on disk, and this extension reads it into three surfaces: a
**Workflow runs** tree in the Activity Bar (run → phase → agent), the runs table
on the dashboard's *Agents & workflows* tab, and the placeholders above. On the
machine this was built on that is 74 runs and 1297 agents, walked in about 25 ms.

A run is in one of three states:

- **running** — no final snapshot yet, the session that owns the run is alive,
  and something in the run's directory was written in the last ten minutes;
- **finished** — the client wrote its final snapshot, the one `.json` file the
  run leaves under `workflows/`;
- **abandoned** — everything else.

The third state is not theoretical, and it exists because of the first fact
about this data: **the snapshot is written once, at the end.** A client that
dies never writes one, and without a third state such a run would spin in the
panel forever. It also means the snapshot cannot describe a run in flight — a
running one is assembled instead from the roll-call journal the runtime keeps
for `resumeFromRunId` and from the agents' transcripts as they grow, and its
phase titles are pulled out of the copy of the workflow script saved beside it
with a regular expression. That script is never evaluated.

A running agent has no label. The label is computed in the runtime and reaches
the disk only with the final snapshot, so until a run ends its agents are named
by the first line of the prompt they were given; the real labels take over as
soon as the snapshot lands, which the panel notices within ten seconds and reads
the run's verdict, phases and duration out of at the same moment.

The tree draws the fifty newest finished runs. Runs still going and runs nobody
ever finished are always drawn: the first is what the panel is for, the second is
a handful worth knowing about, while the finished half only grows — nothing ever
takes a run off the disk.

**Money is read only from `usage` records** — the same arithmetic as everywhere
else here, applied to the workflow's own agents: from the index for an agent
that has stopped, and straight from the transcript for one still writing, re-read
incrementally so each look costs the few kilobytes that appeared since the last
one. The totals the snapshot carries — `totalTokens`, and `tokens` on every
agent in it — are never turned into dollars. They are context sizes, not spend:
what each agent was holding on its last reply, counted once. Across the runs on
this machine that is 86.1M against the 2476.1M actually billed for the same
agents, about thirty times apart, so pricing that field would understate every
run by roughly that factor. It is shown as a token count and nothing else.

A run's price is the sum over the agents its own snapshot lists. A run directory
can also hold transcripts that no snapshot names — on the machine this was built
on, 175 of them across 10 runs, a three-figure sum — and that money is shown
beside the run rather than folded into a total whose meaning is "the agents you
can see".

One run can also arrive in two halves: a background workflow puts its directory
under one session of a project and its snapshot under another session of the
same project. The two are joined into a single record, but only when they
complement each other — two directories, or two snapshots, under one run id stay
two records rather than becoming one number nobody can check.

Right-click a run to open the workflow script it was launched from, or to copy
its `runId` together with that path — what `resumeFromRunId` needs to replay a
stage that failed. There is deliberately no way to kill a run from here: the
panel observes, and a click that ends the work of somebody else's live session
is not worth having.

The reads are split the way the rest of the extension splits them. The walk
across every project is on the minute tick; a run already known to be going is
refreshed every ten seconds from its journal and the tails of its agents'
transcripts, which is bounded by the number of live agents rather than by the
history of the machine. A workflow that has just started therefore shows up to a
minute late, while one already being watched moves immediately. None of this
writes to `~/.claude`.

## Privacy

Everything on the dashboard and in the bar is read from your own disk. **One
request leaves the machine, and it is optional.**

| | |
| --- | --- |
| What is read locally | `~/.claude` — transcripts, the session registry, settings, plugins, workflow runs. Read-only: nothing of ours is ever written there. |
| What is written | Only inside the extension's own `globalStorage`: the aggregate index and the limit history. Neither holds prompt text. |
| What leaves the machine | One `GET https://api.anthropic.com/api/oauth/usage` — the same endpoint Claude Code's own `/usage` screen reads — carrying the OAuth token Claude Code already stores. At most once a minute per machine, shared with `statusline.sh` through the same cache file. |
| What happens to the token | It is read from the macOS Keychain (`Claude Code-credentials`), or from `~/.claude/.credentials.json` when the Keychain has nothing, and goes into one `Authorization` header. It is never logged, never cached, never written, never sent anywhere else. |
| Telemetry | None. No analytics, no crash reporting, no phoning home. |
| How to switch the request off | `"claudeStatusline.fetchLimits": false`. Off means the token is not read at all; the limit fields go quiet and everything drawn from local transcripts keeps working. |

The **Content** tab never stores prompt text — only counts, a length histogram
and word tallies, computed and discarded in the same pass.

## Where the data comes from

Nothing is asked of the CLI — it has no channel to ask.

- **Limits** — `api.anthropic.com/api/oauth/usage`, the same endpoint the
  `/usage` screen reads. The token comes from the Keychain
  (`Claude Code-credentials`), falling back to `~/.claude/.credentials.json`.
  The cache is shared with `~/.claude/statusline.sh`
  (`~/.claude/statusline-usage.json` plus a `.stamp` used as a stampede guard),
  so one request per minute covers every VS Code window and terminal session on
  the machine. Data older than 30 minutes is not drawn.
- **The window's session** — `~/.claude/sessions/*.json`. The panel's process is
  a direct child of the extension host, so `ppid(pid) === process.pid` maps a
  window to its own session exactly, rather than guessing at "the most recent
  record".
- **Context and statistics** — `~/.claude/projects/<slug>/<sessionId>.jsonl`.
  Context is `input + cache_read + cache_creation` of the latest record, read
  from a 256 KB tail in about 2 ms; the full pass for cost, duration and edits
  takes about 20 ms and runs on the minute tick.
- **Workflow runs** — `~/.claude/projects/<slug>/<sessionId>/workflows/<runId>.json`
  once a run has ended, and while it has not:
  `<sessionId>/subagents/workflows/<runId>/journal.jsonl` with the agent
  transcripts beside it, plus the copy of the script under `workflows/scripts/`
  for the phase titles. All of it is undocumented internal state, so every field
  is optional and a read that fails hides a row instead of filling it in.
- **Spend** — computed from public per-million-token rates in `pricing.js`
  (checked 2026-08-08). It is an **estimate, not a bill**: the real figure
  depends on plan and discounts. An unrecognised model is priced at Opus rates
  and flagged as such in the tooltip. A cache write is priced by the TTL the
  record reports — `usage.cache_creation` splits it into 5-minute and hourly
  tokens, billed at 1.25x and 2x input respectively; a record too old to carry
  the split is priced at the cheaper of the two.
- **Limit history** — nowhere, until this extension writes it: the usage
  endpoint answers only for the present moment. A row is appended to
  `limits-history.jsonl` in the extension's global storage whenever a percentage
  moves, plus a heartbeat every six hours so a quiet stretch is distinguishable
  from a closed laptop. Nothing of ours is written into `~/.claude`, which
  belongs to Claude Code.

Two figures are deliberately marked with a tilde: spend, and the share of time
spent waiting on the model — there is no exact `api_duration_ms` on disk, so it
is derived from gaps between records.

## Install

From the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=grgrwlkr.claude-statusline)
or, for Cursor / Windsurf / VSCodium / Gitpod, from
[Open VSX](https://open-vsx.org/extension/grgrwlkr/claude-statusline):

```bash
code --install-extension grgrwlkr.claude-statusline
```

From source, which is also how you develop on it:

```bash
npx @vscode/vsce package
code --install-extension claude-statusline-*.vsix
```

Then reload the window (`Cmd+Shift+P` → Reload Window) — VS Code keeps the old
code in the extension host until you do.

**Nothing appeared in the status bar?** That is the designed behaviour rather
than a failure: every item hides itself when it has nothing true to say. It has
nothing to say when Claude Code has never run on this machine (no `~/.claude`),
when no Claude session belongs to *this* window yet — open the Claude Code panel
and it appears within ten seconds — or when limits are switched off and no cache
exists. The dashboard works either way: **Claude: Open usage dashboard**.

## Settings

All four are editable from **Setup → Settings** in the dashboard, and all four
apply the moment they change — none of them needs a window reload.

| Key | Default | Meaning |
| --- | --- | --- |
| `claudeStatusline.segments` | four templates | One status-bar item per string; see [Configuring the bar](#configuring-the-bar) |
| `claudeStatusline.fetchLimits` | `true` | Ask Anthropic for the account's limits; `false` keeps the token unread and the network untouched — see [Privacy](#privacy) |
| `claudeStatusline.refreshInterval` | `60` | Refresh period for limits and session stats, seconds |
| `claudeStatusline.alignment` | `right` | Which side of the status bar |
| `claudeStatusline.priority` | `100` | Position within that side |

Commands: **Claude: Open usage dashboard**, **Claude: Rebuild the usage index**,
**Claude Statusline: Refresh now**, **Claude Statusline: List status-bar
placeholders**, and — from a row of the workflow view — **Claude: Open the
workflow script** and **Claude: Copy the workflow run id**.

## Tests

```bash
node --test 'test/*.test.js'
```

The pace and `dry` formulas are ports of `~/.claude/statusline.sh` and were
checked against it on live data — both implementations produced `plan=20` and
`dry="12.08 ~13h"` for the same input.

## Compatibility

The transcript and session-registry formats are private to Claude Code and are
not part of any published contract. This extension reads them anyway, because
there is no other source. When a Claude Code release changes them, the affected
item degrades to a dash rather than showing a wrong number.

## License

MIT
