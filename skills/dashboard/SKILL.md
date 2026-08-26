---
name: dashboard
description: Show the Claude dashnlines dashboard for this session — the weekly and 5-hour limits with a pace bar, what fills the context window, and what the session has cost. Use when the user asks "сколько потрачено", "покажи лимиты", "сколько осталось", "show my limits", "how much has this session cost", or asks for the dashboard.
---

# The dashboard, in this terminal

Run it and print what it wrote, unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/dashnlines" --print --width 76
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

If it prints nothing but a line about no limits having been read, the machine
has not yet fetched a usage reading — the figures appear once Claude Code or the
status line has made that request.
