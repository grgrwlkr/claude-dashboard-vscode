# Conventions specific to this repo reference

Read the relevant subsections before the affected task; paths are relative to the repository root. Original contracts and dated rationale are preserved below.

## Conventions specific to this repo

- **Degrade, never guess.** The transcript and session-registry formats are private to Claude Code.
  Every read is wrapped so a parse failure yields a dash or a hidden item, never a wrong number. The
  pervasive `try/catch → null` is the design, not defensive clutter.
- **Workflow money comes from `usage` records only** — the index for an agent that has stopped, a direct
  count over the growing transcript for one still running. `totalTokens` and `workflowProgress[].tokens`
  from the final snapshot are never priced: they are context sizes, not spend, and the two differ by ~29x
  on this machine (86.1M vs 2476.1M over the same agents).
- **A new model needs two edits**: a rate in `RATES` (`pricing.js`) and a context window in
  `windowFor` (`session.js`). An unknown model is priced at the `FALLBACK` rate, which *is* the Opus
  rate — so missing metadata produces an estimate at the fallback rate and can materially misprice usage. `known` from `ratesFor` is what
  says so, and it has two readers: `status.js:202`, which changes the note in the session tooltip,
  and the Models panel, which puts a tilde on the figure and the reason in its hover. A total that
  merely includes such a model is not marked — only the row of the model itself.
- **`RATES` is keyed by alias, and `ratesFor` strips what an id carries on top of it**: `[1m]`,
  `-fast`, and the dated snapshot. The date is the one that bit — transcripts carry
  `claude-haiku-4-5-20251001`, which missed the table and was billed at five times its own rate
  while `shortModel` printed it as "haiku 4.5". A price and a label that disagree about which model
  a row is are the failure to look for here.
- **`<synthetic>` is not a model** — it is the record the client writes in place of a reply that
  never came, with an all-zero usage, and it belongs in no breakdown of models (`SYNTHETIC_MODEL`,
  `dashboard.js`). It still reaches counters of messages, which is what it is: 137 of them here.
- **A response is charged once, from its fullest record** (`holdResponse`, `indexer.js`). Its records
  disagree with each other — a running counter of `output_tokens` on 25.5% of them — and fields sit
  on different ones: `speed` closes a response, the skill and effort open it, and the model must come
  from the record the price is computed from. Four bugs here were "correct because of the shape of
  today's data"; each is now a test rather than a comment.
- Every user-visible estimate carries a tilde: spend, burn rate, `dry`, the api-wait share.
- Comments explain *why* a formula or threshold is what it is; they are unusually dense here on
  purpose, because most constants encode a compatibility decision. Match that register.
