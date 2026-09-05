# EVAL-001 — holdout opens ledger

**Append-only. Entries are never edited, reordered, or deleted.**

Every open of the `holdout` split gets one entry, appended at the bottom of the table in
section 5. A mistaken entry is corrected by appending a correction entry that names the row
it corrects — never by changing the original row.

Governed by spec
[`docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md`](../../docs/agent-runs/specs/2026-08-26-eval001-real-query-evaluation.md)
§3.2.1.

---

## 1. THE RATE RULE

> **The holdout may not be reopened until the previous open's result has been ACTED ON —
> merged, or explicitly reverted and recorded as such.**

Back-to-back opens against successive tweaks of the same unmerged change are exactly the
prohibited loop. If the last entry in section 5 has no recorded action, the holdout is
**closed**, and the correct next step is to keep working against `dev`.

"Acted on" means one of exactly two things, and both are recorded in the entry:

- **merged** — the change landed, with the merge commit or PR named; or
- **reverted** — the change was abandoned or backed out, said so explicitly, and recorded
  here as reverted. A change that was quietly dropped is not reverted; it is unresolved, and
  the holdout stays closed until someone writes down which it was.

Anything else — "still iterating", "one more tweak", "just checking whether the fix helped" —
is not an action, and the holdout stays closed.

There is **no burn and no one-shot ceremony.** This is a regression suite, not a sealed
instrument. The ledger makes the frequency visible; the rate rule makes it bounded. That is
deliberately lighter than the LAB-012/013 single-look joined-qualification discipline,
because that ceremony protects a one-shot gate and this protects a repeatable check.

## 2. Why — the overfitting this prevents

The overfitting risk here is inverted from golden v2's. There, the corpus was tuned to hit a
difficulty band. Here **the corpus is fixed and the SYSTEM is what gets tuned**, so
repeatedly tuning against visible questions is measuring on train: after enough looks, the
retrieval changes stop being general improvements and start being fitted to these particular
questions, and the score rises while real retrieval does not. The holdout is the part of the
question set that stays unseen so that it can still say something. Each open spends a little
of that; opening it once per acted-on change keeps the spending bounded and, more
importantly, keeps it *counted*.

An earlier draft of the spec said "no burn rule… that should be visible in the log" while
specifying no log. That is an intention, not a control. This file is the control.

## 3. Aggregate only — what an entry may and may not contain

An entry records the **closed aggregate only**. Per-question holdout results are never
recorded — not here, not in a PR, not in a commit message, not in a run artifact, not in
chat.

The runner enforces the same boundary: `run-eval001.mjs` emits the per-question
`EVAL001 split=dev question=…` lines for `dev` **only**, and writes
`"(withheld: holdout is aggregate-only)"` in place of the per-question results when
`--split holdout`. Do not work around that to see which holdout question failed. Knowing
*which* question failed is precisely what lets a change be fitted to it, and it converts the
holdout into a second dev split with one look's delay.

If a holdout number is confusing, the permitted response is to reason about the change, or
to add a *new* question from a real failure case per spec §3.3 — not to inspect the holdout.

**Each entry contains, and contains only:**

| field | notes |
|---|---|
| date | ISO 8601 |
| git SHA | the SHA the run was executed against |
| change tested | what was being confirmed, one line |
| `keywordRecall@5`, `keywordRecall@10` | split-level aggregate |
| `testFileRate@5`, `testFileRate@10` | split-level aggregate |
| `nonRetrieval`, `grammarMisses` | counts; nonzero means partially-measured run |
| Δ vs prior open / Δ vs origin | both, always — `BASELINE.md` §3 |
| action taken | `merged <ref>` or `reverted <ref>` — the rate-rule unlock |

## 4. The current holdout

**13 questions SELECTED, 5 SURVIVING** (2 code-plane, 3 memory-plane — `eval001-h-05`,
`-h-06`, `-h-16`, `-h-31`, `-h-32`). Blind keyword authoring plus a strict second reviewer
removes questions whose ground truth cannot be established outside MemBerry, and that
attrition was severe: 25 of the 34 selected questions were removed, and the 9 survivors
split 4 dev / 5 holdout. See the entry-1 notes in section 5 for what n = 5 does and does
not buy.

Assigned mechanically by [`SELECTION-RULE.md`](SELECTION-RULE.md) §6 as amended by A2 —
stratify by plane, walk `code → mixed → memory`, one 3-dev / 2-holdout cycle with a cursor
that does not reset between strata. `dev` is 21 selected. The mixed
stratum (n = 3) lands 3 dev / 0 holdout: three items cannot be split 60/40 without rounding,
and this is an accepted wart, not an omission.

Nobody chooses which question goes where, and re-running the selector on the same mined
population reproduces the assignment byte for byte.

