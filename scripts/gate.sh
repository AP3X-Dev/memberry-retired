#!/bin/sh
# Full local gate in a pinned Node container.
#
#   ./scripts/gate.sh 20 /path/to/worktree
#   ./scripts/gate.sh 22 /path/to/worktree
#
# Runs install, the workspace suite, the evaluation lab, and the build, writing one log per stage
# into the worktree and echoing an *_EXIT line into each.
#
# ---------------------------------------------------------------------------
# WHY --user, AND WHY npm ci RUNS UNDER IT TOO
#
# Running this as the container's default root against a host-owned worktree produced THIRTEEN of
# the fourteen lab failures that looked like product defects for three consecutive gates. Those
# thirteen were not defects: they were `fatal: detected dubious ownership in repository at '/w'`
# — git refuses a repo owned by a different uid. (The FOURTEENTH is a different matter and is NOT
# explained by anything in this section — see ONE KNOWN-RED TEST below. Nothing here says it is
# not a product defect.) `git config --global --add safe.directory` does NOT fix it here: the lab's sandbox
# spawns git with a sanitised environment, so HOME is unset and the global config is never read.
#
# Matching the container uid to the worktree owner removes the mismatch at the source. But npm ci
# must run under the SAME uid, or node_modules ends up root-owned and the tests fail the other way,
# on EACCES writing node_modules/.cache. Both halves are required; either alone trades one failure
# mode for the other.
#
# ---------------------------------------------------------------------------
# ONE KNOWN-RED TEST. CAUSE ESTABLISHED 2026-08-28: A SPAWN TIMEOUT UNDER LOAD.
#
# This block used to blame a missing `docker` CLI. That was withdrawn (grep finds no docker in the
# test or in the gate it loads, and the lab's docker spawns sit behind candidate/live.ts and
# candidate-v3/live.ts, which are their own CI steps and unreachable from `vitest run bench/lab`).
# Then somebody read the logs, which is all it ever needed.
#
# THE TWO ARMS FAIL ON DIFFERENT TESTS:
#   node:20  bench/lab/admission-features/scorer-only/__tests__/blinded-holdout-v2.test.ts
#            "loads the assembled v2 policy through the real preflight CLI" -> timed out in 5000ms
#   node:22  bench/lab/ret010/__tests__/dev-gate.test.ts:2199
#            "runs the exact production finalize CLI..." -> spawnSync node ETIMEDOUT (errno -110)
#
# Same class both times: a short hard timeout around spawning a Node subprocess. The node:22 case
# allows timeout: 3_000 (dev-gate.test.ts:2196); the node:20 case is vitest's default 5s. That one
# file carries seven such 2-3s spawn budgets, so WHICH test trips depends on machine load, not on
# any defect. Both arms reported "Tests 1 failed | 2116 passed", at 160-220s of test time on a
# 4-core box measured at load 2.83.
#
# That is why this looked like one stable known-red test for three packets: stable in COUNT,
# unstable in IDENTITY. Nothing is missing from this container — the budgets are simply too tight
# for it under parallel load. The real fix is to raise those budgets or serialise the lab run, not
# to filter anything out.
#
# CORRECTED 2026-08-29: LAB_EXIT=1 IS NOT THE STEADY STATE. LAB_EXIT=0 IS.
#
# Measured this date on node:22, clean worktree, nothing else competing for the box:
# LAB_EXIT=0, `Test Files 68 passed (68)`, `Tests 2117 passed (2117)`. The lab is not
# unconditionally red, and the earlier "expected steady state" wording was wrong — it taught the
# reader to expect a failure, which is exactly how a real regression gets waved through.
#
# The lab goes red under two SEPARATE and independently avoidable conditions:
#   1. Parallel load, which trips one of the seven tight spawn budgets above (this block).
#      Load-dependent, so the identity of the failing test moves. RESEARCH-LEDGER.md RL-017.
#   2. A dirty worktree, which makes the RET-010 custody check reject before opening a handle.
#      Deterministic, reproduces in under a second, and reports as `expected [] to have a
#      length of 62`. RESEARCH-LEDGER.md RL-020, and the preflight warning below.
#
# Both had been running together, which is why the count looked stable at one while the identity
# moved. Remove both — clean tree, one gate at a time — and the correct expectation is ZERO
# failures. Read any failure; do not budget for one in advance. And do not "fix" this by
# filtering the test out — a gate you have taught to ignore its own output is the thing this
# whole comment exists to prevent.
set -eu

