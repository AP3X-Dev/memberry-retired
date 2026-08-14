# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Versioned evaluation lab with immutable baseline manifests, hidden dev/holdout
  oracles, anti-gaming metrics, explicit fixture/proxy/live evidence, deterministic
  comparison gates, and atomic run artifacts.
- Fail-closed external dataset registry and acquisition workflow with license,
  privacy, revision, size, and SHA-256 requirements.
- Opt-in live MCP evaluation adapter and disposable Redis/Neo4j integration smoke.

### Removed

- Superseded MemBench and hard-coded LongMemEval prototype runners. Their control
  bytes and metrics remain reproducible from the immutable baseline commit.

## [0.1.0] - 2026-06-07

First tagged release. MemBerry is a persistent, cross-session memory system for AI
agents: a Neo4j knowledge graph (episodic + semantic memory, temporal facts,
entities, code symbols, audit log) with a Redis cache/stream layer, exposed to
agents over the Model Context Protocol with progressive tool disclosure.

### Added

- **Durable fact-extraction queue.** `store()` enqueues extraction jobs to a Redis
  Stream; a long-lived consumer drains them with retry, dead-lettering, and
  crash recovery (XAUTOCLAIM). Admin surface via `memberry extraction status|replay`.
- **Schema migration runner.** Ordered, idempotent migrations tracked on a
  `SchemaVersion` node, plus vector-index dimension drift detection. The embedding
  dimension is configurable with `MEMBERRY_EMBEDDING_DIM`.
- **Safety & tenancy controls.** `MEMBERRY_READONLY` (reject all writes),
  `MEMBERRY_REDACT_ON_INGEST` (strip secrets before persistence), an append-only
  audit trail, and per-actor API tokens (`MEMBERRY_API_TOKENS`) compared in
  constant time.
- **Injectable service container.** The MCP tool layer takes an explicit
  `ServiceContainer`, enabling per-instance isolation (legacy global injection
  retained for compatibility).
- **Self-contained packaging.** Docker Compose provisions both Redis and Neo4j
  with env-driven passwords and managed volumes; multi-stage Dockerfile; one-command
  `npm run setup` and `npm run smoke`.
- **Memory-quality benchmark gate.** A deterministic, infra-free Recall/MRR/nDCG
  golden-set eval (`npm run bench:quality`) wired into CI.
- **Security documentation.** `SECURITY.md` and `THREAT-MODEL.md`.

### Changed

- **No-API-key mode degrades safely.** Without an embedding key, vector search is
  disabled and retrieval falls back to deterministic lexical + fulltext ranking,
  instead of querying the vector index with zero vectors (which returned results
  in arbitrary order).
- **Raw Cypher is read-enforced.** `berry_query` runs in a server-enforced READ
  transaction; the validator now NFKC-normalizes input and rejects stacked
  statements, on top of the existing read-only keyword checks.

### Fixed

- `berry_provenance` was silently disabled because the second bootstrap injection
  pass nulled the provenance service.
- `tsconfig.build.json` never compiled `packages/wiki`, and the Dockerfile omitted
  the `wiki`/`graph` workspace manifests — a from-build run could fail at import.

[0.1.0]: https://github.com/AP3X-Dev/memberry/releases/tag/v0.1.0
