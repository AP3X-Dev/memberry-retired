# Research Ledger

Findings we chose **not** to act on yet, each with the condition that should bring it back.

This is not the roadmap. `10X_EXECUTION_ROADMAP.md` says what to build next; this file says what we
learned and deliberately deferred, and why. The roadmap has been wrong about the next real defect
three times running — every time, live measurement overturned it. This ledger exists so the
evidence that corrected it does not live only in someone's head.

## Rules

1. **Every entry needs a revisit trigger.** Not "later" — a condition someone can check. An entry
   without a trigger is a graveyard entry; delete it or give it one.
2. **Every entry names its evidence strength.** `measured` (a number from a real run),
   `verified` (read in the code, file:line), `audit` (found by review, not independently
   re-checked), `hypothesis` (plausible, untested).
3. **Negative results stay.** Something we tried that made things worse is the most valuable kind
   of entry, because it stops the next person burning a day on it.
4. **This repo is public.** Entries describe MemBerry's own code. No client names, no credentials,
   no infrastructure detail that is not already public.
5. **Closing an entry means linking the PR that closed it.** Move it to Closed, keep the trigger
   visible, so the reasoning survives.

---

## Open

### RL-026 — The bounded Cerebro local-model backfill produced zero usable extractions
**Evidence:** measured · **Status:** closed-negative for IDX-001A production activation · **Opened:** 2026-08-30

IDX-001A's accepted dev arm moved the frozen multi-hop set from 28/60 to 36/60,
but that arm assumed structured episode keys already existed. The default-off
production pilot tested whether older memories could be supplied safely by a
small local model. In a loopback-only Ollama container capped at two CPUs and 4
GiB with no restart policy and a 60-second per-episode timeout,
`qwen2.5:3b-instruct` examined 10 episodes and failed 10; the smaller
`qwen2.5:1.5b-instruct` examined three and failed three. Both were cancelled at
the deadline before a valid structured payload was returned.

The first attempted run also exposed a separate strict-driver bug: the bounded
batch limit reached Neo4j as `5.0`. The query failed before any extraction or
write. PR #142 now encodes that value as a Neo4j integer and adds a regression
assertion. Retesting the exact merged build proved the query fix, then produced
the model timeout results above.

No `EpisodicIndexKey` or `EpisodicIndexOutcome` node was written; orphan and
tenant/project mismatch counts are all zero. The reader was never enabled. With
the feature still off, two consecutive production probes stayed 34/34 at five
with zero errors, p95 427.7408 ms then 291.5251 ms, and maximum response 30,402
bytes. MCP and wiki are healthy with zero restarts; the model container is
stopped and has no restart policy.

**Revisit when:** a different offline inference budget or hardware target is
explicitly authorized and first demonstrates a zero-failure bounded extraction
batch with valid tenant/project provenance. Do not treat a longer timeout on the
shared production host as a retrieval win. After extraction qualifies, the same
>=10-point multi-hop target and positive confidence bound still apply before the
reader may be enabled.

---

### RL-025 — Broad structured-link expansion wins more cases but is not monotone
**Evidence:** measured · **Status:** rejected arm · **Opened:** 2026-08-30

On the frozen 60-case multi-hop v4 dev set, inserting one linked neighbour after
every top-five seed moved success@10 from **28/60 to 40/60** (+20.0 percentage
points, paired 95% bootstrap interval [+3.3,+36.7]) but traded **19 improvements
for 7 regressions**. A latch that preserved any already-connected top-five set
still scored 27/60; a broader delivered-query-chain latch preserved 28/60 but
blocked every gain.

The accepted rule expands only a seed that already references the query-planner
target. It scored **36/60** (+13.3 points, interval [+5.0,+23.3]) with **8
improvements and 0 regressions**. This is why the production candidate traverses
from authorized query-target episodes instead of every high-ranked episode.

**Revisit when:** a new frozen instrument version carries canonical entity IDs
directly or a production trace proves the narrower rule misses a safe class of
links. Do not revive either latch or broad expansion on the current v4 set.

---

