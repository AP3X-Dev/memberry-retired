# Known Limitations

This document lists the gaps in MemBerry that are mechanically discoverable in this repository, so
that they are disclosed rather than found. It is the counterpart to [`SECURITY.md`](SECURITY.md) and
[`THREAT-MODEL.md`](THREAT-MODEL.md) (what the system defends and what it does not) and to
[`RESEARCH-LEDGER.md`](RESEARCH-LEDGER.md) (what was measured and deliberately deferred).

**Rules this file follows.** Every number carries the command that produced it, the date it was taken,
and the commit it was taken at. Nothing is stated that was not measured or cannot be read out of a
named file in this repository. Where a limitation has no plan, it says so.

**All numbers below were measured on 2026-09-02 at commit `2bf8389`**, from a clean checkout, with the
repository root as the working directory. Commands are POSIX shell.

---

## 1. Evaluation coverage

MemBerry's evaluation is retrieval-quality-heavy. The metrics that exist are ranking metrics —
Answer@1, Answer@5, and MRR in the outcome probe (`bench/eval/run-outcome-probe.mjs:210`), success@k
in the multi-hop lab. **There is no end-to-end agent task-success metric**: nothing in this repository
measures whether an agent using MemBerry completes a task it would otherwise fail.

There are also **no external baselines**. The lab's system registry has 15 registered systems:

```sh
node -e "const s=require('./bench/lab/registry/systems.json').systems;console.log(s.length);for(const x of s)console.log(x.id,x.fidelity)"
# 15
```

Twelve of the fifteen are MemBerry itself in some configuration (proxy, retrieval core, reranker
on/off, funnel, multi-hop, admission, live MCP). The other three — `bm25-baseline-v1`,
`scope-aware-bm25-control-v1`, `recency-baseline-v1`, all in `bench/lab/adapters/baselines.ts` — are
internal lexical and recency controls over the same fixture corpus.

There is no no-memory arm, no plain-context-files arm, no vector-RAG arm, no other agent-memory
system, and no same-agent-with-a-larger-context-window arm.

**What this means, stated plainly: the numbers this project reports do not establish a comparison
against alternatives.** They measure MemBerry's retrieval against MemBerry's own controls. A reader
should not read "Answer@5 improved" as "better than not using MemBerry", because that experiment has
not been run.

**Why.** The lab was built to catch retrieval regressions in a system under active change, and it
does that. A task-success benchmark and external baselines are a different and much larger piece of
work: they need a task suite, an agent harness, and a scoring rule that is not the retrieval metric
in disguise.

**Plan.** Not scheduled. This is owner-level program work, not a maintenance item, and no design for
it exists in the repository today.

---

## 2. Corpus size

Every dataset here is small enough that individual cases move the headline number.

**Outcome cases** — 46 total, 36 memory-plane, 10 code-plane:

```sh
node -e "const l=require('fs').readFileSync('bench/eval/outcome-cases.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s));const c=l.filter(x=>(x.plane??'code')==='code').length;console.log('total',l.length,'code',c,'memory',l.length-c)"
# total 46 code 10 memory 36
```

The memory-plane subset is what `run-outcome-probe.mjs --memory-only` selects (a case with no `plane`
field defaults to `code`; see `bench/eval/run-outcome-probe.mjs:59-62`). It is used as a pass/fail
gate against the maintainer's live graph. At 36 cases, one case is 2.8 percentage points.

**EVAL-001 real-query set** — 34 questions were selected, 9 survived blind authoring, 25 could not be
grounded and remain unauthored:

```sh
wc -l bench/eval/eval001-questions.jsonl bench/eval/eval001-pending.jsonl
#  9 bench/eval/eval001-questions.jsonl
# 25 bench/eval/eval001-pending.jsonl
# 34 total
grep -o '"split":"[a-z]*"' bench/eval/eval001-questions.jsonl | sort | uniq -c
# 4 "split":"dev"
# 5 "split":"holdout"
```

A 5-question holdout is far below what the governing spec assumed; `bench/eval/HOLDOUT-OPENS.md:142`
records that discrepancy rather than papering over it. The selection is also deliberately biased:
`bench/eval/SELECTION-RULE.md:123` declares code-plane over-sampling as a choice, and
`bench/eval/BASELINE.md:369` records the consequence for what the set can measure.

**Multi-hop v4** — dev 60, holdout 100, calibration 45, twin 30:

```sh
wc -l bench/lab/datasets/multihop/v4/*/input.jsonl
#  45 .../calib/input.jsonl
#  60 .../dev/input.jsonl
# 100 .../holdout/input.jsonl
#  30 .../twin/input.jsonl
# 235 total
```

**Holdout discipline, honestly.** Two different disciplines are in force and they are not equally
strict.

- The multi-hop holdouts under `bench/lab/datasets/*/holdout` are **sealed**: the working rules for
  this repository forbid reading or modifying them during ordinary development, and every accepted
  and rejected arm in `RESEARCH-LEDGER.md` reports its number on `dev`, not on holdout. The dev set
  is therefore repeatedly tuned against and its numbers are optimistic by construction. RL-025 in
  `RESEARCH-LEDGER.md` is a direct example: an arm that moved dev 28/60 to 40/60 was rejected because
  it traded 19 improvements for 7 regressions.
