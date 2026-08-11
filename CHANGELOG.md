# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/), with the VS Code convention that an **odd** minor
is a pre-release and an **even** one is a stable release.

Everything below 0.19.19 was built and installed on one machine — the extension
had not been published yet. The history is kept anyway: it is what the dashboard
grew out of, and a version that shipped nothing is worth saying so.

## [0.19.23] — 2026-08-11

### Changed

- The listing says where the pause lives: the page header and the Settings tab
  move the same switch.

## [0.19.22] — 2026-08-11

### Added

- **Pause the refresh from the page header**, beside Reindex and the countdown.
  It is the same `claudeStatusline.autoRefresh` as the switch on the Settings
  tab — one setting with two controls, and moving either moves the other. While
  it is paused the page is not rebuilt at all, so an expanded list stays
  expanded and the scroll position stays put; the countdown says `paused`
  instead of counting.

## [0.19.21] — 2026-08-11

### Changed

- The listing counts the tabs again — twenty-three, not twenty-two — and says
  what the Claude Code tab answers.
- Privacy names the credential masking as a promise rather than leaving it as an
  implementation detail, and describes the optional refresh by what it fetches
  (Anthropic's published documentation and changelog, public files, no
  credentials) rather than by counting URLs that keep changing.

## [0.19.20] — 2026-08-11

### Added

- **A Claude Code tab**, under Setup. It answers three questions and keeps them
  apart: what you have set, what you could set, and what you have moved away
  from the default. The settings files are listed in the order the client
  resolves them — managed first, then the project, then you — with the file that
  won each key named, the files it shadowed counted, and a button to open any of
  them. Environment variables are shown twice on purpose: the `env` block every
  session gets, and what this editor window happens to have inherited, which are
  not the same thing and disagree often enough to be worth saying.
- **A settings reference**, parsed from Anthropic's published documentation and
  packaged with the extension, so defaults and descriptions are there offline.
  It carries the date it was read. With the network switch on it refreshes
  itself; with it off the tab says how old the packaged copy is rather than
  presenting it as current.

### Fixed

- **Values that read like credentials are hidden.** The Health tab printed the
  `env` block of `~/.claude/settings.json` verbatim, so anyone keeping an
  `ANTHROPIC_API_KEY` there had it drawn on the page. Anything whose name looks
  like a key, token, secret or password now renders as `•••`, at any depth
  inside an object — but not when the value is a plain number, because
  `MAX_THINKING_TOKENS` is a budget and hiding it helps nobody.
- **Managed settings are read.** `/Library/Application Support/ClaudeCode/managed-settings.json`
  overrides everything else on a machine that has one, and the extension did not
  look at it — so on a managed install every number it derived from settings
  could be wrong.

## [0.19.19] — 2026-08-11

### Changed

- **Renamed.** The extension is *Dashboard & Statusline for Claude Code*, and its
  id moved from `claude-statusline` to `claude-dashboard`. It outgrew the old
  name: the bar is one surface of it, the dashboard is the product. Settings keys
  stay `claudeStatusline.*` — renaming those would break configs for no visible
  gain.
- **A new icon**, chosen against the icons of the extensions people actually
  install: a progress ring for the limit and three bars for the dashboard, on a
  teal-to-indigo plate that survives 32 px. The old one is kept in the repository
  as `media/icon-v1`.
- The same mark now sits next to the title on the dashboard page.
- The README is a listing page rather than a reference manual: badges, six
  selling points, four dark/light screenshot pairs, a table of contents, and a
  **Known issues** section that says what does not work (Windows, remote hosts,
  vscode.dev) instead of leaving it to be discovered.

## [0.19.18] — 2026-08-11

### Fixed

- The limits request is the extension's own: it reads the token and writes the
  shared cache itself, so nothing here needs a configured `statusline.sh`. The
  documentation said otherwise.

## [0.19.17] — 2026-08-11

### Fixed

- The word tally on the Content tab counts typed prose only, once per prompt, and
  no longer treats file paths and ids as vocabulary.

## [0.19.16] — 2026-08-11

### Fixed

- A panel note renders as a block, so notes that carry lists are not flattened.