### RL-001 — The BM25F reranker's value is unproven
**Evidence:** measured · **Status:** deferred · **Opened:** 2026-08-27 (PR #123)

IDX-004 shipped two mechanisms behind one flag: a wider retrieval window (the kind prior then
sorting 50 rows instead of 10) and BM25F reranking. Isolated on the live graph:

| | off | widen-only | +rerank |
|---|---|---|---|
| top-5 | 60.0% | **70.0%** | 70.0% |
| answers found | 6/10 | **7/10** | 7/10 |
| MRR | 53.3% | 57.5% | 58.3% |
| variable share@5 | 50.0% | **8.0%** | 8.0% |

The widening does essentially all the work. The reranker adds **+0.8 MRR** and is a wash by case:
fixes `oc-02` (4→1) and `oc-05` (2→1), breaks `oc-09` (1→2) and `oc-10` (1→3).

**Deferred because:** two-up-two-down at n=10 is indistinguishable from noise. Also structural —
the reranker's weights were calibrated on memory prose, and code signatures are a different token
distribution, so this is a mis-aimed instrument rather than a broken one.

**Live confirmation, 2026-08-28.** Deployed and the flag turned on. The deployed server reproduces
the container numbers exactly — top-5 **70.0%**, MRR **58.3%**, variable share **8.0%**,
test-file share **0.0%**, 0 errors — and the deploy-with-flag-off step measured byte-identical to
the old build, so the two are separately attributable. The +0.8 MRR and the two-up-two-down case
split both hold in production. **This entry is unchanged by shipping:** the reranker's value is
still unproven at n=10, it is just now unproven while switched on.

**Revisit when:** `bench/eval/outcome-cases.jsonl` exceeds ~30 cases (see RL-005), or if anyone
recalibrates the reranker weights on code.

**Cheap re-test:** `node bench/eval/idx004-measure.mjs --no-reranker` — the isolation arm is
already committed.

**If we never revisit:** delete the reranker path. Flagged-off code nobody returns to is rot with
a switch on it.

---

### RL-002 — Split IDX-004's four coupled behaviours off their single flag
**Evidence:** measured · **Status:** ready · **Opened:** 2026-08-27

Direct consequence of RL-001. Today `MEMBERRY_CODE_RERANK_V1` turns on both the widening (proven)
and the reranker (unproven), so you cannot take the safe half.

**Correction, 2026-08-28: it is four behaviours, not two, and their ORDER is load-bearing.** One
boolean, `rerankThisCall` (`packages/code/src/search.ts:245`), switches all of:
widen the retrieval window to at least 50 (`:248`; `widenLimit` is `Math.max(limit, 50)` at
`:128-130`, so a caller asking 100 still gets 100), run the reranker (`:332`), force the IDX-002A
kind prior on even when `MEMBERRY_KIND_RANK_V1` is off (`:346` — note the `||`), and truncate
back to the caller's limit (`:347`). The comment at `:242-244` records why they are computed once
— so the four "cannot drift apart into a configuration nobody measured" — and `:319-330` records
why their ORDER is load-bearing: fuse-wide → rerank → truncate with NO prior is **worse than
baseline**, because the reranker's coverage and phrase terms favour memory prose over a short
code signature on an English question.

So this is a flag-surface redesign with an order constraint, not a two-line split — and a naive
two-way split can reach exactly the configuration the comment forbids. `MEMBERRY_CODE_SCOPE_V2`
has the same shape and says so itself (`search.ts:91`, "Two leaks, one switch";
full docblock `:88-97`), gating three sites off one boolean. The reranker also carries a real
latency risk: `scoreBatch` recomputes document frequency *inside* the per-candidate loop, so cost
scales with candidates² — and the window just went from the caller's limit (20 by default) to
50, against a 250ms timeout. On timeout it silently returns the unranked order (a latched
warning was added, but it degrades quietly by design).

**Trigger fired 2026-08-28, and the decision was to ship both.** The flag is now on in
production. Recording what that means rather than quietly retiring the entry:

- The latency risk **did not materialise** on the 10-case probe. No `rerank declined (baseline
  outcome)` warning appeared in the logs, so the reranker completed inside its 250ms budget on
  every query. That is evidence, not a guarantee — 10 queries against one project is a narrow
  sample, and the warning is latched to once per process, so a later degradation on a busier or
  wordier corpus would log once and then go quiet.
- **The coupling is now a live liability, not a hypothetical one.** Turning off the unproven half
  currently means turning off the proven half with it. If the reranker ever misbehaves, the only
  lever available is one that also discards top-5 60% → 70% and variable share 50% → 8%.

**Revisit when:** RL-001 is decided, or at the first sign of rerank latency — whichever comes
first. Splitting the flags is the mechanism that makes RL-001 answerable without a rollback.

---

### RL-003 — The fulltext channel sends whole English questions to Lucene
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

`packages/code/src/search.ts` builds the fulltext query as `` `${escaped}*` `` — the entire
natural-language question, wildcarded. That is why single-word variables whose names collide with
ordinary English (`to`, `at`, `results`, `budget`) scored hits at all.

IDX-002A's kind prior and IDX-004's widening both *compensate* for this downstream. Neither fixes
it.

**Revisit when:** the next retrieval packet touches the fulltext channel, or if rank-1 is still
stuck at 50% after the coverage work.

---

### RL-004 — Stopword stripping makes rank-1 WORSE (negative result)
**Evidence:** measured · **Status:** closed-negative · **Opened:** 2026-08-27

A six-config sweep tested stripping stopwords from the query before the fulltext channel. It
raises coverage but **drops rank-1 from 50% to 30%** (config F). An earlier read of the same sweep
called it "promising"; that was wrong and is corrected here.

**Do not retry blind.** If it comes back, it must come back paired with something that restores
precision over the wider recall — which is exactly what IDX-004 attempted, and see RL-001 for how
well that went.

**Revisit when:** a precision mechanism is proven on code text (RL-001 resolved positively).

---

### RL-005 — The outcome probe is only 10 cases
**Evidence:** measured · **Status:** open · **Opened:** 2026-08-27

`bench/eval/outcome-cases.jsonl` is the only file-level-ground-truth probe, and it has 10 entries.
Every retrieval decision this week rests on it. At n=10 a single case is 10 percentage points, so
differences below ~2 cases cannot be distinguished from noise — which is precisely what blocked
RL-001.

Expanding it is hand-authored work (each case needs a question plus a verified source-of-truth
file), but bounded.

**Revisit when:** any retrieval change produces a delta smaller than 2 cases and the decision
matters. That has already happened once.

---

### RL-006 — The memory plane has no outcome instrument
**Evidence:** measured · **Status:** open — NEXT SPRINT · **Opened:** 2026-08-27

Code search is ~13% of measured call volume. The memory plane — `berry_context`, `berry_ask`,
`berry_load` — is the other ~87%, and **nothing measures whether it returns the right thing.**

This is the single largest gap in the program. The audit produced ~20 candidate memory-plane
defects (RL-007 through RL-011 below) that cannot be *ranked* without it, and the last four
packets have all demonstrated the same lesson: the roadmap's guess about the top defect was wrong
until something measured it.

**Revisit when:** immediately. `bench/eval/run-outcome-probe.mjs` is the template and took under a
day for the code plane.

**2026-08-29 implementation update — blind spot closed locally, live qualification pending.** The
existing outcome runner now accepts evidence-ID cases for `semantic`, `episodic`, `fact`, and
`block` while preserving the ten code cases and their file-level scoring. Five adjudicated memory
cases were derived from mined agent calls. Pre-change live baseline: Semantic n=2 Answer@5 0.5000
MRR 0.2500; Episodic n=1 Answer@5 0.0000; Fact n=1 Answer@5/MRR 1.0000; MemoryBlock n=1
Answer@5 0.0000. `mine-queries.mjs` now reads both Claude and Codex transcript shapes; the
2026-08-29 Codex fixture recovered 22 retrieval calls with session and cwd provenance. This is
local benchmark implementation and a live baseline against the deployed old server, not proof
that the candidate retrieval changes are deployed.

---

### RL-007 — `FactStore` cannot embed a Fact, and a constructor param would not change that
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

`constructor(private driver: Driver)` (`packages/neo4j/src/fact.ts:13`) does take no embedding
provider, and `new SemanticStore(driver, embedding)` at `packages/core/src/services-factory.ts:194`
really is the correct sibling to the `new FactStore(driver)` at `:175`. (The original entry put
the two ~18 lines apart, which is right; it just read as though both lived in `fact.ts`.)

**Correction, 2026-08-28 — the diagnosis holds, the SIZE was wrong.** The original framing
invited a one-line constructor change, and that change would be **completely inert**: there is no
`resolveEmbedding` on `FactStore`, `create()` persists `fact.embedding` only when a caller hands
one in (`fact.ts:88-94`) and none of the five production call sites does —
`packages/core/src/service.ts:1162`, `packages/core/src/dream.ts:228`, and
`packages/core/src/consolidation.ts:1129`, `:1135`, `:1163`. That spread is itself the argument
for putting the embed call inside `create()` rather than at the callers. `setEmbedding`
(`fact.ts:581`) has exactly one caller in the tree, a test.

**IDX-003 is the template, not the counterexample.** It is tempting to say `CodeIndexer` already
owned its write-time embed call and `FactStore` does not — that is false, and git says so.
`a1345d9` added all three parts in ONE commit: the text synthesizer `symbolVectorText`, the
`embedSymbols` write-path call and its call site, and the optional constructor param
(`packages/code/src/indexer.ts:66`). `SymbolNode` had no `content` field either
(`packages/code/src/types.ts:101-127`). The shape transfers — with one caveat that cuts AGAINST
us: IDX-003's step 1 merely extracted an expression that already ran inline for the lexical
vectors, whereas the Fact plane has no such string anywhere, so step 1 is genuinely new work
here. The three parts are:

1. A text synthesizer. `FactNode` (`packages/core/src/types.ts:361-383`) has no `content` field,
   so there is nothing to embed yet; subject + predicate + object is the Fact's text.
2. A write-path embed call in `create()`, mirroring `embedSymbols`.
3. The constructor parameter, which is what makes 1 and 2 reachable.

Plus one thing IDX-003 also needed and this entry must not forget: a backfill for the 29,314
existing nodes, since `setEmbedding` has no production caller to drive it.

**Revisit when:** RL-008 is decided. Note the asymmetry: if the Fact plane gets a reader this is
the prerequisite, but if the indexes are DROPPED this is not neutrally moot — dropping
`fact_embedding` (`packages/neo4j/src/schema.ts:69`) removes the vector index this fix exists to
fill, so the drop forecloses it rather than deferring it. Dropping `fact_content` (`:63`) does
not: it indexes the subject/predicate/object properties, and those properties — the synthesizer's
input — survive it untouched.

---

### RL-008 — The Fact plane: 0 of 29,314 embedded, and nothing reads the index
**Evidence:** measured (counts, 2026-08-27) + verified (no reader) · **Status:** decision needed

`fact_embedding` and `fact_content` are created and maintained and **no query reads them** — each
appears only in its own CREATE statement in `packages/neo4j/src/schema.ts` (`:69` and `:63`). Live
counts: 29,314 Fact nodes, **0 embedded**. Status distribution: 29,109 `tentative`, 152 `active`,
53 `invalidated`. **Re-measured on the live graph 2026-08-28: identical, to the row.**

Two consequences:
- Backfilling the embeddings would cost money for an index with no reader.
- The new coverage guard (HK-1) reported Fact as under-covered on every boot, pinning
  `status.degraded` non-empty and blunting HK-1's own signal. RL-016 fixed that on 2026-08-28, at
  the cost recorded below.

**Either build a reader or drop the index.** Doing neither is the current state and is the worst
of the three.

**2026-08-28 — this entry lost its automated reminder.** RL-016 removed Fact from the coverage
guard's label list, because a guard for indexes nobody reads was pinning `status.degraded`
permanently non-empty. That was the right call for the guard and a real cost here: nothing in the
running system will mention the Fact plane again. **This ledger entry is now the only thing
holding this decision.** If it gets closed without a decision, the Fact plane silently becomes
permanent.

**Revisit when:** RL-006 lands and can size it — or sooner, since nothing else will raise its hand.

**2026-08-29 decision update — do not add Fact embeddings yet.** Refreshed live status is 492
active, 28,924 tentative, and 54 invalidated. The new outcome set's one adjudicated Fact case is
already rank 1 through the served exact-entity channel. A read-only `fact_content` shadow query,
with no top-k before the authorized active/entity filter, also returned the same Fact at rank 1:
zero incremental Answer@1 or MRR on the evidence available. The local cleanup therefore drops
`fact_embedding`, keeps `fact_content` only for bounded shadow expansion, and does not embed the
tentative population. Revisit Fact embeddings only after additional agent-derived Fact cases expose
a paraphrase miss that lexical or exact retrieval does not close.

Exact shadow query shape: `CALL db.index.fulltext.queryNodes('fact_content', 'neuri OR located')
YIELD node, score WITH node AS f, score WHERE f.entity_id = 'ent-8ZNBr-RICORj' AND f.status =
'active' AND (f.tenant_id = 'default' OR f.tenant_id IS NULL) RETURN f.id, score ORDER BY score
DESC, f.id ASC LIMIT 10`. It returned `fact-fW6Rmp-TTMCs` first at score 4.387264251708984. The
absence of a pre-filterable authority field in the existing full-text index is why this remains a
shadow experiment rather than a production reader.

---

### RL-009 — `berry_context` / `berry_ask` discard every MemoryBlock, not every Fact
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

`memory.block` sits in `RETRIEVAL_TRACE_CHANNEL_ORDER` (`retrieval/trace.ts:97-101`) but has no
`SOURCES` spec — the spec union admits only `memory.scope` and `arch.entity`
(`retrieval/runtime-candidate-channel.ts:74`, `:132-135`) — so it falls to the `(!spec && !isFact)`
branch at `:338` and resolves to `unavailable` on every request. The 16 MemoryBlocks in the graph
are unreachable through either tool.

**Scope correction, 2026-08-28: the Fact half of this entry was wrong the day it was opened.** The
original claim was read off `parseMemoryMarkdown` (`retrieval/assembler.ts:1984-1986`, `:2016-2021`),
which skips the `Core Memory` / `Working Memory` / `Current Facts` / `Fact Timeline` aggregate
headings and emits only `source_type: 'semantic'` (`:2042`). That is the legacy path. With
`MEMBERRY_CANDIDATE_CHANNEL_V1=1` — live — both tools run through
`assembleCandidateExecution(Served)` (`retrieval/tools.ts:514-539`, `:642-668`), where `memory.fact`
is a real channel: `FactStore.getActiveByEntityIdsBatch` → `sourceType: 'fact'`
(`runtime-candidate-channel.ts:336`, `:356-358`, `:262`) → a `Facts` heading in `groupAndBudget`
(`assembler.ts:2387`). That channel returns exactly `f.status = 'active'` rows (`neo4j/fact.ts:302`),
so the **152 `active`** Facts this entry named as the real gap are precisely the ones already
reachable. The heading map has carried `fact: 'Facts'` since `46ff991` (2026-08-16), eleven days
before this entry was opened — stale is not the excuse.

This does not weaken RL-008. The fact channel reads Fact node properties by entity MATCH;
`fact_embedding` and `fact_content` still have no reader.

**Revisit when:** RL-006 lands and can size the impact, or if a user reports a block that should
have been cited and was not.

**2026-08-29 implementation update — local, not deployed.** The candidate runtime now supplies
`memory.block` from tenant/project-scoped, sessionless `core` blocks after the same sealed project
proof used by other anchored channels. Working blocks remain session-bound and are intentionally
excluded because the planner receipt carries no session authority. The aggregate candidate budget
is raised from 128 to 256 so four full real channels cannot evict a later valid settlement. The
pre-change outcome case for `project:memberry/project_state` is a measured miss; it is the biting
post-change qualification case.

---

### RL-010 — Raw episodes are injected at hard-coded confidence 1.0
**Evidence:** audit · **Status:** open · **Opened:** 2026-08-27

Raw episodes enter the candidate pool at a fixed confidence of 1.0, which outranks the
*consolidated semantics derived from those same episodes*. If true, consolidation is actively
losing to its own input — meaning the lifecycle work is being undone at retrieval time.

**Revisit when:** RL-006 lands. This is the memory-plane finding most likely to be large, and the
one most obviously unmeasurable without an instrument.

---

### RL-011 — 99.3% of Facts are `tentative`, and the pipeline that would promote them IS running
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

29,109 of 29,314. Only 152 `active`, unchanged when the graph was re-counted on 2026-08-28.

**Someone looked, 2026-08-28. The alarming half is refuted.** The promotion path is fully wired,
with no flag gating it: `buildExtractionConsumer(core)` (`packages/mcp/src/bootstrap.ts:744`) →
`packages/core/src/services-factory.ts:345` → `processExtraction` (`service.ts:1003-1008`) →
`_extractFactsOnce` → `findBySubjectPredicate` with tentative contenders surfaced
(`service.ts:1073`) → the promotable guard (`:1104`) → `await factLayer.corroborate(...)`
(`:1106`) → `SET f.status = 'active'` (`packages/neo4j/src/fact.ts:658`). That is the only
writer that TRANSITIONS a Fact to active — consolidation separately MINTS facts already active
on its auto-invalidate branch (`packages/core/src/consolidation.ts:1118`), so the 152 `active`
rows are not all corroborations. The tentative→active lifecycle is not inert, so **do not cite
this entry as evidence that it is.** One precondition, not a flag: extraction only runs when
`config.embedding.apiKey` is set (`service.ts:913`, `:1005-1006`).

What remains are four narrower defects, each of which would suppress promotion without stopping
the pipeline:

- **Raw byte equality on the object.** `existing.find(f => f.object === fi.object)`
  (`service.ts:1077`) matches the object exactly, while the predicate immediately above it is
  normalized first (`:1065`). "Cerebro" and "cerebro" never reinforce each other.
- **Corroboration needs a DISTINCT episode.** `independent` requires non-empty provenance that
  does not already contain this episode (`service.ts:1097-1099`), and deductive facts are
  promotable only when it holds (`:1100-1103`). This is OPT-70b anti-poisoning and is
  deliberate — but it means a fact restated in one episode can never promote.
- **Minting is unconditionally `tentative`** (`service.ts:1146`) and nothing revisits old facts
  proactively. There is no expiry — a later distinct episode can still promote one at any time —
  but nothing goes looking, so a fact whose corroborating episode never arrives stays tentative.
- **Subject-phrasing drift hides contenders.** `findBySubjectPredicate` resolves the subject with
  `resolveExisting` and returns `[]` when there is no match (`packages/neo4j/src/fact.ts:553-554`),
  while `create()` resolves-or-CREATES (`:23`). So a subject never strands its own prior facts —
  but a later episode phrasing the subject differently mints a fresh Entity, and the existing
  contenders become invisible to it. Weakest of the four; listed for completeness.

**MEASURED 2026-08-28, and it overturns the four defects above as an explanation.** Counts taken
read-only against the live graph:

| question | answer |
|---|---|
| tentative facts | 29,148 |
| already carrying >=2 distinct source episodes (promotable today, never promoted) | **340** |
| carrying zero provenance | 0 |
| inference_type `inductive` (excluded from `promotable` at `service.ts:1100-1103`) | 1,980 |
| duplicate groups, byte-identical subject+predicate+object | **999** (2,008 rows) |
| ...same groups once the object is case/whitespace-normalised | 1,006 (+7) |
| ...duplicate groups whose rows come from **distinct** episodes | **18** |

**The object-comparison defect is worth almost nothing.** Normalising it merges 7 groups out of
1,006 — under 1%. It is still a real inconsistency (the predicate is normalised at `:1065` and the
object is not) but fixing it will not move the corpus, and this entry should stop implying it
might.

**The corpus is not stuck on a bug. It is stuck on the bar being genuinely unmet.** 981 of the 999
duplicate groups are one episode restating itself, which OPT-70b's distinct-episode requirement
(`service.ts:1097-1099`) correctly refuses to count — that is anti-poisoning working as designed,
not a defect. The total realistically promotable population is **~358 of 29,148, about 1.2%**,
which would move active facts from 152 to roughly 510.

**ROOT CAUSE FOUND 2026-08-28, and it is none of the four above.** Splitting the corroborated
population by inference type is decisive:

| | facts | mean distinct source episodes |
|---|---|---|
| tentative `deductive` | 27,168 | **exactly 1.00** |
| tentative `inductive` | 1,980 | 1.49 |
| tentative with >=2 distinct episodes | 340 | **all 340 `inductive`** |
| active | 152 | 138 deductive, 14 inductive |

**Deductive was never broken.** A deductive fact promotes on its SECOND sighting, so a mean of
exactly 1.00 across 27,168 rows is the correct signature of claims that were only ever stated
once. That is a corpus shape, not a defect — and it is explained by history: facts accumulated for
months while the consolidation engine was not yet running.

**Inductive is where it breaks, and it breaks by construction.** `promotable`
(`packages/core/src/service.ts`) admitted only `abductive` or `deductive`. Consolidation mints
`inductive` (`packages/core/src/consolidation.ts:1119`, `:1156`), so the engine's own output could accumulate
corroboration forever and never become servable. Every one of the 340 corroborated-but-stuck facts
is exactly that.

**The exclusion existed for a real reason, and that reason was fixable.** `corroborate`
(`packages/neo4j/src/fact.ts`) welded two operations together: `SET f.status = 'active'` AND
`f.inference_type = 'deductive'`. Relabelling a generalization to deductive would destroy its
provenance — the code comment says so — so instead of separating the two, inductive was barred
from promoting at all. Splitting them (inference type is now an argument, defaulting to
`'deductive'`) lets a generalization be confirmed as a generalization.

**TWIN ROOT CAUSE FOUND AND FIXED 2026-08-28.** Consolidation called
`findBySubjectPredicate(subject, predicate)` with two arguments. That lookup is **active-only by
default** (`packages/neo4j/src/fact.ts:564`), and its own comment named the caller it was
protecting: *"Default = active-only — byte-identical for every existing caller (e.g.
consolidation)."* So a TENTATIVE deductive fact minted by extraction was invisible to
consolidation, which fell through and minted an inductive twin of a claim already in the graph.
Backward compatibility that was safe until the engine began running at volume.

