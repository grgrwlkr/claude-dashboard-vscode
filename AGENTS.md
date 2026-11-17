# Claude statusline — shared project guidance

<!-- shared-instruction-standard:start -->
## Shared agent instructions

`AGENTS.md` is the project instruction source for every agent. `CLAUDE.md`, when
present, contains only `@AGENTS.md`. Maintain project skills in `.agents/skills/`;
client folders may contain operational adapters, not separate copies of rules or skills.
Read applicable nested `AGENTS.md` and the references named by this file. Shared
references remain authoritative regardless of a `.codex/` directory name. Use the
current client's real tools; this convention grants no publication, deployment,
credential access or permission beyond the user's authorized task.
<!-- shared-instruction-standard:end -->

A VS Code extension reading Claude Code state and usage, with status-bar, terminal,
workflow-tree and dashboard views. Preserve the Claude product names, paths,
formats and endpoints; switching it to Codex state is a separate feature.

## Context by task

Read only the relevant sections of these references before the affected work:

- Implementation and architecture: `.codex/reference/architecture.md` — shared
  renderers/state, data ownership, credentials, tick costs, index invalidation,
  dashboard components, theme/CSP rules and visual verification.
- Parsing, pricing, models, usage, workflow money or estimates:
  `.codex/reference/data-contracts.md` — exact accounting and compatibility rules.
- Packaging, installing, dependencies, changelog/README or authorized release:
  `.codex/reference/delivery.md` — commands, same-version delivery, version/channel
  rules and documentation style. It includes dated reasons; they grant no new
  destructive or Git permissions.
- Before changing what a displayed number means, read its definition and data
  source in `README.md`. Before editing README or CHANGELOG, read
  `.agents/skills/writing-docs/SKILL.md`; release work uses the `release` skill.

## Invariants

- Only `extension.js` may require `vscode`; keep testable logic in the vscode-free
  modules. Shared fields/formatting belong in `segments.js`, tooltip content in
  `status.js`, workflow behavior and money in `workflows.js`.
- Treat Claude sessions/settings as read-only. The existing usage transport may write only its named shared usage cache, stamp/backoff and atomic temporary files; extension index/history stays in `globalStorage`.
  Only `usage.js` may obtain the OAuth token for its usage request, never log/cache
  it. Turning limits off must prevent credential reads too.
- Malformed private formats degrade to a dash/hidden item, never a guessed number.
  Price actual usage records, not context-size snapshots; count a response once
  from its fullest record. User-visible estimates carry a tilde.
- Aggregate-shape or rate/cost changes require `INDEX_VERSION` invalidation.
- Dashboard interpolation goes through `esc()`, under the existing CSP and VS Code
  theme variables. UI changes need rendered interaction/overflow checks; read the
  architecture reference for required widths, themes and known-bad probe checks.
- Plain CommonJS; no build/lint/npm-script layer. Run affected `node --test` checks
  and `node --test test/*.test.js` when appropriate. Keep reason-explaining comments.

## Delivery

Finished product code changes are packaged and installed over the existing version;
read the delivery reference before doing so. Instructions-only changes need no VSIX
rebuild or installation. Leave the version unchanged outside an authorized release.
Never reload a live editor window: tell the user when a reload is needed.
Publishing, commits and other Git operations require explicit authorization.

Project skills live in `.agents/skills/`. Their metadata does not authorize release or installation. Historical local notes provide dated evidence, not current state or renewed permission.