- The EVAL-001 holdout is **not sealed**. It is explicitly a repeatable regression check governed by
  a rate rule and an append-only ledger (`bench/eval/HOLDOUT-OPENS.md:16-31`), which bounds how often
  it is opened but does not make it a one-shot instrument. `HOLDOUT-OPENS.md` says this in its own
  words and the file should be read before any EVAL-001 number is trusted.

**Why.** These corpora are hand-authored against a real graph, with a rule
(`bench/eval/run-eval001.mjs:258`) that refuses to run on questions whose expected answers were
guessed. That rule is the reason 25 of 34 questions are still unauthored: authoring is the
bottleneck, not collection.

**Plan.** No target size is scheduled. Growth is opportunistic and each addition is recorded in the
selection log.

---

## 3. Build and runtime: a dependency cycle, and the image does not run what it builds

`@memberry/core` and `@memberry/neo4j` have a type-level circular dependency. Cross-package runtime
resolution is therefore wired through `src`, and the production image runs TypeScript sources under
`tsx` rather than the `dist/` it compiled. The repository states this itself, at `Dockerfile:9-11`:

```
# Why tsx and not `node dist`: @memberry/core and @memberry/neo4j share a
# type-level circular dependency, so cross-package runtime resolution is wired
# through src (see each package's "exports"). tsx is the supported runtime and is
```

The build stage still compiles every package (this is what validates the build and emits `.d.ts`),
and `Dockerfile:85` is `CMD ["node_modules/.bin/tsx", "packages/mcp/src/server.ts"]`.

Consequences, stated without softening: `tsx` is a **runtime** dependency, not a dev dependency; the
compiled `dist/` output is validated but not the artifact that serves traffic; and startup pays
transpilation. `npx tsc -b tsconfig.build.json` is the type gate, so type errors are still caught —
but the type gate and the execution path are not the same artifact.

**Why.** The cycle is real and load-bearing; breaking it means moving shared types into a third
package and updating every import in both, which is a large mechanical change with a wide blast
radius across all ten workspaces.

**Plan.** Not scheduled. This is disclosed, not fixed. The work that produced this document put the
fix explicitly out of its own scope, so nothing is in flight.

---

## 4. Module size

Six modules are over 1,700 lines and three are over 2,500. Non-test source only:

```sh
git ls-files 'packages/*/src/*.ts' 'packages/*/src/**/*.ts' | grep -v __tests__ | sort -u \
  | xargs wc -l | grep -v ' total$' | sort -rn | head -7
```

| Lines | File                                            |
| ----- | ----------------------------------------------- |
| 2832  | packages/retrieval/src/trace.ts                 |
| 2665  | packages/retrieval/src/assembler.ts             |
| 2550  | packages/wiki/src/viewer.ts                     |
| 2049  | packages/neo4j/src/evidence-authority-ledger.ts |
| 1789  | packages/mcp/src/tools.ts                       |
| 1740  | packages/core/src/service.ts                    |
| 1501  | packages/core/src/consolidation.ts              |

For scale, the tracked TypeScript/JavaScript tree is 225,331 lines across 778 files:

```sh
git ls-files '*.ts' '*.mts' '*.mjs' | xargs cat | wc -l   # 225331
git ls-files '*.ts' '*.mts' '*.mjs' | wc -l               # 778
```

**Why.** These files grew with the features they carry (`trace.ts` is the versioned retrieval trace
contract, `assembler.ts` the ranking and budgeting pipeline, `viewer.ts` a server-rendered UI).
Nothing forced a split, and splitting a file that is pinned by contract tests is a diff with real
regression risk and no behavioural payoff.

**Plan.** Not scheduled. Decomposition is explicitly out of scope for the current work, because a
rename-and-move diff of this size destroys the reviewability of every other change made alongside it.

---

## 5. Configuration surface

MemBerry reads 99 distinct `MEMBERRY_*` environment variables:

```sh
grep -c "^  f('MEMBERRY_" packages/core/src/config/flags.ts   # 99
```

`packages/core/src/config/flags.ts` is the single source of truth for that list — name, kind,
default, owning package, and a one-line description for each. It is not documentation that can drift:
`packages/core/src/__tests__/flags.inventory.test.ts` greps `packages/*/src` and fails both ways — a
read of an undeclared `MEMBERRY_*` name fails naming it, and a declared flag whose last read site was
deleted fails as stale.

The raw grep over non-test source finds 104 distinct tokens:

```sh
grep -rhoE "MEMBERRY_[A-Z0-9_]+" packages/*/src --include=*.ts --exclude-dir=__tests__ | sort -u | wc -l   # 104
```

The difference is 5 tokens that are provably not environment variable names; they are enumerated with
their reasons in `NOT_ENV_NAMES` at `packages/core/src/__tests__/flags.inventory.test.ts:31-36`.