**The naive fix would have been worse than the bug.** Simply passing `includeTentative` feeds
tentative rows into the same `existing[0]` head-grab that drives the OPT-31 contradiction gate.
Tentative facts sit at 0.5 against a 0.75 protect threshold, so `autoInvalidate` evaluates true
almost every time — it would invalidate the very corroboration pool extraction depends on and
write the contender ACTIVE. Verified on the real code: the pre-fix path does invalidate a tentative
fact, and a test now pins that it must not.

**Shipped shape:** opt in, then split the result the way the extraction path already does —
`reinforcing` matches ANY status and decides dedup; `current` requires `status === 'active'` and
decides the contradiction. `current` is active by construction, so invalidating a tentative row,
mis-gating OPT-31 and superseding a tentative fact are all structurally unreachable rather than
merely unlikely. The `valid_at DESC` ordering hazard disappears because nothing reads the head any
more.

`dream.ts` carried the same two-arg blindness in its dedup guard and is fixed with it. That guard
only ever SKIPS a create, so seeing more facts can only mean writing less.

**Two further misses in the same family, deliberately NOT in that diff, each with its own blast
radius:** consolidation passes no tenant, so on a non-default tenant it could not see extraction's
facts at all (**correction 2026-08-28: this did NOT contribute to the measured duplicates** — the
`includeTentative` fix stopped them while that call still passes `undefined` as its tenant, and
every row in the graph is `default`; see RL-019); and it stores the RAW predicate while extraction
stores `normalizePredicate(...)`, so predicates where normalization is not the identity (for example
`depends_on` to `uses`) miss on the predicate too. The measured 999 byte-identical groups are
necessarily predicates where normalization is the identity.

