# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/), with the VS Code convention that an **odd** minor
is a pre-release and an **even** one is a stable release.

## [0.19.0] — 2026-08-11

First public release. Everything below existed before it, built and used
locally; this is the version that leaves one machine.

### Added

- **A templated status bar.** `claudeStatusline.segments` is a list of strings,
  one status-bar item each, written with `{placeholders}`, `[optional groups]`
  that vanish whole, and literal text. Around fifty placeholders across limits,
  session, spend, work and workflow runs.
- **Tooltips and a Now tab from one source.** Each item's hover and the
  dashboard's first screen are rendered from the same section list, so the two
  cannot disagree.
- **A usage dashboard** — twenty-two tabs over an index of every transcript on
  the machine: spend by day, model, project and branch; agents, workflows,
  tools, MCP servers, skills and files; cache efficiency, friction, the weekly
  window over time; and a Setup section that reads the installation itself.
- **A workflow panel** — a tree of workflow runs in the Activity Bar with three
  states (running, finished, abandoned), phases and agents, priced from `usage`
  records only.
- **A settings editor** in the dashboard: eleven ready-made bars, a live preview
  per segment and a placeholder palette carrying current values.
- **`claudeStatusline.fetchLimits`** — the one outbound request is opt-out. Off
  means the OAuth token is not read at all.

### Notes

- macOS and Linux. On Windows the extension degrades quietly instead of
  reporting wrong numbers, but it is not supported.
- Spend is an estimate computed from public per-million-token rates, not a bill.
- Unofficial; not affiliated with Anthropic.
