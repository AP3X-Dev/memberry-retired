---
name: memberry
description: "MemBerry — persistent memory for AI agents with progressive tool disclosure, temporal facts, memory tiers, architectural understanding, code intelligence, and unified retrieval via MCP tools."
---

# MemBerry — persistent memory for AI agents

Persistent memory for AI agents. Progressive disclosure: 8 always-visible tools + 9 on-demand domains.

## 5 Rules

1. Load before working — `berry_context` or `berry_load`
2. Store after deciding — `berry_store`
3. Scope with project tags — `project:<name>`
4. Link to entities — include verified canonical Entity IDs in stores
5. Be silent — don't narrate, just use

## Always-Visible Tools (Tier 1)

`berry_load`, `berry_store`, `berry_memory_read`, `berry_memory_insert`, `berry_grep`, `berry_context`, `berry_ask`, `berry_tools`

`berry_ask` is dialectic retrieval: ask a natural-language question and get a synthesized, **cited** answer (not raw chunks); `reasoning_level` minimal→max trades latency for depth. Use it when the answer needs reasoning across several memories; use `berry_context` for raw assembled context.

## On-Demand Domains (enable via `berry_tools`)

Call `berry_tools(action: "enable", domain: "<name>")` before using:

- `memory` (4) — `berry_memory_replace`, `berry_memory_rewrite`, `berry_memory_promote`, `berry_memory_archive`
- `temporal` (2) — `berry_timeline`, `berry_fact_diff`
- `admin` (6) — `berry_query`, `berry_consolidate`, `berry_bootstrap`, `berry_resolve`, `berry_ingest_codebase`, `berry_provenance`
- `research` (6) — `berry_research_init/log/context/tree/contradictions/consolidate`
- `code` (7) — `berry_code_index/search/ast_grep/symbols/deps/context/watch` (`berry_code_index` extracts structure for TypeScript, JavaScript, Python, Go, Rust, plus SQL tables/views/functions, Terraform/HCL resources/modules/variables/outputs, and MCP config servers — env-safe)
- `arch` (6) — `berry_arch_register/relate/aspect`, `berry_impact`, `berry_arch_drift/context`
- `wiki` (5) — `berry_compile`, `berry_ingest`, `berry_lint`, `berry_braindump`, `berry_wiki_sync` (`berry_ingest` also converts PDF, Word/.docx, Excel/.xlsx, HTML, and RTF documents to text via optional system tools, in addition to text/markdown)
- `retrieval` (1) — `berry_feedback`
- `graph` (4) — `berry_graph_report`, `berry_graph_export`, `berry_pr_impact`, `berry_pr_conflicts` (read-only, project-scoped, secret-safe; disabled by default)

## Decision Tree

- General context → `berry_context` (always visible)
- Ask a question, get a cited answer → `berry_ask` (always visible)
- Memory load → `berry_load` (always visible)
- Memory store → `berry_store` (always visible)
- Read memory blocks → `berry_memory_read` (always visible)
- Update memory during session → `berry_memory_insert` (always visible)
- Enable a tool domain → `berry_tools` (always visible)
- Graph query → `berry_query` (enable `admin`)
- Knowledge provenance → `berry_provenance` (enable `admin`)
- Fact history for entity → `berry_timeline` (enable `temporal`)
- What changed between dates → `berry_fact_diff` (enable `temporal`)
- Update core preferences → `berry_memory_replace` (enable `memory`)
- Rewrite a memory block → `berry_memory_rewrite` (enable `memory`)
- Move block between tiers → `berry_memory_promote` (enable `memory`)
- Archive old blocks → `berry_memory_archive` (enable `memory`)
- Code search → `berry_code_search` (enable `code`)
- Code symbols → `berry_code_symbols` (enable `code`)
- Code deps → `berry_code_deps` (enable `code`)
- Architecture → `berry_arch_context` (enable `arch`)
- Blast radius → `berry_impact` (enable `arch`)
- Drift check → `berry_arch_drift` (enable `arch`)
- Build wiki → `berry_compile` (enable `wiki`)
- Ingest sources (incl. PDF/Word/Excel/HTML/RTF) → `berry_ingest` (enable `wiki`)
- Health checks → `berry_lint` (enable `wiki`)
- Capture human brain dump → `berry_braindump` (enable `wiki`)
- Sync human-edited wiki back into graph → `berry_wiki_sync` (enable `wiki`)
- Graph audit / corpus summary / core abstractions → `berry_graph_report` (enable `graph`)
- Export graph (JSON / offline HTML map) → `berry_graph_export` (enable `graph`)
- PR blast radius over code graph → `berry_pr_impact` (enable `graph`, needs `gh` CLI)
- PR pairs likely to conflict → `berry_pr_conflicts` (enable `graph`, needs `gh` CLI)

## Recall — pull the right context, precisely

Recalling the right memory at the right moment without flooding the context window is the whole point — recall is as automatic as storing.

- Recall continuously, not just at session start: before answering about an entity, deciding, modifying a module, assuming a default/limit/preference, or re-asking the user. If you might already know it, check first.
- Recall precisely: scope every load with `entities` + `tags` (`project:<tag>`) and set `max_tokens` to the smallest that fits — the right context, not all of it. Start specific; widen only if empty.
- Smallest tool that fits: `berry_grep` (specific fact/preference) · `berry_memory_read(block)` (known block) · `berry_load(task, entities, tags, max_tokens)` (scoped task memory) · `berry_context` (cross-cutting) · `berry_timeline`/`berry_fact_diff` (how knowledge changed) · `berry_code_search` (code).
- Close the loop: enable `retrieval`, use `berry_feedback` when recalled memory helped (or didn't).

## Autonomous Behavior

Load memory at session start using Tier 1 tools only — no domain enablement needed. `berry_context`/`berry_load` automatically include the core blocks, so no separate read step is needed (use `berry_memory_read(block: "<name>")` only to re-read one specific block). Store decisions, preferences, bug fixes, and conventions automatically (`berry_store`). Update working memory during sessions (`berry_memory_insert`).

When the stored content already gives you trustworthy structure, attach optional atomic `facts`, canonical `entities`, and entity-bound `aliases`. Derive them only from that content; omit guesses, secrets, conversation-only context, invented IDs, and whole-memory restatements. They are bounded additive retrieval keys and never replace the memory.

Before modifying code: enable `code` or `arch` domain via `berry_tools`, then load module context. Before planning: enable `arch` domain for architecture decisions and blast radius analysis.

At session end: enable `memory` domain, then promote valuable working memory (`berry_memory_promote`) and archive session blocks (`berry_memory_archive`). Enable `admin` domain to check consolidation. When user states preferences: enable `memory` domain, then `berry_memory_replace`. For temporal fact tracing: enable `temporal` domain, then `berry_timeline`.

When facts are contradicted, they get invalidated (not just overwritten). Facts also carry an `inference_type` — `deductive` (explicit, default), `inductive` (consolidation-generalized), or `abductive` (a guess from the background "dream" pass); abductive facts rank lower and render as `[hypothesis]`. The dream pass runs via `berry_consolidate(action: "dream", scope: "project:<tag>")` (enable `admin`) or the `memberry dream` CLI / nightly timer — it only adds low-confidence hypotheses, never overwrites known facts.

For full documentation: see `skills/memberry/SKILL.md` in the MemBerry repository root.
