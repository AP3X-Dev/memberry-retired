# EVAL-001 — origin baseline

**Status: ORIGIN PINNED 2026-08-27 at `a1439fb` (deployed `3eba9a9`). Section 2.6 holds the
real measurements and is never overwritten.**

A surviving `TBD` in sections 2.1 to 2.5 is a run-time confirmation cell that was not
captured at the run. It is a placeholder for evidence that does not exist: it is not zero,
it is not "roughly zero", and it must never be quoted, averaged, compared against, or
carried into a report. The origin was taken once and does not get retaken; the `TBD`s in
section 3 are worked examples of the delta format, not cells.

Governed by spec
[`docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md`](../../docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md)
§6.1 and its amendments A2, A8, A9, and by [`SELECTION-RULE.md`](SELECTION-RULE.md) §5.1,
§9, §10 and amendment A1.

---

## 1. The rule this file exists to enforce

**Section 2 is written once and is NEVER overwritten.** Later runs APPEND to section 7.
They do not edit section 2, do not "refresh" it, and do not re-derive it from the most
recent run.

The failure this prevents is boiling-frog drift. "No band" (spec §1) means no headroom
qualification; it does **not** mean no absolute anchor, and conflating the two reintroduces
the failure by another route. A chain of accepted "did not regress" steps, each measured
only against the one immediately before it, IS a moving threshold — just an unrecorded one.
Ten steps of −0.4% each is a 4% decline that no single comparison ever flags.

Golden v1 avoids this with a fixed floor (`precisionAt5: 0.39`) that is never re-derived
from the latest run. This file is the analogous mechanism for EVAL-001.

---

## 2. ORIGIN BASELINE RECORD — origin 2, pinned 2026-09-05

Origin 1 (2026-08-27, `a1439fb`) is retained verbatim in §6. It was superseded because §3.2
conditions 1 and 2 both fired after it was pinned: three retrieval flags shipped (§2.7 of origin 1),
RL-018 changed which questions are answerable (§7, 2026-08-29), and `project:memberry` was
deliberately re-ingested on 2026-09-04 (slice 2 / B-2: 16,399 → 20,197 symbols). The re-pin was
owed since 2026-08-28 and is taken now as a deliberate act, not in response to any number.

### 2.0 Run identity

| field | value |
|---|---|
| date/time of run | 2026-09-05, America/Los_Angeles (dev first, holdout second; holdout is the second attempt — see §2.5) |
| who ran it | slice-3 session (state file `docs/agent-runs/slices-2026-09-04.md`) |
| host the runner executed from | Windows workstation (network MCP client; the SERVER is cerebro) |
| MCP endpoint (`--base`) | `http://192.168.0.25:3101` |

### 2.1 Code identity

