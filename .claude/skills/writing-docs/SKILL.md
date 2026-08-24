---
name: writing-docs
description: Write CHANGELOG.md and README.md entries for this extension — facts only, no rationale, no prose. Use before adding a line to [Unreleased], before editing README.md, when stamping a release section, or when the user says "запиши в чейнджлог", "поправь ридми", "напиши changelog", "update the README".
---

# Writing the CHANGELOG and the README

Both files are read by users of the extension, not by its maintainers. They carry
**what the software does and what changed in it**. Nothing else — no reasoning,
no justification, no story about how the change came about.

The rule is one line: **a changelog entry states the fact; the reason lives in
the commit message and in the code comment.** This repo already comments its code
densely with *why* — that is where reasoning belongs, and it is why none of it is
needed here.

## The measured norm

Sampled from eight VS Code extensions (GitLens, Prettier, ESLint, Docker,
Error Lens, Live Server, Vim, Python), ten applications and CLI tools (ripgrep,
bat, fd, curl, jq, Node, Zed, Ghostty, Obsidian, Bun) and the stated rules of
Keep a Changelog, Conventional Commits, pnpm, Svelte and Astro, on 2026-08-24:

| | Median bullet | Max | Entries carrying a reason |
|---|---|---|---|
| Prettier, ESLint, Docker, Error Lens, Vim, Python | 7–11 words | 20–48 | **0–2.5%** |
| curl, Node, ripgrep, fd, jq | 8–12 words | — | **~0%** |
| Zed, bat — the explanatory end of the range | 16 words | — | up to 25% |
| GitLens (marketing-style outlier) | 14 | 122 | 20% |
| **This repo, before this skill** | **21** | **142** | **22%** |

pnpm states the split outright: *"Write the description for pnpm users and keep
it concise — it becomes a release note. Implementation rationale belongs in the
commit message, not the changeset."* Svelte enforces it structurally: the
changelog gets `fix: description`, while "Why make this breaking change" is a
field in the PR template.

## CHANGELOG entries

**Form.** One change, one bullet, one line where possible. Past tense, matching
the section it sits under. No trailing period is fine; be consistent. Target
**≤ 15 words**, ceiling 20. A bullet may run to about 30 when every word of it is
a named fact — a list of the values a setting takes, or a row of measurements.
Past that, split it in two.

**Content.** What changed, where it is visible. Name the tab, the setting, the
command, the status-bar field. A number is a fact and always welcome —
`281 of 361 were hidden` is exactly right.

**Banned in an entry:**

- Any clause answering *why we did it*: `because`, `so that`, `which is how`,
  `the reason`, `rather than …`, `otherwise`.
- Any claim about what the change is worth: "worth", "cannot afford", "half
  delivered", "silently", "rots".
- Any account of the bug's history, of what a reader would have thought, or of
  what shipped before.
- Em-dash asides that turn one fact into two clauses.
- Design narration — how the code is built. That belongs in `CLAUDE.md`.

**Three exceptions, and only these** — matching where the sampled projects do
carry a sentence of explanation:

1. A breaking change → say what the user must do, not why it broke.
2. A default that flipped → say the new default and how to restore the old one.
3. A security fix → say what was exposed.

Even then it is one sentence about *the user's next action*, never about our
reasoning.

### Before and after, from this file

| Wrong | Right |
|---|---|
| The Launch tab's Extra arguments field was drawn by the browser rather than from the theme — a black box on a light background, which shipped in 0.42.0 and stood in the listing screenshot. | Extra arguments field on the Launch tab is themed; it was drawn by the browser. |
| Each of the three figures now names the measurement it comes from, under the finding it decides: … three separate measurements, no two of them commensurable. A shared footer naming two documents left the reader unable to tell which number came from which. | Each figure in the Launch verdict names its benchmark, size and method. |
| A session opens in the first folder of the workspace instead of wherever the last editor happened to be. The button never said which directory it wanted, so in a multi-root window VS Code answered from the editor history — and a Claude session's directory is its identity. | **Open Claude Code** starts the session in the workspace's first folder, not in the last editor's folder. |

### Sections

Keep a Changelog's six: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
`Security`. `Documentation` is ours, for README and screenshot work. One section
per kind per release — never two `### Added` blocks in one version.

**Not in the changelog at all:** refactors, tests, comments, internal rules,
dependency bumps nobody can observe, anything invisible from the UI.

## README

It is the marketplace listing. It answers *what this is, what it shows, how to
run it, what it reads* — in that order, with facts.

**Skeleton** (the shape every reference-style tool README in the sample uses):
definitional sentence → install → what it does, enumerated → configuration
reference → data sources → known limits → contributing → licence.

**The opening sentence is a definition**, inside ten words: "X is a Y that does
Z." Microsoft's publishing docs mandate nothing about tone; the only hard rules
are that images resolve over `https` and are not SVG.

**Banned in the README:**

- Argument that the extension should exist — "nothing else adds this up",
  "almost none of it", comparisons meant to convince.
- Narrative about the problem before the description of the tool.
- Explanations of internal design: which module renders what, why two surfaces
  share one function, what the page cannot do. Users do not maintain this code.
- Adjectives doing work a number could do. Give the number.

**Welcome in the README:** tables of tabs, settings, commands and fields;
placeholder syntax; screenshots; exact file paths that are read; the list of what
is never read; version and platform requirements.

## Check before you commit

```bash
# Bullets longer than 25 words in the section you just wrote
python3 - <<'PY'
import re
cur = open('CHANGELOG.md').read().split('## [')[1]
for b in re.findall(r'^- .+?(?=\n- |\n### |\n## |\Z)', cur, re.S | re.M):
    n = len(b.split())
    if n > 25: print(f'{n:3} words: {" ".join(b.split())[:110]}…')
PY

# Reason-words in the section you are writing, and in the whole README
REASONS='\b(because|so that|which is how|the reason|rather than|otherwise|worth|cannot afford)\b'
sed -n '/## \[Unreleased\]/,/^## \[0/p' CHANGELOG.md | rg -n --no-heading -i "$REASONS"
rg -n --no-heading -i "$REASONS" README.md
```

Both should print nothing outside the three exceptions above. If a line survives
the grep, it either states a user action (keep it) or explains us (cut it).

Released sections are left as they are: they are the release notes users already
received. The whole file was normalised to this standard once, on 2026-08-24,
facts unchanged — that was a one-off, not a licence to edit published notes
again. The check is scoped to `[Unreleased]` for that reason.
