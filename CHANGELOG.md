# Changelog

Notable changes, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/), with the VS Code convention that an **odd** minor
is a pre-release and an **even** one is a stable release.

## [0.54.0] — 2026-09-03

### Changed

- The Limits tab shows the four newest weekly windows; the rest open with **Show N older windows**.
- Lines and legend entries on the Limits chart fade with the window's age; hovering a line or its legend entry lifts both.
- The limit history keeps 52 weeks of readings instead of 20 000 rows.
- Opening the dashboard keeps one **Claude: opening the dashboard** notification up through indexing, fetching, the machine snapshot and rendering.
- The changelog, docs and marketplace requests run in parallel on open, each with a 10-second timeout.

## [0.52.1] — 2026-09-02

### Fixed

- `opus[1m]`, `sonnet[1m]` and `fable[1m]` are back on the Launch tab and in `claudeStatusline.model`.
- A saved `[1m]` value selects its own card on the Launch tab.
- The Model panel's note says where the plain alias runs on 200k: behind a gateway, on Pro, on third-party providers.

## [0.52.0] — 2026-09-02

### Added

- Permission mode and fallback model are choices on the Launch tab and the
  settings `claudeStatusline.permissionMode` and `claudeStatusline.fallbackModel`,
  passed as `--permission-mode` and `--fallback-model`. Both are user settings
  only, like the extra arguments.
- Each advisor option on the Launch tab says what it buys on the model chosen;
  on a Fable session the `fable` row says not to turn it on.
- `claude-fable-5-1` and `claude-mythos-5-1` are priced, at $10 / $50 per million tokens.

### Changed

- A cache read is priced per model; Fable 5.1 and Mythos 5.1 read at $0.25 per
  million tokens.
- An advisor's consultation is priced from the reply that made it, at the
  advisor's own rate.
- The Advisor tile on the Tools tab counts priced consultations, with the calls
  beside.
- The Cache panel's note names Fable 5.1's read rate, a fortieth of input.
- The Models panel books an advisor's consultation to the advisor's own row; the
  model × effort matrix shows it in an `advisor` column.
- The header and the tab rows stay at the top of the page while it scrolls.
- Switching tab or section opens it at the top of the page.
- The Launch tab names the `fable` alias Fable 5.1, with a 1M window.
- The Launch tab's Opus and Sonnet rows read 1M; the Model panel says where Opus
  is 200k.
- A session row on the Sessions tab lists the advisor among its models and
  leaves `<synthetic>` out.
- `INDEX_VERSION` is bumped.
- The first run after this re-reads every transcript.

### Removed

- The verdict banner above the Launch options, with its **Apply these** button.
- `opus[1m]`, `sonnet[1m]` and `fable[1m]` from the Launch tab and the
  `claudeStatusline.model` setting. A saved `[1m]` value selects its plain card,
  and saving the tab writes the plain alias; on Pro, put `--model 'opus[1m]'`
  in the extra arguments and leave the model to the client.

### Fixed

- The session's cost, today's cost and a live workflow's cost charge a response
  once; a reply written as three records was charged three times.
- `{requests}` and the requests row of the session hover count responses, not
  records.
- The Sessions table fits its panel at every width; the title column gives way
  and the Spend column stays on the page.

## [0.50.0] — 2026-08-31

### Changed

- Spend is judged against the rhythm you work to, not against the share of the
  week elapsed.
- The plan comes from your own hours: 43% of a week's limit goes between 22:00
  and 06:00.
- `{drift}`, the verdict and the glyph bar use it; the chart keeps the linear
  plan.
- The terminal dashboard uses it too; the terminal status line stays linear —
  it opens no file.
- The extension is named **Dashnlines for Claude**: the panel, the settings
  section, the commands and the dashboard heading.
- The identifier, every `claudeStatusline.*` setting and every keybinding are
  unchanged; nothing to migrate.

### Fixed

- A panel's pills stay beside its title at every width; a set too wide for the
  line folds its own tail onto a second row instead of dropping whole.
- Figures keep their monospace font where the editor's font variable is
  missing; they fell back to Courier New.

### Added

- The repository is a Claude Code plugin: `/plugin marketplace add`, then
  `/plugin install dashnlines@dashnlines`.
- `/dashnlines:dashboard` prints the dashboard inside a session.
- A dashboard for the terminal: `bin/dashnlines`, carrying the page's six
  sections and all 24 tabs.
- `Tab` moves between sections, arrows and `1`–`9` between their tabs, `q`
  leaves.
