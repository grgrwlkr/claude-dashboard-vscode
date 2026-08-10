# Security

## What this extension touches

It reads Claude Code's own state under `~/.claude` — transcripts, the session
registry, settings, plugins, workflow runs — and never writes there. Its own
data (the aggregate index, the limit history) lives in the extension's
`globalStorage`.

One credential is involved, in one place. `usage.js` reads the Claude Code OAuth
token from the macOS Keychain (`Claude Code-credentials`), falling back to
`~/.claude/.credentials.json`, and sends it in a single `Authorization` header to
`https://api.anthropic.com/api/oauth/usage`. The token is not logged, cached,
copied or sent anywhere else, and `claudeStatusline.fetchLimits: false` stops it
from being read at all.

The `authToken` an IDE lock file carries is never read; `system.js` has tests
asserting that neither it nor `.credentials.json` reaches its output.

There is no telemetry.

## Reporting a vulnerability

Open a [security advisory](https://github.com/grgrwlkr/claude-statusline-vscode/security/advisories/new)
rather than a public issue, and give it a few days. This is a spare-time
project: expect an answer, not an SLA.

Please do report anything that would put a credential, a transcript or a prompt
somewhere it does not belong — that is the class of bug that matters most here.

## Not in scope

- Anything about Claude Code itself: report those to
  [Anthropic](https://hackerone.com/anthropic).
- The estimate being different from your bill. Spend is computed from public
  rates and is documented as an estimate.
