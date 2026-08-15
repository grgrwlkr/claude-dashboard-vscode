# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/), with the VS Code convention that an **odd** minor
is a pre-release and an **even** one is a stable release.

Everything below 0.20.0 was built and installed on one machine — the extension
had not been published yet. The history is kept anyway: it is what the dashboard
grew out of, and a version that shipped nothing is worth saying so.

## [0.28.0] — 2026-08-16

### Fixed

- **A reply is charged once, at its final figures.** One API response is written
  as several records — one per content block, thinking, text and each tool call —
  and the index added every one of them, billing the same reply as many times as
  it had blocks. Across this machine's 2 475 transcripts that is 112 799 records
  for ~51 000 responses: output read 100.1M where it is **47.1M**, cache writes
  1 043M where they are 382M, input 6.8M where it is 2.0M, cache reads 25.2B
  where they are 12.6B. Every figure the dashboard draws from the index — spend,
  projects, models, the month's forecast, the budget warnings — was high by
  roughly a factor of two.

  The records of a response do not agree with each other, which is what makes
  this more than a dedupe. Two shapes occur: every record repeating the final
  `usage`, and a running counter where the early records hold a partial output
  and only the last is the answer — `3, 3, 3, 1185` on a real reply here, on
  25.5% of responses. Charging the first record instead would read 31.5M, a
  third of the output thrown away.

  A response is therefore held until the file is read and charged once, from its
  **fullest** record — the one whose usage totals the most — with the fields
  around it merged across all of them, because `usage.speed` rides on the closing
  record while the skill and the effort are on the opening one. Deliberately not
  the *last* record (below the maximum on 2 responses of 51 075 — right almost
  always, and strictly worse), not per-field maxima (`cache_creation` is nested
  and carries the TTL split, so a best-of-each-field usage would be one no reply
  ever had), and not `output_tokens` alone (it agrees with the total on all
  51 078 responses here, but only because those fields move together, which
  nothing documents). Tool calls are still counted from every record, since a
  call lives in exactly one of them.

  `INDEX_VERSION` is bumped: a stored aggregate holds the inflated numbers and
  its file has not moved, so without the bump it would be reused forever. The
  first run after this lands re-reads every transcript — about six seconds for
  2 475 files here.

- **"2843 replys"** on the Agents tab and in the Cache note. `plural` defaults
  the plural to the word plus an `s`, which is right for every other noun this
  page counts and wrong for the one it counts most. It had already reached a
  listing screenshot.
- **A dated model id now finds its rate.** `ratesFor` stripped `[1m]` and
  `-fast` but not the date, so `claude-haiku-4-5-20251001` — which is what the
  transcripts of that model actually carry — missed `RATES` and was billed at
  the Opus fallback: five times Haiku's own rate, under a row still reading
  "haiku 4.5", because `shortModel` stripped what `ratesFor` did not. On this
  machine that model reads $0.40 rather than $2.01. Found by the tilde below,
  which marked a model that was never actually unknown.

### Added

- **A model with no published rate is marked as a guess.** Its row in Models
  carries the tilde every other estimate on this page carries, and says why on
  hover: an id missing from `RATES` is billed at the `FALLBACK` rate, which *is*
  the Opus rate. Until now the session tooltip said so and the dashboard did
  not, so an unpriced model appeared there at Opus prices with nothing marking
  it. The breakdowns are the only place this is drawn — a total that merely
  includes such a model is left alone.
- **`<synthetic>` is no longer a model.** It is what the client writes in place
  of a reply that never arrived — a spent limit, a dropped connection, a 403 —
  with an all-zero usage, and it was drawn as a row of its own among the models,
  in the legend, and in the effort matrix. 137 such records here. Its count
  still reaches the Requests tile, which counts messages rather than models.

