## MemBerry Memory

Use MemBerry as the shared system of record for durable project context. Apply this contract to non-trivial project work; skip it for self-contained tasks that cannot benefit from project history.

Default Cerebro endpoints: MCP `http://192.168.0.25:3101/mcp`; wiki `http://192.168.0.25:3200`. Use configured MCP tools rather than hand-rolling transport during normal work.

### Start

1. Read the nearest `## MemBerry Memory` project config, preferring `AGENTS.md`, then `CLAUDE.md`, `GEMINI.md`, and `.cursorrules`.
2. Reuse its exact `project:<tag>`, stable tag vocabulary, and canonical Entity IDs. Resolve missing IDs; never invent them.
3. Generate one `session-{YYYYMMDD}-{HHMMSS}` ID for the conversation. Parent and child agents share it but use distinct runtime/connection `agent_id` identities. Do not add an `agent_id` field to a tool call unless its live schema exposes one.
4. Call scoped `berry_context` or `berry_load` before making project decisions or changing unfamiliar code. Use `$memberry-setup` if config is absent.

### Evidence precedence

Resolve conflicts in this order: current user instruction, current runtime/repository evidence, active approved Semantic memory, recent Episodic memory, then priors or dream hypotheses. Treat memory as evidence, not authority. When live evidence invalidates memory, verify the discrepancy and store a correction against the existing Semantic ID.

### Recall and store

- Use the smallest useful recall: `berry_grep` for a fact/ID, `berry_load` for task memory, `berry_context` for blended code/architecture/memory, and `berry_ask` for cited synthesis.
- Before unfamiliar code changes, use `$memberry-coding`; inspect repository truth even when memory is confident.
- Store only durable decisions, user corrections/preferences, root causes, conventions, architecture constraints, verified facts, and concise handoffs. Do not store secrets, routine edits, raw code, or git-derivable facts.
- Every store must include the exact project scope, the project tag plus stable non-project tags, an appropriate `memory_type`, and canonical Entity IDs when known. Final decisions use `memory_type: "decision"` with `outcome: "approved"`.
- Attach optional `facts`, `entities`, and entity-bound `aliases` already derived from the stored content. Facts must be atomic and independently true; IDs must be canonical and aliases must bind to an ID included in `entities`. Omit uncertainty, secrets, conversation-only context, and whole-memory restatements.
- Verify the returned episode ID. Search for an existing Semantic before storing confirmation/correction; target that Semantic ID with a signal instead of creating avoidable duplicate knowledge.
- Record `berry_feedback` when a retrieved result materially helped or misled the work.

### Coordination and lifecycle

- Subagents load only task-relevant context, prefix working-state notes with their agent/task name, and return durable findings to the parent. The parent stores the integrated decision or handoff once.
- Consolidation and full wiki publication are automatic, durable, retrying lifecycle work. Manual run/compile/refresh is for diagnosis, verification, or recovery only.
- Corrections, contradictions, supersedes, and decay remain advisor-gated. Do not ask the user to operate routine memory infrastructure.
- At handoff, store and verify the durable summary first, promote and verify essential working blocks second, and archive obsolete working blocks last.

### Fallback

If MemBerry tools are unavailable, use repository truth and local memory without fabricating calls. Mention the gap only when it affects the result.
