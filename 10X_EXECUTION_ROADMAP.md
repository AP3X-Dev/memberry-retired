# MemBerry 10X Execution Roadmap

This is the canonical, tracked execution checklist for the MemBerry 10X program.
It is intentionally shorter and more operational than the detailed PRP and local
decision logs. Future sessions must resume from `NEXT ACTION` instead of
reconstructing or redesigning completed work.

The original detailed PRP remains in the local, gitignored workspace at
`docs/superpowers/specs/2026-08-14-memberry-10x-autonomous-prp.md` when that
workspace history is present. This tracked file is the portable execution
authority for sequencing and completion state. Evaluation-dataset activation
details remain in
[`bench/lab/ROADMAP.md`](bench/lab/ROADMAP.md).

Findings we deliberately deferred — with the condition that should bring each one
back — live in [`RESEARCH-LEDGER.md`](RESEARCH-LEDGER.md). This roadmap says what
to build next; the ledger says what we learned and chose not to act on yet. Read
the ledger before planning a lane: three times running, live measurement
overturned what this file predicted the next real defect would be.

## Checkbox rules

- `[x]` means the parent work package or gate met its acceptance criteria and
  merged with the required evidence.
- `[ ]` means open. A `(partial)` note means useful foundations exist but the
  parent package or gate is not closed.
- Test files, lines of code, review rounds, hardening packets, and subpackets do
  not count as roadmap completion by themselves.
- Only the root orchestrator updates this file, and only after a parent package,
  gate, terminal rejection, or active `NEXT ACTION` changes.

## Planning surface (reconciled 2026-08-28)

This file is the ONLY document that describes current program state. Everything
else is either design detail or a historical record.

- **Supporting design references** (durable detail, not plans):
  [`bench/lab/ROADMAP.md`](bench/lab/ROADMAP.md) for evaluation-dataset state and
  the CMP-006 licence blocker; `RET010_SERVED_RERANKER_DESIGN.md` (RET-010A–F all
  promoted, parent closed 2026-08-25 — see the exit checklist below);
  `SEC001B_RUNTIME_BINDING_DESIGN.md` (implemented).
- **Run records** live in the gitignored `docs/` workspace, which is a nested
  private repo with no remote. `docs/agent-runs/run-state-*.md` files are
  autonomous-run RESTART ANCHORS, not plans — a cold session resumes from the
  matching run-state, then this file. Closed runs carry a superseding banner.
- **Full inventory and dispositions:** `docs/PLANNING-SURFACE-INVENTORY.md`
  (private workspace).
- If any other document appears to describe current state or a next action,
  it is stale — this file wins.

## Current program position

- **Last updated:** 2026-08-30
- **Exact deployed runtime pin:** `cb85d9a96ffd084620dc9f6182eb16d80de355a3` —
  PR #140 (RET-Q-005 episodic identifier reserve). Prior: #138 RET-Q-004
  episodic retrieval retention; #137 RET-Q-003 diagnostics/lab reliability.
  **The live Cerebro MCP image was built from this exact commit.** The checkout's
  only untracked files remain the preserved operator files
  `docker-compose.override.yml` and `parsecheck.mjs`.
- **Current verification ratchet:** hosted CI run `33314109447` passed Node 20,
  Node 22, and the full live-container integration job, including authenticated
  scoped retrieval and trace conformance. Clean Linux Node 20 and 22 each passed
  896 retrieval tests (7 skipped) and 341 MCP tests (9 skipped). The repository
  still has no mechanical
  total-test-count threshold; the verifier must continue checking both outcomes
  and counts rather than treating a green exit alone as the ratchet.
- **Active critical-path lane:** IDX-001A — write-time structured indexing. The
  memory plane is 34/34 at five; further single-hop reranker tuning is no longer
  the measured bottleneck. G2 remains open until its parent acceptance criteria
  are explicitly reconciled.
- **Highest phase started:** Phase 9
- **Closed phase gates:** G0, G1, G3
- **Open phase gates:** G2, G4 through G9, and GF
- **Program estimate:** approximately 35–40% complete
- **Measured retrieval quality:** RET-Q-005 moved the live 34-case memory gate
  from 33/34 (97.06%) to **34/34 (100%)** without regressing prior wins. Two
  consecutive production probes were 34/34 with zero errors; p95 was 296.9344 ms
  then 306.6444 ms and max response was 29,383 bytes.
  The earlier code-plane gains remain: Answer@5 moved 20% → 70% across
  IDX-002A/B/003/004.
- **Deployment state:** RET-Q-005 is merged, deployed, and live-verified on Cerebro
  at `cb85d9a`. The MCP container is healthy with zero restarts and
  `MEMBERRY_EPISODIC_IDENTIFIER_RESERVE_V1=1`.
  **COD-010b deployed
  2026-08-26** (master `3eba9a9`); the served
  code plane is live and verified at `**Code:** served (16 of 20)` on a mixed
  request. Code index live counts (2026-08-28 census): `project:memberry` 16,399,
  `project:hermes-agent` 15,055, `project:neuri` 12,339, `project:ag3ntic` 5,385,
  NULL 5,136 — 54,314 symbols, **100% embedded** since the IDX-003 backfill.
  Live retrieval flags on the box: `MEMBERRY_QUERY_PLANNER_V1=1`,
  `MEMBERRY_CANDIDATE_CHANNEL_V1=1`, `MEMBERRY_RERANKER_V1=served`,
  `MEMBERRY_KIND_RANK_V1=1`, `MEMBERRY_CODE_SCOPE_V2=1`, `MEMBERRY_CODE_RERANK_V1=1`.
  No Retrieval 2.0 capability-policy activation has been authorized.
- **Golden v2 instrument: TOMBSTONED 2026-08-26.** Both permitted corpus shapes
  measured infeasible before any build; band never adjusted, **zero version slots
  opened**. The binding constraint is the CONTROL: under plural relevance
  (>=5 relevant/query) `memberry-retrieval-core-v1` tops out near 0.32 P@5,
  below the pre-registered `[0.42,0.58]`. Evidence:
  `bench/lab/golden-v2/CALIBRATION-GOLDEN-V2.md`, tracked on master; the
  `feat/ret-golden-v2` branch no longer exists.

## NEXT ACTION

### IDX-001A — Write-time structured indexing