- **Spend by agent type**, on the Agents tab. The type a dispatch asked for is
  recorded in the `.meta.json` the client writes beside each subagent
  transcript — never inside the transcript, which is why this page could say
  what subagents cost in total and nothing about which of them. The same file
  carries the model the dispatch asked for, its depth in the spawn tree and its
  parent, all now indexed.
- **Plugin agents are matched by that type** on the Health tab. An agent used to
  be unmatchable — its type is named in the arguments of the call that spawned
  it, and the index reads results — so it was reported as "not visible" whether
  or not it had ever run. It now answers the same question a skill does.
- **Replies the cache could not answer**, on the Cache tab: calls that sent more
  than 100k of input at the full rate, with the largest listed by session and
  project. The first reply of a session is always one; a large one partway
  through a run is a cache rebuilt rather than reused.
- **Peak parallel sessions** and **time actually working**, on the Sessions tab,
  plus a *working* column beside *open* in the table. Gaps longer than five
  minutes are a session left sitting rather than one thinking, and are not
  counted as work. The peak counts main transcripts only: a fan-out of a hundred
  agents is the Agents tab's subject, not one person running a hundred windows.

## [0.26.0] — 2026-08-14

Everything below, in the stable channel. It went out an hour earlier as
`0.25.0`, whose odd minor put it in pre-release by mistake — same code, same
package, one number apart.

### Added

- **Open Claude Code** — a button in the editor's title bar, and a command, that
  starts a Claude Code session as a tab in the group you are looking at, next to
  the files already open there. Claude Code's own button splits a new editor
  group off to the right instead. The session runs `claude` from the shell's
  `PATH`; the tab closes with it when it ends cleanly and stays when it fails, so
  the reason is still on screen. The tab carries this extension's own icon — the
  same one as the button.
- `claudeStatusline.openLocation` chooses where that session lands: a tab in the
  group you are looking at (the default), a tab beside it, the terminal panel at
  the bottom, or a window of its own. It governs all three ways in — both buttons
  and the command — is read at the moment you press one, and the status-bar
  button's hover names the place it will use. Also on the dashboard's Settings
  tab, under Behaviour.
- The tab is named after the session running in it, following `/rename` and the
  generated title as they change — `claudeStatusline.renameTabs`, on by default.
  Only tabs this extension opened are renamed, and only while one of them is the
  active terminal: VS Code's rename acts on the active terminal, so a background
  tab could only be renamed by switching to it first.
- The same button in the status bar, left of every segment: `$(terminal)$(sparkle)`,
  one click for a session in the group you are looking at. The status bar takes
  codicons only, so it wears the extension's icon as the two glyphs that exist —
  the prompt and the spark. It is drawn whether or not anything has been read, so
  it is there on a machine that has never run Claude Code, and the bar's own
  right-click menu hides it like any other item.

- Every row of the Disk tab now says where it is and offers to open it: the
  full path on hover, and a **show** button that reveals the directory in
  Finder. The extension still deletes nothing — the numbers say what is worth
  removing, the file manager is where removing happens, and the decision stays
  yours. A wildcard row like `plugins/cache/temp_subdir_*` has no single
  directory of its own and opens the one holding them all.

### Changed

- **The week bar on the Now tab draws spend on the week's own axis.** An even
  burn puts x% of the limit at x% of the week, so the fill is the spend, the mark
  is where the week stands, and the gap between them is the over- or underspend
  itself — red past the mark, green short of it — with the figure and its
  distance from the plan written on the fill: `72% +17%`. The cells are calendar
  days with their dates, today in bold, so the rail reads as a week rather than
  as a bar that happens to be full. Both ends of the window carry their date and
  hour, and the forecast is stated in every state the way the terminal states it
  — `dry 1d12h → Sat 15.08, ~13h` — pinned quietly to the right edge when it
  lands past the reset. This replaces a rail that measured time alone.