**Forward-looking only.** This stops NEW twins; the 2,008 existing duplicate rows are untouched and
merging them is a separate pass.

**Also explains the August duplicate spike.** 985 of the 999 duplicate groups are one `deductive`
+ one `inductive` twin of the same claim. The inductive twin absorbs the corroboration and cannot
use it; the deductive twin stays at one episode. All 2,008 duplicate rows are August-only — 26% of
this month's fact writes — which is when the engine started running.

**Fixed forward, NOT backfilled.** The mechanism now promotes inductive facts on distinct-episode
corroboration, with the OPT-70b independence bar untouched. The existing 340 stay tentative until
something restates them; realising that population needs a separate sweep, which mutates the live
graph and is therefore an owner decision.

**So the remaining open question is a product decision, not a repair:** should a claim seen once, in one
episode, ever be servable? Today it is not, and 99% of the fact corpus is exactly that. Answering
"no" means the Fact plane is permanently a ~500-row store and should be sized accordingly.
Answering "yes" means changing what corroboration is for, which is a deliberate weakening of an
anti-poisoning gate and needs a security read.

**This also re-sizes RL-008.** Any fact reader — `fact_content` or `fact_embedding` — serves the
`status = 'active'` population only (`neo4j/fact.ts:302`, `mcp/tools.ts:810`). That is 152 rows
now and ~510 after the most optimistic sweep. Indexing is not the fact plane's bottleneck and
building readers first would be building over 1.7% of the data.

**Revisit when:** RL-006 lands and can size which of the four actually accounts for the 29,109 —
or sooner for the object-normalization one, which is a one-line change with an a-priori
justification and needs no measurement. Loosening it touches an anti-poisoning gate, so it
wants a security read.

---

### RL-019 — the tenant gap is in the Cypher, not in the plumbing
**Evidence:** verified (2026-08-28) · **Status:** open — decision needed before a 2nd tenant

Consolidation and dream call tenant-aware methods without a tenant, and the obvious reading is
"plumb the tenant through". Three designs were costed — pass it at the known sites, make
`tenantId` required across the ~110 optional signatures, or bind it at store construction. **All
three were rejected, and the reason is the finding.**

**SCOPED DOWN 2026-08-29 — the original wording overstated this. There is no data leak.**
Measured on the live graph: Entity nodes hold exactly `type`, `id`, `created_at`, `name`,
`aliases` — **no content** — and 15,647 of 15,647 carry no `tenant_id`, because the schema never
defines one and nothing writes one. Entities are a deliberately SHARED namespace; `tenant.ts`'s
own header calls this "logical (shared-graph) multi-tenancy". Every node that holds actual
content — Fact, Semantic, Episodic, MemoryBlock — IS tenant-filtered.

So the "tenant-blind queries" below are blind because their subject has no tenant to be blind
about. A second tenant resolving a name reaches the same Entity node and then gets none of the
first tenant's facts. **The residual exposure is name ENUMERATION, not data**: a tenant could learn
that an entity name exists. Real, bounded, and only once a second tenant exists — there is none
today.

Closing even that is a DATA MODEL change, not a query fix: stamp `tenant_id` on Entity, filter the
resolver, migrate 15,647 nodes. It also disappears entirely under database- or instance-per-tenant
isolation, which is the strongest argument for settling the isolation model before touching any of
this.

The original point still stands as written, just at a lower severity:
**binding or requiring a tenant makes it AVAILABLE. It does not make any Cypher USE it.**
`packages/neo4j/src/entity-resolver.ts` contains **8 `.run()` calls and zero occurrences of the
string "tenant"** — e.g. `MATCH (e:Entity {name: $text})`. `FactStore.create` calls
`this.resolver.resolve(...)` inside its write transaction, so a perfectly tenant-bound `FactStore`
still resolves subjects against a tenant-blind Entity graph. Counting the same way across
`packages/neo4j/src`, roughly **19 queries carry no tenant predicate at all**
(`entity-resolver.ts`, `provenance.ts`, `entity.ts`, `audit.ts`, `gds.ts`, `temporal-edges.ts`).
A signature change converts an omission at the call site into an omission inside the query body,
where nothing checks it.

**Three further findings that kill the cheap options:**

- The consolidation tenant field (`core/consolidation.ts:375`) is **dead in production** — both
  constructions (`mcp/bootstrap.ts:317`, `:667`) omit it — and the default wiring adapter at
  `bootstrap.ts:329` is a two-parameter lambda that **silently discards** the engine's tenant and
  substitutes `DEFAULT_TENANT`. Passing the tenant two lines earlier changes nothing while that
  adapter stands. (`:680`, the dedicated-tenant one, correctly closes over `tenant`.)
- Dream has **no tenant in scope at any level** — not on `DreamEngineDeps`, not on `CoreServices`,
  not on `AMPConfig`. The tenant is resolved per request from a bearer token, and dream is a
  process-lifetime singleton on a timer. That is structural, not an oversight. Its WRITE is
  untenanted too (`dream.ts` `toAbductiveFact` stamps no `tenant_id`), so fixing only the reads
  produces a half-tenanted module — a worse state to hand the next reader than a uniformly
  untenanted one.
- Requiring the parameter forces `this.tenantId ?? DEFAULT_TENANT` at call sites: identical wrong
  behaviour, now compile-clean and laundered past the type checker. It also cannot be enforced by
  tests — all ten package tsconfigs exclude `src/__tests__` and there is no vitest typecheck, so
  the doubles are never type-checked at all.

**Zero behavioural change today, by construction.** `resolveTenant(undefined)` and
`resolveTenant('default')` both return `DEFAULT_TENANT`, and `tenantWhere` emits identical Cypher
for it. Every row in the live graph is `default`. All three options are insurance, not repairs.

**The one cheap thing worth doing:** `resolveTenant` (`packages/neo4j/src/tenant.ts`) is a single
chokepoint with 37 production call sites. A strict mode there — loud in dev/test, unchanged in
production — makes an omitted tenant visible instead of silently becoming `default`. About five
lines in one file, and it is useful whichever way the isolation question goes.

**Revisit when:** before a second tenant exists, and BEFORE any tenant-isolation design is chosen.
If the answer turns out to be a database or instance per tenant, most of the plumbing question
disappears and the 19 tenant-blind queries stop mattering — which is itself an argument for
deciding isolation first and plumbing second.

---

### RL-021 — memory candidate selection on the live anchored path ignores the question entirely
**Evidence:** verified in source (2026-08-29) · **Status:** open · **Opened:** 2026-08-29

With `MEMBERRY_QUERY_PLANNER_V1` + `MEMBERRY_CANDIDATE_CHANNEL_V1` live, a `berry_context` or
`berry_ask` call that names an entity runs through `RuntimeCandidateChannelService`. Its `SOURCES`
list (`packages/retrieval/src/runtime-candidate-channel.ts:132-135`) holds two entries, and a
third channel is special-cased outside it (see the correction at the end of this entry):

- `memory.scope` — `SCOPE_QUERY` (`:111-123`), every non-archived in-scope Semantic ABOUT the one
  resolved entity, `ORDER BY coalesce(s.confidence, 0.0)`.
- `arch.entity` — `ARCH_QUERY` (`:126-131`), with a hardcoded `1.0 AS score`.

Every other channel — `memory.semantic-vector`, `memory.episodic-vector`, `memory.graph`,
`memory.block` — is hardwired to `failure(channel, 'unavailable')` at `:339`. **The query text
appears nowhere in that file, and no embedding is computed or read.** Candidate SELECTION on the
live anchored path is therefore query-blind: it returns the entity's highest-confidence memories
regardless of what was asked. Only the downstream reranker ever reads the question. Episodic nodes
cannot appear at all, so a freshly stored episode is unreachable on this path.

Three consequences verified in the same file and its neighbours:

1. **The 65-row cliff.** `:368` requests `rowLimit: MAX_ROWS + 1` and `:210` throws
   `budget-exceeded` on `records.length > MAX_ROWS` (`MAX_ROWS = 64`, `:39`). An entity with 65 or
   more in-scope semantics contributes **zero** memory candidates rather than its top 64 — the
   overflow probe is correct, the reaction to it is not. It bites the best-documented entities
   hardest, which is exactly backwards.
2. **Arch outranks memory by construction.** `arch.entity`'s hardcoded `1.0` is read downstream as
   a provenance confidence. The highest value ever *assigned* to a memory is
   `APPROVED_DECISION_CONFIDENCE = 0.9` (`core/consolidation.ts:39`), so an arch stub always sorts
   above an approved decision. Compare RL-010, which was the same defect with episodes at 1.0.
3. **The reranker's declared 15% baseline blend is ~1%.** `assembler.ts:468`/`:693` call
   `rrfFusion` with `collectionSize` undefined, so `fusion.ts:120` never normalises and
   `baselineScore` stays a raw RRF sum in roughly [0, 0.085]. The 0.15-weighted term spans about
   0.013 of a 1.0 range. The local reranker is not blended with retrieval score; it is effectively
   the entire ranker.

