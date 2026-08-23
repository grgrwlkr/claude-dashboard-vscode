# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/), with the VS Code convention that an **odd** minor
is a pre-release and an **even** one is a stable release.

Everything below 0.20.0 was built and installed on one machine; the extension was
not published yet.

## [Unreleased]

### Added

- Setup → Launch opens on what the published measurements settle, above the
  options rather than inside them: the Opus 5 + Fable advisor pairing at 85.7%,
  `xhigh` ahead of `max` at 44.4% against 43%, and Opus 5 matching Fable 5 at
  about 60% of the cost. Each figure carries the date it was checked, because a
  verdict with no date rots silently, and this one is one system card away from
  being wrong.
- The same banner spells the verdict out as settings — model `opus 1M`, effort
  `xhigh`, advisor `fable` — and an **Apply these** button puts them in the
  controls below, so reading the verdict and acting on it are not two jobs. Save
  lights as it would for a choice made by hand; the write is still yours.

### Changed

- The bar describes the session in the terminal tab you are looking at, where it
  used to describe whichever session in the workspace wrote last.
- A tab with no Claude in it falls back to the workspace answer rather than
  emptying the bar.
- The switch redraws at once instead of waiting up to ten seconds for the next
  tick.
- VS Code's active terminal is the one with focus or the one that had it last,
  so the bar does not go quiet when you click into a file.
- A terminal already active when the window opens is picked up at startup, since
  a reload restores the tabs without announcing which was last used.

### Added

- The Launch tab writes out the command **Open Claude Code** would run, with a
  button that copies it.
- The line follows the choices as they are picked, before anything is saved.
- It is shown rather than typed into: the panels above are the controls, and an
  editable copy would raise the question of which of the two wins.
- The builder moved beside the page, so the line shown and the line run are the
  same string from the same function.
- The same command is offered as a shell alias, named by
  `claudeStatusline.aliasName`, for starting the session from a terminal.
- The alias is quoted a second time: written the obvious way, its inner quotes
  close the outer ones and zsh answers `no matches found: opus[1m]`.
- A name a shell would refuse produces no line rather than one that cannot be
  sourced.
- **Write to ~/.zshrc** puts it there, in a block of its own that the extension
  owns; everything else in the file comes back byte for byte.
- A copy of the file is kept beside it the first time, and the replace is atomic,
  so a crash cannot leave it half-written.
- It happens on that button and never on a save: a settings page that quietly
  edited a shell file would be a surprise nobody asked for.
- Clearing the name removes the block and leaves the file as it was.
- A shell whose `alias` does not take this syntax is told so rather than handed a
  line that fails at every prompt.

### Fixed

- The rule that paints inputs from the theme reached only a direct child of a
  panel, so a field wrapped in a row of its own fell through to the browser's
  control — dark on a light page, the same failure 0.42.0 shipped.
- A session opens in the first folder of the workspace instead of wherever the
  last editor happened to be. The button never said which directory it wanted,
  so in a multi-root window VS Code answered from the editor history — and a
  Claude session's directory is its identity: the CLAUDE.md it reads, the
  project memory it carries and the transcript it writes all follow from it.

## [0.44.0] — 2026-08-21

### Added

- The output styles you wrote yourself are offered on the Launch tab, read from
  `~/.claude/output-styles`, under the client's own five.
- A style is named by its frontmatter `name` and by its file name when it has
  none, which is how the client names it.
- Each one carries its `description`, and a style that does not set
  `keep-coding-instructions` says so, because it replaces Claude Code's
  engineering instructions rather than adding to them.
- The panel says where styles live whether or not you have any.
- A quoted frontmatter value loses its quotes, the way YAML reads it, so a
  name written `"like this"` still matches what the client is matching against.
- The heading pill keeps showing a chosen style after its file is deleted,
  because the name still travels to the client.

### Fixed

- The Launch tab's Extra arguments field was drawn by the browser rather than
  from the theme — a black box on a light background, which shipped in 0.42.0
  and stood in the listing screenshot.
- The setting's own description sent you to `launchArgs` to name a style of your
  own, which is no longer the way to do it.
- The marketplace description called this a 23-tab dashboard; it has 24, and a
  test now holds the sentence to what `SECTIONS` actually carries.

