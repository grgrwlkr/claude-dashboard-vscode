---
name: release
description: "Prepare an explicitly requested release or storefront upload; diagnose storefront differences read-only."
---

# Releasing the extension

First distinguish diagnosis, complete release and separately authorized upload. A question about mismatched storefronts is read-only. A release request covers its named publication actions; prepare the exact candidate before any unresolved permission gate. Preserve unrelated edits and live editor sessions. Do not contact other chats without user authorization or stage their work.

Read the current delivery guide and `.github/workflows/release.yml`. Tag-triggered CI publishes Open VSX; the Marketplace step is currently disabled in that workflow, so verify the available authorized route rather than assuming a historical credential limitation. Complete delivery means the requested versions/channels are visible at the intended stores, not only a green run.

## Prepare

Review changes since the previous release, README settings/commands/media and Unreleased. Use the writing-docs contract. Stable is the default and has an even minor; odd-minor pre-release needs an explicit request. A fixes-only release can be patch; a new capability needs the next appropriate minor; major is the user's decision. Match `package.json` and `.claude-plugin/plugin.json`, then stamp the changelog. Do not create an empty Unreleased section in the released artifact.

For a full release run `node --test test/*.test.js` and `node --test test/packaging.js`, plus any affected product checks. Build a VSIX from the actual release candidate with the project's vsce command. Inspect that exact archive: AGENTS/CLAUDE and `.claude/`, `.agents/`, `.codex/` must not ship; required runtime assets such as dashboard.css must be present. An untracked required asset cannot be assumed to reach tagged CI. Product changes follow the local installation/visual-check procedure without restarting the user's editor; instruction-only changes are exempt.

Use independent review before an irreversible release when its correctness/regression risk warrants it. A Stop hook is not a substitute and does not create a separate mandatory ritual. Stage only attributed release files. For an authorized commit use the actual Git identity, verified Agent/Model trailers, an available verified Session identifier and truthful contributor attribution; use Model: unverified if exact evidence is unavailable.

## Publish and verify

Create/push only the authorized commit and exact version tag, never a broad --tags push. Confirm the tag's SHA and the Release workflow for that tag. Download its `extension.vsix`, verify release digest, manifest version/channel and stamped changelog. Use this same checked CI asset for a separately authorized Marketplace upload, not a different local build.

Operate the publisher UI through current supported tools, verifying account, extension and Update action; do not use remembered coordinates or neighboring destructive controls. An upload banner proves receipt only. Verify actual store version and pre-release metadata through their current APIs/UI. The Open VSX extension endpoint is `https://open-vsx.org/api/grgrwlkr/claude-dashboard`. The Marketplace gallery extensionquery request must include version properties (the existing recipe uses flags 119; 103 omits them). Verify current API behavior: missing properties or an empty response is not proof of stable publication. README badges and fixed historical wait durations are not acceptance evidence.

Finish by checking both requested storefronts, listing anchors/media and the changelog tab. Report partial publication precisely. A successful release does not authorize cleanup, credential changes, unrelated branches or another release.