**Not the same as RL-002.** RL-002 is about how the ranked path *weights* signals. This is that the
anchored path has no relevance signal to weight.

**Scope note.** This is the anchored path only. Unanchored requests take the task-text path (RL-018)
which does run the vector channels — so as of RL-018 the tool is, counter-intuitively, more
query-aware when you tell it LESS.

**Separately, and cheap:** `arch.fulltext` on the legacy path reports `outcome: "success"` while
returning nothing for every Entity nobody ran `berry_arch_register` against, because its index
covers only hand-written fields (`packages/arch/src/schema.ts:19`). A silent ingestion gap of
exactly the class COD-010 added fail-loud status for on the code plane.

**CORRECTED 2026-08-29, same day, before anyone acted on it. Two errors, both mine.**

**Error 1 — there are THREE live channels, not two.** `SOURCES` holds two specs, but `memory.fact`
is special-cased outside it at `:336` (`const isFact = channel === 'memory.fact'`) and runs via
`FactStore.getActiveByEntityIdsBatch` (`:255`, `:352-358`). The channel-enable test at `:337` is
`(spec || isFact)`. "Exactly two entries in SOURCES" is true; "only two channels run" is not.
`memory.fact` is query-blind in the same way — it fetches the entity's active facts — so the
finding's direction survives, but the count was wrong.

**Error 2 — and this one matters more — "query-blind" describes SELECTION only, and the practical
cost is bounded by the cap, not unbounded.** Selection is genuinely query-independent. But the
served reranker downstream DOES read the question, and per point 3 above it is effectively the
entire ranker. So when an entity has FEWER in-scope semantics than `MAX_ROWS`, every one of them
becomes a candidate, the reranker sees the whole set, and the answer is question-sensitive after
all. Blind selection of a set that is not truncated costs nothing.

**Measured live, which is how the error was caught.** Entity `memberry` has 57 attached semantics
(57 < 64). Two unrelated questions — "How does tenant isolation work in the Neo4j Cypher queries"
and "What are the token budget and reasoning level cost tradeoffs" — returned **12 vs 14 sources
with substantially different content**. Entity `bench`, which has only 2, returned byte-identical
results for the same two questions, which is what having no choice looks like.

**So where does it actually bite?** Three places, all still real:

1. **At 65 or more, you get nothing.** The cliff (point 1) is the severe case, and it is severe
   precisely because selection is blind: there is no principled top-64 to fall back to, so the
   channel discards everything. It punishes the best-documented entities hardest.
2. **Episodic memory is unreachable on this path at any count.** `memory.episodic-vector`,
   `memory.graph` and `memory.block` are hardwired `unavailable`, and no source spec returns
   Episodic nodes. A freshly stored episode cannot be retrieved by an anchored call, ever —
   independent of how many semantics the entity has.
3. **Nothing is reachable by MEANING unless it is already filed `ABOUT` that entity.** A semantic
   that answers the question perfectly but hangs off a different entity is invisible, because the
   only lookup is a graph edge, not a similarity search.

**The original framing here — "the tool ignores your question" — was wrong and is withdrawn.** It
generalised a source read into a behavioural claim without probing the behaviour, which is the
same mistake as the "zero sources" caveat corrected above, made twice in one day on the same
entry. The accurate claim is narrower and still worth fixing: selection is blind, which is free
under the cap, catastrophic at the cap, and permanently excludes episodes and meaning-based recall.

**Not yet measured against answer quality.** The probes above show the pipeline is question-
sensitive; they say nothing about whether the answers are GOOD. EVAL-001 cannot measure this:
of its nine questions, only `eval001-d-07` calls `berry_context` with an `entity_scope`, and that
question's mined `originalInput` sets `include_memory: false`. A perfect memory-selection change
therefore produces zero EVAL-001 delta. Anchored memory questions need their own blind-authored
instrument; re-pinning EVAL-001 is not a substitute.

---

### RL-022 — anchored Entity reachability is poor; agent-weighted impact was not yet observable
**Evidence:** measured live (2026-08-29) · **Status:** compatibility fix and agent-first measurement prepared; topology repair open · **Opened:** 2026-08-29

The resolver concern flagged by RL-021's handoff is confirmed, but it is two failures rather than
one. The measured population was every live Entity with at least one incoming Semantic `ABOUT`
edge: 27 exact names. Each was then sent through the public `berry_context` path with
`project_name: "project:memberry"`, its exact name as the sole `entity_scope`, memory/code off,
and architecture on so successful resolution still exercised a real provider.

| public outcome | count | share |
|---|---:|---:|
| resolved | 7 | 25.9% |
| `runtime_query_planner:resolution_failed` | 14 | 51.9% |
| `runtime_query_planner:invalid_request` | 6 | 22.2% |
| **failed before an answer** | **20** | **74.1%** |

**Scope correction (owner-confirmed): this is not a user-impact rate.** MemBerry is consumed
primarily by agents; people very rarely query it directly. The 27-name population above is an
unweighted graph census, not a sample of production agent calls. The checked-in mined snapshot is
also insufficient to estimate agent failure: it has only 13 `berry_context` calls from one session,
mostly deliberate engineering probes; five are unanchored (four omit `entity_scope`, one supplies
an empty array) and eight supply an Entity. It is useful for request-shape regression tests, not a
production miss-rate denominator.

The correct active proxy is now prepared locally: content-free process-lifetime counters record
`berry_context` versus `berry_ask`, unanchored versus anchored routing, and the planner's closed
resolution outcome classes. Authenticated `/readyz` exposes the aggregate with explicit
`caller_type_known:false`, `content_captured:false`, and `identity_captured:false`; no task text,
Entity/project name, tenant, actor, or session is retained. This measures real MCP traffic after
deployment while honestly acknowledging that the server cannot distinguish an agent from a human.

The project guidance itself is a stronger agent-facing control. A new read-only audit,
`scripts/audit-agent-entity-resolution.mjs`, parses configured Entity names and applies the real
tenant/project containment boundary without graph mutation. Against live default-tenant data it
reported exactly **1/12 resolvable, 2/12 uncontained, 9/12 missing, 0 ambiguous**. That is a
configuration/topology defect in the names agents are instructed to use, independent of direct
human querying. The script has an optional `--fail-on-drift` gate and prints no credentials or
memory content.

**Failure 1 — graph authority and memory filing disagree.** Direct Neo4j classification found
12 of the 27 memory-bearing Entities reachable from canonical project Entity
`Y-GCkJYdEeWm38j_HI1XX` by `CONTAINS*0..64`, and 15 outside it. Fourteen of those 15 produced
`resolution_failed`; the remaining outside Entity has a spaced name and hit Failure 2 first.
This is expected resolver behavior against inconsistent topology, not fuzzy matching: the resolver
starts from an authorized project root (`scoped-entity-resolver.ts:304-317`) while a Semantic can
be filed `ABOUT` any Entity.

The repository guidance makes the drift more concrete. Of its 12 declared canonical Entity names,
only `memberry` resolves. `mcp-server` and `wiki-compiler` exist but are outside the project
containment tree; the other nine do not exist by exact case-folded name. No graph repair was run:
creating or relinking those nodes is shared live-data mutation and needs a tenant-aware migration,
especially while RL-019's entity namespace decision remains open.

**Failure 2 — valid Entity display names containing spaces are rejected before resolution.** All
six spaced names returned `invalid_request`; five are already correctly contained and therefore
would otherwise resolve: `Call Context Resolver`, `Electron Renderer`, `Review-first Validator`,
`SOP lifecycle`, and `Submission Builder`. The cause is the duplicated
`SAFE_HINT = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/` gate in
`runtime-query-planner.ts` and `query-plan.ts`. The values are non-authoritative, bounded Entity
name hints and are passed to Neo4j as parameters, but the identifier-only charset excluded a form
the graph and public Entity URI already support.

A narrow working-tree fix permits internal ASCII spaces only for task-derived Entity-name hints.
Authority, repository, symbol, canonical ID, and project validators remain unchanged; leading or
trailing whitespace, controls, reserved `project:`/`tenant:` prefixes, and injection characters
still fail closed. Cerebro verification at exact base `618af4d`: retrieval TypeScript build passed;
full package suite **874 passed / 7 skipped**; focused planner/contract/tool path **111/111** passed
across ordinary/traced `berry_context` and `berry_ask`.

Agent-first observability verification at the same exact base plus this working-tree diff: full
monorepo TypeScript build passed; retrieval **876 passed / 7 skipped** and MCP **340 passed / 9
skipped**. The focused changed-path suites also passed **143/143**. The read-only audit reproduced
the 1 resolvable / 2 uncontained / 9 missing guidance result against Cerebro.

**RL-021 severity correction.** The real `SCOPE_QUERY` filters were reproduced across every
project/Entity pair in the deployed graph: tenant ownership, canonical project scope or tag,
non-archived Semantic, current `ABOUT` edge, and exactly one authorized containment path. The
maximum is **57**, across 17 pairs, and **zero are at 65 or above**. The row cliff is a real latent
class bug, not an active deployed loss. Entity reachability is the active problem and should stay
ahead of Phase 1a until topology coverage improves.

**Revisit when:** land and deploy the compatibility/measurement slice, collect a representative
window of real MCP outcome counters, then prepare an ID-based repair manifest from the dry-run
report. Do not repair the live graph by name with `BootstrapGraphService` while RL-019 is undecided:
its current entity and parent lookups are global name matches (`bootstrap-graph.ts:95-132`).

