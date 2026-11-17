---
name: writing-docs
description: "Update user-facing README and CHANGELOG from verified behavior without inventing release state."
---

# Writing extension documentation

Read the relevant delivery guidance and inspect the actual change. README is the marketplace listing: explain what a user sees, can configure or should do. Verify setting names/defaults, commands, paths, data sources, media and limitations against code and manifest. Keep one user-visible change per CHANGELOG bullet; prefer about fifteen words when it preserves the needed condition. Avoid internal implementation narration.

Write ongoing changes under Unreleased with the project's Keep a Changelog categories and Documentation where useful. Preserve published entries; stamp a version only in a release task. A breaking change states the required migration/action. A changed default states the new behavior and how to restore the old behavior when supported. A security entry states the exposure or conditions and the protective action, without disclosing secrets. Match the user's requested scope and existing register.

## Verification

Read the changed sections in context. Check factual claims, manifest names, links/anchors and image paths, including already published raw/HEAD references. Inspect rendered documentation when layout matters. Word counts and grep are editing aids, not proof of correctness. Instruction-only editing does not require a VSIX installation or release.