## [0.19.15] — 2026-08-11

### Added

- The Health tab says, per plugin, where its update would come from.

## [0.19.14] — 2026-08-11

### Fixed

- The hover panel was transparent and read as two rows at once.

## [0.19.13] — 2026-08-11

### Fixed

- The update check actually checks, and old releases fold away instead of filling
  the tab.

## [0.19.12] — 2026-08-11

### Added

- Every setting on the Setup page, each with the switch where it applies, and a
  countdown to the next refresh.

## [0.19.11] — 2026-08-11

### Added

- **Usage credits** — what the account has spent past its plan. The only figure
  in the extension that is billed money rather than an estimate, and the only one
  written without a `~`.

## [0.19.10] — 2026-08-11

### Added

- **A monthly budget** (`claudeStatusline.monthlyBudget`): the month drawn against
  a ceiling, with a word at 80 % and at 100 % — once each, not every tick.
- **Export** of the index as CSV or JSON.
- **Plugin and MCP health**: what each plugin ships, which of it ever ran, and
  which MCP servers earn their place. Version checking against a plugin's
  marketplace is opt-in (`claudeStatusline.checkPluginUpdates`).
- **A memory tab**: the files loaded into every prompt — `CLAUDE.md`, `rules/`,
  project memory — sized in tokens and priced across every request made.

## [0.19.9] — [0.19.4] — 2026-08-11

### Added

- The Now tab grew a live workflow panel: one table per running run, a row per
  agent with the model and the effort it was given, agents named rather than
  numbered, and in dispatch order.

### Fixed

- Every agent of a run is listed, not the first page of them.
- A run whose session is alive is given an hour of quiet before it counts as
  abandoned, rather than ten minutes — slow runs were being written off.
- Long names wrap at word boundaries and say the whole thing on hover.

## [0.19.3] — [0.19.2] — 2026-08-11

### Fixed

- The charts have a y-axis with round ticks, the calendar has a scale that says
  what the darkest cell costs a day, and a bar list no longer draws 1 % as a full
  bar when a percentage series has a single row.
- The overflow probe was replaced: the old one compared `scrollWidth` to
  `clientWidth` on a page that hides overflow, which cannot ever report a
  problem. The new one measures geometry, and was verified against a revision
  known to be broken.

## [0.19.1] — [0.19.0] — 2026-08-11

### Added

- Everything needed to publish: a marketplace identity, an icon, a licence,
  workspace-trust capabilities, and `claudeStatusline.fetchLimits` — the one
  outbound request made opt-out, where off means the OAuth token is never read.

### Changed

- The whole page rebuilt on one vocabulary: tiles, panels, share cells. No
  heading outside a panel anywhere in the 22 tabs.
- The first screen redesigned, and the hovers given meters that match the bar.

### Fixed

- A test that could not fail on a calendar boundary, and a preset description
  that printed its own markdown.

## [0.18.0] — [0.15.1] — 2026-08-10

### Added

- **A settings editor** in the dashboard: ready-made bars, a field per segment
  with a live preview, and a placeholder palette carrying current values.
- **The Now tab**, cut from the same sections as the status-bar tooltips, so the
  page and the hover cannot disagree.
- The open page redraws on the same tick as the bar, keeping its section, tab and
  scroll position.

## [0.10.1] — [0.9.0] — 2026-08-10

### Added

- **The workflow panel**: a tree of runs in the Activity Bar with three states
  (running, finished, abandoned), phases and agents, priced from `usage` records
  only — a live run assembled from its journal and its agents' transcripts,
  because the snapshot is written once, at the end.
- Status-bar placeholders for a running workflow, commands to open the run's
  script and copy its id.

## [0.6.4] — [0.6.0] — 2026-08-09

### Added

- **The usage dashboard** over an index of every transcript on the machine, open
  from any status-bar item.
- Tooltips rewritten for a GUI rather than for one terminal line.

### Fixed

- The session reported is the one this window is actually using.

## [0.5.0] — 2026-08-09

### Added

- The first build: Claude Code's limits, context and spend in the VS Code status
  bar, read from `~/.claude` and the account's usage endpoint.