### Documentation

- The Launch screenshots are re-shot: the previous pair predates the custom-style
  block and carries the black input this release fixes.
- The demo data invents two output styles, one of each kind, because the real
  list is read from disk and demo mode has no disk to read.

## [0.42.0] — 2026-08-21

### Changed

- Setup splits in two: `Live now`, `Background jobs`, `Task lists` and `Disk`
  move to a new **Machine** section.
- The tabs themselves are unchanged, only where they are found.
- A new **Launch** tab holds what a session is started with: where it opens, the
  model, the effort, the advisor, the output style and the extra arguments.
- Every launch option carries a description in the client's own wording.
- Every model carries its rate and its context window.
- Each panel heading shows what it is set to, the way the Now tab's panels do.
- Preset cards are a third of their old height, with the full bar preview moved
  to hover.

### Added

- The advisor list is ranked against the chosen model and re-ranks as you change
  it.
- An advisor the client would refuse is dimmed behind a dashed border and
  disabled, with the reason beside it.
- Picking a model that refuses the advisor already chosen clears that choice back
  to none rather than leaving an impossible pair selected.
- Each effort level shows what it costs on this machine: output per reply, and a
  ratio against the level with the most replies behind it.
- A level with fewer than 300 replies behind it says so instead of printing a
  ratio.

### Fixed

- `best` was documented as picking whichever model suits the task; it picks
  Fable 5 where your organization has access to it and the latest Opus otherwise.
- The advisor panel said refused pairings are struck through; they are dimmed
  behind a dashed border.

### Documentation

- Six listing screenshots re-shot in both themes: every one of them carried the
  five-section nav that this release replaces with six.
- The demo data makes every launch choice, so the Launch tab photographs as a
  configured screen rather than six panels reading "not set".

## [0.40.1] — 2026-08-20

### Added

- `Concise`, the output style the client added in 2.1.237, can be picked when
  starting a session.

### Fixed

- The session panel showed no output style for sessions this extension started,
  which on a machine that launches them from the dashboard is all of them.
- The client has no `--output-style` flag, so the style travels in `--settings`
  JSON, and the panel was reading the settings files, where it was never written.
- The style now comes off the session's own command line, which beats the file on
  purpose: the client compiles it into the system prompt at session start, so a
  file edited since then says what the *next* session will get.

## [0.40.0] — 2026-08-19

### Changed

- The page header uses the same grammar as the panels below it: name, mark and
  version on the left, the state of the index and the two controls on the right.
- Freshness and the countdown share one pill, `19:09 · next in 55s` while the
  timer runs and `19:09` when it is paused, with the full date on hover.
- `Pause` and `Reindex` wear the page's own `.btn`, as `Save` and `Add segment`
  already did, instead of being pills with a cursor.
- A hairline separates what is read from what is pressed.
- Pausing turns the control yellow and empties the countdown.

### Fixed

- Listing screenshots had started carrying the version number: `--demo` stripped
  it by a class the version left when it moved into a pill.
- The anchor is an attribute now, and a test holds both files to it.
- The context panel drew no bar at all when the transcript could not be read, so
  the window gauge now keeps its own track when there is no breakdown to replace
  it.
- An unreadable `dashboard.css` now falls back to a legible minimum, where it
  threw at require time and took the status bar, the tree and the sidebar down
  with it.
- A test checks that `.vscodeignore` cannot drop a file the runtime reads.
- The tooltip drew every pill the same way, ignoring `tone`, so `credits off`
  looked like `max`.
- Pills that warn or reassure now carry the codicon a toned note gets.
- `credits off` was stated twice, as a pill and again in the note beside it; the
  pill states the switch and the note states the money.
- The output style pill read as a bare `default` and now reads `style default`,
  the same shape as `advisor`.
- The body spacing used a general sibling selector, so it applied to every block
  of a sidebar section and beat any rule declared above it.
- The week footer's centring rule still pointed at a middle element that no
  longer exists.

## [0.38.0] — 2026-08-19

### Changed

- The three panels of the Now tab follow one shape: heading with state as pills,
  the figure the panel exists for, what it is made of, the facts, a footer.
- Limits leads with the week, drawn as one large percentage with the plan as a
  notch on its track.
