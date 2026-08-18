---
name: release
description: Cut a release of this extension end to end — pick the number, stamp the changelog, tag, and get both storefronts onto it. Use when the user says "зарелизь", "давай релиз", "выпускай", "release it", or asks to publish a new version. Also covers the marketplace upload on its own — "обнови в маркетплейсе", "залей в маркетплейс", "publish to the marketplace", or asking why the two storefronts disagree: start at the marketplace section.
---

# Releasing this extension

One tag publishes to Open VSX. The VS Marketplace is a manual upload, because its
step in `release.yml` is commented out — the `VSCE_PAT` it needs cannot be issued
on this account (project memory `vsce-pat-blocked-by-azure-subscription`). So a
release is done when **both** storefronts show the new number, not when the
workflow goes green.

**This is publishing.** Do it when the user asks for a release, not because work
accumulated. Everything up to the tag is reversible; the tag and the upload are
not — a published version can be unpublished, never replaced.

## Before touching anything

```bash
git status --porcelain          # what will go in
git log --oneline -1            # what the last release was
rg -m2 '^## ' CHANGELOG.md      # is there an [Unreleased] section at all
```

Two questions the answers decide:

**Is there a live session in this repository?** `ListAgents` — if another session
is working here, tell it what you are about to commit and give it a minute to
object. A release commits the whole tree; a peer's half-finished file would ride
along.

**Is `[Unreleased]` there and complete?** It should already hold a line per
user-visible change, written as each was made. If it is missing or thin, write it
now from `git diff` and say in the report that it was written late — the rule is
in `CLAUDE.md`, and a release is exactly when its absence hurts.

## The number

`CLAUDE.md` and project memory `version-bumps-at-release-only` own this. In short:

- **patch** when the changelog entry is all `### Fixed`; **minor** when the
  extension does something it did not do before. **`major` is never yours.**
- **The channel is the parity of the minor.** "Release" with no qualifier means
  **stable**, which is an **even** minor: 0.34 → **0.36**, never 0.35. A
  pre-release happens only when the user asks for one in words (project memory
  `release-channels`, and it cost a wasted version once).

## Cutting it

```bash
# 1. Stamp the changelog: [Unreleased] becomes the number and today's date.
#    The heading is replaced, not kept — no empty [Unreleased] ships.
# 2. Bump "version" in package.json to the same number.

node --test test/*.test.js                                    # must be green
node -p "require('./package.json').version"                   # and match
rg -m1 -n '^## ' CHANGELOG.md                                 # the two agree

npx @vscode/vsce package --no-dependencies -o <scratch>/vX.Y.Z.vsix
unzip -l <scratch>/vX.Y.Z.vsix | rg -c '\.claude/' || echo 'ok: no .claude'
code --install-extension <scratch>/vX.Y.Z.vsix
```

Then the release commit — the work and the bump together, Conventional Commits,
and the tag on it:

```bash
git add <explicit paths>          # never -A: another session may be writing here
git commit --no-verify -F - <<'MSG'
feat(scope): what changed, in the register the repo already uses
…
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: <this session's URL>
MSG
git push origin master
git tag vX.Y.Z && git push origin vX.Y.Z
```

## Open VSX, which the tag does by itself

```bash
gh run list --limit 2 --json name,status,conclusion   # poll until Release completes
```

The workflow decides the channel from the minor's parity and passes
`--pre-release` itself — never pass it by hand. The tag must equal the manifest
version or the workflow fails its own check.

Verify the artifact rather than trusting the run, because this same file is what
goes to the marketplace by hand:

```bash
gh release download vX.Y.Z -p extension.vsix -D <scratch> --clobber
gh release view vX.Y.Z --json assets --jq '.assets[] | "\(.name) \(.digest)"'
shasum -a 256 <scratch>/extension.vsix                       # must equal the digest
unzip -p <scratch>/extension.vsix extension.vsixmanifest | rg -o 'PreRelease[^/]*'
unzip -p <scratch>/extension.vsix extension/package.json | rg -o '"version": "[^"]*"'
unzip -p <scratch>/extension.vsix extension/changelog.md | rg -m1 '^## '
```

`PreRelease" Value="true"` means pre-release; no output at all means stable. The
changelog's first heading must carry the number just released — a stray
`[Unreleased]` above it means the working section shipped as a version.

**Check the channel against what was asked, not against the tag you just made.**
A stable release that went out odd reaches nobody who has not opted in, and the
fix is another release: the number is spent.

