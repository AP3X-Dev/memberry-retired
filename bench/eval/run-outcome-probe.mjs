#!/usr/bin/env node
// EVAL-001B outcome probe — "did the right evidence come back, and how far down?"
//
// WHY THIS EXISTS ALONGSIDE run-eval001.mjs.
// keywordRecall@k asks whether a required term appears ANYWHERE in the top-k content. That is
// satisfiable by junk: a variable named `to` matching the word "to" in the question contains the
// token and scores a hit. This probe asks the question an agent actually cares about — is the
// file or memory item that answers me in the top 5? Code cases use file-level truth. Memory cases
// use adjudicated evidence ids, so the same Answer@k/MRR instrument measures Semantic, Episodic,
// Fact, and MemoryBlock retrieval instead of inventing another harness.
//
// Measured 2026-08-27 on the origin index: 0 of 4 answers in the top 5. The junk occupying those
// slots was single-word local variables whose names collide with ordinary English words in the
// question (`to`, `at`, `applied`, `budget`, `validated`). That is a finer-grained defect than
// the test-file contamination the roadmap named, and it is what IDX-002A and IDX-002 target.
//
// Usage: node bench/eval/run-outcome-probe.mjs [--project memberry] [--limit 10]
//
// ponytail: file-level truth only. No keyword sets, no splits, no holdout ceremony -- this is a
// diagnostic, not a gate. It complements EVAL-001; it does not replace it.

import { readFileSync } from 'node:fs'
import { createClient } from './mcp-client.mjs'

const TEST_PATH = /__tests__|\.test\.|\.spec\./
const EVIDENCE_ID = /<!--\s+([^\s>]+)\s+-->/g