### RL-020 — a dirty worktree fails the RET-010 custody tests, and the failure is unreadable
**Evidence:** demonstrated (2026-08-29) · **Status:** mitigated in the harness · **Opened:** 2026-08-29

`bench/lab/ret010/dev-gate.cjs` `pinPaths()` and `auditPinnedPaths()` both open with

    git rev-parse HEAD != head  ||  git status --porcelain=v1 --untracked-files=all != ''  ->  reject()

so the finalizer refuses to pin sources it cannot prove match HEAD. That is the custody guarantee
and it is correct. The problem is the *shape* of the refusal: it rejects before opening a single
file handle, so the test that counts handles reports `expected [] to have a length of 62 but got
+0` — which reads as a product defect and is really one stray edited file anywhere in the tree.

**Demonstrated, not inferred.** On a clean worktree the test passes; appending a single comment
line to an unrelated source file (`packages/neo4j/src/tenant.ts`) flips it to failing; `git
checkout --` flips it straight back.

**How it was found, which is the part worth keeping.** It surfaced as a lab failure on the RL-018
branch, and a first comparison — master passes, branch fails — pointed straight at the change.
That comparison was invalid: the branch checkout carried leftover uncommitted edits from an
earlier session, so the variable under test was tree cleanliness, not the diff. **`git clean -fd`
is not enough to prevent this** — it removes untracked files but leaves modified tracked ones,
which is exactly the state that bites.

**Distinct from RL-017.** RL-017 is a spawn timeout under load, affects a different test in each
Node arm, and is load-dependent. This one is deterministic, reproduces in under a second, and has
a named cause in the source. Two different known-red modes in the same file.

**Together they explain the "one stable known-red test", and removing both makes the lab green.**
Measured 2026-08-29, node:22, clean worktree, no competing gate run: `LAB_EXIT=0`,
`Test Files 68 passed (68)`, `Tests 2117 passed (2117)`. The lab is not unconditionally red. The
count looked stable at one because two independent causes were running together — RL-017 supplying
a moving identity under load, RL-020 supplying a fixed one whenever the tree was dirty.

**The stale expectation was propagated in two places and both are corrected.** `scripts/gate.sh`
and `.claude/agents/verifier.md` both instructed the reader that `LAB_EXIT=1` with one failure was
the expected steady state. That is withdrawn: budgeting for a failure in advance is how a real
regression gets waved through. Both now say expect zero, and both say to check tree cleanliness
and concurrent runs before blaming a diff.

**Mitigation:** `scripts/gate.sh` now runs `git status --porcelain=v1 --untracked-files=all`
before the container starts and prints the offending paths with an explicit warning that the
resulting failure is not a product defect. It warns rather than refuses, because gating a
work-in-progress tree is otherwise legitimate.

### RL-018 — `berry_context` rejects a real call that names no entities
**Evidence:** measured (2026-08-28) · **Status:** FIXED (2026-08-29) · **Opened:** 2026-08-28

`eval001-d-08` is a real mined `berry_context` call — `task`, `project_name`, `include_code`,
`include_memory`, `strategy`, `max_tokens`, and no `entity_scope`. The runtime query planner
rejects it with `runtime_query_planner:invalid_request`
(`packages/retrieval/src/runtime-query-planner.ts`: the input must carry an `entityScope` key, and
the hint snapshot requires a non-empty array). `packages/retrieval/src/tools.ts` swallows the
throw to `null` on one path, so it degrades quietly.

**It is not an edge case.** It is 1 of the 2 surviving `berry_context` questions in EVAL-001, so
half that tool's coverage scores as `nonRetrieval` rather than as a number — the same failure at
the origin on 2026-08-27 and again on the post-deploy run on 2026-08-28. Of the mined real
`berry_context` calls, 5 of 13 carried no `entity_scope`.

An agent asking a scoped question without naming entities is ordinary usage, not malformed input.
Every such call is currently unanswerable.

**CORRECTED 2026-08-28 after a security review of the obvious fix — it is not a validation bug.**
Accepting an empty entity scope in `snapshotEntityHints` **does not fix this**; it only renames the
error. Verified chain: empty hints leave `canonicalEntityIds` empty
(`packages/retrieval/src/scoped-entity-resolver.ts:888-895`, which is length-guarded and fails
CLOSED to `not-found` + `entity_not_found` — it never issues an unfiltered query), and
`exactResolvedEntityId` (`runtime-query-planner.ts:173-194`) demands zero diagnostics,
`state === 'resolved'` and exactly ONE canonical id. So the call still fails, as
`resolution_failed` instead of `invalid_request`, and still scores `nonRetrieval`.

**The real constraint is architectural.** `berry_context` under `MEMBERRY_CANDIDATE_CHANNEL_V1`
(live) is anchored on a single resolved entity by construction —
`runtime-candidate-channel.ts:328` pins `resolvedEntityIds: Object.freeze([state.resolvedEntityId])`
and every channel query is parameterised on it. **There is no task-text mode.** The legacy path
does have one (`tools.ts` ends with `assembler.assemble(args.task, runtimeOptions)`, and
`resolvedEntityIds === undefined` is an already-supported shape), but it too calls
`resolveRuntimeEntityIds`, which returns `Promise<readonly [string]>` and throws rather than
yielding nothing.

So `berry_context` can only answer questions that NAME an entity. Everything else is unanswerable
on both paths. Note the second edge of this: when entities ARE supplied, the resolved-id lane
disables the episodic vector channel (`core/service.ts:1284-1291`), so the tool is constrained
either way.