- The 5-hour and per-model windows sit under it as compact rows.
- The verdict against plan moved into a pill beside the heading, out of the
  sentence that measures it.
- Pace, forecast and credits keep their words and lose their left borders, with a
  coloured dot carrying the tone.
- Spend is titled Spend rather than titled with its own answer, so the session's
  cost can be the figure.
- Burn rate and today's spend are pills, and what it took stays a table.
- The session panel shows effort, advisor, thinking and output style as pills
  beside the model instead of four rows of monospace.
- That panel ends in a footer of branch and client version, with a chip when a
  newer client is unpacked and waiting.
- The stylesheet moved out of a template literal into `dashboard.css`, 708 lines
  where a backtick in a comment breaks the module at require time.
- `STYLE` is still a string read from that file at load, so both pages, both
  preview tools and every test are untouched.
- The week track became a panel: everything that used to float around the rail is
  a pill in the heading, and the block lost 45px.
- Two pills wear a dot in the colour of the mark they name, which is what let the
  rail's captions go.
- A forecast landing past the reset gets no dot, because there is no mark on the
  rail to point at.
- The task list is a strip across the page instead of a fourth panel that left
  one column of three carrying two.
- The strip carries `Tasks 4/7`, the share as a track, what is in progress, and
  how many other sessions are open.
- The strip is one line down to about 640px and two below that.
- The context breakdown is one colour bar with a legend under it, keyed by part
  name so a part keeps its hue when the sort moves it.
- Where auto-compact waits rides on that legend's caption, beside `your setup`.
- The context block is a gauge with a list under it: the window is the headline,
  and cache and auto-compact are chips beneath rather than rows of their own.
- Each part of the breakdown is one line rather than two, and the share is drawn
  as the fill behind the row.
- The breakdown sums what your own setup costs — memory files, skills, agents,
  MCP instructions, tool names, hooks — as a share of the window.
- Two new block kinds, `gauge` and `parts`, so the tooltip and the page keep
  saying the same thing in their own way.

### Fixed

- The same fact was drawn in opposite tones on one screen: `12% ahead of plan` in
  green on Limits, `12% over` in yellow on the track above it.
- Both now say `over` and `under`, and both colour overspend as a warning.

## [0.36.0] — 2026-08-18

### Added

- The context window is broken down into what fills it, which puts it on the Now
  tab and in the sidebar at once.
- Rows are ordered by share, largest first, with free space pinned to the bottom.
- `/context` in the client draws this from figures it holds in memory and writes
  none of them down, so none of it can be read back.
- What the transcript does record is the blocks the client adds to the prompt —
  the skill listing, the deferred tool names, the agent listing and each MCP
  server's instructions — weighed at four characters to a token and each marked
  with a tilde.
- Listings arrive as deltas, so a record marked `isInitial` replaces what came
  before it and everything else adds and removes by name.
- Summed naively this machine reads ~93k tokens of skills where the client
  reports ~10k.
- The largest row is called **rest in use** rather than "messages": the
  conversation, the system prompt and the tool schemas reach this side as one
  number, and nothing on disk separates them.

## [0.34.0] — 2026-08-17

### Added

- An output style can be asked for at launch: `default`, `Proactive`,
  `Explanatory` or `Learning`.
- There is no `--output-style` flag, so the style travels as `--settings` JSON,
  which merges with your settings files and leaves everything else alone.
- A style of your own lives in `~/.claude/output-styles` and goes through the
  extra arguments by name.

### Changed

- The sidebar opens on Limits and Session split evenly, with Live sessions and
  Workflow runs collapsed.
- None of that binds afterwards: VS Code remembers whatever you drag or open
  yourself.
- `initialSize` is applied the first time a pane is shown, and the session pane
  sits behind a `when` clause that only turned true on the first tick, so it
  arrived into a finished sidebar and took what was left.
- The previous window's answer is now remembered and given before anything is
  read, with the first tick correcting it.
- The four panes have new ids, which is the only way an extension can ask VS Code
  for a fresh layout, because a pane that has ever been opened ignores
  `initialSize` and `visibility` forever, so this resets it once.

### Fixed