**The listing lags the run.** `open-vsx.org/api/grgrwlkr/claude-dashboard` kept
answering with the previous version for two to four minutes after the workflow
reported success. Poll it; do not conclude the publish failed. The page itself is
an SPA and `curl` returns 200 even for an extension that does not exist — the API
is what tells the truth:

```bash
curl -s https://open-vsx.org/api/grgrwlkr/claude-dashboard \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["version"], d["preRelease"])'
```

## The VS Marketplace, by hand

Upload the **release asset**, never a locally built package: `extension.vsix`
from the GitHub release is the exact file CI handed to Open VSX, so both
storefronts carry one byte-identical build. It is already downloaded and checked
by the step above; if you are here on your own — because the storefronts have
drifted apart without a new release — do that verification first.

### The browser steps

1. `tabs_context_mcp { createIfEmpty: true }`, then `navigate` to
   `https://marketplace.visualstudio.com/manage/publishers/grgrwlkr`.
2. The page comes up blank while MSAL redirects — `wait` five to eight seconds
   and screenshot again rather than concluding it failed.
3. Click the **⋮** next to the extension row. The menu is
   Reports / View Extension / **Update** / Unpublish / Remove — Update is third,
   and the two below it are destructive. **Screenshot immediately before each
   click and click by the coordinates in that screenshot**: the window resizes
   between calls, and a click at stale coordinates closes the menu silently.
4. In "Upload Visual Studio Code extension": do **not** click the drop zone —
   that opens a native file picker you cannot see. Instead
   `find { query: "file input for uploading the vsix" }` and hand the path to
   `file_upload` with that ref.
5. The dialog then shows the file name and enables **Upload**. Click it.

### Confirming it, which is not the same as seeing it

The green **"It's live!"** panel appears immediately and means the upload was
accepted, not that the version is published — the row shows the old number with a
spinner while the package is verified. Measured: 7, 10, 11, 6, 7, 6, 7 and 6
minutes across the last eight releases. It does not lengthen with the version:
budget ten minutes and poll, rather than reading the last number as a trend.

The truth is the gallery API. Run it in the background and keep working; do not
sit on a foreground sleep:

```bash
curl -s -H 'Content-Type: application/json' \
  -H 'Accept: application/json;api-version=7.2-preview.1' \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"grgrwlkr.claude-dashboard"}]}],"flags":119}' \
  https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
  | python3 -c 'import sys,json
vs = json.load(sys.stdin)["results"][0]["extensions"][0]["versions"]
for v in vs[:3]:
    p = {x["key"]: x["value"] for x in v.get("properties", [])}
    print(v["version"], p.get("Microsoft.VisualStudio.Code.PreRelease", "(absent -> stable)"), len(p), "props")'
```

**`flags:119`, not `103`.** The smaller value omits `IncludeVersionProperties`,
so every version comes back with no `PreRelease` key — which reads exactly like
"published as stable" whatever the truth is. 18 properties on a stable version,
19 on a pre-release; a count near zero means the flags were wrong, not the
package.

The endpoint also answers with an empty body often enough to matter, and a bare
parse of that throws in a way that looks like "not published yet" — retry before
drawing a conclusion.

The version badge in the README comes from badgen with `max-age=3600`, so it lags
publication by up to an hour. Never use it as the check.

## Done means

| | |
|---|---|
| git | tag on the release commit, pushed |
| GitHub release | asset present, digest matches the local file |
| Open VSX | new version, `preRelease` false for a stable release |
| VS Marketplace | new version, `PreRelease` absent, 18 properties |

Then walk the publication checklist in project memory
(`publication-checklist`): anchors by clicking, images on the moving `raw/HEAD`,
the changelog tab's first heading, the channel, and how far the two storefronts
sit from each other.

## What has gone wrong before

- **An odd minor published as a pre-release** and the Install button stayed on
  the old version. Two releases were spent on one piece of work.
- **`[Unreleased]` shipped as a version heading**, so the file claimed a number
  nobody could install.
- **`.claude/` rode into the package** in 0.30.0 — the publishing instructions
  themselves went to both storefronts. A published version cannot be replaced.
- **Screenshots are on `raw/HEAD`**, a moving target: renaming a file under
  `media/` breaks the images of every version already published.
- **A click at coordinates from an older screenshot** closed the ⋮ menu instead
  of opening Update, and the next step then failed looking for a dialog that was
  never opened.
