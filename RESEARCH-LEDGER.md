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

### RL-018 — `berry_context` rejects a real call that names no entities
**Evidence:** measured (2026-08-28) · **Status:** open · **Opened:** 2026-08-28

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
**Evidence:** measured · **Status:** RESOLVED 2026-08-28 (all 14) · **Opened:** 2026-08-27

The lab sweep failed 14 tests in both Node majors, byte-identical across three consecutive gates
(recorded at the time against `bench/lab/ret010/__tests__/dev-gate.test.ts`, though the
dubious-ownership class reaches other lab suites that also shell out to git, so that single-file
attribution is not corroborated). Stable and pre-existing — and read, for three packets, as a
product defect nobody had time for.

**Thirteen of them were not a product defect. They were our own gate script.** CI runs the same
command (`npm run bench:lab:test`, `ci.yml:50`) and is expected green, which should have been the
tell. No CI run id was recorded at the time, so treat that green as expected rather than
attested. **The fourteenth is still unexplained** — see the bullet below; nothing here says it is
not a product defect.

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

  **Not a product defect, and not a harness bug — a test-timeout budget that does not survive a
  loaded machine.** Fixing it means raising those spawn budgets or serialising the lab run, not
  filtering anything out. Until then `LAB_EXIT=1` stays expected, but **do not assume the same
  test**: read the log.

The fix lives in a tracked script, `scripts/gate.sh`, so the reasoning cannot evaporate with a
box-local file again. **Expected steady state is `LAB_EXIT=1` with exactly ONE failure; two or
more is a real regression.**

**Lesson worth more than the fix:** "pre-existing, identical across gates" proved the failures were
*stable*, and I treated that as evidence they were *legitimate*. It was only evidence they were
consistent. A red gate nobody has diagnosed is not a baseline, it is an unread message.

**Revisit when:** the spawn budgets are raised or the lab run is serialised, or if lab failures
ever exceed one.

---

## Closed

_Nothing yet. When an entry closes, move it here with the PR that closed it and keep the trigger
visible, so the reasoning survives the fix._