| field | value |
|---|---|
| repo `master` at time of run | `f1afe29` |
| commit DEPLOYED on the box | `037247c` (`git -C /home/cerebro/projects/memberry rev-parse HEAD`) |
| `git diff --stat 037247c..f1afe29 -- packages/ src/` | **EMPTY** — docs-only delta (#154), deployed code == master code |

### 2.2 Flag state at origin 2 — read in-container at run time

Command: `ssh cerebro@192.168.0.25 "docker exec memberry-mcp env | grep -E '^MEMBERRY_' | sort"`.
Verbatim, retrieval-governing subset (the two `ADMISSION_SHADOW_*` tunables and
`LIFECYCLE_EXPORT_DIR` omitted as non-ranking):

```
MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1=live
MEMBERRY_ADMISSION_ROUTING_V1=shadow
MEMBERRY_CANDIDATE_CHANNEL_V1=1
MEMBERRY_CODE_RERANK_V1=1
MEMBERRY_CODE_SCOPE_V2=1
MEMBERRY_KIND_RANK_V1=1
MEMBERRY_LIFECYCLE_ANTIENTROPY=live
MEMBERRY_LIFECYCLE_HEBBIAN=live
MEMBERRY_LIFECYCLE_V1=live
MEMBERRY_QUERY_PLANNER_V1=1
MEMBERRY_RERANKER_V1=served
```

The three `LIFECYCLE_*` lines now come from the repo's `docker-compose.yml` via the box `.env`,
so the origin-1 reproducibility hazard no longer applies. `KIND_RANK_V1` is sourced only from the
box `.env` (compose passes `${MEMBERRY_KIND_RANK_V1:-}`), so a checkout without that `.env` line
runs kind-aware ranking OFF and will not reproduce this origin.

### 2.3 Index state at the moment of the run

Captured 2026-09-05 between the dev and holdout runs with `cypher-shell` inside `memberry-neo4j`.
Re-index since origin 1: **yes** — `berry_ingest_codebase /workspace/memberry` on 2026-09-04
(slice 2 / B-2) and again after #153 deployed (2026-09-05 05:55 UTC).

| `project_tag` | Symbol count |
|---|---|
| `project:memberry` | 20,197 (origin 1: 16,399) |
| `project:hermes-agent` | 15,055 |
| `project:neuri` | 12,339 |
| `project:ag3ntic` | 5,385 |
| NULL | 5,136 |

`project:memberry` kind histogram:

| kind | count |
|---|---|
| `variable` | 13,672 |
| `function` | 4,236 |
| `interface` | 935 |
| `method` | 756 |
| `type` | 369 |
| `class` | 201 |
| `module` | 28 |

| property | value |
|---|---|
| test-file symbols (`file_path` matches `__tests__`, `.test.`, `.spec.`) | 10,083 (**49.9%**) |
| bare-variable (kind `variable`, empty `doc_comment`) | 12,482 (**61.8%**) |

Queries: `MATCH (s:Symbol) RETURN coalesce(s.project_tag,"NULL"), count(*)`;
`MATCH (s:Symbol {project_tag:"project:memberry"}) RETURN s.kind, count(*)`; the two shares are
`sum(CASE WHEN … THEN 1 ELSE 0 END)` over the same match, on `s.file_path` and on
`s.kind="variable" AND coalesce(s.doc_comment,"")=""`. The Symbol property is `file_path`, not
`file`; a first attempt on `s.file` returned 0.0% and was discarded.

### 2.4 Question set state

| field | value |
|---|---|
| question file | `bench/eval/eval001-questions.jsonl`, unchanged since origin 1 |
| SHA-256 at run time | `4417d4a912755ee77c16b63f453bb5baae70b68dc28bb61d8ee89cdb0990e70d` |
| selection rule in force | `SELECTION-RULE.md` incl. A1, A2, A4 — no re-selection |
| `dev` split | 4 authored, **4 scored** (origin 1 scored 3: `eval001-d-08` is answerable after RL-018) |
| `holdout` split | 5 |

### 2.5 How the run was invoked

```
node bench/eval/run-eval001.mjs --split dev                                          # → bench/eval/last-run.json
node bench/eval/run-eval001.mjs --split holdout --out bench/eval/last-run-holdout.json
```

| field | value |
|---|---|
| runner SHA-256 | `95f46e5e35e103e91d47ac5094db15826b1a1b1de1fbf4b6696da10a823933ec` |
| node version | v20.18.2 |
| session line | `EVAL001 session codeDomainEnabled=true codeToolsVisible=7` (both splits) |
| holdout attempt 1 | **aborted, no numbers**: `DOMException [TimeoutError]` from the client's 30 s `AbortSignal` on one call while `memberry-mcp` was inside a consolidation burst (80 lifecycle/consolidation log lines in the preceding 15 min). Retried once after the burst with the box idle (mcp 0.35% CPU). No question result from attempt 1 was observed or retained. |

### 2.6 THE ORIGIN-2 NUMBERS

Metric definitions unchanged from origin 1 (§6, its "2.6"). `noiseRate` remains retired.

**`dev` split (n = 4 authored, 4 scored):**

| metric | origin-2 value |
|---|---|
| `keywordRecall@5` | **0.0625** |
| `keywordRecall@10` | **0.1250** |
| `testFileRate@5` | **0.3000** |
| `testFileRate@10` | **0.3750** |
| `nonRetrieval` | **0** |
| `grammarMisses` | **0** |

**`holdout` split (n = 5) — AGGREGATE ONLY:**

| metric | origin-2 value |
|---|---|
| `keywordRecall@5` | **0.2000** |
| `keywordRecall@10` | **0.2000** |
| `testFileRate@5` | **0.0000** |
| `testFileRate@10` | **0.0000** |
| `nonRetrieval` | **0** |
| `grammarMisses` | **0** |

Verbatim `EVAL001 …` lines, both splits:

```
EVAL001 session codeDomainEnabled=true codeToolsVisible=7
EVAL001 split=dev n=4 keywordRecall5=0.0625 keywordRecall10=0.1250
EVAL001 split=dev testFileRate5=0.3000 testFileRate10=0.3750
EVAL001 split=dev grammarMisses=0 nonRetrieval=0 flags=QUERY_PLANNER_V1,CANDIDATE_CHANNEL_V1,RERANKER_V1
EVAL001 split=dev question=eval001-d-07 keywordRecall5=0.0000 testFileRate5=0.8000 missing=assembler.ts|UnifiedAssembler|AssemblerCodeLayer|CodeSearch
EVAL001 split=dev question=eval001-d-08 keywordRecall5=0.2500 testFileRate5=0.4000 missing=UnifiedAssembler|rrfFusion|fusion.ts
EVAL001 split=dev question=eval001-d-11 keywordRecall5=0.0000 testFileRate5=0.0000 missing=evidence-authority-ledger.ts|linkSignal|CONTRADICTS|EvidenceAuthorityCoverage
EVAL001 split=dev question=eval001-d-25 keywordRecall5=0.0000 testFileRate5=0.0000 missing=hibernated|computerStatus.ts

EVAL001 session codeDomainEnabled=true codeToolsVisible=7
EVAL001 split=holdout n=5 keywordRecall5=0.2000 keywordRecall10=0.2000
EVAL001 split=holdout testFileRate5=0.0000 testFileRate10=0.0000
EVAL001 split=holdout grammarMisses=0 nonRetrieval=0 flags=QUERY_PLANNER_V1,CANDIDATE_CHANNEL_V1,RERANKER_V1
```

**Read against origin 1 for context only — deltas do not cross an origin boundary (§5 item 4).**
Dev `testFileRate@5` 0.1333 → 0.3000, with `eval001-d-07` at 0.8000: four of its top five are
test files, on an index that is 49.9% test-file symbols. Dev `keywordRecall` is flat at n = 4 and
dominated by two questions (`d-11`, `d-25`) that miss every keyword; those are the same misses as
origin 1. Holdout `keywordRecall@10` moved 0.3000 → 0.2000 and `@5` 0.1000 → 0.2000; at n = 5
that is one question moving, a smoke signal, not a trend.

The sibling probe (§8) taken the same day against the same deploy reads memory-only Answer@5
0.5323 over 62 cases (`SELECTION-LOG.md` 2026-09-05) and code-plane Answer@5 0.8421 over 38
(2026-09-04). Those are not EVAL-001 numbers.

---

## 3. How every later comparison is reported

**Two numbers, always. Never one.** Every comparison reports drift against BOTH:

1. **the immediately-prior accepted state** — the previous accepted row in section 7, and
2. **the origin baseline** — section 2.6, which never moves.

A row reporting only one of the two is incomplete, and the change it supports is not
accepted. This is the mechanism, not the aspiration: a "did not regress" measured only
against the prior step cannot detect accumulated decline, because each individual step is
genuinely within noise.

Per split, per metric, the row carries:

```
keywordRecall@5   this=TBD   Δ vs prior=TBD   Δ vs ORIGIN=TBD
testFileRate@5    this=TBD   Δ vs prior=TBD   Δ vs ORIGIN=TBD
```

### 3.1 The monotonic-decline flag

**A monotonic decline across three or more consecutive accepted runs is FLAGGED, even when
no single step regressed.** That is the boiling-frog case, and it is the specific thing this
file exists to catch.

Flagging means the run is recorded with a `FLAG: monotonic decline over N runs` line in
section 7, and the next change touching that metric must either address the drift or justify
it in writing. A flag is a recorded event, not a veto — but clearing it silently is not
available.

Evaluate the flag per metric, per split, over the accepted rows only.

### 3.2 What voids comparison entirely

From SELECTION-RULE §9. Each of these makes results uncomparable and requires a **fresh
baseline**, not a delta:

1. A re-index, which changes the corpus underneath (spec §8 item 4).
2. A change to any flag in §2.2.
3. Re-selecting the question set by any rule other than `SELECTION-RULE.md`.
4. Discovery that the mined population is not what §3 of that rule claims — for example,
   transcript coverage turning out to be partial in a way that correlates with query
   difficulty.

Also voiding, from the metric side: a nonzero `grammarMisses`, which means the render
diverged from the pinned grammar and `testFileRate` is known-invalid for that run.

---

## 4. What these numbers do NOT describe — declared bias

These caveats travel with every EVAL-001 number. A report quoting a metric from this file
without them is overclaiming.

**Deliberate code-plane over-sampling (SELECTION-RULE §5.1).** By raw frequency the mined
population is 87% memory-plane; a proportional sample would have yielded roughly two code
questions. Because the primary diagnosed defect is a code-plane defect, the rule takes
**every** surviving code-plane and mixed query and then fills to target from memory. This is
a bias, chosen on an *a priori* ground — where the known defect lives — and not on any
measured outcome. **`keywordRecall` on this set does not describe MemBerry's average
traffic, and no report may claim that it does.**

**Single-client transcript source (SELECTION-RULE §10).** The population is Claude Code on
one Windows workstation. Codex, Neuri, and Hermes agents also query MemBerry; their logs live
elsewhere and were not mined. The set over-represents one client's phrasing and one client's
tool-selection habits. Mining a second client's logs is the obvious fix and was out of scope
for this pass.

**Foreign-client scopes excluded (SELECTION-RULE amendment A1, ground E5).** 89 memory-plane
queries scoped to non-MemBerry projects were excluded, because this repo is public and the
question file is tracked — and redaction was rejected on the ground that the client name *is*
the retrieval signal, so a redacted query is no longer the real query. E5 removed **zero**
code-plane and **zero** mixed-plane queries. The consequence is that this set measures
retrieval on *MemBerry-and-siblings development traffic*, not the workstation's whole query
load.

**Small n (spec §8 item 1).** The surviving set is sized for signal on obvious defects, not
statistical power. A small delta is not detectable and must not be claimed as one.

**Keyword presence is a proxy for usefulness (spec §8 item 2).** A response can contain every
required keyword and still be badly ordered or padded. `testFileRate` partly covers this;
nothing fully does.

**Author bias (spec §8 item 3).** Whoever authored the keywords decided what "good" means.
Blind authoring (SELECTION-RULE §7) constrains this; it does not remove it.

**A retrieval claim only (spec §2.4).** No answer quality, task completion, latency, or cost
is measured. A `keywordRecall` gain is a retrieval claim and must not be reported as anything
else.

---

## 5. Re-pinning the origin — the ONLY permitted procedure

**Amended 2026-08-28 (owner).** This section previously permitted re-pinning on a deliberate
re-index alone, while §3.2 listed FOUR conditions that void comparison and said each "requires a
fresh baseline, not a delta". Those two statements contradicted each other: three flags shipping
after the origin (§2.7) voided comparison under §3.2 item 2 and simultaneously forbade the only
documented way to restore it, leaving EVAL-001 runnable but unable to compare anything — most of
what a regression guard is for. The permitted triggers are now the §3.2 list, so the two sections
agree.

The origin baseline is re-pinned **only when comparison has been voided by one of the four
conditions in §3.2**:

1. a deliberate re-index (the corpus changed underneath — spec §8 item 4);
2. a change to any flag governing the measured path;
3. re-selecting the question set by any rule other than `SELECTION-RULE.md`;
4. discovery that the mined population is not what SELECTION-RULE §3 claims.

Nothing else re-pins it — not a run that looks anomalous, not a metric that has drifted, not a
change of opinion about the question set that does not go through the selection rule, and **never**
as a way to clear a monotonic-decline flag. Widening the trigger list does not widen the ceremony:
every re-pin still retains the prior origin verbatim, still records its reason, and still appears
in §6 so the count stays visible. **A re-pin is never a way to escape a number** — if a re-pin and
an unwelcome result ever coincide, the burden is on the re-pinner to show the voiding condition
existed independently of the result.

When one of those conditions occurs:

1. **Retain the prior origin. It is never deleted.** Move section 2 verbatim into section 6
   under a heading `Superseded origin N — <date>`. Not edited, not summarised, not trimmed.
2. Record the **reason** in that heading — which of the four conditions fired, and the evidence
   for it (the re-index performed, or the flag and the PR that shipped it, and so on).
3. Write a **new** section 2 with new SHAs, new flag state, new index state, and a new run.
   The new origin is a fresh capture, not an adjustment of the old one.
4. Note in section 7 the exact row after which comparison switches to the new origin.
   **Deltas do not cross an origin boundary:** a run under origin N+1 is never compared to
   origin N's numbers.
5. Every re-pinning is itself an entry in section 6, so the count of re-pinnings is visible.
   Frequent re-pinning is a smell, and the record makes it one.

---

## 6. Superseded origins — retained forever

### Superseded origin 1 — 2026-09-05

**Reason (§3.2 / §5):** condition 2 — flags governing the measured path changed after the pin
(`MEMBERRY_KIND_RANK_V1` #118, `MEMBERRY_CODE_SCOPE_V2` #119, `MEMBERRY_CODE_RERANK_V1` #123, and
the RL-018 behaviour change, PR #130); and condition 1 — a deliberate re-index of `project:memberry`
on 2026-09-04 (slice 2 / B-2, 16,399 → 20,197 symbols). Both conditions existed independently of
any result; the re-pin had been declared owed in §2.7 since 2026-08-28. Origin-1 numbers were:
dev kwRecall@5 0.0833 / @10 0.0833, testFileRate@5 0.1333 / @10 0.2000, nonRetrieval 1;
holdout kwRecall@5 0.1000 / @10 0.3000, testFileRate 0.0000 / 0.0000.

Section 2 as it stood, verbatim:

## 2. ORIGIN BASELINE RECORD — write once, never overwrite

### 2.0 Run identity

| field | value |
|---|---|
| date/time of run (ISO 8601, with zone) | 2026-08-27, America/Los_Angeles |
| who ran it | autonomous-memberry-10x session, EVAL-001 lane |
| host the runner executed from | Windows workstation (the runner is a network MCP client; the SERVER is cerebro) |
| MCP endpoint (`--base`) | `http://192.168.0.25:3101` |

### 2.1 Code identity — two SHAs, because they differ

Two commits must be recorded, and the relationship between them stated, or the baseline is
not reproducible.

| field | value |
|---|---|
| repo `master` at time of writing | `a1439fb` |
| commit DEPLOYED on the box | `3eba9a9` |
| deployed code == master code? | **yes** |

**Why both.** The box runs `3eba9a9`; repo master is `a1439fb`. These are different commits,
and recording only one would misstate what was measured. But
`git diff --stat 3eba9a9..a1439fb -- packages/ src/` is **EMPTY** — the delta between them
is docs-only — so **the deployed code is identical to the master code**, and a result taken
against the box is a result against master's code. That fact is what makes the two SHAs
reconcilable; without it, a future reader has to re-derive it or distrust the run.

Confirm at run time and record the confirmation:

| check | value |
|---|---|
| `git diff --stat 3eba9a9..a1439fb -- packages/ src/` still empty at run time | TBD |
| repo SHA actually used, if it moved | TBD |
| deployed SHA actually used, if it moved | TBD |

### 2.2 Flag state at origin — the complete set, including what is not in the repo

A change to any of these voids cross-run comparison (SELECTION-RULE §9 item 2) and requires
a fresh baseline.

| flag | value at origin |
|---|---|
| `MEMBERRY_QUERY_PLANNER_V1` | `1` |
| `MEMBERRY_CANDIDATE_CHANNEL_V1` | `1` |
| `MEMBERRY_RERANKER_V1` | `served` |
| `MEMBERRY_ADMISSION_ROUTING_V1` | `shadow` |
| `MEMBERRY_ADMISSION_FEATURE_PRODUCER_V1` | `live` |
| `MEMBERRY_LIFECYCLE_*` (all three) | `live` |

> **REPRODUCIBILITY HAZARD — read this before trying to reproduce the baseline.**
>
> **The three `MEMBERRY_LIFECYCLE_*=live` lines exist ONLY as an UNCOMMITTED modification to
> the box's `docker-compose.yml`. They are NOT in the repo's copy of that file.**
>
> A clean checkout of `a1439fb` brought up with the repo's compose file does not have them
> and will not reproduce this baseline. Anyone reconstructing the environment must add them
> by hand. Without this note the baseline is not reproducible, which is why it is stated
> here rather than left to be rediscovered.

Record the in-container verification at run time, so the flags are evidence rather than
recollection:

| field | value |
|---|---|
| command used to read the flags in-container | TBD |
| verbatim output | TBD |
| the three `LIFECYCLE` lines still uncommitted at run time? | TBD |

### 2.3 Index state at the moment of the run

Spec §8 item 4: EVAL-001 measures the current index, so cross-index comparison is
conditional on recorded index state. Spec amendment A8: these counts must be captured **at
the same moment as the first run**, not afterwards.

**Reference measurement, taken 2026-08-27 during the Phase 0 grounding pass.** This is
pre-run context, not the baseline capture:

| `project_tag` | Symbol count |
|---|---|
| `project:memberry` | 16,399 |
| `project:hermes-agent` | 15,055 |
| `project:neuri` | 12,339 |
| `project:ag3ntic` | 5,385 |
| NULL | 5,136 |

`project:memberry` kind histogram:

| kind | count |
|---|---|
| `variable` | 11,847 |
| `function` | 2,589 |
| `method` | 880 |
| `interface` | 654 |
| `type` | 254 |
| `class` | 155 |
| `module` | 20 |

Derived shape of `project:memberry`:

| property | value |
|---|---|
| test-file symbols | 8,344 (**50.9%**) |
| bare-variable (kind `variable`, empty `doc_comment`) | 10,996 (**67.1%**) |

**`project:memberry` is 16,399 symbols, NOT the roadmap's 8,928** (+83.7%). Any document
still quoting 8,928 — or 34% test-file, or 74% variable — is stale and must not be used to
interpret a baseline number. The `noiseRate` motivation in spec §2.2 was written against
those stale figures.

**Captured at the moment of the origin run.** Re-measure; do not copy the reference table
above into these cells:

| field | value |
|---|---|
| per-`project_tag` Symbol counts at run time | TBD |
| `project:memberry` kind histogram at run time | TBD |
| test-file share at run time | TBD |
| bare-variable share at run time | TBD |
| query used to produce these counts | TBD |
| any re-index between 2026-08-27 and the run? | TBD |

### 2.4 Question set state

| field | value |
|---|---|
| question file | `bench/eval/eval001-questions.jsonl` |
| selection rule in force | `SELECTION-RULE.md` at `a1439fb`, incl. amendments A1 and A2 |
| total questions SELECTED | 34 (extended from 20 per SELECTION-RULE amendment A4) |
| total questions SURVIVING blind authoring | **9 of 34** — 25 could not be grounded outside MemBerry. See §4. |
| `dev` split | 21 selected — **4 surviving** (2 mixed, 2 memory) |
| `holdout` split | 13 selected — **5 surviving** (2 code, 3 memory) |
| SHA-256 of the question file at run time | TBD |
| questions carrying no `entity_scope` | 27 of 34 — see `SELECTION-LOG.md`, OPEN ISSUE. Mitigated: the runner replays each query through the tool that ACTUALLY issued it, so the planner requirement only binds the 3 `berry_context` questions. |

### 2.5 How the run was invoked

```
node bench/eval/run-eval001.mjs --split dev     --out bench/eval/last-run.json
node bench/eval/run-eval001.mjs --split holdout --out bench/eval/last-run-holdout.json
```

**As actually run, both splits wrote to `bench/eval/last-run.json`.** The holdout run
overwrote the dev artifact and `last-run-holdout.json` was never produced, so the surviving
artifact holds the holdout aggregate with per-question detail withheld. Future runs must use
distinct `--out` paths.

| field | value |
|---|---|
| exact command lines used | TBD |
| runner file SHA-256 at run time | TBD |
| node version | TBD |
| `EVAL001 session codeDomainEnabled=… codeToolsVisible=…` line | TBD |
| `--smoke` transport check passed before the scored run? | TBD |

Opening the `holdout` split at origin is an open, and **must be recorded in
[`HOLDOUT-OPENS.md`](HOLDOUT-OPENS.md)** like any other, with `change tested = origin
baseline`.

`run-eval001.mjs` is the only EVAL-001 instrument. A sibling probe harness is committed
alongside it in this directory and is **not** governed by this file; see section 8.

### 2.6 THE ORIGIN NUMBERS

Metric definitions in force, per spec §2.1 and amendment A2:

- **`keywordRecall@k`** — primary. Mean over questions of
  `|{kw in K(q) present in top-k}| / |K(q)|`, at `k = 5` and `k = 10`.
- **`testFileRate@k`** — secondary. Share of top-`k` items whose path contains `__tests__`
  or `.test.`.
- **kind histogram** — **descriptive and UNSCORED.** Context for reading the other two. It
  is not a metric, and no change may be justified by moving it.
- **`noiseRate` is RETIRED and NOT IMPLEMENTED.** Spec §2.2's bare-variable clause was
  measured unsound (amendment A2): `doc_comment` is a *preceding* comment rather than a
  docstring, and the six `session: () => session` items that motivated the whole metric
  classify as kind `method`, so they would have scored **clean** under it. The name is
  retired rather than redefined, so that no one ever compares numbers across two meanings.
  If a `noiseRate` appears in a later run's row, that row is wrong.

Two excluded-from-scoring counters travel with every result and are part of the record, not
footnotes. A run with a nonzero `nonRetrieval` is a partially-measured run:

- **`nonRetrieval`** — planner rejections and silent-zero modes, NEVER scored as zero.
- **`grammarMisses`** — render lines the pinned grammar failed to parse. Nonzero means
  `testFileRate` for that run is known-invalid, not merely noisy.

**`dev` split (n = 4 authored, 3 scored):**

| metric | origin value |
|---|---|
| `keywordRecall@5` | **0.0833** |
| `keywordRecall@10` | **0.0833** |
| `testFileRate@5` | **0.1333** |
| `testFileRate@10` | **0.2000** |
| `nonRetrieval` (count, of 4 dev questions) | **1** — `eval001-d-08`, `runtime_query_planner:invalid_request` (no `entity_scope` in the original call). Excluded from scoring, never counted as zero. **n scored = 3.** |
| `grammarMisses` (count) | **0** |
| kind histogram over top-10 (descriptive) | not retained — the holdout invocation overwrote `last-run.json`. Re-run the dev split to regenerate; unscored, so nothing depends on it. |

**`holdout` split (n = 5) — AGGREGATE ONLY. No per-question row is ever recorded here.**

| metric | origin value |
|---|---|
| `keywordRecall@5` | **0.1000** |
| `keywordRecall@10` | **0.3000** |
| `testFileRate@5` | **0.0000** |
| `testFileRate@10` | **0.0000** |
| `nonRetrieval` (count, of 5 holdout questions) | **0** |
| `grammarMisses` (count) | **0** |
| kind histogram over top-10 (descriptive) | not recorded — aggregate-only split |

Verbatim `EVAL001 …` output lines, both splits, pasted unedited:

```
EVAL001 session codeDomainEnabled=true codeToolsVisible=7
EVAL001 split=dev n=3 keywordRecall5=0.0833 keywordRecall10=0.0833
EVAL001 split=dev testFileRate5=0.1333 testFileRate10=0.2000
EVAL001 split=dev grammarMisses=0 nonRetrieval=1 flags=QUERY_PLANNER_V1,CANDIDATE_CHANNEL_V1,RERANKER_V1
EVAL001 NON-RETRIEVAL question=eval001-d-08 tool=berry_context classified=true error=runtime_query_planner:invalid_request
EVAL001 split=dev question=eval001-d-07 keywordRecall5=0.2500 testFileRate5=0.4000 missing=UnifiedAssembler|AssemblerCodeLayer|CodeSearch
EVAL001 split=dev question=eval001-d-11 keywordRecall5=0.0000 testFileRate5=0.0000 missing=evidence-authority-ledger.ts|linkSignal|CONTRADICTS|EvidenceAuthorityCoverage
EVAL001 split=dev question=eval001-d-25 keywordRecall5=0.0000 testFileRate5=0.0000 missing=hibernated|computerStatus.ts

EVAL001 session codeDomainEnabled=true codeToolsVisible=7
EVAL001 split=holdout n=5 keywordRecall5=0.1000 keywordRecall10=0.3000
EVAL001 split=holdout testFileRate5=0.0000 testFileRate10=0.0000
EVAL001 split=holdout grammarMisses=0 nonRetrieval=0 flags=QUERY_PLANNER_V1,CANDIDATE_CHANNEL_V1,RERANKER_V1
```

**Per-question `dev` detail is permitted and belongs in the run artifact
(`bench/eval/last-run.json`), not in this file** — this file records split-level aggregates.
Per-question `holdout` detail is not permitted anywhere, per spec §3.2.1 and §5.

### 2.7 Post-origin flag drift

Section 2.2 records the origin environment and is not rewritten. Three retrieval flags went
live after the origin was pinned:

| flag | shipped in | live value |
|---|---|---|
| `MEMBERRY_KIND_RANK_V1` | #118 — IDX-002A, kind-aware ranking | `1` |
| `MEMBERRY_CODE_SCOPE_V2` | #119 — IDX-002B, project-scoped code search | `1` |
| `MEMBERRY_CODE_RERANK_V1` | #123 — IDX-004, wide-window code rerank | `1` |

All three are declared in `packages/code/src/search.ts` (lines 63, 98, and 113), and all
three read `1` on the deployed box as of 2026-08-28.

**They are in scope for §3.2 item 2.** "Any flag in §2.2" means any flag governing the
measured path; the §2.2 table is the origin's snapshot of that set, not a closed list a later
flag escapes by being younger. Cross-run comparison against the origin numbers is therefore
void, and **a fresh baseline is owed** before section 7 carries its first post-origin row.
The §2.6 numbers stand as the record of what the `a1439fb` environment measured.

IDX-004 was confirmed live on 2026-08-28 against the deployed server — top-5 70.0%, MRR
58.3%, variable share 8.0%, test-file share 0.0%, 0 errors. That measurement was taken with
the sibling probe harness (section 8), not with `run-eval001.mjs`, and is logged in the root
`RESEARCH-LEDGER.md`. It is not an EVAL-001 result and does not substitute for the fresh
baseline.

---

## 7. Run log — APPEND ONLY

### 2026-08-28 — dev split, post-deploy. NOT a re-pin, and NOT comparable to the origin.

| metric | value |
|---|---|
| `keywordRecall@5` | 0.0833 |
| `keywordRecall@10` | 0.0833 |
| `testFileRate@5` | 0.2000 |
| `testFileRate@10` | 0.2333 |
| `nonRetrieval` | 1 of 4 (`eval001-d-08`) |
| `grammarMisses` | 0 |

Run against the deployed server at master `e7308ef`, flags
`QUERY_PLANNER_V1,CANDIDATE_CHANNEL_V1,RERANKER_V1`. Artifact:
`bench/eval/eval001-dev-fresh.json` (on the box).

**No delta is reported, because none is permitted.** §3.2 item 2 voided comparison against the
origin when `MEMBERRY_KIND_RANK_V1`, `MEMBERRY_CODE_SCOPE_V2` and `MEMBERRY_CODE_RERANK_V1`
shipped. The origin's `keywordRecall@5` also reads 0.0833; that the two numbers coincide is
recorded as an observation and is explicitly **not** a claim that nothing changed.

**This run does not re-pin the origin.** §5 permits re-pinning only on a deliberate re-index, and
no re-index happened. See the blocked decision below.

### RESOLVED 2026-08-28 (owner): §3.2 and §5 now agree

§3.2 lists four conditions that void comparison and each "requires a **fresh baseline**, not a
delta". §5 permits re-pinning the origin for exactly **one** of those four — a deliberate
re-index — and says "nothing else re-pins it". A flag change (§3.2 item 2) therefore demands a
fresh baseline and forbids the only documented procedure for producing one.

**Resolved by extending §5's permitted triggers to the §3.2 list** rather than by narrowing §3.2.
The ceremony is unchanged — prior origin retained verbatim, reason recorded, every re-pin visible
in §6 — and a clause was added making explicit that a re-pin is never a route around an unwelcome
number.

The dev run above therefore stands as the last measurement under the ORIGINAL origin. It is still
not a re-pin: re-pinning is now permitted, but a re-pin is a deliberate act with its own record, and
it should be taken against the system as it will actually run — after the `berry_context` defect in
`RESEARCH-LEDGER.md` RL-018, which currently makes one of four dev questions unscoreable.

### 2026-08-29 — RL-018 fixed. The precondition named directly above is now met.

`berry_context` and `berry_ask` no longer reject a request that names no entity; an unanchored
request routes to the task-text path instead (`RESEARCH-LEDGER.md` RL-018, PR #130). This directly
changes the instrument's inputs: `eval001-d-08` scored `nonRetrieval` at the origin and again on
the 2026-08-28 dev run **because of this defect**, and the pending `eval001-d-04` is the same
shape. Both become scoreable.

**No number is claimed here.** This entry records a change to the system under test, not a run.

**§3.2 does not literally enumerate this, and that is a gap worth stating.** The four voiding
conditions are a re-index, a flag change, a re-selection, and a population discovery. This is none
of them — it is an unflagged behaviour change on the retrieval path — yet it plainly makes prior
`berry_context` results uncomparable, since a question that previously could not be answered now
can be. The gap is recorded rather than patched: §3.2 is owner-governed and was last amended by an
explicit owner decision (see the resolution above). Until then, treat this the way §3.2 item 2
would be treated.

**The re-pin is now unblocked and still not taken.** It remains a deliberate act with its own
record, and per §5 it is never a way to escape a number.


Later runs append rows here. **They do not touch section 2.** Rows are never edited,
reordered, or deleted; a mistaken row is corrected by appending a correction row that
references it.

Each row carries date, git SHA, split, the change being tested, the aggregate metrics, the
Δ vs prior accepted **and** the Δ vs origin for each, the `nonRetrieval` and `grammarMisses`
counts, the flag state if it differs from §2.2, and the accept/reject verdict.

| date | SHA | split | change tested | kwRecall@5 (Δprior / Δorigin) | kwRecall@10 (Δprior / Δorigin) | testFileRate@5 (Δprior / Δorigin) | testFileRate@10 (Δprior / Δorigin) | nonRetrieval | grammarMisses | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-05 | `f1afe29` (deployed `037247c`, code-identical) | dev + holdout | **origin 2 pinned** (re-pin per §5; §2 rewritten, origin 1 in §6) | dev 0.0625 · holdout 0.2000 (— / —) | dev 0.1250 · holdout 0.2000 (— / —) | dev 0.3000 · holdout 0.0000 (— / —) | dev 0.3750 · holdout 0.0000 (— / —) | 0 | 0 | origin 2 pinned; comparison switches to origin 2 AFTER this row |

*The origin baseline is recorded in section 2.6 and as entry 1 of
[`HOLDOUT-OPENS.md`](HOLDOUT-OPENS.md) section 5. No post-origin run has been appended here
yet.*

---

## 8. Sibling probes in this directory — NOT the EVAL-001 instrument

`bench/eval/` also carries a probe harness that this file does not govern. It has no blind
keyword authoring, no splits, and no holdout: it is diagnostic, and its results are logged in
the root [`RESEARCH-LEDGER.md`](../../RESEARCH-LEDGER.md), never in section 7.

| script | the question it answers |
|---|---|
| `run-outcome-probe.mjs` | did the right FILE come back, and how far down? |
| `scope-probe.mjs` | what is OCCUPYING the top-`k`, and how much of it is this project's code? |
| `idx004-measure.mjs` | does retrieve-wide + rerank + prior-last actually find more? |

All three read the same ground-truth file, `outcome-cases.jsonl` — 10 cases, `oc-01` through
`oc-10`. Each names a question, the file that answers it, and a `sourceOfTruth` file:line,
and carries `authoredBeforeFirstRun: true`. File-level ground truth is unarguable, which is
why this probe needs no blind-authoring ceremony to be honest. The trade is that at n = 10
with no sealed split it is a weaker instrument than EVAL-001, not a stronger one.

`run-outcome-probe.mjs` and `scope-probe.mjs` are MCP clients (`mcp-client.mjs`) and read the
deployed server. `idx004-measure.mjs` is different: it constructs `CodeSearch` against the
live graph in-process and runs the shipped code path, one process per flag state because the
flag is read at module load. It measures shipped code against live data; it is **not** a
reading from the deployed server, and must be reported that way. Its `--no-reranker` arm
isolates the two mechanisms IDX-004 ships together — the widened window with the prior run
over 50 rows instead of 10, and BM25F reranking — so that a gain from the first is not
credited to the second. Its `--compare off.json on.json` mode is pure arithmetic over two
saved runs and needs no database.

**These probes never write to section 7 and never move the origin in section 2.** The recent
retrieval decisions (IDX-002A, IDX-002B, IDX-003, IDX-004) rested on them. That records what
the evidence actually was, and at what n; it does not promote the probe to a gate.