Ninety-nine flags is a large surface for a single-operator system. Many are staging toggles for
retrieval experiments that are default-off in production, which is why they exist and also why the
count keeps rising: an experiment adds a flag and nothing forces its removal when the experiment ends.

**Why.** The project ships behind default-off flags so that a retrieval change can be measured in
place before it becomes the default. That discipline is deliberate and is what the research ledger
depends on.

**Plan.** The inventory is done and enforced (that is the mechanism above; it landed as backlog item
20a). **Reduction is not scheduled** — no flag has a retirement date, and there is no rule today that
removes a flag when its experiment concludes.

---

## 6. Evaluation machinery sprawl

The multi-hop evaluation exists in **four generations** that all still live in the tree:

```sh
ls bench/lab/datasets/ | grep -c "load-multihop"   # 4
ls bench/lab/datasets/multihop/                    # v1 v2 v3 v4
```

`bench/lab/multihop/` correspondingly carries `policy.ts`, `policy-v2.ts`, `policy-v3.ts`,
`policy-v4.ts` and matching `scorer-only-*` and `qualify-control-*` files. Only v4 is current.

There are 23 `bench:lab:*` npm scripts, out of 40 scripts total:

```sh
node -e "const k=Object.keys(require('./package.json').scripts);console.log(k.length,k.filter(x=>x.startsWith('bench:lab:')).length)"
# 40 23
```

**Why.** Each generation is kept because the ledger entries that cite it name a specific dataset
version, and deleting the dataset would make the recorded result unreproducible. That is a real
reason, but it does not require keeping every generation's scripts wired into `package.json`.

**Plan.** Consolidation is intended — collapse the superseded generations to datasets-plus-ledger and
drop their runner scripts — but **it is not scheduled and no consolidation spec exists**.

---

## 7. Performance: query latency, and whose property it is

The code plane (AST symbol search) is measurably slower than the memory plane on the maintainer's
test box. The probe client aborts a request at 30 seconds (`bench/eval/mcp-client.mjs:36`), and code-plane
cases on that host have hit it.

**This document deliberately quotes no code-plane latency figure, because the figures that exist are
a property of that box and not of this system, and because no artifact in this repository records
one.** Publishing them as a MemBerry characteristic would be wrong in both directions: it would
overstate the problem for anyone running on adequate hardware, and it would understate how well the
underlying cause is understood.

The cause is known and is infrastructure, not code. Neo4j is started with the sizing in
`docker-compose.yml:27-29`:

```
NEO4J_dbms_memory_heap_initial__size: "256m"
NEO4J_dbms_memory_heap_max__size: "512m"
NEO4J_dbms_memory_pagecache_size: "256m"
```

On the maintainer's test host that container runs against a store several gigabytes in size, on a
4-core machine that is simultaneously hosting a large number of unrelated containers. A 256 MB page
cache against a multi-gigabyte store means code-plane traversals read from disk on a contended host.
The store size and the host's container count are properties of that machine; they are **not**
recorded in this repository and cannot be reproduced from it, so no figure for either is given here.

The one latency benchmark that _is_ in the repository, `bench/latency/RESULTS.md`, does not measure
this and does not claim to: it drives mock layers with injected latencies (`redis=1ms, neo4j=8ms,
embedApi=120ms`) to isolate request phasing. It is a phasing experiment, not an infrastructure
measurement.

**Plan.** The sizing change is tracked as SPR-013 / blocked item B-1 in the maintainer's loop state
(not in this repository, and therefore not citable here) and is blocked on an owner decision, because
raising the page cache on that host is a production infrastructure change rather than a code change.
Until it lands, code-plane latency numbers from that host are treated as uninformative about the
system and are not ratcheted.

---

## What is enforced today

For completeness, since the sections above are about what is missing — this is the current mechanical
floor, not a claim of achievement:

- **Lint.** `npm run lint` (ESLint flat config at `eslint.config.mjs`) is enforced at 0 errors and
  ends `✖ 469 problems (0 errors, 469 warnings)`. The warning count is ratcheted down-only; it is not
  zero, and `eslint.config.mjs:78-134` downgrades `@typescript-eslint/no-unused-vars` to a warning for
  an enumerated list of 38 pre-existing files. That list is down-only by construction and the block is
  deleted when it empties.
- **Format.** `npm run format:check` is check-only, behind an ignore list that starts closed. Existing
  source is deliberately **not** formatted; only files added from that point on opt in. See the
  comment at the top of `.prettierignore`.
- **Test inventory.** 407 test files are pinned in
  `packages/core/src/__tests__/test-files.manifest.txt` (`wc -l < packages/core/src/__tests__/test-files.manifest.txt`).
  A test file that disappears fails the suite naming the missing path, so a deletion has to be a
  visible line in a diff.
- **Type gate.** `npx tsc -b tsconfig.build.json` at 0 errors.

None of these measure whether the system is _good_. They measure that it has not silently gotten
worse, which is a much weaker claim and the only one they support.