- `dashnlines --reindex` builds the usage index from the terminal.
- `--print` draws one frame instead, for a pipe or a screenshot; `--tab` picks
  which one.
- A status line for the terminal: `node bin/statusline.js` as the `statusLine`
  command in `~/.claude/settings.json`.
- Segment templates are passed as arguments to it; `--no-color` and `NO_COLOR`
  drop the escapes.

## [0.48.0] — 2026-08-25

### Added

- Agent rows and agent cards name the effort the agent ran on, beside its model.

### Fixed

- Settings come from `settings-reference.md`; the Client tab refreshes again.
- The registry ships 208 settings and 341 variables; it held 135 and 315.
- Bedrock, Vertex and gateway model ids are priced and labelled as the model they
  name.

## [0.46.3] — 2026-08-25

### Added

- **Claude: Remove the shell alias** takes the extension's block out of the
  shell file.

### Fixed

- A blank alias field no longer removes the alias from the shell file.
- **Write to ~/.zshrc** follows the alias field as you type it.

## [0.46.2] — 2026-08-25

### Changed

- The Launch banner is headed **The most you can get for the price**; it read
  *What the measurements settle*.
- A panel's title and its state pills stay on one line; the pills wrap under
  themselves instead of dropping whole under the title.
- Below 360px of panel width the two stack; the pills keep the right edge on
  whatever line they land on.

### Fixed

- Claude Sonnet 5 is priced at $2/$10 per million tokens, in the rate table and
  on the Launch tab; it was $3/$15.
- The first run after this re-reads every transcript and reprices Sonnet 5 spend.
- **Write to ~/.zshrc** keeps the alias when the field is blank and the setting
  still names one.
- The refresh tick leaves the Launch tab alone, as it already did the Settings
  tab.

## [0.46.1] — 2026-08-24

### Added

- Setup → Launch opens on a verdict banner above the options, carrying three
  figures:
  - the Opus 5 + Fable advisor pairing at 85.7%, against 84.4% and 83.4% alone;
  - `xhigh` at 44.4% against `max` at 43%;
  - Opus 5 at 91.7% against Fable 5 at 91.3%, for about 60% of the cost.
- Each figure names the benchmark behind it, its size and its method.
- Each figure names the document it comes from; the footer carries the date the
  three were checked.
- The banner names the settings the verdict implies: model `opus 1M`, effort
  `xhigh`, advisor `fable`.
- An **Apply these** button sets those three in the controls below. Save lights
  as it does for a choice made by hand.
- The Launch tab writes out the command **Open Claude Code** would run, with a
  button that copies it.
- The line is read-only and follows the choices as they are picked, before
  anything is saved.
- The same command is offered as a shell alias, named by
  `claudeStatusline.aliasName`.
- The alias quotes model ids such as `opus[1m]`; unquoted, zsh answers
  `no matches found`.
- A name the shell would refuse produces no alias line.
- **Write to ~/.zshrc** puts the alias there in a block the extension owns; the
  rest of the file is preserved byte for byte.
- The first write keeps a copy of the file beside it, and the replace is atomic.
- The write happens on that button only, never on Save.
- Clearing the alias name removes the block.
- A shell whose `alias` takes different syntax is told so instead of being
  handed a line.

### Changed

- The bar describes the session in the terminal tab you are looking at, not
  whichever session in the workspace wrote last.
- A tab with no Claude in it falls back to the workspace answer.
- Switching tabs redraws the bar at once instead of waiting for the next tick.
- The active terminal is the one with focus, or the one that had it last.
- A terminal already active when the window opens is picked up at startup.

### Documentation

- Every released changelog section was rewritten to the facts-only style of
  `.claude/skills/writing-docs`; the facts themselves are unchanged.

### Fixed

- The shell file named on the Launch tab is the one the chosen shell reads; a
  test asserted `.zshrc` whatever the shell was, and CI runs bash.
- Fields wrapped in a row of their own are themed; they were drawn by the
  browser, dark on a light page (0.42.0).
- **Open Claude Code** starts the session in the workspace's first folder, not
  in the folder of the last editor.
- The verdict banner no longer says that no published measurement puts `max`
  above `xhigh`.
- The banner names the two measurements that do: GDPval-AA v2, ELO 1827 against
  1861, and AA-Briefcase, 1693 against 1720, on 25% and 15% fewer output tokens.
- The banner no longer credits Fable with a lead on multimodal work and human
  preference; it names DeepResearch Bench II, where Fable does lead.

## [0.44.0] — 2026-08-21

### Added

