---
name: dashboard
description: Show the Dashnlines for Claude dashboard for this session — the weekly and 5-hour limits with a pace bar, what fills the context window, and what the session has cost. Use when the user asks "сколько потрачено", "покажи лимиты", "сколько осталось", "show my limits", "how much has this session cost", or asks for the dashboard.
---

# The dashboard, in this terminal

Run it and print what it wrote, unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/dashnlines" --print --no-color --width 76
```

The doubled slash a path like this can produce is harmless — POSIX collapses it
— and is safer than trimming it: `CLAUDE_PLUGIN_ROOT` is documented without a
trailing slash, and a build that follows the documentation would otherwise
concatenate into a wrong path.

Then paste the output into your reply inside a fenced block, exactly as it came
back. Do not summarise it, reorder it or re-word the figures: every line is
already written for a reader, and the wording is shared with the VS Code status
bar so that the two never disagree.

It describes the session it is run from, found through `$CLAUDE_CODE_SESSION_ID`.

`--print` is what makes it draw one frame and exit. Run without it in a terminal
of their own, the same command opens a tabbed screen — tell the user that is
there when they ask for more than the figures above:

```bash
dashnlines
```

Useful flags:

| flag | what it does |
| --- | --- |
| `--width N` | draw at a fixed width instead of the terminal's |
| `--no-color` | drop the ANSI escapes |
| `--session ID` | describe another session |
| `--tab spend` | print another tab: `now`, `spend`, `agents`, `sessions` |

Missing limits mean that this print operation has no usable local usage-cache reading;
the cache may be absent, unavailable, invalid or older than the implementation's TTL.
Other work/session sections may still be present. This read-only print path does not
fetch OAuth usage and does not prove that the machine has never fetched it.

The frame describes Claude's selected session and may include neighboring session
names or locations. Return it locally to the requesting user; do not forward it to
another service or substitute these figures for Codex/Astra usage without a separate
request.
