# Evaluation registry

The registries are the fail-closed inventory for datasets, systems, metrics, and
experiments. `npm run bench:lab:validate` validates structure and also verifies
the normalized SHA-256 and size of every repository dataset required in CI.

Rules:

- Dev and holdout inputs are physically separate from scorer-only oracles.
- A required CI dataset must be bundled, reviewed, synthetic, and offline.
- External acquisition requires an immutable revision, verified license,
  reviewed exclusions, and a byte-level SHA-256.
- Unknown or restricted external data remains explicitly blocked; a missing
  prerequisite never becomes a skip or a zero score.
- Experiments are default-off and declare owner, control, and rollback.
- `fidelity` distinguishes proxy, fixture, and live evidence.

LongMemEval-S Cleaned and LoCoMo are intentionally registered as blocked. Their
metadata makes future work visible without claiming reproducibility that has
not yet been established. Their required Phase 10 activation packets, approvals,
and closeout procedure are tracked in [../ROADMAP.md](../ROADMAP.md).