- The settings inputs are painted from the theme again: their rules were keyed on
  `.form`, a class the page puts on nothing.
- Every field fell through to the browser's own control, which under
  `color-scheme: light dark` is drawn dark whatever the page's theme is.
- The number fields were the same story: `width: 8ch` never applied either, which
  is why they were as wide as a sentence.

### Documentation

- Two new screenshot pairs: the launch panel with everything chosen, and the week
  track of a window spent ahead of its plan.
- Below plan the forecast lands past the reset and `{dry}` is silent by design,
  so `tools/preview.js --demo --over` spends the demo week ahead of plan.
- The week under its plan gets its own frame and paragraph, including the caption
  `lasts to the reset`, where `{dry}` stays empty while `{dryAt}` still names a
  date.
- Colours are named for both themes wherever a mark actually changes with the
  theme.
- The plan rule was called black, which is only true on a light theme: it is
  drawn in `--vscode-foreground`.
- The status bar's thresholds were described as yellow and red where they are the
  editor's own warning and error backgrounds.

## [0.32.0] — 2026-08-16

### Added

- A session can be started on a model, an effort and an advisor of your own,
  through `claudeStatusline.model`, `.effort` and `.advisor`.
- Empty is the default for all three and passes no flag at all, so the client
  keeps deciding exactly as it did before.
- `--advisor` is a real flag the client keeps out of its own `--help` with
  `.hideHelp()`, so a setting is the only way most people will find it.
- The model list is the aliases the client itself accepts, read out of 2.1.233
  rather than remembered: `opus`, `sonnet`, `fable`, `haiku`, each with its
  `[1m]` variant, plus `best` and `opusplan`.
- A `[1m]` entry is the million-token variant of that model rather than a second
  name for it, and the client has a `prefer1m` setting for picking it by default.
- Values are quoted on the way into the shell, because unquoted, zsh reads
  `opus[1m]` as a pattern and answers `no matches found`.
- Quoting also keeps a model name with shell syntax in it a single argument
  rather than a second command, which is now a test.
- `claudeStatusline.launchArgs` goes in as typed, because quoting a line of
  several arguments would break it.
- `launchArgs` is therefore `machine`-scoped: free text written into a shell is
  not something an opened repository gets to choose.
- **Claude: Open Claude Code with…** asks for a model and an effort instead of
  reading the settings, for the run that is not like the others.
- The button's hover names what it would start on.
- The Settings tab has a panel for what a session starts with, so four fields
  about one command line stop sitting next to "Side of the bar".
- Save left the panels and became a bar of its own, stuck to the bottom of the
  tab.
- That bar says whether there is anything to save, comparing against the state
  the page was drawn with rather than raising a flag that stays up once tripped.
- The free text field got room to type in, where the browser's default width
  showed about twenty characters.
- The dashboard tab wears the extension's own mark instead of the generic webview
  glyph.

### Fixed

- A tab restored after a reload follows its session's name again.
- 0.30.0 recognised such a tab by its icon or by the name it was opened under,
  and the extension host rebuilds neither: `creationOptions` for a terminal it
  did not create holds six fields, and the icon is not among them.
- Two witnesses replace them, either of which is enough: a mark this extension
  puts in the tab's environment, and its own note of the shell's pid.
- Matching by name could have renamed and closed a tab belonging to Claude Code's
  own button, which opens terminals under the same name; that is now a test.
- The tab's icon cannot be fixed from here: it does not reach the extension, and
  every field of `Terminal` is read-only.
- `.claude/` is no longer packaged: `.vscodeignore` excluded the notes, the docs
  and CI but not this one, so 0.30.0 shipped the repository's publishing skill to
  both storefronts.

## [0.30.0] — 2026-08-16

### Added

- The Activity Bar container is a panel of four sections rather than one tree:
  Limits, Session, Live sessions and Workflow runs.
- The container is called **Claude Dashboard** rather than "Claude", which read
  as the client itself.
- Limits and Session are the status bar's own tooltip sections, so the panel
  cannot drift from the hover.
- Session hides itself when no Claude session is open in this window, rather than
  standing empty and claiming height.
- Limits have a pane to themselves, so the one section worth reading without
  scrolling is not pushed under the fold.
