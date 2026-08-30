# MemBerry Tool Quick Reference

## Progressive Disclosure

8 tools are always visible. All others require enabling their domain first via `berry_tools(action: "enable", domain: "<name>")`.

## Always Visible (Tier 1)

| Tool | Purpose |
|------|---------|
| `berry_load` | Load assembled memory context |
| `berry_store` | Store episodic memory with signals |
| `berry_memory_read` | Read memory blocks from a tier (core/working/archive) |
| `berry_memory_insert` | Insert or append to a memory block |
| `berry_grep` | Search memory by text pattern (exact or regex) across all node types |
| `berry_context` | Super-load: blends architecture + code + memory |
| `berry_ask` | Dialectic retrieval: ask a question, get a synthesized cited answer (tunable `reasoning_level`) |
| `berry_tools` | Enable/disable/list on-demand tool domains |

`berry_store` may also include up to 32 atomic `facts`, 32 canonical `entities`, and 32 alias objects shaped as `{entity_id, values}` (up to 16 values). Each alias ID must appear in `entities`, and structured fields require canonical `scope: "project:<name>"`.

## On-Demand Domains

### memory (4 tools)

| Tool | Purpose |
|------|---------|
| `berry_memory_replace` | Replace content in a memory block |
| `berry_memory_rewrite` | Full rewrite of a memory block |
| `berry_memory_promote` | Move a block between tiers (e.g., working → core) |
| `berry_memory_archive` | Archive a memory block |

### temporal (2 tools)

| Tool | Purpose |
|------|---------|
| `berry_timeline` | Chronological fact history for an entity |
| `berry_fact_diff` | What changed between two timestamps |

### admin (6 tools)

| Tool | Purpose |
|------|---------|
| `berry_query` | Read-only Cypher against Neo4j |
| `berry_consolidate` | Run/check/review consolidation, or `action:"dream"` — background gap-filling + abductive hypotheses for a scope (also `memberry dream` CLI / nightly timer) |
| `berry_bootstrap` | One-time project graph setup |
| `berry_resolve` | Resolve memberry:// URIs to markdown |
| `berry_ingest_codebase` | One-shot project setup: scan + bootstrap + index + seed |
| `berry_provenance` | Trace full lifecycle of a semantic node |

### code (7 tools)

| Tool | Purpose |
|------|---------|
| `berry_code_index` | AST-based code indexing (TS, JS, Python, Go, Rust; plus structural extraction for SQL, Terraform/HCL, MCP config) |
| `berry_code_search` | Hybrid fulltext + vector code search |
| `berry_code_ast_grep` | Structural AST search via ast-grep patterns (JS/TS/TSX) |
| `berry_code_symbols` | Query symbols by file/name/kind |
| `berry_code_deps` | Symbol deps: callers, callees, importers, inheritance |
| `berry_code_context` | Code-aware context assembly for a task |
| `berry_code_watch` | Background watcher that auto-reindexes changed files (test and mock files are skipped) |

### arch (6 tools)

| Tool | Purpose |
|------|---------|
| `berry_arch_register` | Enrich entity with responsibility/interface/internals |
| `berry_arch_relate` | Create typed entity relationships |
| `berry_arch_aspect` | Cross-cutting concerns management |
| `berry_impact` | Blast radius analysis |
| `berry_arch_drift` | SHA-256 drift detection |
| `berry_arch_context` | Deterministic architectural context assembly |

### research (6 tools)

| Tool | Purpose |
|------|---------|
| `berry_research_init` | Initialize experiment campaign |
| `berry_research_log` | Log experiment with provenance |
| `berry_research_context` | Dynamic THINK phase context |
| `berry_research_tree` | Hypothesis tree visualization |
| `berry_research_contradictions` | Find conflicting principles |
| `berry_research_consolidate` | Research pattern consolidation |

### wiki (5 tools)

| Tool | Purpose |
|------|---------|
| `berry_compile` | Compile graph into interlinked markdown wiki |
| `berry_ingest` | Ingest source documents (auto-extracts entities/claims; also converts PDF, Word/.docx, Excel/.xlsx, HTML, RTF to text via optional system tools) |
| `berry_lint` | 10 graph health checks |
| `berry_braindump` | Capture a human brain dump as durable human-authored memory under a custom scope |
| `berry_wiki_sync` | Reconcile a human-edited wiki markdown file back into the graph via per-claim anchors |

### graph (4 tools)

| Tool | Purpose |
|------|---------|
| `berry_graph_report` | Deterministic graph audit: corpus summary, node/relation counts, memory-confidence summary, high-centrality "Core Abstractions", "Knowledge Areas", dependency cycles, low-confidence knowledge, knowledge gaps (general-purpose — any memory graph) |
| `berry_graph_export` | Portable JSON, or self-contained offline interactive HTML graph map (pan/zoom/drag, inspect nodes, color by type or knowledge area); secret-safe + XSS-escaped |
| `berry_pr_impact` | Blast radius of a GitHub PR over the code graph (changed files → symbols → dependent files; requires gh CLI) |
| `berry_pr_conflicts` | PR pairs whose impact overlaps (likely merge/review conflicts; requires gh CLI) |

### retrieval (1 tool)

| Tool | Purpose |
|------|---------|
| `berry_feedback` | Record result usefulness for ranking improvement |