**FIXED 2026-08-29 — routed, not accepted (PR #130).** The constraint is real and was left intact:
the candidate channel is still anchored on exactly one resolved entity, and `snapshotEntityHints`
still rejects an empty scope. What changed is which path answers. One predicate, `plannerAnchored`,
gates the four sites where `berry_context` and `berry_ask` enter the planner; a request supplying
neither an entity anchor nor a project takes the task-text path instead.

That path is not a degraded mode. It is the same path both tools take with the planner flag off, it
still honours `entity_scope` and `project_name` as ordinary filters, and it KEEPS the episodic
vector channel the resolved-id lane disables — so it repairs the second edge noted above rather
than inheriting it.

**Absent, never invalid.** Only shapes the planner could never have accepted are routed. A supplied
but malformed `entity_scope` or `project_name` still reaches the planner and still fails
`invalid_request`; an entity that simply does not resolve still fails `resolution_failed`. Naming
something that is not there is a real answer, and must never widen into a broad sweep.

**Wider than the entry said.** The measured shape counts are 13 real mined `berry_context` calls,
of which 5 are unanchored: 4 carry a project but no entities, 1 carries neither. `berry_ask` shares
the constraint verbatim and was fixed in the same change; the original entry named only
`berry_context`.

**One hole found during the fix, by the gate.** The first cut routed unanchored requests past the
planner — and the planner is where `authenticated` is checked, so omitting `entity_scope` bought an
answer without authenticating. Caught by the two authentication-first precedence pins in
`tools.test.ts`, both of which send an unanchored `{ task: 'blocked' }`. Anchoring decides WHICH
path answers, never WHETHER the caller may ask; the gate now runs before the routing branch
whenever either switch is on. Pinned in `tools.unanchored-routing.test.ts`, which the first 12
tests had missed because every one of them authenticated.

**Verified:** 15 tests across both tools and all four unanchored shapes. Checked that they bite —
with the four `&& plannerAnchored(args)` guards removed, 8 of 12 failed with exactly
`RuntimeQueryPlannerError: runtime_query_planner:invalid_request`, the original defect, while the
loud-failure guards kept passing.

**Unblocks the EVAL-001 re-pin.** `eval001-d-08` and the pending `eval001-d-04` were both this
shape, so half of `berry_context`'s coverage was scoring `nonRetrieval` rather than a number.

**VERIFIED LIVE 2026-08-29** against the deployed server at master `2cf8261`, flags
`QUERY_PLANNER_V1,CANDIDATE_CHANNEL_V1,RERANKER_V1=served,KIND_RANK_V1,CODE_SCOPE_V2,CODE_RERANK_V1`
— the exact configuration in which the defect bit:

| request shape | before | after (measured) |
|---|---|---|
| `task` + `project_name`, no entities (`eval001-d-08`) | `invalid_request` | 21 IDs, `Code: served (20 of 20)` |
| `task` only | `invalid_request` | 21-23 IDs, `Code: served (20 of 20)` — see correction |
| `berry_ask` + `project_name`, no entities | `invalid_request` | cited synthesis, 23 evidence items |
| `task` + project + resolvable entity | candidate channel | unchanged, candidate channel |
| `task` + project + unresolvable entity | `resolution_failed` | `resolution_failed` — still loud |

The first row also confirms the predicted second effect: the task-text path **served the code
plane** (20 of 20), which the candidate channel marks `unsupported / candidate-channel` for the
same request. The answer is richer, not merely non-failing.

**CORRECTION 2026-08-29 — the "zero sources" caveat first written here was wrong.** It read: "the
no-project-no-entity shape now returns a well-formed context with zero sources". That generalised
from a single probe which had passed `include_code: false`, so it measured an arch-plus-memory call
for one query, not the shape. Re-probed live: a task-only `berry_context` with the default
`include_code` returns **21-23 IDs with `Code: served (20 of 20)`**, including foreign-project
symbols that the project-scoped call correctly excludes. A missing project WIDENS every channel —
memory tags (`assembler.ts:1041`, `:2058-2076`), the code layer's path filter (`:1121`), the arch
fulltext channel (`:1500-1508`, `$projectName IS NULL OR ...`), `byScope`'s no-filter branch
(`neo4j/query.ts:369`) — it narrows nothing. Row 2 of the table above is amended accordingly.

Two real things were behind the bad probe and neither is a routing defect:
- The `arch.fulltext` discovery channel returns nothing for Entities nobody hand-enriched. Its
  index `entity_arch_content` covers only `responsibility`, `interface_desc`, `internals`
  (`packages/arch/src/schema.ts:19`), whose sole production writer is the manual
  `berry_arch_register` (`packages/arch/src/tools.ts:155-164`); `berry_bootstrap` writes
  `e.description`, which is not indexed (`core/bootstrap-graph.ts:290-292`). It reports that as
  `outcome: "success"`. An ingestion gap reported as a clean run — see RL-021.
- A missing project drops core/working memory blocks, undisclosed. The one place absence really
  does narrow.

**The lesson is the generalisation, not the typo.** One probe, one query, one flag set, written up
as a property of a request SHAPE. The row that says a shape returns nothing must come from probing
that shape, not from one call that resembles it.

**For the record, the hint relaxation is safe, just insufficient.** Entity hints are explicitly
non-authoritative (`query-plan.ts:65-71`), the contract already accepts `minItems: 0`, and the
sibling hint kinds `repositories` and `symbols` plus `callerScopes.entities` are hardcoded empty on
every production call. An existing test pins the `>= 1` bound
(`runtime-query-planner.test.ts:36`), grouped with genuinely hostile cases.

**Revisit when:** the owner decides the routing question, because it is a product decision rather
than a repair — should an entity-less `berry_context` call be routed to the legacy task-text path
(an answer, from a supported but different engine, with no candidate channel), or rejected loudly
at the tool boundary (no answer, but an honest one instead of a generic planner failure)? Doing
neither leaves 5 of 13 mined real calls unanswerable.

---

### RL-012 — 5,136 symbols are unreachable by any scoped search
**Evidence:** measured (2026-08-27) · **Status:** decision needed · **Opened:** 2026-08-27

Symbols with `project_tag = NULL`. IDX-002B's scope fix means no scoped search can ever return
them; the audit found them to be foreign or stale, none belonging to a live project.

They were embedded anyway on 2026-08-27 — deliberately, and the reasoning is worth keeping: the
alternative was either an arbitrary coverage threshold or an unattended destructive delete. Cost
was about half a cent, and it left this decision open rather than making it silently.

**They remain a deletion candidate.** Deleting them would also let the HK-1 coverage floor tighten.

**Confirmed 2026-08-28:** all 5,136 are still present and still embedded. The graph now holds
54,314 symbols at 100% coverage across all five tag buckets, so no coverage number will surface
them again. The deletion call has not been made.

**Revisit when:** someone is willing to make a destructive call on the graph, or before the next
index-wide operation.

---

### RL-013 — Two Symbol indexes are maintained on every write and queried by nothing
**Evidence:** verified · **Status:** open · **Opened:** 2026-08-27

`symbol_mini` (`code/schema.ts:30`) has no reader: `mini_vector` is written on every symbol at
`code/indexer.ts:87` and queried nowhere. `symbol_content_hash` (`code/schema.ts:16`) has no reader
either — nothing in the repo puts a predicate on `s.content_hash`. The one query that returns it
(`symbol-store.ts:370`) seeks on `symbol_file_path` and projects the hash out; the comparison then
happens in JS at `indexer.ts:216`. A property index serves predicates, and there is no predicate.
Two properties cost the same way with no index at all — `sparse_indices` / `sparse_values`
(`code/indexer.ts:225-226`). This is a write-amplification and storage cost, not a correctness
problem — which is why it keeps losing to capability work.

**Correction, 2026-08-28.** This entry opened claiming seven unread indexes and named the
4096-slot lexical vector as the most expensive of them. Both halves were wrong when it was written,
not stale, and the second is the dangerous one: acting on it would have deleted a live retrieval
channel. `packages/code/src/schema.ts` declares thirteen Symbol indexes — nine property (`:11-21`),
one fulltext (`:23-25`), three vector (`:27-31`) — and eleven are reachable: `symbol_search`,
`symbol_embedding` and `symbol_lexical` by the search channels (`code/search.ts:496`, `:547`,
`:604`), `symbol_name_file_kind` by `findByCompositeKey` (`code/symbol-store.ts:192-204`), the rest
by the language, kind and scope filters (`search.ts:476`, `:489`, `:786-812`). The lexical vector
is also **dense**, not sparse — `Float64Array(4096)` at `code/vectors.ts:68-70` — and
`symbol_lexical` is queried by `lexicalVectorSearch` (`search.ts:604`) as an ungated arm of the
4-way fan-out in `searchStandard` (`search.ts:270`, `:278-291`); only the semantic arm is flagged.
It has been read since the package landed in `195c5f0`.

**Revisit when:** write latency or graph size becomes a complaint, or during any index cleanup.
Pair it with RL-012, which is the same kind of housekeeping.

**2026-08-29 implementation update — local, reversible, not deployed.** New Symbol writes retain
only the served dense embedding and 4096-slot lexical vector; they stop generating or persisting
`mini_vector`, `sparse_indices`, and `sparse_values`. Migration
`0010-prune-unserved-derived-indexes` drops `symbol_mini`, `symbol_content_hash`,
`semantic_content`, `episodic_content`, `aspect_content`, and `fact_embedding` with `IF EXISTS`.
It removes no stored properties, so rolling back the code/schema recreates the indexes and resumes
the old writers. Migration 0010 also carries an explicit `down()` that recreates all six indexes
with `IF NOT EXISTS`; this is required because the core schema is not reinitialized by a simple
binary rollback after the migration record advances. `fact_content` is intentionally retained for
the bounded shadow experiment.

---

### RL-014 — `Semantic.status` is NULL on all 194 nodes
**Evidence:** measured (2026-08-27) + verified (lifecycle) · **Status:** open · **Opened:** 2026-08-27

The field exists and nothing sets it — there is no `status` on `SemanticNode`
(`core/types.ts:39-58`) and zero matches for it in `packages/neo4j/src/semantic.ts`. Facts carry a
real status distribution; Semantics carry none. Re-measured 2026-08-28: still 194 nodes, still NULL
on all 194.

**Scope correction, 2026-08-28.** This entry concluded there was no way to mark a semantic memory
deferred, superseded or retired. Two of the three ship today. **Superseded:** the `SUPERSEDES` edge,
written at `neo4j/semantic.ts:272` and read back by the provenance chain (`neo4j/provenance.ts:18`,
`:45`). **Retired:** the reversible `archived` flag (`core/types.ts:57`), set by the lifecycle
service (`core/lifecycle.ts:467` → `neo4j/lifecycle.ts:351`) and enforced across the read paths by
`archivedWhere` (`neo4j/query.ts:60-62`), with `MEMBERRY_LIFECYCLE_V1` live. Only **deferred** has
no mechanism at all. What is missing is a status vocabulary on Semantic, not a lifecycle — a
narrower prerequisite for RL-015 than this entry was written as, and still part of why this ledger
is a markdown file instead of living in MemBerry itself.

**Revisit when:** before attempting to migrate this ledger into MemBerry (RL-015), or when
lifecycle work next touches Semantic nodes.

---

### RL-015 — Move this ledger into MemBerry
**Evidence:** hypothesis · **Status:** open · **Opened:** 2026-08-27

MemBerry is a memory system for durable project context, and its own project context is tracked in
a flat file. That is worth fixing once it can actually hold the shape: an entry needs a status, a
revisit trigger, and citable retrieval.

**Blocked on:** RL-014, narrowly — the missing status vocabulary on Semantic, since `SUPERSEDES`
and `archived` already cover superseded and retired. RL-009 blocks this only if entries land as
MemoryBlocks: as of 2026-08-28 `berry_ask` cites semantics and facts, and blocks not at all.
Neither is an excuse.

**Revisit when:** both are closed. Until then this file is the source of truth.

---

### RL-016 — HK-1's coverage alarm landed in a channel that was already dirty
**Evidence:** verified · **Status:** RESOLVED 2026-08-28 · **Opened:** 2026-08-27

The coverage guard reported any label below 95%. Fact sits at 0%, so `status.degraded` was
permanently non-empty and could never clear on any boot.

**Fixed by correcting the guard's scope, not by muting it.** The guard exists to catch exactly one
failure: a vector index that queries hit and silently get nothing from. Nothing reads
`fact_embedding` — it appears only in its own CREATE statement in `schema.ts` — so Fact coverage
cannot produce that failure. The guard now iterates `EMBEDDING_READ_LABELS`
(`Symbol`, `Semantic`, `Episodic`), with the rule written down: add a label when something starts
reading its embeddings, not before. Pinned by S18.

**Not confirmable from outside the process, and worth knowing why.** `status.degraded` is a
bootstrap-local array (`packages/mcp/src/bootstrap.ts:254`, pushed at `:273`, `:292`, `:311`) that
is only ever printed to stderr at `:762-765`. It appears in no HTTP payload. `/readyz` does return
a `consolidation_automation` block with its own `degraded` / `limitations` fields, but those come
from consolidation worker health (`consolidation-coordinator.ts:111-117`) and would read the same
whether or not this fix landed — checking them proves nothing about the coverage guard. Verifying
this one means reading the server's boot log, or the S18 pin.

**What this cost, recorded because it is easy to lose:** the Fact plane's open decision just lost
its only automated reminder. See RL-008 — this ledger is now the only thing holding it.

---

### RL-017 — 13 of 14 "pre-existing lab failures" were a broken gate harness; the 14th is a spawn timeout
**Evidence:** measured · **Status:** RESOLVED 2026-08-30 (all 14) · **Opened:** 2026-08-27

The lab sweep failed 14 tests in both Node majors, byte-identical across three consecutive gates
(recorded at the time against `bench/lab/ret010/__tests__/dev-gate.test.ts`, though the
dubious-ownership class reaches other lab suites that also shell out to git, so that single-file
attribution is not corroborated). Stable and pre-existing — and read, for three packets, as a
product defect nobody had time for.

**Thirteen of them were not a product defect. They were our own gate script.** CI runs the same
command (`npm run bench:lab:test`, `ci.yml:50`) and is expected green, which should have been the
tell. No CI run id was recorded at the time, so treat that historical green as expected rather
than attested. **The fourteenth was later reproduced, root-caused, and closed** — see the bullet
and 2026-08-30 closure below.

- **13 of 14:** `fatal: detected dubious ownership in repository at '/w'`. The gate container ran
  as root against a uid-1000 worktree. `git config --global --add safe.directory` does not help,
  because the lab sandbox spawns git with a sanitised environment — HOME is unset, so the global
  config is never read. Fixed by matching the container uid to the worktree owner **and** running
  `npm ci` under the same uid; doing only one trades dubious-ownership for EACCES on
  `node_modules/.cache`.
- **1 of 14: CAUSE ESTABLISHED 2026-08-28 — a short spawn timeout, tripped by load.** The docker
  story was withdrawn first (`grep -i docker` returns zero in the test and in the gate it loads,
  and the lab's docker spawns sit behind `candidate/live.ts` / `candidate-v3/live.ts`, which are
  their own CI steps and unreachable from `vitest run bench/lab`). Then somebody read the logs,
  which is all it ever needed.

  **The two Node arms fail on DIFFERENT tests, and neither is the one this entry named.**

  | arm | failing test | error |
  |---|---|---|
  | node:20 | `bench/lab/admission-features/scorer-only/__tests__/blinded-holdout-v2.test.ts` — "loads the assembled v2 policy through the real preflight CLI" | `Test timed out in 5000ms` |
  | node:22 | `bench/lab/ret010/__tests__/dev-gate.test.ts:2199` — "runs the exact production finalize CLI and emits only its validated upload path" | `spawnSync /usr/local/bin/node ETIMEDOUT` (errno -110) |

  Both are the same class: **a short hard timeout around spawning a Node subprocess.** The node:22
  case allows `timeout: 3_000` for a spawn of `node bench/lab/ret010/dev-gate.cjs finalize`
  (`dev-gate.test.ts:2196`); the node:20 case is vitest's default 5s around a preflight CLI.
  `dev-gate.test.ts` alone carries seven such 2-3s spawn budgets, so WHICH one trips is a function
  of machine load, not of any defect. Each arm reported `Tests 1 failed | 2116 passed`, taking
  160-220s of test time on a 4-core box measured at load 2.83.

  That explains the shape which misled three packets: the failure is **stable in count** (always
  exactly one) but **unstable in identity**, which reads like a single known-red test and is not
  one. It also retires the "environment gap" framing — nothing is missing from the container; the
  budgets are simply too tight for it under parallel load.

  **Not a product defect — a test execution topology that put short, intentionally fixed child
  deadlines in contention with the rest of the lab.** Raising production-like child deadlines
  would have weakened the contract. PR #137 instead kept the 3-second `SIGKILL` deadlines and
  serialized the entire RET-010 directory after the rest of the lab. Serializing only dev/holdout
  was insufficient: the full gate then exposed the same class in `load-dev.test.ts` under the
  parallel TypeScript compiler load.

**Closure, 2026-08-30.** `npm run bench:lab:test` now runs non-RET-010 suites first, then all four
RET-010 files with `--fileParallelism=false`. A workflow-binding regression test pins both that
exact topology and the unchanged child deadline. Linux Node 22 passed 965/965 non-RET-010 plus
1,153/1,153 RET-010 tests (2,118 total). Hosted CI run `33301429083` then passed Node 20, Node 22,
and live-container integration. **Expected steady state is now `LAB_EXIT=0`; any lab failure is a
regression.**

**Lesson worth more than the fix:** "pre-existing, identical across gates" proved the failures were
*stable*, and I treated that as evidence they were *legitimate*. It was only evidence they were
consistent. A red gate nobody has diagnosed is not a baseline, it is an unread message.

**Revisit when:** RET-010's process topology changes, its fixed child deadlines change, or any lab
failure returns.

---

### RL-023 — exhaustive retrieval trace is the wrong default diagnostic surface
**Evidence:** measured · **Status:** RESOLVED by PR #137 · **Opened:** 2026-08-30

The production retrieval path was healthy without trace, but one representative traced memory
request (`rq-s-01`) took 29.17 seconds and returned 4,026,794 bytes. The cost came from collecting
and serializing the exhaustive replayable trace, not from finding the answer: the same request
without that collector completed in roughly 0.2 seconds.

PR #137 added an explicit `trace_detail: summary` mode while preserving `full` as the backward-
compatible default whenever a caller asks only for `include_trace: true`. Summary is content-free,
non-replayable, capped at 16 KiB of diagnostic data and 64 ordered result details, and binds the
full delivered order with a SHA-256 digest. It reports request-shape buckets, source counts/order,
result/token counts, total timing, and omitted-detail counts without returning raw task, content,
title, tenant, project, entity, or evidence identifiers. `explain + summary` fails before retrieval
because explanation requires the exhaustive trace.

Live after deployment at `8cf1f651`, `rq-s-01` returned the same evidence order and rank 2 in both
modes: summary 195.96 ms / 28,783 total response bytes versus full 28.76 s / 4,026,794 bytes. That
is about 147x faster and 99.29% smaller end to end. The complete 34-case live summary run had zero
errors, preserved Answer@5 31/34 and MRR 0.6127 exactly, and measured p50 192.71 ms, p95 298.85 ms,
and max response 30,329 bytes.

**Decision:** agents should request summary for ordinary diagnostics and reserve full trace for a
specific replay/explanation investigation. The exhaustive path remains intentionally available;
this packet did not optimize it.

**Revisit when:** the summary exceeds 32 KiB end to end, loses parity with delivered order, exposes
content or scope identifiers, or a normal agent workflow genuinely requires replayability.

---

### RL-024 — two episodic misses were ranking/packing failures; the last is candidate reachability
**Evidence:** measured · **Status:** PARTIALLY RESOLVED by PR #138 · **Opened:** 2026-08-30

RET-Q-004 began from the frozen live 31/34 memory baseline. Candidate inspection separated three
apparently identical top-five misses into different failure stages:

- `rq-e-05`: the expected architecture episode was vector rank 1, but the served lexical
  reranker catastrophically demoted it to roughly rank 13.
- `rq-e-06`: the expected legacy unclassified episode reached reranked rank 5, then the token
  density packer discarded it.
- `rq-e-07`: the expected episode was vector rank 53, outside the bounded 50-candidate window, so
  neither reranking nor assembly could recover it.

Broad fallbacks were rejected because they regressed up to six existing wins. PR #138 instead
added exact default-off `MEMBERRY_EPISODIC_RECALL_V1=1` behavior at the two proven loss points: it
pins only a baseline-rank-1 episodic `architecture` result demoted beyond the top ten, preserving
the rest of the reranked order, and retains only the literal legacy `Episodic` result at exact
reranked rank 5 when it fits the caller's budget. It makes no graph writes or migrations.

Hosted CI run `33307134353` passed Node 20, Node 22, the complete unit/lab matrix, live Docker
integration, authenticated scoped retrieval, and trace conformance. Clean Linux Node 20 and 22
also passed 896 retrieval tests (7 skipped) and 341 MCP tests (9 skipped). After deployment at
`1c0f97c`, two consecutive production 34-case runs scored 33/34 with zero errors and no regression
of the 31 prior wins. `rq-e-05` was rank 1, `rq-e-06` rank 4, and only `rq-e-07` remained missing.
Production p95 was 265 ms then 279 ms; maximum response size was 29,357 bytes. The prior image is
retained as `memberry:rollback-retq004-8cf1f65`; unsetting the flag and restarting MCP restores
baseline behavior without a data rollback.

**Decision:** close RET-Q-004. The next packet is candidate reachability for the single rank-53
episode, not another reranker or packer exception. Any widening must remain bounded,
authority-scoped, benchmark-agnostic, and preserve all 33 current wins.

**Revisit when:** `rq-e-07` enters the served candidate window, any current win regresses, p95
exceeds 500 ms, a response exceeds 32 KiB, or the rollback image is retired.

---

## Closed

_Nothing yet. When an entry closes, move it here with the PR that closed it and keep the trigger
visible, so the reasoning survives the fix._