- The container's icon is the extension's own mark, drawn as a single-colour
  glyph, where a shape at two opacities comes out as one solid circle.
- The editor caches that glyph by path, so a redrawn icon needs a new file name;
  this one is `media/bar-icon.svg`.
- A badge on that icon counts live sessions and shows nothing when there are
  none.

### Fixed

- A session opened by the button survives a window reload: the tab was created
  with `isTransient: true`, VS Code's opt-out of terminal persistence.
- The flag had been copied from Claude Code's own extension, which sets it on
  both of its `createTerminal` calls in 2.1.233.
- A tab that comes back is taken over again and keeps following its session's
  name.
- Closing itself when the session ends is not promised across a reload, because
  that depends on VS Code reporting the end of a command which started before the
  extension host did.
- A full quit is left alone deliberately: there is no process to reconnect to, so
  sending the command again would start a new session wearing an old one's
  scrollback.

## [0.28.0] — 2026-08-16

### Fixed

- A reply is charged once, at its final figures, where the index added every
  record of a response and billed the same reply as many times as it had content
  blocks.
- Output read 100.1M where it is 47.1M, cache writes 1 043M where they are 382M,
  input 6.8M where it is 2.0M, and cache reads 25.2B where they are 12.6B.
- The records of one response disagree: on 25.5% of them the early records hold a
  partial output and only the last is the answer.
- A response is therefore charged from its fullest record, the one whose usage
  totals the most, with the fields around it merged across all of them, because
  `usage.speed` rides on the closing record while the skill and the effort are on
  the opening one.
- Tool calls are still counted from every record, since a call lives in exactly
  one of them.
- `INDEX_VERSION` is bumped, because a stored aggregate holds the inflated
  numbers and its file has not moved.
- The first run after this re-reads every transcript.
- "2843 replys" on the Agents tab and in the Cache note: `plural` appends an `s`,
  which is right for every other noun this page counts.
- A dated model id finds its rate again, where `ratesFor` stripped `[1m]` and
  `-fast` but not the date.
- `claude-haiku-4-5-20251001` therefore missed `RATES` and was billed at the Opus
  fallback, five times its own rate, under a row still reading "haiku 4.5".
- On this machine that model reads $0.40 rather than $2.01.

### Added

- A model with no published rate carries the tilde every other estimate carries,
  and says why on hover: an id missing from `RATES` is billed at the `FALLBACK`
  rate, which is the Opus rate.
- Only the row of the model itself is marked; a total that merely includes such a
  model is left alone.
- `<synthetic>` is no longer drawn as a model: it is what the client writes in
  place of a reply that never arrived, with an all-zero usage.
- Those records still reach the Requests tile, which counts messages rather than
  models.
- Spend by agent type, on the Agents tab, read from the `.meta.json` the client
  writes beside each subagent transcript.
- The same file carries the model the dispatch asked for, its depth in the spawn
  tree and its parent, all now indexed.
- Plugin agents are matched by that type on the Health tab, where an agent was
  reported as "not visible" whether or not it had ever run.
- Replies the cache could not answer, on the Cache tab: calls that sent more than
  100k of input at the full rate, with the largest listed by session and project.
- The first reply of a session is always one; a large one partway through a run
  is a cache rebuilt rather than reused.
- Peak parallel sessions and time actually working, on the Sessions tab, plus a
  *working* column beside *open*.
- Gaps longer than five minutes are a session left sitting rather than one
  thinking, and are not counted as work.
- The peak counts main transcripts only, because a fan-out of a hundred agents is
  the Agents tab's subject.

## [0.26.0] — 2026-08-14

Everything below, in the stable channel. It went out an hour earlier as `0.25.0`,
whose odd minor put it in pre-release by mistake.

### Added

- **Open Claude Code** — a button in the editor's title bar, and a command, that
  starts a session as a tab in the group you are looking at.
- Claude Code's own button splits a new editor group off to the right instead.
- The session runs `claude` from the shell's `PATH`.
- The tab closes with the session when it ends cleanly and stays when it fails,
  so the reason is still on screen.
- `claudeStatusline.openLocation` chooses where that session lands: a tab in the
  group you are looking at, a tab beside it, the terminal panel, or a window of
  its own.