- The moment a week runs out is now recorded, because it is the one fact here
  that cannot be recomputed: the forecast divides by what is left, so at 100% it
  collapses onto the present and answers "now" for the rest of the window. It is
  written once, on the first reading that sees the quota gone, together with the
  plan of that moment — 100% reached with 54% of the week elapsed is a different
  week from 100% reached on the last evening. Kept in `week-marks.json` beside
  the reading log, which is trimmed by design; a window that ran out before this
  shipped has its moment recovered from the readings, and one whose readings do
  not reach back that far says the moment is unknown rather than inventing a
  date. After that the mark stays where it happened while `now` keeps moving, so
  the distance between them is how long you have been without quota — and the
  delta on the fill melts towards zero as the plan catches up.
- **The status-bar bar is seven cells — one per day of the window**, the same
  axis the page draws: spending exactly to plan fills as many cells as the week
  has days behind it. At six they were 28-hour blocks standing for nothing, and
  a whole percent of the limit could not fit in one.
- Nothing is said about pace in the first half hour of a window or below 2%
  spent — not by the bar, not by `{drift}`, not by the hover, not by the page.
  With a plan of 0% every fraction of a percent is "ahead of schedule", so a
  fresh week opened red over one percent. One flag decided in `pace()` rather
  than the same arithmetic in four places.
- At 100% no forecast is offered at all. The formula divides what is left by the
  rate, so it returned the present moment and the bar printed the current hour
  as a prediction — `dry ~03h`. When the quota is gone the fact worth having is
  when it ended, and that one is recorded rather than computed.
- The zone between the fill and the plan mark is measured to the mark itself
  rather than to the whole percent printed under it. The plan arrives floored —
  6.43% of the week elapsed is reported as 6% — so the zone stopped just short of
  the line it exists to reach, and the gap was visible on screen.
- The Settings tab's Behaviour panel shows every choice at once instead of
  hiding all but one behind a dropdown: the side of the bar and where Claude
  Code opens are a card per option, each with a line saying what picking it
  does, and the save target is a pair of buttons. A setting whose alternatives
  are invisible is a setting nobody changes.
- Reading and the network is built from the same rows: the name and the sentence
  above the control rather than beside it, so the two panels of that tab read as
  one form. The switches themselves are unchanged, and still write immediately.
- The environment panels of the Claude Code tab say what each variable does on
  the page instead of in a tooltip — the browser drew that whole sentence on one
  line across the panel next to it — and show the documented default beside the
  value, marked when what is set differs from it. Defaults come from the
  reference's own prose, which states one for 32 of the 315 documented
  variables; the rest keep a dash rather than a guess.
- Dates on this page are written day first — `11.08`, and `Tue 11.08` in Busiest
  days. They were `08.11`, the only place on the page or in the bar that put the
  month first.
- The status bar's own context menu names this extension's items after it:
  **Claude Statusline: Open** for the button and **Claude Statusline 1**, **2**,
  … for the segments. They read as `Claude Code` and `Claude 4` before, sitting
  in one list with Claude Code's own entry, where neither said whose they were.
  VS Code remembers a hidden item by id, so nothing you had hidden comes back.

## [0.25.0] — 2026-08-14

Published to the pre-release channel by mistake and superseded an hour later by
0.26.0, which carries exactly the same code. Listed here because it exists on
both storefronts: anyone running it is running 0.26.0 under an older number.

## [0.24.0] — 2026-08-13

Carries everything prepared as 0.22.2, which was never released.

### Changed

- The week track on the Now tab measures time end to end: grey is the part of
  the week already gone and its right edge is now, then how long the quota lasts
  and how long the week runs on without it, each block carrying its duration.
- Out of quota is its own state on the track: one block from now to the reset
  with the length of the wait in it.
- Both marks on the track are always named — `now` under the rail, `dry` over
  it. Neither is hidden when they sit close together.
- Weekly spend moved off the track into the line above it, as a sentence.
- Status-bar bar glyphs: `█` spent, `▓` spent past the plan, `▒` plan not yet
  reached, `░` the rest.
