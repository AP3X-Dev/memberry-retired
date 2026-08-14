# Evaluation Lab Roadmap

This file tracks evaluation-lab work that is intentionally deferred but must not
be forgotten. A blocked dataset remains visible here and in
`registry/datasets.json`; it must never be treated as an executed benchmark, an
unsupported zero, or a silently skipped gate.

## External memory benchmark activation

**Roadmap target:** Phase 10, work package `CMP-006`, after phase gates G2
(Retrieval 2.0) and G5 (bitemporal semantics) pass.

**Current status:** blocked by design.

| Dataset | Registry ID | Current blocker | Activation constraint |
|---|---|---|---|
| LongMemEval-S Cleaned | `longmemeval-s-cleaned` | Upstream revision, artifact digest, and data review are unresolved | Do not enable until exact source bytes are pinned and reviewed |
| LoCoMo | `locomo10` | Non-commercial license approval, upstream revision, artifact digest, and data review are unresolved | Explicit human approval is required before any non-commercial dataset use |

### CMP-006A — Pin and approve source data

For each dataset, complete all of the following in one reviewable change:

- Pin an immutable upstream revision and immutable artifact URL.
- Record exact normalized size and SHA-256 from independently acquired bytes.
- Verify license identifier, source, and intended usage. LoCoMo's non-commercial
  terms require an explicit recorded approval; autonomous execution cannot infer it.
- Complete the privacy/data-policy review for personal data, secrets, customer
  data, retention, cache location, redistribution, and required exclusions.
- Record every rejected or excluded case with a reason; no silent exclusions.
- Change registry acquisition status from `blocked` only when every required
  field is concrete and its evidence is reviewable.

### CMP-006B — Build frozen dataset execution

- Add versioned input and scorer-only oracle loaders without exposing labels to
  candidate adapters.
- Freeze dev and holdout splits, transformations, prompts, scorer versions, and
  exclusion manifests. Hash both original and derived artifacts.
- Run the same accepted bytes and scenarios through control and candidate systems.
- Add negative tests for checksum mismatch, missing license/privacy approval,
  candidate oracle access, unsupported capability, and silent scenario exclusion.
- Prove a second offline run from the published cache produces the same normalized
  dataset and report hashes.

### CMP-006C — Execute and report

- Run LongMemEval and LoCoMo only after CMP-006A/B and gates G2/G5 are complete.
- Compare no-memory, scope-aware BM25, MemBerry proxy, and live MemBerry as
  distinct systems; never present proxy evidence as live product performance.
- Report coverage, answer quality, temporal correctness, stale leakage, isolation,
  latency, token/cost usage, failures, unsupported probes, and every exclusion.
- Include uncertainty/confidence intervals where the benchmark supports them.
- Identify exact commits, configs, runtime, hardware, dataset hashes, and adapter versions.
- Update this roadmap, `registry/datasets.json`, and the main PRP in the same
  closeout change; attach the final reproducibility artifacts.

### Activation gate

`CMP-006` is complete only when:

1. `npm run bench:lab:validate` passes with neither dataset marked `blocked`.
2. Network/source-file acquisition and a deliberate checksum-failure regression pass.
3. A cache-only rerun reproduces the same dataset and report hashes.
4. The report contains no unrecorded exclusions and no candidate access to holdout labels.
5. License and privacy approvals are recorded, including explicit LoCoMo usage approval.
6. The comparison report contains uncertainty and cost evidence and is independently reviewed.

Until then, these datasets remain registered and fail closed. Product work may
continue, but no release or comparison claim may imply that LongMemEval or LoCoMo
has been executed.