The holdout grows only through SELECTION-RULE §8 — real failure cases appended with their
keywords and provenance. **A question is never removed to raise a score.** If the holdout
composition changes, that is recorded as its own entry in section 5 with no metrics, so the
composition at each open is recoverable.

## 5. Entries

### EXAMPLE ENTRY — NOT A REAL RUN, NOT A RESULT, DO NOT CITE

Illustrates the required shape. The numbers below are **invented for illustration only** and
are not measurements of anything. Delete nothing; real entries are appended below this block.

> **2026-09-04 · `abc1234` · code-plane symbol-kind demotion in candidate ranking**
>
> Confirming a change developed against `dev`, whose a priori justification was "a local
> variable is not a better answer than the class it lives in". Holdout opened once, after
> `dev` showed no regression.
>
> | metric | this open — EXAMPLE, INVENTED | Δ vs prior open | Δ vs origin |
> |---|---|---|---|
> | `keywordRecall@5` | 0.6042 | +0.0208 | +0.0625 |
> | `keywordRecall@10` | 0.7188 | +0.0104 | +0.0521 |
> | `testFileRate@5` | 0.3250 | −0.0250 | −0.1000 |
> | `testFileRate@10` | 0.3625 | −0.0125 | −0.0875 |
>
> `nonRetrieval` 1 of 8 (planner `runtime_query_planner:invalid_request`, excluded from
> scoring, not counted as zero) · `grammarMisses` 0 · flags unchanged from `BASELINE.md` §2.2
>
> **Action taken:** merged — PR #999, 2026-09-05. Holdout reopens permitted after this point.

### Real entries

| # | date | git SHA | change tested | kwRecall@5 (Δprior / Δorigin) | kwRecall@10 (Δprior / Δorigin) | testFileRate@5 (Δprior / Δorigin) | testFileRate@10 (Δprior / Δorigin) | nonRetrieval | grammarMisses | action taken |
|---|---|---|---|---|---|---|---|---|---|---|

| 1 | 2026-08-27 | `a1439fb` (deployed `3eba9a9`, code-identical) | **origin baseline** | 0.1000 (— / —) | 0.3000 (— / —) | 0.0000 (— / —) | 0.0000 (— / —) | 0 | 0 | origin pinned in `BASELINE.md` §2.6 |
| 2 | 2026-09-05 | `f1afe29` (deployed `037247c`, code-identical) | **origin 2 re-pin** (§3.2 conditions 1+2: re-index of project:memberry 2026-09-04; flags #118/#119/#123 and RL-018 #130) | 0.2000 (— / —) | 0.2000 (— / —) | 0.0000 (— / —) | 0.0000 (— / —) | 0 | 0 | origin 2 pinned in `BASELINE.md` §2.6; origin 1 retained in §6 |

**Opened twice: the origin baseline, 2026-08-27; the origin-2 re-pin, 2026-09-05.**

**Entry 2 notes.** A re-pin is itself an origin, so both delta columns read `—` again; no delta crosses the origin boundary. Attempt 1 of this open aborted on a client 30 s timeout during a consolidation burst on the box and yielded no numbers; the retry after the burst is the recorded run (`BASELINE.md` §2.5). Rate rule: this open is ACTED ON by the pin itself, so the holdout may be reopened for the next change.

**Entry 1 notes.** The origin open is the one open that has no prior and no origin to compare
against — it *is* the origin, so both delta columns read `—`.

Holdout n = 5 (2 code-plane, 3 memory-plane), not the 6–10 spec §3.2 assumes. Blind keyword
authoring plus an independent second reviewer removed 25 of 34 selected questions, and the
survivors split 4 dev / 5 holdout. **At this size the holdout does not provide the statistical
protection §3.2.1 describes** — it is an honest sealed set, but a small one. Treat a change in
these numbers as a smoke signal, not evidence.

`testFileRate` is 0.0000 on both k for a structural reason worth recording so nobody reads it
as "the test-file problem is fixed": the holdout's two code-plane questions are
`berry_code_search` calls scoped to **neuri** and **scribo-agent**, and its three memory-plane
questions return memory blocks that carry no file path at all. **No holdout question scores
against the `project:memberry` index**, which is the one measured at 50.9% test-file
contamination. The dev split, which does include `berry_context` against memberry, reads
`testFileRate@5 = 0.1333` and `@10 = 0.2000`.

**Rate rule status:** this open is ACTED ON — the origin is pinned in `BASELINE.md` §2.6 and
committed. The holdout may be reopened for the next change.


The first real entry will be the origin baseline run itself (`change tested = origin
baseline`, `action taken = origin pinned in BASELINE.md §2.6`), because taking the origin
baseline reads the holdout and therefore counts as an open like any other.
