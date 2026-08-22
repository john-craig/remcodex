# Changelog

## 0.1.0-beta.13 — 2026-08-21

- Added capability-scoped peer communication with administrator grants, worker
  credentials, bounded envelopes, mailbox cursors, summaries, timelines, and
  audit records.
- Added isolated worker credential injection, disconnect-timeout dormancy, and
  runtime integration coverage.
- Added bounded, non-triggering coordination digest scheduling. Delivery to an
  external Orchestrator remains an integration boundary until its transport and
  authentication contract is defined.

Merge, publication, and deployment are separate operational steps.
