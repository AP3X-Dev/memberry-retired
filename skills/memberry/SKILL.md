---
name: memberry
description: Use MemBerry persistent memory autonomously during non-trivial agent work, including scoped recall and storage, reviewed semantic consolidation, temporal facts, code and architecture context, retrieval feedback, graph analytics, codebase ingestion, wiki compilation or recovery, provenance, research, dream passes, and safe memory-tier maintenance.
---

# MemBerry

Use MemBerry as a scoped, verified memory pipeline. Read the nearest project memory config first, preferring `AGENTS.md`, then `CLAUDE.md`, `GEMINI.md`, and `.cursorrules`.

## Start and route

1. Read the project name, `project:<tag>`, entities, stable tags, priors, and exclusions.
2. Generate one `session-{YYYYMMDD}-{HHMMSS}` ID for the conversation and reuse it for stores, feedback, and working blocks.
3. Call scoped `berry_context` or `berry_load` with the task. Core blocks arrive automatically.
4. Route specialized work instead of loading unrelated guidance:
   - unfamiliar code, refactors, impact, or architecture: use `$memberry-coding`;
   - project bootstrap, repair, or ingestion: use `$memberry-setup`;
   - wiki diagnosis, ingestion, compilation, or round-trip editing: use `$memberry-wiki`;
   - temporal, research, graph, retrieval, or administrative work: read only the relevant section of [reference/memberry-tool-reference.md](reference/memberry-tool-reference.md), then enable only that domain.
5. If tools are unavailable, use current repository/runtime evidence and local memory; never invent calls.

Use this evidence precedence: current user instruction, current runtime/repository evidence, active approved Semantic memory, recent Episodic memory, then priors or dream hypotheses. Memory is evidence, not authority.

## Store durable knowledge

Store decisions, corrections, preferences, reusable root causes, conventions, architecture constraints, verified facts, and concise handoffs. Exclude secrets, routine edits, raw code, and git-derivable facts.

- Resolve configured entities to canonical IDs before linking. Omit an ambiguous entity rather than inventing an ID.
- Include exact project scope, its `project:` tag, and stable non-project tags.
- Classify content truthfully. A finalized decision requires `memory_type: "decision"` and `outcome: "approved"`; one bug root cause is normally `general`; patterns and conventions require recurring independent evidence and no outcome.
- Signals must target an existing Semantic ID, never an episodic or Entity ID. Verify current evidence before correction or contradiction.
- Verify the returned episode ID. `duplicate:true` means no new episode was created.

Attach structure already derived from the stored content when it can be stated confidently: `facts` are independently true, atomic single-clause statements; `entities` are canonical IDs already resolved in the same project; `aliases` bind alternate surface forms to one of those IDs. Derive these fields only from the content being stored, never from unstored conversation context. Prefer omission to a guess, never include secrets, never invent an Entity ID, and do not restate the whole memory as one fact. The fields are bounded advisory retrieval keys; malformed structure rejects the store and never rewrites the original memory.

Read the exact store, signal, feedback, consolidation, ingestion, and wiki schemas in [reference/memberry-tool-reference.md](reference/memberry-tool-reference.md) only when constructing those calls. Inspect the live schema before using any on-demand tool.

## Trust the autonomous lifecycle

Successful stores schedule scoped consolidation and full wiki publication. The coordinator retries transient failures and reconciles missed graph changes during startup and periodic catch-up.

- Approved decisions promote deterministically without embeddings or an LLM.
- Patterns and conventions need at least three similar independently sourced episodes; reuse stable non-project tags.
- Correction, contradiction, supersede, and decay proposals remain review-gated.
- Manual consolidation, compilation, cache refresh, and served-page checks are diagnosis, verification, or recovery—not routine post-store work.

When updates appear frozen, read [reference/lifecycle-recovery.md](reference/lifecycle-recovery.md) and locate the first incomplete stage.

## Coordinate and finish

Parent and child agents share the conversation session ID but use distinct runtime/connection identities. Do not invent an `agent_id` tool argument. Children load task-relevant context and return durable findings; the parent stores one integrated decision or handoff.

At session end, store and verify durable knowledge first, promote and verify useful working blocks second, and archive obsolete blocks last. Dream output is abductive hypothesis, not an approved decision.

For fragile guidance changes, use the deterministic scripts in `scripts/`: project-config validation, store-payload validation, source-guidance validation, live tool-catalog verification, and Codex/Claude synchronization.