- The Pace tooltip says "behind plan" where it said "under plan", matching the
  track.
- The forecast tooltip carries how long the week runs on after the quota is
  gone, and says "out of quota" instead of a time when there is none left.

### Fixed

- The status-bar bar no longer shows an overspend cell for a week that is behind
  plan. 216 of the 10 201 possible spend/plan pairs were wrong.
- The countdown in the page header no longer sits at zero when a redraw is
  skipped — with the Settings tab open, or the panel hidden.
- Credits print in the currency the endpoint named, instead of assuming dollars.
- A meter in a tooltip no longer draws every filled cell as spend past the plan.
- The Changelog tab lists every release in the file, not the newest 80. 281 of
  361 were hidden.
- "Refresh on a timer", switched off, now stops the transcript pass, the spend
  across every project and the limits request — not only the redraw. Focus on
  the window no longer triggers them either.
- A new refresh interval takes effect when set, without a window reload. Ticking
  another checkbox no longer restarts the countdown.
- "Releases ahead" counts only releases ahead of the running client, not every
  release on the page.
- The links in the README's table of contents work on both listing pages.
- The "Across all requests" figure on the Context tab reads the Opus rate from
  the file that holds rates, not a copy of it.
- Settings values shaped like a credential are masked on the Client tab even
  when the name gives nothing away — `GH_PAT` and a Sentry DSN were printed in
  full.

### Internal

- Removed a function with no caller, a filter on a field that does not exist, a
  shadowed import, and a chart axis built twice per drawing.
- The overflow probe rendered the Changelog tab empty and priced every agent at
  zero, so it measured a page shorter and narrower than the real one. It now
  opens what is folded before measuring.
- The week-track probe read a stylesheet from a file that no longer exists and
  could not run. Rewritten to measure label rectangles in the browser, and
  verified against a known-bad input.
- Five tests for the week track, which had none.
- The trim on the limits history has a test, and its comment carries a measured
  figure instead of one out by a factor of five.

## [0.22.1] — 2026-08-12

**The first version on Open VSX** — the registry Cursor, Windsurf, VSCodium and
Gitpod install from, where this extension had no listing at all. The code is
0.22.0 unchanged; what is new is where you can get it.

The VS Code Marketplace stays on 0.22.0 for now. Its upload step ran before Open
VSX, so a release that could not authenticate there reached neither registry;
the step is off until the token is back, and the listing catches up with the
next version after that.

## [0.22.0] — 2026-08-11

**The first version actually published.** Even minor, so it lands in the stable
channel where the Install button works without picking anything from a dropdown.
It carries everything 0.20.0 was, plus the fixes that came after it: a run is
aged by its files rather than by its directory, and three tests stopped measuring
the machine they run on.

## [0.21.0] — 2026-08-11

### Fixed

- **A run is as old as its files, not as its directory.** Liveness took the
  newest of the run directory's own creation time and its contents, so a
  directory stamped "just now" over hours-old files — a checkout, a copy, a
  restore — read as a live workflow. Creation time now answers only for a run
  that has not written its first line yet.

## [0.20.0] — 2026-08-11

**First public release.** Even minor, so this is the stable channel: the Install
button on the page works for everyone, without picking a pre-release from a
dropdown.

What it is, in one line each — a status bar you write yourself out of 45
placeholders, and a 23-tab dashboard over every Claude Code transcript on the
machine: limits with a pace forecast, spend by day, model, project and branch,
subagents and workflow runs with what each agent cost, cache and friction, and a
Setup section that reads the installation itself. Everything is read locally;
one request leaves the machine and it has a switch.

The full feature history is below, from 0.5.0 onwards.

## [0.19.24] — 2026-08-11

### Fixed

- The Claude Code tab said "No settings files could be read" where it simply had
  none to read — the wording turned an empty listing screenshot into a broken
  one.

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
