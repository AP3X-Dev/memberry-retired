# MemBerry Evaluation Lab

The lab is the permanent measurement spine for MemBerry changes. It preserves the
pre-lab quality results as an immutable control, runs deterministic protected
scenarios in pull requests, and provides a fail-closed adapter for disposable live
MCP environments.

## Evidence tiers

| Mode | Purpose | What it proves |
|---|---|---|
| `fixture` | Frozen BM25/recency controls | Evaluator and gate sensitivity |
| `proxy` | Fast candidate inner loop | Deterministic behavior of the proxy only |
| `live` | MCP + Redis + Neo4j integration | The exercised production path |

Proxy scores are never labeled as live MemBerry results. An unsupported capability,
adapter failure, and a real zero score are separate outcomes. Empty responses fail
the joint recall and answer-coverage gates and cannot earn stale/isolation credit.

## Reading the scores

Lab scores are normalized from `0` to `1`; multiply by 100 for a percentage.
Higher is better except for rates named `leak`, `duplicate`, or `unknown`, where
`0` is ideal.

The current migrated retrieval report shows `answerCoverage = 0.8461538462` for
both the scope-aware BM25 control and the MemBerry proxy. That is `11 / 13`, or
84.615% of required answer units retrieved across 13 probes. More concretely, ten
probes were fully covered, two were half-covered, and one returned no answer. It
does **not** mean live MemBerry is 84.6% accurate, and it currently shows no lift
over this control (`delta = 0`).

| Metric | Plain-English meaning | Current proxy | Current control |
|---|---|---:|---:|
| Answer coverage / Recall@K | Required answer evidence retrieved | 0.8462 | 0.8462 |
| Precision@K | Fraction of returned items that were relevant | 0.5513 | 0.5513 |
| Reciprocal rank | How near the top the first relevant item appeared | 0.8846 | 0.8846 |
| nDCG@K | Overall relevance ordering quality | 0.8352 | 0.8352 |
| Stale leak rate | Returned items known to be stale | 0 | 0 |
| Isolation leak rate | Returned items from a forbidden project/tenant | 0 | 0 |

“Without MemBerry” must be named precisely:

- **No-memory control:** the agent receives no stored evidence. This is not yet
  part of the required migrated suite and will be added to comparison work.
- **Scope-aware BM25 control:** a simple lexical memory retriever with scope/time
  filtering. This is the current control shown above.
- **MemBerry proxy:** a deterministic inner-loop stand-in, not the live platform.
- **Live MemBerry:** real MCP, Neo4j, and Redis. The current live smoke proves
  wiring/isolation only; it is not yet a scored live retrieval comparison.

The external benchmark activation plan, including the future no-memory and live
comparisons, is tracked in [ROADMAP.md](ROADMAP.md).

## Data safety

- Committed fixtures are synthetic and attest that they contain no real user memory,
  credentials, customer data, or secrets.
- Adapter-visible inputs and scorer-only oracle labels live in separate files.
- External datasets are downloaded only through the registry-driven acquisition
  command. Unknown licenses, missing hashes, or unreviewed data fail closed.
- The live adapter is read-only unless `MEMBERRY_LAB_ALLOW_WRITES=true` is set.
  Writes use unique `project:memberry-eval-*` scopes and a visible
  `MEMBERRY_LAB_ID` marker.
- The public MCP API has no safe broad reset. The live adapter therefore does not
  claim cleanup capability and never deletes graph data. Disposable test stores are
  the preferred live environment.

## Common commands

```bash
# Protected temporal, stale, project, and tenant comparison
npm run bench:lab

# Contract, metric, adapter, registry, acquisition, and gate tests
npm run bench:lab:test

# Verify registry metadata and the immutable pre-lab baseline
npm run bench:lab:validate
npm run bench:lab:baseline:verify

# Mandatory deterministic CI comparison
npm run bench:lab:ci
```

The CLI also supports `--suite protected|retrieval|all`,
`--split dev|holdout|all`, `--run-id`, and `--output`. The migrated retrieval suite
retains known baseline weaknesses honestly; use it for comparison evidence rather
than weakening its oracle until it turns green.

## Live smoke test

Run this only against an explicitly disposable service stack:

```bash
MEMBERRY_LAB_TENANT_ID=lab \
MEMBERRY_LAB_API_TOKEN=lab-test-token \
MEMBERRY_LAB_MCP_URL=http://127.0.0.1:3101 \
MEMBERRY_LAB_ALLOW_WRITES=true \
npm run bench:lab:live
```

The command fails when any opt-in setting is absent. It stores one uniquely marked
synthetic fact and verifies the exact episodic record through scoped `berry_grep`,
which works without an embedding provider. This smoke proves MCP/database wiring
and isolation; scored live queries still use `berry_load` and must report the real
retrieval result. The adapter also confirms it does not claim destructive cleanup.

## Adding a scenario

1. Put memories and query text in an `*-inputs.ts` or `input.jsonl` file.
2. Put relevance, required, stale, and forbidden IDs in the paired scorer-only
   oracle file.
3. Assign `dev` or `holdout`; never tune candidate logic against holdout labels.
4. Declare only capabilities the scenario genuinely requires.
5. Add hand-calculated metric expectations and one deliberate-regression test.
6. Update the dataset registry hash and data-policy attestation.

Adapters receive only `IngestRequest` and `QueryRequest`; the runner owns all oracle
data. New candidates must have a distinct identity and implementation from the
frozen control.

## Artifacts and reproducibility

Each comparison records the source and baseline commits, dirty state, normalized
dataset/config hashes, seed, runtime, execution identities, exclusions, capability
gaps, and metric deltas. Diagnostic configuration is recursively secret-redacted.
The report, manifest, and JSON comparison publish as one immutable directory rename;
an existing run ID is never overwritten.

The pre-lab baseline is locked under `baselines/` and verified from Git object bytes,
so later dead-code cleanup does not erase the evidence needed to reproduce it.

Deferred external benchmark work is governed by [ROADMAP.md](ROADMAP.md), not by
an informal TODO. LongMemEval and LoCoMo remain fail-closed until its activation
packets and approvals are complete.

## Layout

```text
bench/lab/
  adapters/     frozen controls, proxy candidate, opt-in live MCP adapter
  baselines/    immutable pre-lab manifest, lock, comparison policy
  contracts/    versioned adapter, scenario, report, and manifest contracts
  datasets/     synthetic input/oracle splits and registry-driven acquisition
  fixtures/     committed protected and migrated behavioral scenarios
  registry/     datasets, systems, metrics, and default-off experiments
  ROADMAP.md    deferred dataset activation packets and acceptance gates
  __tests__/    golden metrics, hostile regressions, contract boundaries
```