- That setting governs both buttons and the command, and is read at the moment
  you press one.
- The tab is named after the session running in it, following `/rename` and the
  generated title as they change, under `claudeStatusline.renameTabs`.
- Only tabs this extension opened are renamed, and only while one of them is the
  active terminal, because VS Code's rename acts on the active terminal.
- The same button sits in the status bar as `$(terminal)$(sparkle)`, the two
  codicons closest to the extension's icon.
- That button is drawn whether or not anything has been read, so it is there on
  a machine that has never run Claude Code.
- Every row of the Disk tab says where it is on hover and offers a **show**
  button that reveals the directory in Finder.
- The extension still deletes nothing.

### Changed

- The week bar draws spend on the week's own axis, so the gap between the fill
  and the mark is the over- or underspend itself, red past it and green short of
  it.
- The figure and its distance from the plan are written on the fill, as
  `72% +17%`.
- The cells are calendar days with their dates, today in bold.
- Both ends of the window carry their date and hour, and the forecast is stated
  the way the terminal states it, as `dry 1d12h → Sat 15.08, ~13h`.
- The moment a week runs out is recorded, because the forecast divides by what is
  left and collapses onto the present at 100%.
- The mark is written once, on the first reading that sees the quota gone,
  together with the plan of that moment, and kept in `week-marks.json` beside the
  reading log.
- A window that ran out before this shipped has its moment recovered from the
  readings, or says it is unknown rather than inventing a date.
- The status-bar bar is seven cells, one per day of the window, where six were
  28-hour blocks standing for nothing.
- Nothing is said about pace in the first half hour of a window or below 2%
  spent: against a plan of 0% every fraction of a percent reads as ahead.
- At 100% no forecast is offered, because the formula returned the present moment
  and the bar printed the current hour as a prediction.
- The zone between the fill and the plan mark is measured to the mark rather than
  to the floored percent printed under it.
- The Behaviour panel shows every choice at once instead of hiding all but one
  behind a dropdown, as a card per option with a line saying what picking it does.
- Reading and the network are built from the same rows, with the name and the
  sentence above the control rather than beside it.
- The Claude Code tab says what each environment variable does on the page
  instead of in a tooltip, which the browser drew as one line across the panel.
- The same tab shows each variable's documented default beside its value, marked
  when the two differ.
- Defaults come from the reference's own prose, which states one for 32 of the
  315 documented variables; the rest keep a dash rather than a guess.
- Dates are written day first — `11.08` — everywhere on the page.
- The status bar's context menu names this extension's items after it, where they
  read as `Claude Code` and `Claude 4` before.

## [0.25.0] — 2026-08-14

Published to the pre-release channel by mistake and superseded an hour later by
0.26.0, which carries the same code. Anyone running it is running 0.26.0 under an
older number.

## [0.24.0] — 2026-08-13

Carries everything prepared as 0.22.2, which was never released.

### Changed

- The week track measures time end to end: the part already gone, how long the
  quota lasts, and how long the week runs on without it.
- Out of quota is its own state on the track, one block from now to the reset.
- Both marks are always named, `now` under the rail and `dry` over it.
- Neither mark is hidden when the two sit close together.
- Weekly spend moved off the track into the line above it.
- Status-bar bar glyphs: `█` spent, `▓` spent past the plan, `▒` plan not yet
  reached, `░` the rest.
- The Pace tooltip says "behind plan" where it said "under plan".
- The forecast tooltip carries how long the week runs on after the quota is gone,
  and says "out of quota" instead of a time when there is none left.

### Fixed

- The status-bar bar no longer shows an overspend cell for a week behind plan;
  216 of the 10 201 possible spend/plan pairs were wrong.
- The countdown no longer sits at zero when a redraw is skipped.
- Credits print in the currency the endpoint named instead of assuming dollars.
- A meter in a tooltip no longer draws every filled cell as spend past the plan.
- The Changelog tab lists every release in the file: 281 of 361 were hidden.
- "Refresh on a timer", switched off, now stops the transcript pass, the spend
  across every project and the limits request, not only the redraw.