function parseArgs(argv) {
  const args = {
    cases: 'bench/eval/outcome-cases.jsonl', project: 'memberry', limit: 10, plane: null, caseId: null, memoryOnly: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cases') args.cases = argv[i + 1]
    if (argv[i] === '--project') args.project = argv[i + 1]
    if (argv[i] === '--limit') args.limit = Number(argv[i + 1])
    if (argv[i] === '--plane') args.plane = argv[i + 1]
    if (argv[i] === '--case') args.caseId = argv[i + 1]
    if (argv[i] === '--memory-only') args.memoryOnly = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const token = process.env.MEMBERRY_API_TOKEN
if (!token) {
  console.error('OUTCOME fatal: MEMBERRY_API_TOKEN is not set')
  process.exit(2)
}

const allCases = readFileSync(args.cases, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const cases = allCases.filter((c) => {
  const plane = c.plane ?? 'code'
  return (!args.memoryOnly || plane !== 'code')
    && (args.plane === null || plane === args.plane)
    && (args.caseId === null || c.id === args.caseId)
})
if (cases.length === 0) {
  console.error(`OUTCOME fatal: no cases selected for plane=${args.plane ?? 'all'}`)
  process.exit(2)
}
const client = createClient(process.env.MEMBERRY_BASE_URL || 'http://192.168.0.25:3101', token)
const session = await client.connect()
const needsCode = cases.some((c) => (c.plane ?? 'code') === 'code')
if (needsCode && !session.codeDomainEnabled) {
  // The code tools are disabled by default; without them every case is unmeasurable rather than
  // wrong, and reporting zeros would be a fabricated collapse.
  console.error('OUTCOME fatal: code domain could not be enabled — every case would be unmeasurable')
  process.exit(2)
}

const rows = []
for (const c of cases) {
  const plane = c.plane ?? 'code'
  const isCode = plane === 'code'
  const tool = isCode ? 'berry_code_search' : (c.tool ?? 'berry_context')
  console.error(`OUTCOME progress case=${c.id} plane=${plane} tool=${tool}`)
  const queryField = tool === 'berry_grep' ? 'pattern'
    : tool === 'berry_ask' ? 'question'
      : 'task'
  const input = isCode
    ? { query: c.question, project_name: args.project, limit: args.limit }
    : {
        ...(c.input ?? {}),
        [queryField]: c.question,
        ...(c.input?.project_name === undefined ? { project_name: args.project } : {}),
      }
  let res
  try {
    res = await client.callTool(tool, input)
  } catch (error) {
    rows.push({ id: c.id, plane, error: String(error?.message ?? error).slice(0, 120) })
    continue
  }
  if (res.isError) {
    rows.push({ id: c.id, plane, error: res.text.slice(0, 500) })
    continue
  }
  let rank = -1
  let top5 = []
  if (isCode) {
    let items = []
    try {
      const parsed = JSON.parse(res.text)
      items = (Array.isArray(parsed) ? parsed : Object.values(parsed).flat()).filter(Boolean)
    } catch {
      rows.push({ id: c.id, plane, error: 'unparseable response' })
      continue
    }
    rank = items.findIndex(
      (x) =>
        String(x.file ?? '').includes(c.expectFile) ||
        (c.expectSymbol && String(x.name ?? '') === c.expectSymbol)
    )
    top5 = items.slice(0, 5)
  } else {
    const expected = new Set(c.expectEvidenceIds ?? (c.expectEvidenceId ? [c.expectEvidenceId] : []))
    if (expected.size === 0) {
      rows.push({ id: c.id, plane, error: 'memory case has no expected evidence id' })
      continue
    }
    const evidenceIds = []
    const seen = new Set()
    for (const match of res.text.matchAll(EVIDENCE_ID)) {
      const id = match[1]
      if (!seen.has(id)) {
        seen.add(id)
        evidenceIds.push(id)
      }
    }
    rank = evidenceIds.findIndex((id) => expected.has(id))
    top5 = evidenceIds.slice(0, 5)
  }
  let reranker = null
  if (!isCode && c.input?.include_trace === true) {
    for (const block of res.texts ?? []) {
      try {
        const parsed = JSON.parse(block)
        const event = Array.isArray(parsed?.events)
          ? parsed.events.find((candidate) => candidate?.kind === 'reranker-stage')
          : undefined
        if (event?.outcome === 'reranked' || event?.outcome === 'baseline') {
          reranker = event.outcome
          break
        }
      } catch { /* ordinary markdown block */ }
    }
  }
  rows.push({
    id: c.id,
    plane,
    rank: rank < 0 ? null : rank + 1,
    reranker,
    testInTop5: isCode ? top5.filter((x) => TEST_PATH.test(String(x.file ?? ''))).length : 0,
    variableInTop5: isCode ? top5.filter((x) => x.kind === 'variable').length : 0,
    top5: isCode
      ? top5.map((x) => `${x.name}(${x.kind})${TEST_PATH.test(String(x.file ?? '')) ? '[T]' : ''}`)
      : top5,
  })
}
await client.close()

const scored = rows.filter((r) => !r.error)
const at = (k) => scored.filter((r) => r.rank !== null && r.rank <= k).length
const mrr = scored.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / (scored.length || 1)
const fmt = (v) => v.toFixed(4)

console.log(`OUTCOME n=${scored.length} errors=${rows.length - scored.length} project=${args.project}`)
console.log(`OUTCOME answerAt1=${fmt(at(1) / (scored.length || 1))} answerAt5=${fmt(at(5) / (scored.length || 1))} answerAt10=${fmt(at(10) / (scored.length || 1))} mrr=${fmt(mrr)}`)
const rerankerEligible = scored.filter((r) => r.plane !== 'code' && r.reranker !== null)
const reranked = rerankerEligible.filter((r) => r.reranker === 'reranked').length
const baseline = rerankerEligible.filter((r) => r.reranker === 'baseline').length
const rerankerMissing = scored.filter((r) => r.plane !== 'code' && r.reranker === null).length
console.log(`OUTCOME rerankerEligible=${rerankerEligible.length} reranked=${reranked} baseline=${baseline} missing=${rerankerMissing}`)
const codeRows = scored.filter((r) => r.plane === 'code')
const codeShare = (f) => codeRows.reduce((a, r) => a + r[f], 0) / (codeRows.length * 5 || 1)
console.log(`OUTCOME variableShare5=${fmt(codeShare('variableInTop5'))} testFileShare5=${fmt(codeShare('testInTop5'))}`)
for (const plane of [...new Set(scored.map((r) => r.plane))].sort()) {
  const planeRows = scored.filter((r) => r.plane === plane)
  const planeAt = (k) => planeRows.filter((r) => r.rank !== null && r.rank <= k).length / (planeRows.length || 1)
  const planeMrr = planeRows.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / (planeRows.length || 1)
  console.log(`OUTCOME plane=${plane} n=${planeRows.length} answerAt1=${fmt(planeAt(1))} answerAt5=${fmt(planeAt(5))} mrr=${fmt(planeMrr)}`)
}
for (const r of rows) {
  if (r.error) {
    console.log(`OUTCOME case=${r.id} plane=${r.plane} ERROR=${r.error}`)
    continue
  }
  console.log(`OUTCOME case=${r.id} plane=${r.plane} rank=${r.rank ?? 'MISS'} reranker=${r.reranker ?? 'missing'} varTop5=${r.variableInTop5} testTop5=${r.testInTop5} top5=${r.top5.join(' ')}`)
}
