---
name: publish-to-marketplace
description: Upload a released .vsix to the Visual Studio Marketplace through the browser, because the CI step for it is off. Use after a vX.Y.Z tag has published to Open VSX and the marketplace is still on the previous version — the user says "обнови в маркетплейсе", "залей в маркетплейс", "publish to the marketplace", or asks why the two storefronts disagree.
---

# Publishing to the VS Marketplace by hand

`release.yml` publishes to Open VSX only: the marketplace step is commented out
in place and comes back with the `VSCE_PAT` secret. Until then a tag leaves the
marketplace on the old version, and this is how it is caught up.

**This is publishing.** It is outward-facing and irreversible in the sense that
matters — a version cannot be replaced, only unpublished. Do it when the user
has asked for it, not because a release happened.

## What you upload

The **release asset**, never a locally built package: `extension.vsix` from the
GitHub release is the exact file CI handed to Open VSX, so both storefronts
carry one byte. Verify it rather than trusting the download:

```bash
SCRATCH=<session scratchpad>
gh release download vX.Y.Z -p extension.vsix -D "$SCRATCH"
gh release view vX.Y.Z --json assets --jq '.assets[] | "\(.name) \(.digest)"'
shasum -a 256 "$SCRATCH/extension.vsix"        # must equal the digest above
```

The channel is a property of the package, not of the upload — the form never
asks. Read it before uploading and say which channel it is:

```bash
unzip -p "$SCRATCH/extension.vsix" extension.vsixmanifest | rg -o 'PreRelease[^/]*'
```

`PreRelease" Value="true"` → pre-release (odd minor). No output → stable.

**Check this against what was asked, not against the tag you just made.**
"Release" means stable — an even minor, the channel the Install button serves.
Pre-release happens only when it was asked for in words. A stable release that
went out odd reaches nobody who has not opted in, and the fix is another
release: the version number is spent.

## The browser steps

1. `tabs_context_mcp { createIfEmpty: true }`, then `navigate` to
   `https://marketplace.visualstudio.com/manage/publishers/grgrwlkr`.
2. The page comes up blank while MSAL redirects — `wait` a few seconds and
   screenshot again rather than concluding it failed.
3. Click the **⋮** next to the extension row. The menu is
   Reports / View Extension / **Update** / Unpublish / Remove — Update is third,
   and the two below it are destructive. Screenshot before clicking, click by
   the coordinates you can see, and never click blind.
4. In "Upload Visual Studio Code extension": do **not** click the drop zone —
   that opens a native file picker you cannot see. Instead
   `find { query: "file input for uploading the vsix" }` and hand the path to
   `file_upload` with that ref.
5. The dialog then shows the file name and enables **Upload**. Click it.

## Confirming it, which is not the same as seeing it

The green **"It's live!"** panel appears immediately and means the upload was
accepted, not that the version is published — the row shows the old number with
a spinner beside it while the package is verified. Measured on 0.24.0: upload
~10 s, verification **7 minutes**.

The truth is the gallery API, not the page and not the badge:

```bash
until curl -s -H 'Content-Type: application/json' \
  -H 'Accept: application/json;api-version=7.2-preview.1' \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"grgrwlkr.claude-dashboard"}]}],"flags":103}' \
  https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery \
  | rg -q '"version":"X\.Y\.Z"'; do sleep 30; done
```

Run it in the background and keep working; do not sit on a foreground sleep.

The endpoint answers with an empty body often enough to matter — a bare parse of
it throws, and the throw looks like "not published yet". Retry before drawing a
conclusion:

```bash
for i in 1 2 3; do
  R=$(curl -s --max-time 20 ... )
  [ -n "$R" ] && printf '%s' "$R" | python3 -c '...' && break
  sleep 3
done
```

Verification took 7 minutes on 0.24.0, 10 on 0.25.0, 11 on 0.26.0 and 6 on
0.28.0 — the page shows `Verifying…` in the version column meanwhile, which is
the honest status. It does not lengthen with the version: budget ten minutes and
poll, rather than reading the last number as a trend.

To read the **channel** back off the gallery, ask for version properties or the
answer is a lie of omission: `flags:103` omits `IncludeVersionProperties` (16),
so every version comes back with no `Microsoft.VisualStudio.Code.PreRelease`
key — which reads exactly like "published as stable". Use `flags:119`, and only
then is an absent key the stable answer:

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

18 properties on a stable version, 19 on a pre-release one — a count near zero
means the flags were wrong, not that the package was.

The version badge in the README comes from badgen with `max-age=3600`, so it
lags publication by up to an hour — never use it as the check.

## After

Walk the publication checklist in project memory (`publication-checklist`):
anchors by clicking, images on the moving `raw/HEAD`, the changelog tab's first
heading carrying the released number, the channel, and how far the two
storefronts sit from each other.