- Focus on the window no longer triggers those reads either.
- A new refresh interval takes effect without a window reload.
- Ticking another checkbox no longer restarts the countdown.
- "Releases ahead" counts only releases ahead of the running client.
- The links in the README's table of contents work on both listing pages.
- The "Across all requests" figure reads the Opus rate from the file that holds
  rates rather than a copy of it.
- Settings values shaped like a credential are masked even when the name gives
  nothing away — `GH_PAT` and a Sentry DSN were printed in full.

### Internal

- Removed a function with no caller, a filter on a field that does not exist, a
  shadowed import, and a chart axis built twice per drawing.
- The overflow probe now opens what is folded before measuring; it had rendered
  the Changelog tab empty and priced every agent at zero, so it measured a page
  shorter than the real one.
- The week-track probe was rewritten to measure label rectangles in the browser
  and verified against a known-bad input; it had been reading a stylesheet from a
  file that no longer exists and could not run at all.
- Five tests for the week track, which had none.
- The trim on the limits history has a test, and its comment carries a measured
  figure instead of one out by a factor of five.

## [0.22.1] — 2026-08-12

The first version on Open VSX — the registry Cursor, Windsurf, VSCodium and
Gitpod install from. The code is 0.22.0 unchanged.

The VS Code Marketplace stays on 0.22.0: its upload step ran before Open VSX, so
a release that could not authenticate there reached neither registry.

## [0.22.0] — 2026-08-11

The first version actually published, in the stable channel. It carries
everything 0.20.0 was, plus the fixes that came after it.

## [0.21.0] — 2026-08-11

### Fixed

- A run is as old as its files, not as its directory: a directory stamped "just
  now" over hours-old files read as a live workflow.

## [0.20.0] — 2026-08-11

First public release, stable channel: a status bar you write yourself out of 45
placeholders, and a 23-tab dashboard over every Claude Code transcript on the
machine — limits with a pace forecast, spend by day, model, project and branch,
subagents and workflow runs with what each agent cost, cache and friction, and a
Setup section that reads the installation itself.

Everything is read locally; one request leaves the machine and it has a switch.

## [0.19.24] — 2026-08-11

### Fixed

- The Claude Code tab said "No settings files could be read" where it simply had
  none to read.

## [0.19.23] — 2026-08-11

### Changed

- The listing says where the pause lives: the page header and the Settings tab
  move the same switch.

## [0.19.22] — 2026-08-11

### Added

- Pause the refresh from the page header, beside Reindex and the countdown.
- The control is the same `claudeStatusline.autoRefresh` as the switch on the
  Settings tab, and moving either moves the other.
- While it is paused the page is not rebuilt at all, so an expanded list stays
  expanded and the scroll position stays put.

## [0.19.21] — 2026-08-11

### Changed

- The listing counts the tabs again — twenty-three, not twenty-two — and says
  what the Claude Code tab answers.
- Privacy names the credential masking as a promise rather than an implementation
  detail.
- The optional refresh is described by what it fetches rather than by counting
  URLs that keep changing.

## [0.19.20] — 2026-08-11

### Added

- A Claude Code tab, under Setup, answering three questions: what you have set,
  what you could set, and what you have moved away from the default.
- Settings files are listed in the order the client resolves them — managed
  first, then the project, then you.
- The file that won each key is named, the files it shadowed are counted, and
  there is a button to open any of them.
- Environment variables are shown twice on purpose: the `env` block every session
  gets, and what this editor window happens to have inherited.
- A settings reference parsed from Anthropic's published documentation and
  packaged with the extension, so defaults and descriptions are there offline.
- That reference carries the date it was read, and with the network switch off
  the tab says how old the packaged copy is.

### Fixed

- Values that read like credentials are hidden: the Health tab printed the `env`
  block of `~/.claude/settings.json` verbatim, so an `ANTHROPIC_API_KEY` kept
  there was drawn on the page.
- Anything whose name looks like a key, token, secret or password now renders as
  `•••` at any depth, but not when the value is a plain number, because
  `MAX_THINKING_TOKENS` is a budget.
- Managed settings are read: `managed-settings.json` overrides everything else,
  and on a managed install every number derived from settings could be wrong.

## [0.19.19] — 2026-08-11

### Changed

- Renamed to *Dashboard & Statusline for Claude Code*, with the id moving from
  `claude-statusline` to `claude-dashboard`.