NODE_MAJOR="${1:?usage: gate.sh <node-major> <worktree>}"
WORKTREE="${2:?usage: gate.sh <node-major> <worktree>}"

OWNER_UID="$(stat -c %u "$WORKTREE")"
OWNER_GID="$(stat -c %g "$WORKTREE")"
echo "gate: node:${NODE_MAJOR}  worktree=${WORKTREE}  user=${OWNER_UID}:${OWNER_GID}"

# A DIRTY WORKTREE FAILS THE RET-010 CUSTODY TESTS, AND THE FAILURE DOES NOT LOOK LIKE ONE.
#
# `bench/lab/ret010/dev-gate.cjs` pinPaths()/auditPinnedPaths() open with
#   git rev-parse HEAD ... || git status --porcelain=v1 --untracked-files=all != '' -> reject()
# so the finalizer refuses to pin sources it cannot prove match HEAD. That is the point of the
# gate and is correct. But it rejects BEFORE opening a single file handle, so the test that
# counts handles reports `expected [] to have a length of 62` -- which reads as a product defect
# and is really one stray edited file anywhere in the tree.
#
# Demonstrated 2026-08-29: appending one comment line to an unrelated source file flips
# "drains every retained finalizer owner once after an injected close failure" from pass to fail,
# and `git checkout --` flips it straight back.
#
# Note `git clean -fd` is NOT sufficient to get here -- it removes untracked files but leaves
# MODIFIED TRACKED ones, which is exactly the state that bites. This warns rather than refuses,
# because running the gate on a work-in-progress tree is otherwise legitimate.
DIRT="$(git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all 2>/dev/null)"
if [ -n "$DIRT" ]; then
  echo "gate: WARNING -- worktree is NOT clean. The RET-010 custody tests will fail on this,"
  echo "gate:            and the failure will look like a product defect. It is not one."
  echo "$DIRT" | sed 's/^/gate:            /'
fi

docker run --rm --network host \
  --user "${OWNER_UID}:${OWNER_GID}" \
  -e HOME=/tmp \
  -v "$WORKTREE":/w -w /w "node:${NODE_MAJOR}" sh -c "
  npm ci --no-audit --no-fund > /w/install.log 2>&1; echo INSTALL_EXIT=\$? >> /w/install.log;
  npm test                    > /w/ws.log      2>&1; echo WS_EXIT=\$?      >> /w/ws.log;
  npx vitest run bench/lab    > /w/lab.log     2>&1; echo LAB_EXIT=\$?     >> /w/lab.log;
  npm run build               > /w/tsc.log     2>&1; echo TSC_EXIT=\$?     >> /w/tsc.log;
" > "$WORKTREE"/docker.log 2>&1 || true

echo "--- exits ---"
for f in install ws lab tsc; do
  grep -oE '[A-Z]+_EXIT=[0-9]+' "$WORKTREE/$f.log" 2>/dev/null || echo "${f}: no log"
done

echo "--- workspace suite totals (summed across all workspaces) ---"
grep -oE '^ *Tests +.*' "$WORKTREE/ws.log" 2>/dev/null \
  | grep -oE '[0-9]+ (passed|failed|skipped)' \
  | awk '{s[$2]+=$1} END {for (k in s) print k, s[k]}'

echo "--- lab failures (expected: ZERO on a clean tree with no competing run -- see the header) ---"
grep -oE '^ *Tests +.*' "$WORKTREE/lab.log" 2>/dev/null | tail -1
