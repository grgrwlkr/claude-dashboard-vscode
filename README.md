# Claude Statusline

Claude Code limits, session context and spend — in the VS Code status bar.

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

## Configuring the bar

The items above are just the default value of `claudeStatusline.segments`.
One string is one status-bar item, left to right:

```jsonc
"claudeStatusline.segments": [
  "✻ 7d {weekly} {weeklyBar}[ dry {dry}]",
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

Run **Claude Statusline: List status-bar placeholders** to see every name
alongside the value it has on this machine right now, and copy one.

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
["$(server) {sessions} sessions[ · {jobs} jobs][ · {openTasks} open]", "today ~{today}"]
```

Tooltips are not configurable and do not need to be: each segment gets the full
tooltip of every topic it mentions, so hiding a number from the bar never hides
it from the hover. Colour follows the same rule — a segment carrying a limit or
a context fill turns yellow past 50 % and red past 80 %.

Reading is lazy: a field no segment mentions is never collected, so a bar
without `{today}` does not pay for the walk across every project it needs.

## Usage dashboard

Click any status-bar item, or run **Claude: Open usage dashboard**. Twenty-one
tabs in four sections: three drawn from an index of every transcript on the machine, and
one that reads the installation itself.

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
| Health | settings as they resolve, MCP servers, plugins and what each ships — each marked used or idle by whether anything of it appears in the transcripts — hooks, permission rules |
| Background jobs | every background agent: state, tokens burned, the session it holds, and the scratch directory it never cleaned up |
| Live now | sessions whose process is alive, editors attached, daemon workers — and registry entries left by sessions that crashed |
| Task lists | todo lists left behind by sessions, and what is still open in them |
| Disk | every directory under `~/.claude` by size, with the leftovers named: a finished job's scratch, abandoned marketplace clones, superseded plugin copies |
| Context budget | the files loaded into every prompt — `CLAUDE.md`, `rules/`, project memory — sized in tokens and priced across every request made |
| Changelog | the client's own changelog, cut at the version currently running |

Nothing in the Setup section writes to `~/.claude`, and there is no delete
button anywhere in it: the numbers are the point, the decision is the user's.
Two files are never read at all — `.credentials.json`, and the `authToken` an
IDE lock file carries.

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
can also hold transcripts that no snapshot names — 175 of them here, ~$120
across 10 runs — and that money is shown beside the run rather than folded into
a total whose meaning is "the agents you can see".

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

```bash
npx @vscode/vsce package
code --install-extension claude-statusline-*.vsix
```

Then reload the window (`Cmd+Shift+P` → Reload Window) — VS Code keeps the old
code in the extension host until you do.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `claudeStatusline.refreshInterval` | `60` | Refresh period for limits and session stats, seconds |
| `claudeStatusline.alignment` | `right` | Which side of the status bar (needs a reload) |
| `claudeStatusline.priority` | `100` | Position within that side (needs a reload) |

Commands: **Claude: Open usage dashboard**, **Claude: Rebuild the usage index**,
**Claude Statusline: Refresh now**.

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