- The output styles you wrote yourself are offered on the Launch tab, read
  from `~/.claude/output-styles`, under the client's own five.
- A style is named by its frontmatter `name`, or by its file name when it has
  none.
- Each one carries its `description`, and a style that does not set
  `keep-coding-instructions` says so.
- The panel says where styles live whether or not you have any.
- A quoted frontmatter value loses its quotes; a name written `"like this"`
  still matches what the client is matching against.
- The heading pill keeps showing a chosen style after its file is deleted.

### Fixed

- Extra arguments on the Launch tab is themed; it was drawn by the browser, a
  black box on a light background (0.42.0).
- The setting's description sent you to `launchArgs` to name a style, which
  is no longer the way to do it.
- The marketplace description called this a 23-tab dashboard; it has 24.

### Documentation

- The Launch screenshots are re-shot; the previous pair predated the
  custom-style block and showed the black input this release fixes.
- The demo data invents two output styles, one of each kind.

## [0.42.0] — 2026-08-21

### Changed

- Setup splits in two: `Live now`, `Background jobs`, `Task lists` and `Disk`
  move to a new **Machine** section.
- The tabs themselves are unchanged, only where they are found.
- A new **Launch** tab holds what a session starts with: where it opens,
  model, effort, advisor, output style, and extra arguments.
- Every launch option carries a description in the client's own wording.
- Every model carries its rate and its context window.
- Each panel heading shows what it is set to, the way the Now tab's panels
  do.
- Preset cards are a third of their old height, with the full bar preview
  moved to hover.

### Added

- The advisor list is ranked against the chosen model and re-ranks as you
  change it.
- An advisor the client would refuse is dimmed behind a dashed border and
  disabled, with the reason beside it.
- Picking a model that refuses the advisor already chosen clears that choice
  back to none.
- Each effort level shows what it costs on this machine: output per reply,
  and a ratio against the level with the most replies.
- A level with fewer than 300 replies behind it says so instead of printing a
  ratio.

### Fixed

- `best` was documented as picking whichever model suits the task; it picks
  Fable 5 where your organization has access, and the latest Opus when it
  doesn't.
- The advisor panel said refused pairings are struck through; they are
  dimmed behind a dashed border.

### Documentation

- Six listing screenshots re-shot in both themes: every one of them carried
  the five-section nav that this release replaces with six.
- The demo data makes every launch choice.

## [0.40.1] — 2026-08-20

### Added

- `Concise`, the output style the client added in 2.1.237, can be picked when
  starting a session.

### Fixed

- The session panel showed no output style for sessions this extension
  started.
- The panel was reading the settings files, where the style was never
  written.
- The style comes off the session's own command line; the client has no
  `--output-style` flag, so it travels in `--settings` JSON.
## [0.40.0] — 2026-08-19

### Changed

- The page header shows name, mark and version on the left, index state and
  the two controls on the right.
- Freshness and the countdown share one pill, `19:09 · next in 55s` while the
  timer runs and `19:09` when it is paused, with the full date on hover.
