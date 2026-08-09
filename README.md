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

Four independent items — each one colours and hides on its own.

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

## Usage dashboard

Click the spend item, or run **Claude: Open usage dashboard**. Seven tabs, drawn
from an index of every transcript on the machine:

| Tab | What it answers |
| --- | --- |
| Overview | spend all-time / 30d / 7d / today, daily stacked chart by model, a calendar heatmap, model breakdown, hour-of-day profile |
| Sessions | every transcript as a row: project, kind, models, duration, requests, tokens, spend |
| Projects | which repository the money went to |
| Branches | spend per git branch, accumulated across sessions |
| Agents & workflows | main vs subagent vs workflow spend, and each workflow run with its agent count |
| Skills | which skill was driving when the tokens burned, from the transcript's own `attributionSkill` |
| Content | prompt counts, length histogram, where prompts came from, and the words you use |

The Agents tab is the reason this exists: subagents and workflow agents write
their own transcripts, so on a machine that runs them their spend is the larger
half — and it is invisible in the terminal statusline, which only ever sees one
session.

**Indexing.** The first run reads every transcript — about 1.1 GB and 4–5 s on
the machine this was built on — behind a progress notification. After that a
file whose size and mtime are unchanged is reused as-is, so a refresh costs tens
of milliseconds. The index lives in the extension's global storage, holds only
aggregates, and is rebuilt from scratch by **Claude: Rebuild the usage index**.

**The Content tab never stores prompt text** — only counts, a length histogram
and word tallies. Words shorter than five letters are ignored, and anything
appearing in most sessions is dropped as filler, which works in any language
without a stop-word list. Nothing leaves the machine.

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
- **Spend** — computed from public per-million-token rates in `pricing.js`
  (checked 2026-08-08). It is an **estimate, not a bill**: the real figure
  depends on plan and discounts. An unrecognised model is priced at Opus rates
  and flagged as such in the tooltip.

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
