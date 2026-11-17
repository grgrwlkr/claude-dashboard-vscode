# Commands reference

Read the relevant subsections before the affected task; paths are relative to the repository root. Original contracts and dated rationale are preserved below.

## Commands

```bash
node --test test/*.test.js                                  # whole suite
node --test test/usage.test.js                                # one file
node --test --test-name-pattern 'pace' test/usage.test.js     # one test by name
npx @vscode/vsce package                                      # build the .vsix
code --install-extension claude-statusline-*.vsix             # install it
```

No build step, no lint config, no npm scripts — plain CommonJS run by VS Code and by `node --test`.
Reloading the window is the user's action, never yours — other Claude sessions may be alive in it.

**Finished product-code changes are packaged and installed over the existing version without changing `version`; instruction-only changes are exempt.** That is how Grigory checks the work: the editor has to be running what you just wrote,
not the build from three commits ago.

```bash
npx @vscode/vsce package --no-dependencies -o <scratch>/current.vsix   # scratch, never the repo
code --install-extension <scratch>/current.vsix                        # overwrites the same number
```

Installing the same version **does** overwrite the files on disk — verified 2026-08-12 by packaging a
marked build and finding the marker in `~/.vscode/extensions/…-<version>/`. No uninstall step, no
`--force`. What survives is the code already loaded into the extension host, which is why the last
line of your report is that the window needs reloading — and that reload is the user's action, never
yours: other Claude sessions may be alive in it.

What must never happen again: several numbers installed side by side. VS Code runs the **highest**
version present, so building 0.22.3/0.22.4/0.22.5 and then settling the tree back to 0.22.2 left the
editor running the newest of the four — code that no longer existed in git. If a stale version is installed, identify its actual active profile/path and prepare a scoped cleanup. Uninstalling or deleting installed extensions requires applicable explicit authorization; do not remove other versions or directories by assumption.
`globalStorage` holds the index and the limits history and is not touched by any of this.

**Add a dependency when it makes the work easier. Do not reimplement what already exists.** The tree
happens to have none today; that is a fact about it, not a rule against them. Before writing a
utility, look for one that already does the job — a built-in first (`Intl`, `URL`, `node:*` ship in
the runtime and cost nothing), then npm — and if it removes real work, install it: `npm i <pkg>`,
and `vsce` packs production dependencies into the `.vsix` by itself. Verify what you are adding
instead of recalling it — `npm view <pkg> version time.modified license dependencies
dist.unpackedSize` — and prefer one with no transitive dependencies.

The test is whether it saves work, in both directions. Hand-rolling a date library, a diff, a parser
or a scheduler because "no dependencies" sounds tidy is the failure this rule exists to prevent.
Adding a package for something already written here is the other one: `pluralize` would ship a
dictionary of English irregulars for sixteen nouns that are spelled out in our own source, so it buys
nothing — while a package that replaced a hundred lines of parsing would buy a great deal. Ask which
one you are looking at, and say so in the commit.

**The changelog is written as you go; the version is stamped on it at the release (2026-08-13).**
Every change that a user would notice adds its lines to `## [Unreleased]` in the same commit that
makes the change — not to a numbered heading, because at that moment nobody knows which number the
work will ship under. At the release, `[Unreleased]` is given the version and the date, and that is
the whole ceremony.

This exists because writing the entry at release time means reconstructing days of work from
`git log`, and because the previous attempt at the same idea wrote a *numbered* entry early: `0.22.2`
had a full entry, a bump in `package.json` and no tag, so the file claimed a version that nobody
could install, and the next release had to work out by grep which of its lines were already
described. An unnumbered section cannot drift that way — it has no number to be wrong about.

**How those lines are written is `.agents/skills/writing-docs`, and it is not optional.** A
changelog entry is a fact about the change — what it is and where it is visible — in about fifteen
words. The reason for the change goes in the commit message and in the code comment, never in
`CHANGELOG.md` or `README.md`; those two files are read by users of the extension, who do not
maintain it. Read the skill before writing either file. The measured norm across eight comparable
extensions is a 7–15 word entry with 0–2.5% of entries carrying any reason at all; this file's own
history had drifted to 21 words and 22% before the skill was written.

**The version moves at a release and nowhere else (2026-08-12, since the extension went public).**
Ordinary commits — fixes, features, refactors, docs — leave `package.json` alone. The number is
raised once, in the commit that carries the tag: bump, stamp `[Unreleased]` with the number and the
date, commit, create the authorized `vX.Y.Z` tag and push only that exact tag.

This replaces the earlier rule that a bump rode inside the commit that caused it. That one was
written when nothing had been published and every build was its own release; now a version is a
thing other people install, and four bumps inside one unreleased stretch of work — which is what
happened on the day this changed — produce four numbers nobody can install and four CHANGELOG
entries describing one piece of work.

**How far to raise it is your call, from what actually changed since the released version.** A
`patch` for fixes and internals; a `minor` when the extension does something it did not do before,
or does something visibly differently. Read the CHANGELOG entry you are about to write: if it is all
`### Fixed`, that is a patch. **`major` is never yours** — only on Grigory's explicit word.

Mind the channel while choosing: an odd minor publishes as a pre-release and an even one as stable
(see `release.yml`), so a minor step inside the stable channel goes 0.22 → 0.24, and the odd number
in between is the pre-release line rather than a version that was skipped.

Commit only when explicitly authorized. The reason to capture a verified release in Git remains: the installed `.vsix` is built from the **working
tree**, so an uncommitted tree means the editor runs code that exists nowhere in git, and nothing can
be reverted to it, diffed against it, or explained by it. Installing without committing is how a
dozen versions once ended up as one uncommitted pile.
