# MemBerry tool reference

## Always visible and domains

Always visible: `berry_load`, `berry_store`, `berry_memory_read`, `berry_memory_insert`, `berry_grep`, `berry_context`, `berry_ask`, `berry_tools`.

Nine domains:

- `memory`: `berry_memory_replace`, `berry_memory_rewrite`, `berry_memory_promote`, `berry_memory_archive`
- `temporal`: `berry_timeline`, `berry_fact_diff`
- `admin`: `berry_query`, `berry_consolidate`, `berry_bootstrap`, `berry_resolve`, `berry_ingest_codebase`, `berry_provenance`
- `research`: `berry_research_init`, `berry_research_log`, `berry_research_context`, `berry_research_tree`, `berry_research_contradictions`, `berry_research_consolidate`
- `code`: `berry_code_index`, `berry_code_search`, `berry_code_ast_grep`, `berry_code_symbols`, `berry_code_deps`, `berry_code_context`, `berry_code_watch`
- `arch`: `berry_arch_register`, `berry_arch_relate`, `berry_arch_aspect`, `berry_impact`, `berry_arch_drift`, `berry_arch_context`
- `wiki`: `berry_compile`, `berry_ingest`, `berry_lint`, `berry_braindump`, `berry_wiki_sync`
- `retrieval`: `berry_feedback`
- `graph`: `berry_graph_report`, `berry_graph_export`, `berry_pr_impact`, `berry_pr_conflicts`

## Exact schemas that commonly drift

`berry_store.entities` accepts at most 32 canonical Entity IDs. Store both `scope: "project:<tag>"` and `tags` containing the project tag plus reusable non-project tags. Optional `facts` accepts at most 32 atomic strings. Optional `aliases` accepts at most 32 closed objects shaped as `{ "entity_id": "canonical-id", "values": ["surface form"] }`, with at most 16 values each; facts plus alias values may contain at most 64 total retrieval keys, and every alias Entity ID must also appear in `entities`. Structured fields require canonical project scope, are validated and persisted only as additive derived retrieval keys, and never replace original content. `memory_type` is one of `decision`, `pattern`, `convention`, `architecture`, `preference`, `fact`, or `general`. Outcomes are `approved`, `revised`, `rejected`, or `abandoned`. An approved explicit decision promotes automatically; patterns/conventions require recurrent independent evidence. Signal types are `reinforcement`, `correction`, or `contradiction`; `target_id` must be an existing Semantic ID.

Attach `facts`, `entities`, and `aliases` only when they are verifiable from the content being stored. Prefer omission to guessing; never invent canonical IDs, copy secrets, use conversation-only context, or submit the whole memory as one fact. The local-model backfill covers missing Phase A facts later.

Consolidation:

```json
{ "action": "run", "scope": "project:my-app" }
{ "action": "status" }
{ "action": "review", "proposal_id": "proposal-id" }
{ "action": "review", "proposal_id": "proposal-id", "decision": "approve" }
{ "action": "dream", "scope": "project:my-app" }
```

Exact `berry_feedback` schema:

```json
{
  "result_id": "result-id",
  "was_useful": true,
  "session_id": "session-20260814-010203",
  "query": "original query",
  "source_type": "semantic"
}
```

Required: `result_id`, `was_useful`, `session_id`. Optional: `query` (default `""`) and `source_type` (default `semantic`; one of `semantic`, `episodic`, `symbol`, `arch_entity`, `aspect`). There is no `useful` or `reason` field.

`berry_ingest_codebase` requires `path`; optional fields are `project_name`, `project_tag`, `description`, `domain`, `languages`, and `exclude_patterns`. Allowed `languages` values are case-sensitive lower-case literals: `typescript`, `javascript`, `python`, `go`, `rust`. The path must be under `MEMBERRY_INGEST_ALLOW_DIR`.

Wiki tools:

- `berry_compile`: required `project_tag`; use `all` for the full wiki.
- `berry_ingest`: required `source_path`, `source_type`, `project_tag`.
- `berry_lint`: required `project_tag`.
- `berry_braindump`: required `scope` plus `content` or `source_path`.
- `berry_wiki_sync`: required `path`; optional `project_tag`. Integrated deployments schedule publication automatically after graph changes.