Persist optional, validated atomic facts, canonical entity references, and
entity-bound aliases when an episode is stored. Treat them as additive derived
retrieval keys: original episode bytes remain unchanged, query time stays
model-free, and one default-off flag makes the reader inert.

1. Require closed bounded inputs and exact tenant/project authorization for every
   referenced entity; reject malformed structure before any episode is written.
2. Persist derived keys atomically with their source episode and provenance.
3. Provide a resumable, idempotent, resource-capped local-model backfill and a
   rollback that deletes only derived keys.
4. Accept only if the frozen 60-case multi-hop dev set improves by at least 10
   percentage points with a positive confidence bound, while the 34-case memory
   gate remains 34/34, p95 stays <=500 ms, and responses stay <=32 KiB.
5. Stop after Phase A if the measured multi-hop gain is not meaningful; do not
   proceed into a larger graph-instrument expansion without evidence.

### Historical measurement-first direction (superseded by RET-Q-005)

**Direction changed 2026-08-26 (owner).** The program spent 25+ merged PRs with a
bit-identical retrieval metric vector, then tombstoned a purpose-built instrument.
Both facts point the same way: **we cannot measure retrieval quality, and we have
been trying to fix it blind.** The new sequence puts measurement first, and it
deliberately abandons the synthetic-instrument approach that has now failed twice.

### Why the synthetic approach is retired

Golden v2 built synthetic corpora with invented topics and mechanically-derived
relevance labels, then pre-registered a difficulty band. It could not be
calibrated and was tombstoned before any build. Published industry practice names
exactly these failure modes: unrealistic corpora of isolated snippets, synthetic
queries that miss how nuanced real questions are, and proxy relevance metrics that
"often do not align closely with what a real user would genuinely find helpful."
Systems tuned on such benchmarks "consistently stumble in real-world scenarios."

We reproduced that result at a cost of one day. Do not build a third one.

### The measured problem, from the live index

**RE-MEASURED 2026-08-27 against the live graph. The numbers below replace the
2026-08-26 figures, which are superseded — the index grew 83.7% since.**

`project:memberry`, **16,399** indexed symbols (was 8,928):

| kind | count | share |
|---|---|---|
| `variable` | 11,847 | **72.2%** |
| function | 2,589 | 15.8% |
| method | 880 | 5.4% |
| interface | 654 | 4.0% |
| type | 254 | 1.5% |
| class | 155 | 0.9% |
| module | 20 | 0.1% |
| from test files | 8,344 | **50.9%** |
| bare variable (empty `doc_comment`) | 10,996 | **67.1%** |

**Test-file contamination is now HALF the index, not a third.** Other project tags
are unchanged: hermes-agent 15,055, neuri 12,339, ag3ntic 5,385, NULL 5,136.

**CORRECTION — the ranking description below was wrong and cost a wrong mental
model.** Ranking is NOT `ORDER BY score DESC` with one `* 0.8` adjustment. That
`ORDER BY` (`packages/code/src/search.ts:500`) sorts one of four channels. The final
rank is `rrfFusion` (k=60), which **discards raw scores** for `1/(k+rank+1)` sums,
followed by feedback boosts, a `{symbol: 0.25}` source-type boost
(`packages/retrieval/src/scoring.ts:233-240`), a multiplicative lexical text boost
(`packages/retrieval/src/assembler.ts:1338-1341`),
MMR diversity, dedup, and the served reranker. The `* 0.8` semantics discount
(`search.ts:705`) **never fires** on this path — the assembler passes
`include_semantics: false` (`assembler.ts:1119`, `:629`).

What DOES hold: `SymbolKind` is **never used for ranking** — it is only an equality
filter and is explicitly stripped from the title before scoring by `stripKindSuffix`
(`packages/retrieval/src/scoring.ts:103-105`). Note `inferSourceTypeBoost` boosts source_type `symbol`, not
SymbolKind, so a query containing "class" boosts variables just as much as classes.

Test-path handling is **not uniformly absent**, and the split is worse than either
half: the bulk indexer applies none (`walkDirectory`, `indexer.ts:496-525`, which
contains no `isTestPath` call), but `CodeWatcher` excludes `.test.`, `.spec.`,
`__tests__`, `__mocks__` by default (`TEST_FILE_PATTERNS` at `types.ts:45` and
`isTestPath` at `types.ts:55-59`, applied at `watcher.ts:264` under `skipTests`,
which defaults true at `watcher.ts:144`). So a full re-index admits test symbols and
the incremental watch then never refreshes or deletes them.

A live query for assembler internals returned `class UnifiedAssembler` at rank 4,
behind `results` (variable, test file), `ranked` (variable), and `compose` (function,
test file). Re-confirmed live 2026-08-27.

### The lanes, in order