- `Pause` and `Reindex` now wear the page's `.btn`, like `Save` and `Add
  segment`, instead of pills with a cursor.
- A hairline separates what is read from what is pressed.
- Pausing turns the control yellow and empties the countdown.

### Fixed

- Listing screenshots carried the version number that `--demo` no longer
  stripped.
- The anchor is an attribute now, and a test holds both files to it.
- The context panel drew no bar when the transcript could not be read; the
  window gauge now keeps its own track instead.
- An unreadable `dashboard.css` now falls back to a legible minimum, instead
  of throwing at require time and taking down the status bar, the tree and
  the sidebar.
- A test checks that `.vscodeignore` cannot drop a file the runtime reads.
- The tooltip drew every pill the same way, ignoring `tone`; `credits off`
  looked like `max`.
- Pills that warn or reassure now carry the codicon a toned note gets.
- `credits off` was stated twice, as a pill and again in the note beside it;
  the pill states the switch, the note states the money.
- The output style pill read as a bare `default` and now reads `style
  default`, the same shape as `advisor`.
- The body spacing applied to every block of a sidebar section and beat any
  rule declared above it.
- The week footer's centring rule still pointed at a middle element that no
  longer exists.

## [0.38.0] — 2026-08-19

### Changed

- The three panels of the Now tab follow one shape: heading with state as pills,
  the panel's figure, what it is made of, the facts, a footer.
- Limits leads with the week, drawn as one large percentage with the plan as a
  notch on its track.
- The 5-hour and per-model windows sit under it as compact rows.
- The verdict against plan moved into a pill beside the heading, out of the
  sentence that measures it.
- Pace, forecast and credits keep their words and lose their left borders, with
  a coloured dot carrying the tone.
- Spend is titled Spend; the session's cost is the figure.
- Burn rate and today's spend are pills, and what it took stays a table.
- The session panel shows effort, advisor, thinking and output style as pills
  beside the model instead of four rows of monospace.
- That panel ends in a footer of branch and client version, with a chip when a
  newer client is unpacked and waiting.
- The stylesheet moved out of a template literal into `dashboard.css`, 708
  lines.
- The week track became a panel: everything that used to float around the rail
  is a pill in the heading, and the block lost 45px.
- Two pills wear a dot in the colour of the mark they name; the rail's
  captions are gone.
- A forecast landing past the reset gets no dot.
- The task list is a strip across the page; the old fourth panel left one
  column of three carrying two.
- The strip carries `Tasks 4/7`, the share as a track, what is in progress, and
  how many other sessions are open.
- The strip is one line down to about 640px and two below that.
- The context breakdown is one colour bar with a legend, keyed by part name;
  a part keeps its hue when the sort moves it.
- Where auto-compact waits rides on that legend's caption, beside `your setup`.
- The context block is a gauge with a list under it: the window is the
  headline, cache and auto-compact are chips beneath, not rows of their own.
- Each part of the breakdown is one line, not two; the share is drawn as the
  fill behind the row.
- The breakdown sums what your own setup costs — memory files, skills, agents,
  MCP instructions, tool names, hooks — as a share of the window.
- Two new block kinds, `gauge` and `parts`.

### Fixed

- The same fact was drawn in opposite tones on one screen: `12% ahead of plan`
  in green on Limits, `12% over` in yellow on the track above it.
- Both now say `over` and `under`, and both colour overspend as a warning.

## [0.36.0] — 2026-08-18

### Added

- The context window is broken down into what fills it, shown on the Now tab
  and in the sidebar.
- Rows are ordered by share, largest first, with free space pinned to the
  bottom.
- `/context` in the client draws this from figures held only in memory; none
  of it can be read back.
- The transcript records the blocks the client adds to the prompt: the skill
  listing, the deferred tool names, the agent listing and each MCP server's
  instructions.
- Those blocks are weighed at four characters to a token, each marked with a
  tilde.
- Listings arrive as deltas: a record marked `isInitial` replaces what came
  before, everything else adds and removes by name.
- Summed naively this machine reads ~93k tokens of skills where the client
  reports ~10k.
- The largest row, **rest in use**, combines the conversation, the system
  prompt and the tool schemas into one number that nothing on disk separates.

## [0.34.0] — 2026-08-17

### Added

- An output style can be asked for at launch: `default`, `Proactive`,
  `Explanatory` or `Learning`.
- There is no `--output-style` flag: the style travels as `--settings` JSON,
  merged with your settings files, leaving the rest alone.
- A style of your own lives in `~/.claude/output-styles` and goes through the
  extra arguments by name.

### Changed

- The sidebar opens on Limits and Session split evenly, with Live sessions
  and Workflow runs collapsed.
- None of that binds afterwards: VS Code remembers whatever you drag or open
  yourself.
- The previous window's answer is now remembered and given before anything is
  read; the first tick corrects it.
- The four panes have new ids, resetting the layout once.

### Fixed

- The settings inputs are painted from the theme again.
- Every field fell through to the browser's own control, drawn dark under
  `color-scheme: light dark` whatever the page's theme is.
- Number fields had the same issue: `width: 8ch` never applied, leaving them
  as wide as a sentence.

### Documentation

- Two new screenshot pairs: the launch panel with everything chosen, and a
  window's week ahead of plan.
- Below plan the forecast lands past the reset and `{dry}` is silent;
  `tools/preview.js --demo --over` spends the demo week ahead of plan.
- The week under its plan gets its own frame and paragraph, including the
  caption `lasts to the reset`, where `{dry}` stays empty while `{dryAt}`
  still names a date.
- Colours are named for both themes wherever a mark actually changes with the
  theme.
- The plan rule was called black, true only on a light theme; it is drawn in
  `--vscode-foreground`.
- The status bar's thresholds were described as yellow and red where they are
  the editor's own warning and error backgrounds.

## [0.32.0] — 2026-08-16

### Added

- A session can start on a chosen model, effort and advisor, via
  `claudeStatusline.model`, `.effort` and `.advisor`.
- Empty is the default for all three; passing no flag keeps the client
  deciding as before.
- `--advisor` is a real flag hidden from the client's own `--help`; the
  setting is the way to find it.
- The model list matches the client's aliases: `opus`, `sonnet`, `fable`,
  `haiku` (each with a `[1m]` variant), plus `best` and `opusplan`.
- A `[1m]` entry is the million-token variant of a model; `prefer1m` picks
  it by default.
- Values are quoted before they reach the shell; unquoted, zsh reads `opus[1m]`
  as a pattern and answers `no matches found`.
- Quoting also keeps a model name with shell syntax as a single argument,
  not a second command.
- `claudeStatusline.launchArgs` goes in as typed.
- `launchArgs` is `machine`-scoped.
- **Claude: Open Claude Code with…** asks for a model and an effort instead
  of reading the settings.
- The button's hover names what it would start on.
- The Settings tab has a panel for what a session starts with.
- Save is a bar of its own, stuck to the bottom of the tab.
- That bar says whether there is anything to save.
- The free text field has more room to type in.
- The dashboard tab uses the extension's own icon instead of the generic
  webview glyph.

### Fixed

- A tab restored after a reload follows its session's name again.
- A restored tab is matched by two identifiers, either enough alone: an
  environment mark and the shell's pid.
- The tab's icon is not restored: it does not reach the extension, and
  `Terminal`'s fields are read-only.
- `.claude/` is no longer packaged. 0.30.0 had shipped the repository's
  publishing skill to both storefronts.

## [0.30.0] — 2026-08-16

### Added

- The Activity Bar container is a panel of four sections: Limits, Session,
  Live sessions and Workflow runs.
- The container is called **Claude Dashboard**, not "Claude".
- Limits and Session are the status bar's own tooltip sections.
- Session hides itself when no Claude session is open in this window.
- Limits have a pane to themselves.
- The container's icon is the extension's own mark, drawn as a
  single-colour glyph.
- The editor caches that glyph by path. This one is `media/bar-icon.svg`.
- A badge on that icon counts live sessions and shows nothing when there
  are none.

### Fixed

- A session opened by the button survives a window reload: the tab is
  created with `isTransient: true`.
- A tab that comes back is taken over again and keeps following its
  session's name.
- Closing itself when the session ends is not promised across a reload.
- A full quit is left alone: there is no process to reconnect to.

## [0.28.0] — 2026-08-16

### Fixed

- A reply is charged once, at its final figures.
- Output read 100.1M where it is 47.1M, cache writes 1 043M where they are
  382M, input 6.8M where it is 2.0M, and cache reads 25.2B where they are
  12.6B.
- The records of one response disagree: on 25.5% of them the early records
  hold a partial output and only the last is the answer.
- A response is charged from its fullest record, the one whose usage totals
  the most, with its fields merged across every record.
- Tool calls are still counted from every record.
- `INDEX_VERSION` is bumped.
- The first run after this re-reads every transcript.
- The Agents tab and the Cache note no longer read "2843 replys".
- A dated model id finds its rate again: `[1m]` and `-fast` were stripped from
  an id, the date was not.
- `claude-haiku-4-5-20251001` missed `RATES` and was billed at the Opus
  fallback, five times its own rate, under a row still reading "haiku 4.5".
- On this machine that model reads $0.40 rather than $2.01.

### Added

- A model with no published rate carries the tilde every other estimate
  carries.
- The hover says an id missing from `RATES` is billed at the `FALLBACK` rate,
  the Opus rate.
- Only the row of the model itself is marked; a total that merely includes
  such a model is left alone.
- `<synthetic>` is no longer drawn as a model: it is what the client writes
  in place of a reply that never arrived, with an all-zero usage.
- Those records still reach the Requests tile, which counts messages rather
  than models.
- Spend by agent type, on the Agents tab, read from the `.meta.json` the
  client writes beside each subagent transcript.
- The same file carries the model the dispatch asked for, its depth in the
  spawn tree and its parent, all now indexed.
- Plugin agents are matched by that type on the Health tab; an agent was
  reported as "not visible" whether or not it had ever run.
- Replies the cache could not answer, on the Cache tab: calls that sent more
  than 100k of input at the full rate.
- The largest of them are listed by session and project.
- The first reply of a session is always one; a large one partway through a
  run is a cache rebuilt rather than reused.
- Peak parallel sessions and time actually working, on the Sessions tab,
  plus a *working* column beside *open*.
- Gaps longer than five minutes are a session left sitting rather than one
  thinking, and are not counted as work.
- The peak counts main transcripts only.

## [0.26.0] — 2026-08-14

Everything below is in the stable channel; it shipped an hour earlier as
`0.25.0`, whose odd minor number put it in pre-release by mistake.

### Added

- **Open Claude Code** — a button in the editor's title bar, and a command,
  that starts a session as a tab in the group you are looking at.
- Claude Code's own button splits a new editor group off to the right
  instead.
- The session runs `claude` from the shell's `PATH`.
- The tab closes with the session when it ends cleanly and stays, with the
  reason on screen, when it fails.
- `claudeStatusline.openLocation` chooses where that session lands: a tab in
  the current group, a tab beside it, the terminal panel, or its own window.
- That setting governs both buttons and the command, and is read at the
  moment you press one.
- The tab is named after the session running in it, following `/rename` and
  the generated title as they change, under `claudeStatusline.renameTabs`.
- Only tabs this extension opened are renamed, and only while one of them is
  the active terminal.
- The same button sits in the status bar as `$(terminal)$(sparkle)`, the two
  codicons closest to the extension's icon.
- That button is drawn whether or not anything has been read; it is there
  even on a machine that has never run Claude Code.
- Every row of the Disk tab says where it is on hover and offers a **show**
  button that reveals the directory in Finder.
- The extension still deletes nothing.

### Changed

- The week bar draws spend on the week's own axis.
- The gap between the fill and the mark is the over- or underspend: red past
  it, green short of it.
- The figure and its distance from the plan are written on the fill, as
  `72% +17%`.
- The cells are calendar days with their dates, today in bold.
- Both ends of the window carry their date and hour, and the forecast is
  stated as `dry 1d12h → Sat 15.08, ~13h`.
- The moment a week runs out is recorded.
- The mark is written once, on the first reading that sees the quota gone, with
  the plan of that moment.
- It is kept in `week-marks.json` beside the reading log.
- A window that ran out before this shipped has its moment recovered from
  the readings, or says it is unknown rather than inventing a date.
- The status-bar bar is seven cells, one per day of the window; six were
  28-hour blocks standing for nothing.
- Nothing is said about pace in the first half hour of a window or below 2%
  spent.
- At 100% no forecast is offered; the bar printed the current hour as a
  prediction.
- The zone between the fill and the plan mark is measured to the mark
  rather than to the floored percent printed under it.
- The Behaviour panel shows every choice at once as a card per option, each
  with a line saying what picking it does; it was a dropdown.
- Reading and the network are built from the same rows, with the name and
  the sentence above the control rather than beside it.
- The Claude Code tab says what each environment variable does on the page; it
  was a browser tooltip, one line across the panel.
- The same tab shows each variable's documented default beside its value,
  marked when the two differ.
- Defaults come from the reference's own prose, which states one for 32 of
  the 315 documented variables; the rest keep a dash rather than a guess.
- Dates are written day first, as `11.08`, everywhere on the page.
- The status bar's context menu names this extension's items after it; they
  read as `Claude Code` and `Claude 4` before.

## [0.25.0] — 2026-08-14

Published to the pre-release channel by mistake and superseded an hour later
by 0.26.0, which carries the same code; anyone running 0.25.0 is running
0.26.0 under an older number.

## [0.24.0] — 2026-08-13

Carries everything prepared as 0.22.2, which was never released.

### Changed

- The week track measures time already gone, how long the quota lasts, and
  how long the week runs without it.
- Out of quota is its own state on the track, one block from now to the
  reset.
- Both marks are always named, `now` under the rail and `dry` over it.
- Neither mark is hidden when the two sit close together.
- Weekly spend moved off the track into the line above it.
- Status-bar bar glyphs: `█` spent, `▓` spent past the plan, `▒` plan not yet
  reached, `░` the rest.
- The Pace tooltip says "behind plan" where it said "under plan".
- The forecast tooltip shows time left after the quota is gone, and says
  "out of quota" instead of a time.

### Fixed

- The status-bar bar no longer shows an overspend cell for a week behind
  plan; 216 of the 10 201 possible spend/plan pairs were wrong.
- The countdown no longer sits at zero when a redraw is skipped.
- Credits print in the currency the endpoint named instead of assuming
  dollars.
- A meter in a tooltip no longer draws every filled cell as spend past the
  plan.
- The Changelog tab lists every release in the file: 281 of 361 were hidden.
- Switching off "Refresh on a timer" now also stops the transcript pass,
  spend across every project, and the limits request.
- Focus on the window no longer triggers those reads either.
- A new refresh interval takes effect without a window reload.
- Ticking another checkbox no longer restarts the countdown.
- "Releases ahead" counts only releases ahead of the running client.
- The links in the README's table of contents work on both listing pages.
- The "Across all requests" figure now shows the correct Opus rate.
- Settings shaped like a credential are now masked regardless of name;
  `GH_PAT` and a Sentry DSN had printed in full.

### Internal

- Removed a function with no caller, a filter on a field that does not exist, a
  shadowed import, and a chart axis built twice per drawing.
- The overflow probe opens what is folded before measuring; it had rendered the
  Changelog tab empty and priced every agent at zero.
- The week-track probe measures label rectangles in the browser and is verified
  against a known-bad input; it had been reading a stylesheet that no longer
  exists.
- Five tests for the week track, which had none.
- The trim on the limits history has a test, and its comment carries a measured
  figure.

## [0.22.1] — 2026-08-12

The first version on Open VSX (the registry Cursor, Windsurf, VSCodium and
Gitpod install from) carries 0.22.0 unchanged.

The VS Code Marketplace stays on 0.22.0: its upload step runs before Open
VSX's, and an authentication failure there reaches neither registry.

## [0.22.0] — 2026-08-11

The first version actually published, in the stable channel, carries
everything 0.20.0 was, plus the fixes that came after it.

## [0.21.0] — 2026-08-11

### Fixed

- A run's age now comes from its files, not its directory; hours-old files
  no longer read as a live run.

## [0.20.0] — 2026-08-11

First public release, stable channel: a status bar you write yourself out of 45
placeholders, and a 23-tab dashboard over every Claude Code transcript on the
machine — limits with a pace forecast, spend by day, model, project and branch,
subagents and workflow runs with what each agent cost, cache and friction, and a
Setup section that reads the installation itself.

Everything is read locally; one request leaves the machine and it has a switch.

## [0.19.24] — 2026-08-11

### Fixed

- The Claude Code tab said "No settings files could be read" where it simply
  had none to read.

## [0.19.23] — 2026-08-11

### Changed

- The listing says where the pause lives: the page header and the Settings
  tab move the same switch.

## [0.19.22] — 2026-08-11

### Added

- Pause the refresh from the page header, beside Reindex and the countdown.
- The control is the same `claudeStatusline.autoRefresh` as the switch on the
  Settings tab, and moving either moves the other.
- While it is paused the page is not rebuilt: an expanded list stays
  expanded, and the scroll position stays put.

## [0.19.21] — 2026-08-11

### Changed

- The listing counts the tabs again (twenty-three, not twenty-two) and says
  what the Claude Code tab answers.
- Privacy names the credential masking as a promise rather than an
  implementation detail.
- The optional refresh is described by what it fetches rather than by
  counting URLs that keep changing.

## [0.19.20] — 2026-08-11

### Added

- A Claude Code tab, under Setup, answering three questions: what you have
  set, what you could set, and what you have moved away from the default.
- Settings files are listed in the order the client resolves them: managed
  first, then the project, then you.
- The file that won each key is named, the files it shadowed are counted,
  and there is a button to open any of them.
- Environment variables are shown twice: the `env` block every session
  gets, and what this editor window happens to have inherited.
- A settings reference parsed from Anthropic's published documentation and
  packaged with the extension: defaults and descriptions are available
  offline.
- That reference carries the date it was read, and with the network switch
  off the tab says how old the packaged copy is.

### Fixed

- Credential-like values are hidden: the Health tab printed
  `~/.claude/settings.json`'s `env` block verbatim, including any
  `ANTHROPIC_API_KEY` kept there.
- Values that look like a key, token, secret or password render as `•••` at any
  depth; a plain number stays readable, such as `MAX_THINKING_TOKENS`.
- Managed settings are read: `managed-settings.json` overrides everything
  else, and on a managed install every number derived from settings could be
  wrong.

## [0.19.19] — 2026-08-11

### Changed

- Renamed to *Dashboard & Statusline for Claude Code*, with the id moving
  from `claude-statusline` to `claude-dashboard`.
- Settings keys stay `claudeStatusline.*`.
- A new icon: a progress ring for the limit and three bars for the
  dashboard, on a teal-to-indigo plate that survives 32 px.
- The old one is kept in the repository as `media/icon-v1`, and the same
  mark now sits next to the title on the dashboard page.
- The README is a listing page rather than a reference manual, with a
  **Known issues** section that says what does not work: Windows, remote
  hosts, vscode.dev.

## [0.19.18] — 2026-08-11

### Fixed

- The limits request is the extension's own; no configured `statusline.sh`
  is needed, though the documentation said otherwise.

## [0.19.17] — 2026-08-11

### Fixed

- The word tally on the Content tab counts typed prose only, once per
  prompt, and no longer treats file paths and ids as vocabulary.

## [0.19.16] — 2026-08-11

### Fixed

- A panel note renders as a block; notes that carry lists are no longer
  flattened.

## [0.19.15] — 2026-08-11

### Added

- The Health tab says, per plugin, where its update would come from.

## [0.19.14] — 2026-08-11

### Fixed

- The hover panel was transparent and read as two rows at once.

## [0.19.13] — 2026-08-11

### Fixed

- The update check actually checks, and old releases fold away instead of
  filling the tab.

## [0.19.12] — 2026-08-11

### Added

- Every setting on the Setup page, each with the switch where it applies,
  and a countdown to the next refresh.

## [0.19.11] — 2026-08-11

### Added

- Usage credits: what the account has spent past its plan, the only figure
  billed as money rather than estimated, and the only one shown without a
  `~`.

## [0.19.10] — 2026-08-11

### Added

- A monthly budget (`claudeStatusline.monthlyBudget`): the month drawn
  against a ceiling, with a word at 80% and at 100%, once each, not every
  tick.
- Export of the index as CSV or JSON.
- Plugin and MCP health: what each plugin ships, which of it ever ran, and
  which MCP servers earn their place.
- Version checking against a plugin's marketplace is opt-in
  (`claudeStatusline.checkPluginUpdates`).
- A memory tab: the files loaded into every prompt (`CLAUDE.md`, `rules/`,
  project memory), sized in tokens and priced across every request made.

## [0.19.9] — [0.19.4] — 2026-08-11

### Added

- A live workflow panel on the Now tab: one table per running run, one row per
  agent, in dispatch order.
- Each row carries the model and the effort that agent was given.
- Agents are named rather than numbered.

### Fixed

- Every agent of a run is listed, not the first page of them.
- A run whose session is alive gets an hour of quiet before it counts as
  abandoned, rather than ten minutes.
- Long names wrap at word boundaries and say the whole thing on hover.

## [0.19.3] — [0.19.2] — 2026-08-11

### Fixed

- The charts have a y-axis with round ticks, and the calendar has a scale
  that says what the darkest cell costs a day.
- A bar list no longer draws 1% as a full bar when a percentage series has
  a single row.
- The overflow probe was replaced: the old one compared `scrollWidth` to
  `clientWidth` on a page that hides overflow.
- The new one measures geometry, and was verified against a revision known
  to be broken.

## [0.19.1] — [0.19.0] — 2026-08-11

### Added

- Everything needed to publish: a marketplace identity, an icon, a licence
  and workspace-trust capabilities.
- `claudeStatusline.fetchLimits`, the one outbound request, made opt-out;
  off means the OAuth token is never read.

### Changed

- The whole page rebuilt on one vocabulary: tiles, panels, share cells,
  with no heading outside a panel anywhere in the 22 tabs.
- The first screen redesigned, and the hovers given meters that match the
  bar.

### Fixed

- A test that could not fail on a calendar boundary, and a preset
  description that printed its own markdown.

## [0.18.0] — [0.15.1] — 2026-08-10

### Added

- A settings editor in the dashboard: ready-made bars, a field per segment
  with a live preview, and a placeholder palette carrying current values.
- The Now tab is cut from the same sections as the status-bar tooltips; the
  page and the hover cannot disagree.
- The open page redraws on the same tick as the bar, keeping its section,
  tab and scroll position.

## [0.10.1] — [0.9.0] — 2026-08-10

### Added

- The workflow panel: a tree of runs in the Activity Bar with three states
  (running, finished, abandoned), phases and agents, priced from `usage`
  records only.
- A live run is assembled from its journal and its agents' transcripts.
- Status-bar placeholders for a running workflow, and commands to open the
  run's script and copy its id.

## [0.6.4] — [0.6.0] — 2026-08-09

### Added

- The usage dashboard over an index of every transcript on the machine,
  open from any status-bar item.
- Tooltips rewritten for a GUI rather than for one terminal line.

### Fixed

- The session reported is the one this window is actually using.

## [0.5.0] — 2026-08-09

### Added

- The first build: Claude Code's limits, context and spend in the VS Code
  status bar, read from `~/.claude` and the account's usage endpoint.