- Settings keys stay `claudeStatusline.*`, because renaming those would break
  configs for no visible gain.
- A new icon: a progress ring for the limit and three bars for the dashboard, on
  a teal-to-indigo plate that survives 32 px.
- The old one is kept in the repository as `media/icon-v1`, and the same mark now
  sits next to the title on the dashboard page.
- The README is a listing page rather than a reference manual, with a **Known
  issues** section that says what does not work: Windows, remote hosts,
  vscode.dev.

## [0.19.18] — 2026-08-11

### Fixed

- The limits request is the extension's own, so nothing here needs a configured
  `statusline.sh`; the documentation said otherwise.

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

- Usage credits — what the account has spent past its plan, the only figure in
  the extension that is billed money rather than an estimate and the only one
  written without a `~`.

## [0.19.10] — 2026-08-11

### Added

- A monthly budget (`claudeStatusline.monthlyBudget`): the month drawn against a
  ceiling, with a word at 80% and at 100% — once each, not every tick.
- Export of the index as CSV or JSON.
- Plugin and MCP health: what each plugin ships, which of it ever ran, and which
  MCP servers earn their place.
- Version checking against a plugin's marketplace is opt-in
  (`claudeStatusline.checkPluginUpdates`).
- A memory tab: the files loaded into every prompt — `CLAUDE.md`, `rules/`,
  project memory — sized in tokens and priced across every request made.

## [0.19.9] — [0.19.4] — 2026-08-11

### Added

- A live workflow panel on the Now tab: one table per running run, a row per
  agent with the model and the effort it was given, in dispatch order.
- Agents are named rather than numbered.

### Fixed

- Every agent of a run is listed, not the first page of them.
- A run whose session is alive gets an hour of quiet before it counts as
  abandoned, rather than ten minutes, because slow runs were being written off.
- Long names wrap at word boundaries and say the whole thing on hover.

## [0.19.3] — [0.19.2] — 2026-08-11

### Fixed

- The charts have a y-axis with round ticks, and the calendar has a scale that
  says what the darkest cell costs a day.
- A bar list no longer draws 1% as a full bar when a percentage series has a
  single row.
- The overflow probe was replaced: the old one compared `scrollWidth` to
  `clientWidth` on a page that hides overflow, so it could never report a
  problem.
- The new one measures geometry, and was verified against a revision known to be
  broken.

## [0.19.1] — [0.19.0] — 2026-08-11

### Added

- Everything needed to publish: a marketplace identity, an icon, a licence and
  workspace-trust capabilities.
- `claudeStatusline.fetchLimits`, the one outbound request, made opt-out — off
  means the OAuth token is never read.

### Changed

- The whole page rebuilt on one vocabulary: tiles, panels, share cells, with no
  heading outside a panel anywhere in the 22 tabs.
- The first screen redesigned, and the hovers given meters that match the bar.

### Fixed

- A test that could not fail on a calendar boundary, and a preset description
  that printed its own markdown.

## [0.18.0] — [0.15.1] — 2026-08-10

### Added

- A settings editor in the dashboard: ready-made bars, a field per segment with a
  live preview, and a placeholder palette carrying current values.
- The Now tab, cut from the same sections as the status-bar tooltips, so the page
  and the hover cannot disagree.
- The open page redraws on the same tick as the bar, keeping its section, tab and
  scroll position.

## [0.10.1] — [0.9.0] — 2026-08-10

### Added

- The workflow panel: a tree of runs in the Activity Bar with three states
  (running, finished, abandoned), phases and agents, priced from `usage` records
  only.
- A live run is assembled from its journal and its agents' transcripts, because
  the snapshot is written once, at the end.
- Status-bar placeholders for a running workflow, and commands to open the run's
  script and copy its id.

## [0.6.4] — [0.6.0] — 2026-08-09

### Added

- The usage dashboard over an index of every transcript on the machine, open from
  any status-bar item.
- Tooltips rewritten for a GUI rather than for one terminal line.

### Fixed

- The session reported is the one this window is actually using.

## [0.5.0] — 2026-08-09

### Added

- The first build: Claude Code's limits, context and spend in the VS Code status
  bar, read from `~/.claude` and the account's usage endpoint.