1. **EVAL-001 — BUILT AND BASELINED (PR #117, merge `5563490`); the baseline is
   now VOID.** The harness, the frozen selection rule and the question set are
   tracked under `bench/eval/` (`run-eval001.mjs`, `select-questions.mjs`,
   `mine-queries.mjs`, `SELECTION-RULE.md`, `eval001-questions.jsonl`), and the
   origin was pinned 2026-08-27 at `a1439fb` — real numbers in `BASELINE.md` §2.6
   (dev `keywordRecall@5` 0.0833 over 3 scored of 4, one non-retrieval; holdout
   0.1000 / @10 0.3000, aggregate only). **Three retrieval flags went live after
   that pin** — `MEMBERRY_KIND_RANK_V1`, `MEMBERRY_CODE_SCOPE_V2`,
   `MEMBERRY_CODE_RERANK_V1` — which voids cross-run comparison under spec §3.2
   item 2. **A fresh baseline is owed before EVAL-001 can act as a regression
   guard again** (`BASELINE.md` §2.7). Interim measurement has all run on
   `bench/eval/run-outcome-probe.mjs` instead — file-level ground truth, and only
   10 cases (`RESEARCH-LEDGER.md` RL-005).
2. ~~**IDX-002 — chunk granularity.**~~ **DEAD — tested and rejected 2026-08-27.**
   The controlled-study argument (function-level chunking "consistently
   underperforms all other strategies by 3.57-5.64 pp EM") predicted that MemBerry's
   individual-symbol unit was the defect. It was not. Coarsening the retrieval unit
   by excluding variables — the crude form of a bigger chunk — left the same five
   misses and made MRR *worse*, 0.3250 against 0.4000. The misses were never chunk
   size; there was no semantic retrieval at all (IDX-003). What shipped under the
   IDX-002 name is ranking, not chunking: 002A kind prior and 002B project scope.
   Do not reopen this without new evidence.
3. **IDX-001 Phase A — index-time structure.** Relationships, call graphs, module
   hierarchy. Still the structural bet, and now it lands on an index that has
   embeddings, project scope and a kind prior. Prerequisite for RET-007.
4. **G2 (Phase 2 close).** Needs explicit owner authorization for one RET-010
   holdout evaluation. **Read the G2 checkbox before spending the one shot** —
   golden v1 reports 0.4000 against a 0.4667 structural cap, and a fair instrument
   scores the same control at ~0.32, so the pre-registered "+0.05" asks for 75% of
   reachable headroom on an instrument that flatters the starting point.

Cheap cleanup available in lane 2 or ahead of it: rank `class`/`interface`/
`function`/`method` above `variable`, and deprioritize (never exclude) `__tests__`
and `.test.` paths. It needs no calibration — "a local variable is not a better
answer than the class it lives in" is true before any measurement, so it is a
mechanism fix, not tuning to a score.

**DONE, and it was worth more than "cheap cleanup" suggested.**

- **IDX-002A** (PR #118, `3874f7a`) shipped that ranking behind
  `MEMBERRY_KIND_RANK_V1`, live since 2026-08-27.
- **IDX-002B** (PR #119, `afcf3b2`) fixed what measuring 002A exposed. A
  `berry_code_search` scoped to one project was returning **42% of that
  project's code** in its top 5. The rest was memory prose with no file or line
  (28 of 50 slots — the kind predicate scored them 0, so 002A's sort actively
  promoted them above code) and another project's source, admitted because the
  un-stamped-symbol scope fallback had no path constraint. The semantic channel
  had no project scope at all. Behind `MEMBERRY_CODE_SCOPE_V2`, live.

Measured live on the ten-question outcome probe, baseline → after both:

| | before 002A | after 002B |
|---|---|---|
| the project's own code in top 5 | 42% | **100%** |
| answerAt5 | 0.4000 | **0.5000** |
| MRR | 0.2700 | **0.4000** |
| memory rows in top 5 | 28 of 50 | **0** |
| foreign / stale rows in top 5 | 1 | **0** |

No case regressed; oc-01 2→1, oc-02 5→2, oc-08 MISS→2.

**What IDX-002 did not fix turned out not to be granularity at all.**

- **IDX-003** (PR #121, `51fcd99`). `CodeIndexer` was constructed with only a
  driver — **no embedding provider** — so `symbol.embedding` was never assigned
  and the branch deriving `mini_vector` never executed. Every symbol ever
  indexed had both null: **0 embeddings across all 54,314 symbols in all five
  projects**. `symbol_embedding` was an empty vector index, `code.dense-vector`
  returned zero rows on every query *while reporting success*, and code search
  has always been lexical-only. Backfilled 16,399 memberry symbols.

| | before 002A | after 002B | after 003 |
|---|---|---|---|
| answerAt1 | 0.1000 | 0.3000 | **0.5000** |
| answerAt5 | 0.2000 | 0.5000 | **0.6000** |
| MRR | 0.1619 | 0.4000 | **0.5333** |
| own code in top 5 | 42% | 100% | 100% |

**The granularity hypothesis was tested and failed.** Excluding variables from
the pool — the crude form of a coarser chunk — left the same five misses and
made MRR *worse* (0.3250 vs 0.4000). The misses were never about chunk size;
they were about there being no semantic retrieval at all. Lane 2 as written
would have re-chunked a lexical-only index.

**That bottleneck was closed by IDX-004** (PR #123, merge `9fb40f1`), live 2026-08-28
behind `MEMBERRY_CODE_RERANK_V1`. With embeddings live, the 11,847 embedded
variables were crowding real answers out of the dense channel's top-k before fusion
saw them. The fix was not a per-channel cap: widening the retrieval window to 50
rows so the kind prior sorts a bigger pool (`widenLimit`,
`packages/code/src/search.ts:128`, applied at `:248`) cut variable share@5 from 50%
to 8% and lifted top-5 60% → 70%. The BM25F reranker that shipped on the same flag
adds only +0.8 MRR and is a wash by case — see `RESEARCH-LEDGER.md` RL-001 (decide
it) and RL-002 (split the flag, so the proven half can be kept without the
unproven one). **The open ranking question is now RL-002, not a per-channel cap.**

**Still open, same class:** the boot guard added in IDX-003 found `Fact` nodes with
zero embeddings on its first run, and the 2026-08-28 census still reads
**0 of 29,314**. Semantic was fixed once, Symbol is fixed now, Fact is not — and
nothing reads `fact_embedding`, which is why the guard no longer reports it
(RL-016). That decision now hangs on RL-008 alone. The instruments are
`bench/eval/run-outcome-probe.mjs` (is the answer there, and how far down),
`bench/eval/scope-probe.mjs` (what is occupying the slots), and
`bench/eval/idx004-measure.mjs` (which carries a `--no-reranker` isolation arm).

**The discipline that survives the direction change.** Never tune weights because
a number moved on the same queries used to choose them; that is measuring on
train, and it is how golden v2 died. Fix mechanisms with a priori justification,
then use EVAL-001 as a REGRESSION check. Golden v1 remains the regression guard it
became in RET-006 and its `precisionAt5: 0.39` floor is not raised or lowered.

Standing scope exclusions, unchanged: keep RET-007 v2 and v3 permanently frozen;
keep deployment, activation, threshold changes, sealed holdout inspection, new
credentials/permissions, destructive Git, tenant/data mutation, and live-service
changes out of scope unless separately authorized.

## Confirmed context-engine incident — Neuri code plane

Live read-only audit on 2026-08-22 confirmed that this is a real product/setup
failure, not merely an unhelpful agent answer:

- Cerebro MemBerry was confirmed at `1052232f`, 159 commits behind roadmap master,
  then separately upgraded on 2026-08-22 to exact CI-green `844aeb0`. The upgrade
  removed version drift but did not itself repair the remaining incident classes.
- The live graph contains 34,504 `Symbol` nodes but zero with
  `project_tag = project:neuri`; the represented projects are Hermes Agent,
  MemBerry, AG3NTIC, and legacy unscoped files.
- `berry_context(include_code=true, include_memory=false)` returned zero sources
  and a successful-looking empty code trace instead of an actionable unsupported
  status.
- The mixed code+memory request returned semantic summaries only, without saying
  that current code evidence was unavailable.
- The same mixed request with tracing enabled returned the opaque public error
  `Retrieval trace validation failed`.
- `berry_tools enable code` reported success, but Codex still received no callable
  `berry_code_search`, `berry_code_symbols`, or `berry_code_context` schema. The
  server's tool-list notification contract is therefore not sufficient for every
  supported client.

**Partially repaired as of 2026-08-25 (COD-010 slice, PR #94, deployed).** Two of
the six findings are closed: Neuri is indexed at 12,339 `Symbol` nodes tagged
`project:neuri`, and `berry_code_search` returns live-repo symbols that hit the
held-out regression evidence (`pieces_catalog.py`, `ApiIntegrationAction`, and the
relevant tests); the 10,428 stale audit-day clone rows were deleted. Silent empty
code traces are gone — `berry_context` now states code-plane status per response
as `served (K of N)` or `unavailable (reason)`.

**CLOSED 2026-08-26 by COD-010b** (PR #113, master `3eba9a9`, deployed and
live-verified). Mixed code+memory requests under the live flags
(`MEMBERRY_QUERY_PLANNER_V1=1`, `MEMBERRY_CANDIDATE_CHANNEL_V1=1`,
`MEMBERRY_RERANKER_V1=served`) now render `**Code:** served (16 of 20)` and carry
real `file:line` symbols alongside semantic memory. The guidance below applied
only while the gap was open and no longer governs.

~~Until it does, a Neuri answer may cite `berry_code_search` results directly, but
must treat a mixed `berry_context` request as carrying no code evidence…~~

Two constraints that DO survive: a semantic-only answer still never counts as
code-context success, and a project with no indexed symbols still yields
`served (0 of 0)` rather than evidence. Check index coverage before trusting a
code answer — live counts as of 2026-08-26: `project:memberry` 8,928,
`project:neuri` 12,339, `project:hermes-agent` 15,055, `project:ag3ntic` 5,385.

The exact held-out regression is the integration-Library discovery incident. Given
the original diagnosis request, MemBerry must retrieve and cite the current Build
Hermes catalog handler, Tools integration handler, integrations HTTP endpoint,
Google Calendar action manifest, and relevant tests; it must identify the MCP-versus-
piece catalog split or explicitly report which required evidence is missing.

## Immediate Retrieval 2.0 exit checklist

- [x] Bind G2 evidence to the real production retrieval adapter (LAB-010/011).
- [x] Freeze scorer-separated multi-hop v1 (LAB-012).
- [x] Reject RET-007 v1 approach 1 honestly: control `1.0`, candidate `1.0`,
  delta `0`, interval `[0,0]`; holdout unopened; PR #49 closed unmerged.
- [x] Author candidate-blind, non-saturated multi-hop v2 instrument (LAB-013).
- [x] Merge LAB-013 instrument-only PR #50 as `d984c6b`; no qualification or
  capability claim.
- [x] Pass exact-merge post-master CI (`32440317151`): Node 20, Node 22,
  integration, artifacts, and cleanup all succeeded.
- [x] Execute the exact-source joined Node 20+22 LAB-013 control qualification
  as run `32441685712` against `d984c6b`; both nodes agreed and the sole
  authoritative output was a `control-headroom-rejected` tombstone (SHA-256
  `862b6134c10172888b5f6274596d974f2466c9f32d6f1683e61532295fa1e4d1`).
- [x] Record the terminal headroom result: dev control `5/20` (`25%`), holdout
  control `3/20` (`15%`); holdout low and medium strata had no successes.
- [x] Freeze LAB-013 permanently after rejection. No candidate was registered
  or executed, and no production capability was changed.
- [x] Apply the declared escape condition: do not run either RET-007 v2
  hypothesis or the v2 candidate holdout; park RET-007 pending a separate owner
  decision on any additive v3 instrument and advance the independent G6 lane.
- [x] Complete the bounded SEC-001 detour: strict SEC-001A contract commit
  `660b2d26`, SEC-001B design merge `a43a3da`, runtime merge `3c623e8`, and exact
  runtime post-master CI `32469628048` all passed without deployment or policy
  activation. G6 and the remaining SEC packages stay open independently.
- [x] Promote RET-010A through RET-010D: qualification instrument, ranked-v2
  model, real served-response wiring, and runtime composition.
- [x] Promote the RET-010E verification design through PR #68 as merge
  `8fbaa24f`, the fast-path roadmap through PR #69 as `6793fe7f`, and the final
  executable CommonJS boundary through PR #70 as exact master `844aeb0`.
- [x] Implement and qualify RET-010E in the frozen thirteen paths on Node 20 and
  Node 22. `(merged and qualified by CI 32627897999)`
- [x] Close RET-010F by independently authenticating the hosted development
  evidence and committing the canonical approval record as `f8627b8`.
- [x] Close RET-010: qualify and independently approve the real served reranker.
  A shadow-mode flag or identity provider does not satisfy this item; the
  parent remains open until RET-010E and RET-010F close.
- [x] Arm the previously declared G2 improvement threshold only when the
  qualifying capabilities exist.
- [x] Repair the holdout harness so it emits content-free stage-classified
  failure receipts. `(9eae555 pre-flight stage receipts, c7af25e fallback
  receipts off the structured output path, d43b646 fully-qualified dispatch ref
  comparison, 9f4b210 holdout-only split count; authenticated development
  records 3665d6d from run 32644686048 and d39712a from run 32647104086)`
- [ ] Obtain explicit owner authorization for one actual holdout evaluation.
  `(the live blocker on G2 — nothing technical is outstanding)`
- [ ] Pass G2: Recall@10 not below baseline, Precision@5 materially improved,
  stale/contamination zero, and task-success-per-token improved with confidence
  bounds. `(READ THIS BEFORE DISPATCHING THE HOLDOUT. "Precision@5 materially
  improved" is pre-registered as +0.05 over the immutable baseline's 0.4000.
  Measured 2026-08-25, precision@5 on the golden set is capped at 0.4667 by how
  few relevant docs its queries carry, so the criterion asks for 75% of all
  reachable headroom. Confirm the holdout instrument does not share that
  structure before spending the one shot — if it does, G2's precision clause is
  close to unmeasurable and the gate would reject a genuinely better ranker.)`

### Retrieval escape conditions

- If LAB-013 control qualification rejects, do not mutate v2. Mark it
  unqualified, move active delivery to G3 or G6, and require a separate owner
  decision before any additive v3 instrument.
- If two genuine RET-007 capability hypotheses fail dev, mark RET-007 blocked
  and advance another independent roadmap lane. `(This limit was deliberately
  superseded for the v4 campaign by explicit owner authorization on 2026-08-25;
  v4 then failed dev honestly and RET-007 is now blocked on indexing. The limit
  is back in force — reviving RET-007 before IDX-001 needs a fresh owner
  decision.)`
- Do not create another lab packet merely because a candidate failed.
- Never lower thresholds, alter a frozen holdout, inspect sealed per-case
  outcomes, or manufacture a weaker control.

## Topological route to the final gate

```text
COMPLETED: SEC-001 capability binding; RET-010A-F; Phase 3 (MEM-002..008,
          MEM-006H) -> G3 CLOSED 2026-08-25; COD-010 fail-loud slice;
          COD-010b served code plane (PR #113, 3eba9a9); EVAL-001 harness
          (PR #117); IDX-002A/002B/003/004 (PRs #118/#119/#121/#123)
TERMINAL:  RET-007 v1 (saturated), v2 (no control headroom), v3 (dev rejected);
          IDX-002 chunk granularity (hypothesis tested, rejected 2026-08-27)
PARKED:    RET-007 v4 — measured, blocked on indexing, resumes after IDX-001
NOW (owner picks the order; these do not block each other)
  -> RL-006: an outcome instrument for the MEMORY plane — ~87% of call volume,
       nothing measures it, and it gates ranking every finding under RL-007..011
  -> EVAL-001 re-baseline: the 2026-08-27 origin is void under three later flags,
       so the harness is not a guard until a fresh run replaces it
  -> G2: one authorized RET-010 holdout -> decide Retrieval 2.0 and stop
  -> IDX-001 Phase A: index-time structure, the measured prerequisite for RET-007
       |-> Lane A: G3 CLOSED -> G5 temporal -> G7 reliability
       |-> Lane B: G4 Git-native coding memory
       |-> Lane C: G6 security/tenancy -> G9 operations UI
       `-> Lane D: G8 agent behavior
                -> Phase 10 comparisons and release audit
                -> GF final release gate
```

After G1, independent lanes are permitted. A blocker in Retrieval 2.0 must not
freeze G3, G6, or G8 indefinitely.

## Phase 0 — Control and execution spine

- [x] CTL-001 — Immutable baseline manifest
- [x] CTL-002 — Feature-flag and experiment registry
- [x] CTL-003 — Autonomous run state
- [x] CTL-004 — Benchmark/release gates in CI
- [x] G0 — Reproducible baseline, isolated candidate, resumable state

## Phase 1 — Minimum viable evaluation spine

- [x] LAB-001 — Versioned lab contracts and registries
- [x] LAB-002 — Baseline and candidate adapters
- [x] LAB-003 — Deterministic metrics engine
- [x] LAB-004 — Run manifest and artifact writer
- [x] LAB-005 — PR comparison gate
- [x] LAB-006 — Dataset acquisition and license registry
- [x] LAB-007 — Temporal/isolation scenario expansion
- [x] EVAL-001 — Real-query retrieval evaluation `(PR #117, 5563490. Harness,
  frozen selection rule, mined question set and sealed holdout under bench/eval/;
  origin pinned 2026-08-27 at a1439fb, numbers in BASELINE.md 2.6. It is NOT
  currently a live regression guard: IDX-002A/002B/004 turned on three retrieval
  flags after the pin, which voids cross-run comparison per spec 3.2 item 2, so a
  fresh baseline is owed — BASELINE.md 2.7.)`
- [x] G1 — Reproducible comparison with regression enforcement

## Phase 2 — Retrieval 2.0

- [x] RET-001 — Secret-safe retrieval trace model
- [x] RET-002 — Entity/scope/time-aware query planner
- [x] RET-003 — Multi-channel candidate contract
- [x] RET-004 — Calibrated reranker provider interface `(closed 2026-08-25 on
  its PRP acceptance, "local and remote implementations; baseline fallback
  preserved": createLocalRerankerProviderV1, createHttpsRerankerProviderV1 with
  https-only endpoint validation, and baselineIdentityRerankerScoreV1 all live in
  packages/retrieval/src/reranker-providers.ts and are bound by named RET-004B
  tests. Verified at 6d2c6f7 in node:20 on cerebro: reranker + reranker-shadow +
  served-reranker + quality.regression = 66/66 pass. The "hosted qualification"
  this line previously demanded was RET-010's, and it closed with approval record
  f8627b8.)`
- [x] RET-005 — Contradiction/stale/dedup post-filter
- [ ] RET-006 — Token-budget evidence optimizer `(partial, and the acceptance is
  now measured rather than vague. PRP acceptance is "precision/context utility
  improves without Recall@10 regression"; the pre-registered arming rule in
  bench/lab/baselines is precisionAt5 minImprovement 0.05, armed: false,
  armsWith: RET-006 — so a candidate must reach 0.45 against the immutable
  baseline's 0.4000. MEASURED 2026-08-25 at 6d2c6f7: precision@5 = 0.4000,
  recall@10 = 0.9306, and the STRUCTURAL CEILING of precision@5 on this
  12-query golden set is 0.4667, because 8 of the 12 queries have so few
  relevant docs that they already sit at their own cap. The +0.05 the rule
  demands is therefore 75% of all headroom that exists, reachable only by
  fixing three of the four queries that have any. WARNING before anyone tries:
  the golden set is the regression instrument, not a held-out one — tuning the
  ranker until precision@5 clears 0.45 on the same 12 queries that define the
  threshold is measuring on train, and would be the same selection-inflation
  error the RET-007 campaign spent four attempts avoiding. Closing RET-006
  honestly needs either a mechanism gain that shows up somewhere other than
  this set, or a golden set with more relevant docs per query. A regression
  guard at precisionAt5 0.39 plus a pinned ceiling test are on master (PR #111,
  2ad56a4): packages/retrieval/bench/quality-eval.ts:485 and
  packages/retrieval/src/__tests__/quality.regression.test.ts.)`
- [ ] RET-007 — Query decomposition for multi-hop tasks `(v4 measured and
  parked 2026-08-25 — BLOCKED ON INDEXING, resume after IDX-001; see the
  Phase 3 tail RETURN POINT and docs/agent-runs/advisor-log-2026-08-25-ret007v4.md
  Findings 3 and 4; source preserved at tag archive/ret007-query-decomposition)`
- [x] RET-008 — Tenant-scoped learned routing and feedback
- [x] RET-009 — Caching, timeout, and provider fallback
- [x] RET-010 — Real reranker promotion into the served response path
  `(reconciled 2026-08-25 — this line contradicted the exit checklist above,
  which already recorded RET-010E qualified by CI 32627897999 and RET-010F
  closed as approval record f8627b8. The specific evidence wins. The one
  outstanding holdout is a G2 GATE item, not a RET-010 item; RET-010's own
  acceptance is the served reranker, and it is served.)`
- [x] RET-Q-002 — Memory-plane outcome measurement and quality repair `(PRs
  #134-#136; live 34-case baseline Answer@5 31/34, with Semantic/Fact/MemoryBlock
  at 100% and Episodic at 14/17.)`
- [x] RET-Q-003 — Agent retrieval reliability `(PR #137, commit 8cf1f651; bounded,
  content-free trace summary plus a serialized RET-010 lab lane. Hosted CI
  run 33301429083 passed Node 20, Node 22, and live-container integration. Live
  representative result: same order in 196 ms / 28,783 bytes versus exhaustive
  trace in 28.76 s / 4,026,794 bytes.)`
- [x] RET-Q-004 — Episodic miss repair `(PR #138, commit 1c0f97c; live Answer@5
  31/34 → 33/34 with rq-e-05 at rank 1 and rq-e-06 at rank 4, no prior-win
  regressions, zero errors, bounded latency/response size, and rollback retained.)`
- [x] RET-Q-005 — Final episodic candidate reachability `(PR #140, cb85d9a;
  live Answer@5 34/34 with two consecutive zero-error probes.)`
- [ ] G2 — Retrieval holdout quality and safety gate

## Phase 3 — Admission and lifecycle intelligence

- [x] MEM-001 — Admission policy interfaces and shadow scorer
- [x] MEM-002 — Salience/novelty/durability/sensitivity features `(live feature
  producer PR #96; holdout corpus PR #97; custodian seal PR #98)`
- [x] MEM-003 — Tier routing and policy configuration `(PR #91 tier routing;
  PR #95 live routing inside the shadow write path)`
- [x] MEM-004 — Confidence calibration and evidence diversity `(PR #92; ECE
  111‰, maxGap 143‰, Brier 20‰, report identity 130ebf01…)`
- [x] MEM-005 — Fair keyset candidate scheduling `(PR #93)`
- [x] MEM-006 — Per-scope budgets, compaction, archive, and decay `(PR #99)`
- [x] MEM-006H — Usage-modulated (Hebbian) decay `(PR #102)`: retrieval hits and helpful
  feedback strengthen a memory (slow/reset its decay, decay-class promotion
  eligible); memories never retrieved decay faster and sink to archive first.
  Depends on MEM-002 durability features + MEM-006 decay engine; today decay
  is purely time-based (volatile 14d / stable 90d / permanent 365d) and only
  explicit reinforcement signals raise confidence — mere use changes nothing.
- [x] MEM-007 — Anti-entropy graph and queue repair `(PR #100)`
- [x] MEM-008 — Risky-proposal advisor policy `(PR #101)`
- [x] G3 — Lifecycle quality, calibration, and self-healing gate `(CLOSED
  2026-08-25, owner-ratified. All four clauses PASS at 52aa9d6 on an isolated
  seeded corpus: noise load sidecar −55.0% and active memory −15.2% with 25
  review-gated decay proposals and zero protected losses; durable Recall@10
  1.0→1.0 byte-identical pre/post; calibration report reproduced exactly;
  self-heal 15/15 fault injection against real Redis with zero unsafe
  mutations. Evidence pack docs/agent-runs/g3-evidence-2026-08-25.md plus
  -raw/. Packets 9/9 merged, deployed, and live-verified; ratchet 3351→3579.)`
- [x] IDX-002A — Kind-aware code ranking, sinking trivial symbols and test paths
  behind `MEMBERRY_KIND_RANK_V1` `(PR #118, 5ef90bc; feature commit 3874f7a)`
- [x] IDX-002B — Project-scoped code search that ranks code ahead of memory rows,
  behind `MEMBERRY_CODE_SCOPE_V2` `(PR #119, afcf3b2)`
- [x] IDX-003 — Dense embeddings for indexed code symbols, plus the boot guard for
  empty vector indexes `(PR #121, 51fcd99. CodeIndexer had no embedding provider,
  so 0 of 54,314 symbols were embedded and the dense channel returned nothing
  while reporting success. Backfilled; the 2026-08-28 census reads 54,314/54,314.)`
- [x] IDX-004 — Wide candidate window with BM25F reranking, behind
  `MEMBERRY_CODE_RERANK_V1` `(PR #123, 9fb40f1; live 2026-08-28. The widening is
  proven and the reranker is not — RESEARCH-LEDGER RL-001/RL-002.)`
- [ ] IDX-001 — Index-time structure: write-time extraction plus local-model
  backfill. Plan at docs/agent-runs/packet-plan-idx-001-local-llm-indexing.md.
  Phase A (atomic facts as additional retrieval keys) is measurable on today's
  instruments and comes first; Phase B (entity graph, aliases, project-scoped
  identity) needs a NEW graph-carrying instrument version — lab scenarios carry
  no entity fields today, so budget that apparatus cost before Phase B, not
  after. Ships with the D-DOCS agent-guidance deliverable in the same change as
  the schema.
- [ ] RETURN POINT: RET-007 multi-hop — resume AFTER IDX-001, not before.
  Measured 2026-08-25 (advisor log Findings 3 and 4): the query-time mechanism
  now recovers the withheld second hop in 13 of 14 calib scenarios, up from 0,
  but cannot decide WHEN to fire — every text-only gate signal tried was
  degenerate (fired 45/45, or 0/45, or cut the wrong cases). Deciding requires
  knowing whether two memories are linked, which is a property of the index and
  does not exist at query time. With a working gate the same mechanism scores
  35/45 against a control of 22.
  On return, expect to REPLACE rather than tune: given recorded links you
  traverse them instead of guessing a bridge from capitalised tokens and
  re-querying, and Phase A may remove the need entirely for the scenarios it
  makes reachable in pass 1. Keep the lexical second pass as the fallback for
  memories the index never covered (pre-schema memories, absent agent extras,
  backfill lag). Do NOT raise the scorer's K to convert the near-misses at
  positions 11-12; that moves the goalposts and voids every recorded number.
  Work preserved on branch research/aug25-multihop (best keep f23438b; best
  mechanism 62eb486) with the calib harness at bench/lab/multihop/tune-calib-v4.ts.

## Phase 4 — Git-native coding memory

- [ ] COD-001 — Repository/branch/worktree/commit identity `(partial)`
- [ ] COD-002 — Stable symbol identity and relocation mapping
- [ ] COD-003 — Code-bound memory provenance
- [ ] COD-004 — Drift-driven confidence and invalidation
- [ ] COD-005 — Git/PR/CI/test connector contracts
- [ ] COD-006 — Branch-merge knowledge reconciliation
- [ ] COD-007 — Multi-repository dependency graph
- [ ] COD-008 — Pre-edit and post-verification context pipeline
- [ ] COD-009 — Directory-scoped managed-agent context
- [ ] COD-010 — Code-index readiness and fail-loud context assembly. A scoped code
  request returns repository root, indexed commit/branch, index time, file/symbol/
  test counts, exclusions, watcher/error state, and drift; zero code cannot be
  silently replaced by semantic memory. `(partial: the fail-loud slice merged as
  PR #94 c4cd671, deployed, post-master CI 32724618129 green — berry_context now
  states code-plane status per response as "served (K of N)" or "unavailable
  (reason)", and Neuri is indexed at 12,339 symbols. KNOWN GAP closing in
  COD-010b — CLOSED 2026-08-26, PR #113 merged as master 3eba9a9, deployed and
  live-verified at "Code: served (16 of 20)" on a mixed request. The historical
  diagnosis is retained below because it cost real time to establish and the
  corrected file anchors are still the right ones for anyone reading this code.
  CORRECTED 2026-08-25 after re-grounding against master —
  an earlier version of this line blamed runtime-candidate-channel.ts and would
  have sent an implementer to the wrong file. That file does lack a code option,
  but its per-channel "unavailable" is a candidate-channel FAILURE CODE that
  never reaches the rendered line, and two existing pins
  (runtime-candidate-channel.test.ts:103 and :207) would block a fix attempted
  there. include_code is actually dropped at tools.ts:517, where executeOptions
  is built with only includeArchitecture and includeMemory; the fix belongs in
  the assembler's assembleCandidateExecutionServed, which is what the approved
  spec says. Note also that berry_context now has TWO served call sites
  (tools.ts:523-526 multihop, :528-531 non-multihop) — patching one leaves the
  bug alive under the other flag combination. COD-010b spec at
  docs/agent-runs/specs/2026-08-25-cod010b-code-service.md; implementation plan at
  docs/agent-runs/plans/2026-08-26-cod010b-implementation.md. SHIPPED.)`
- [ ] COD-011 — Current worktree and dirty-overlay context. Responses distinguish
  canonical, branch, worktree, dirty, deployed, and unrepresented bytes and attach
  resolvable path/symbol/line/commit anchors.
- [ ] G4 — Private coding-task improvement gate

## Phase 5 — Bitemporal semantics and ontology

- [ ] TMP-001 — Bitemporal schema and compatibility reader `(partial)`
- [ ] TMP-002 — Late/out-of-order event reconciliation
- [ ] TMP-003 — Relationship-level bitemporal history
- [ ] TMP-004 — Future-effective changes
- [ ] TMP-005 — Versioned ontology registry
- [ ] TMP-006 — Online migration and rollback tooling
- [ ] G5 — Temporal QA, provenance, and rollback gate

## Phase 6 — Identity, tenancy, privacy, and providers

- [x] SEC-001 — Actor/tenant/project capability model `(SEC-001A contract
  `660b2d26`; SEC-001B design/runtime merges `a43a3da` and `3c623e8`; exact
  post-master run `32469628048` green; default-off and not activated)`
- [ ] SEC-002 — JWT/OIDC verifier interface
- [ ] SEC-003 — Per-tool and resource authorization
- [ ] SEC-004 — Uniform mutation audit
- [ ] SEC-005 — Tenant-qualify satellite domains
- [ ] SEC-006 — Dedicated tenant datastore and wiki routing
- [ ] SEC-007 — Quotas, rate limits, and backpressure
- [ ] SEC-008 — Secret/PII admission policy
- [ ] SEC-009 — Retention/export/hold/delete workflow
- [ ] SEC-010 — Local/provider-neutral inference stack
- [ ] Investigate the observed project-scoped `berry_context` result that mixed
  in another project's architecture; keep it separate from G2 unless an
  isolation review escalates it.
- [ ] G6 — Adversarial tenant/authz/privacy/provider gate

## Phase 7 — Reliability and scale

- [ ] OPS-001 — End-to-end OpenTelemetry and correlation `(partial)`
- [ ] OPS-002 — SLO metrics and readiness policy
- [ ] OPS-003 — Fault-injection harness
- [ ] OPS-004 — Mutation journal and anti-entropy replay
- [ ] OPS-005 — Backup verification and restore drill
- [ ] OPS-006 — Load generator and dataset synthesizer
- [ ] OPS-007 — Backpressure, fairness, and index tuning
- [ ] OPS-008 — Rolling upgrade and migration rehearsal
- [ ] OPS-009 — Deployed-version and project-index inventory readiness. Readiness
  reports source commit/image, per-project symbol inventory, last successful index,
  and code-plane degradation; semantic scope without a code index is partial setup.
- [ ] G7 — SLO/RPO/RTO, scale, and fault-survival gate

## Phase 8 — Skills and agent behavior

- [ ] AGT-001 — Live-schema-derived skill contracts
- [ ] AGT-002 — Cross-client guidance source model
- [ ] AGT-003 — Behavioral agent harness
- [ ] AGT-004 — Hook/context-floor hardening
- [ ] AGT-005 — Procedural-memory proposal workflow
- [ ] AGT-006 — Pre-compact and session-end automation
- [ ] AGT-007 — Actionable error and recovery contracts
- [ ] AGT-008 — Progressive-disclosure optimization
- [ ] AGT-009 — Cross-client progressive-disclosure compatibility. Codex, Claude,
  Gemini, and Hermes must either receive newly enabled callable schemas in-turn or
  use one permanently visible typed gateway; reporting enabled while tools remain
  undefined fails the client harness.
- [ ] G8 — Agent adherence and reduced-intervention gate

## Phase 9 — Human trust and operations UI

- [x] UI-001 — Retrieval explanation view
- [ ] UI-002 — Temporal/provenance/confidence timeline
- [ ] UI-003 — Unified proposal review and preview
- [ ] UI-004 — Tenant/project pipeline health
- [ ] UI-005 — Tenant-qualified atomic wiki publication
- [ ] UI-006 — Retrieval replay and incident export
- [ ] G9 — Tenant-safe explanation, review, recovery, and audit gate

## Phase 10 — Comparison and release candidate

- [ ] CMP-001 — Local Graphiti adapter
- [ ] CMP-002 — Local/self-hosted Mem0 adapter
- [ ] CMP-003 — Local Letta adapter
- [ ] CMP-004 — Local Cognee adapter
- [ ] CMP-005 — Managed adapters when credentials exist `(optional)`
- [ ] CMP-006 — Full LongMemEval/LoCoMo/DMR suite
- [ ] CMP-006A — Pin and approve LongMemEval/LoCoMo source data
- [ ] CMP-006B — Frozen loaders, splits, scorers, and acquisition replay
- [ ] CMP-006C — Execute no-memory, BM25, proxy, and live comparison
- [ ] CMP-007 — Private coding-memory benchmark
- [ ] REL-001 — Release-candidate audit across G2 through G9
- [ ] REL-002 — Independent hostile program review
- [ ] REL-003 — PR, operator handoff, decision ledger, and rollback runbook
- [ ] GF — All mandatory evidence complete; default-off until human-reviewed
  release/deployment

## Rejected approaches — do not repeat

- **G2 proxy evidence:** the original G2 lanes measured a small BM25 proxy, not
  production retrieval. LAB-010/011 corrected the binding.
- **LAB-012 as capability evidence:** v1 is saturated by construction. It may
  remain as a regression instrument but cannot prove a positive RET-007 delta.
- **RET-007 v1 approach 1:** post-retrieval bridge multipliers changed no strict
  top-10 outcomes. Do not rerun it against LAB-012 or weaken that policy.
- **LAB-013 v2 control:** exact-source joined Node 20/22 qualification rejected
  control headroom (dev 25%, holdout 15%; holdout low/medium had zero
  successes). Do not mutate v2, run a v2 candidate, or treat the tombstone as
  infrastructure failure.
- **RET-007 v3:** the instrument qualified on holdout (0.55, strata 4/3, 3/4,
  4/2) and the candidate was rejected on dev (0.85, high stratum 6/0). Terminal
  — tombstoned via PR #104. Do not revive the v3 mechanism or re-run it.
- **RET-007 v4 query-time multi-hop:** instrument (PR #108) and candidate
  (PRs #109/#110) both merged and honestly measured; dev gave control 28/60 vs
  candidate 30/60, +3.3 points, CI [-5.0, +11.7] — FAILS. Follow-on calib
  investigation drove second-hop recovery from 0/14 to 13/14 but could not build
  a firing gate from text alone. Do not tune this further at query time; the
  missing signal is index-side. See the RETURN POINT below.
- **Flag-only reranker promotion (superseded by RET-010):** while the reranker was
  shadow-only and the wired provider was identity, a flag flip could not improve
  served order. RET-010 closed that gap — `MEMBERRY_RERANKER_V1=served` now wires a
  real served reranker (`packages/mcp/src/bootstrap.ts:211-213`). The rule that
  survives: never claim a served improvement from a flag state alone.
- **IDX-002 chunk granularity:** the published-evidence argument that
  individual-symbol indexing is too fine was tested on 2026-08-27 and failed.
  Coarsening the pool by excluding variables left the same five misses and made MRR
  worse (0.3250 vs 0.4000). The defect was the absent dense channel (IDX-003), not
  chunk size. Do not re-chunk on this argument alone.
- **Stopword stripping before the fulltext channel:** a six-config sweep raised
  coverage but dropped rank-1 from 50% to 30%. Negative result, recorded in
  `RESEARCH-LEDGER.md` RL-004. Do not retry it unpaired with a precision mechanism
  proven on code text.
- **Endless evaluator repair:** a candidate failure is not permission to build a
  new dataset, change thresholds, or inspect sealed per-case outcomes.

## Operating rules that prevent another stalled phase

1. **Headroom first:** qualify the control before candidate code is authorized.
2. **Capability before another lab packet:** after a frozen qualified instrument,
   the next change must affect production behavior or explicitly block the
   capability.
3. **Two-hypothesis limit:** after two genuine dev capability failures, stop the
   packet and advance another independent lane.
4. **Parent-level progress only:** report closed work packages, gates, and
   measured behavior—not test counts, subpackets, or review activity.
5. **One active item per lane:** the root orchestrator owns sequencing and
   prevents overlapping edits.
6. **Risk-proportional review:** full maker/checker/hosted evidence for production
   capability and security boundaries; one static checker plus hosted rerun for
   narrow test/registry corrections.
7. **No phase monopoly:** after G1, a blocked G2 packet cannot prevent safe,
   dependency-ready work in G3, G6, or G8.
8. **No silent replanning:** source drift or a concrete P0/P1 may change the
   route; difficulty, boredom, or a new session may not.
9. **RET-010 fast path:** implementation promotion blocks on P0/P1. Record
   non-safety P2 findings in implementation acceptance instead of reopening the
   promoted design; one hosted development qualification and one authorized
   holdout decide the route. A frozen-gate failure stops iteration rather than
   changing the instrument, thresholds, or sealed evidence.

## New-session restart protocol

Every new session must do exactly this before proposing work:

1. Read this file completely.
2. Read `AGENTS.md` and the authoritative PRP only for the active package's
   detailed acceptance criteria.
3. Fetch and verify `origin/master`, open PRs, active worktrees, and the current
   lane under `NEXT ACTION`.
4. If repository state matches this file, resume the exact next unchecked item.
5. If it does not match, update factual identity/state first; do not redesign the
   roadmap.
6. Preserve all entries under `Rejected approaches` and `Retrieval escape
   conditions`.
7. Update this file only when a parent package, gate, terminal rejection, or
   active `NEXT ACTION` changes.
