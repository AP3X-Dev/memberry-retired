#!/usr/bin/env node
// SPR-003 — "how often does naming a thing actually resolve?"
//
// The handoff (2026-08-29 §5a) hit runtime_query_planner:resolution_failed on 7 of 10 plausible
// entity names. If naming usually fails, the whole anchored berry_context path is moot. This
// quantifies it: one berry_context call per name, memory-only, grouped by name class.
//
// Usage: node bench/eval/resolver-probe.mjs [--project memberry] [--cases bench/eval/resolver-cases.jsonl]
//
// ponytail: memory-only (include_code false), so the code domain does not need enabling and a
// code-plane failure cannot be mistaken for a resolver miss.

import { readFileSync } from 'node:fs'
import { createClient } from './mcp-client.mjs'

const args = { project: 'memberry', cases: 'bench/eval/resolver-cases.jsonl' }
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--project') args.project = process.argv[i + 1]
  if (process.argv[i] === '--cases') args.cases = process.argv[i + 1]
}

const token = process.env.MEMBERRY_API_TOKEN
if (!token) { console.error('RESOLVER fatal: MEMBERRY_API_TOKEN is not set'); process.exit(2) }

const cases = readFileSync(args.cases, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const client = createClient(process.env.MEMBERRY_BASE_URL || 'http://192.168.0.25:3101', token)
await client.connect()

const TASK = 'Summarize what is known about this component.'
const PLANNER_ERROR = /runtime_query_planner:(invalid_request|resolution_failed|authentication_required|unavailable)(?::([a-z_]+))?/

// Planner errors arrive as HTTP 200 + isError:true with the code only in the text body
// (see NON_RETRIEVAL_ERRORS in mcp-client.mjs), so classify from the serialized response.
const classify = (res) => {
  const match = PLANNER_ERROR.exec(JSON.stringify(res.raw ?? '') + res.text)
  if (match) return `runtime_query_planner:${match[1]}${match[2] ? ':' + match[2] : ''}`
  if (res.isError || res.raw?.error) return 'other_failure'
  if (/\*\*Entity scope:\*\* unresolved \(entity_not_found\)/.test(res.text)) return 'fallback:entity_not_found'
  return 'resolved'
}

const byClass = new Map()
const failures = []

for (const c of cases) {
  const res = await client.callTool('berry_context', {
    project_name: `project:${args.project}`,
    entity_scope: [c.name],
    task: TASK,
    include_code: false,
    include_memory: true,
    max_tokens: 2000,
    include_trace: false,
  })
  const outcome = classify(res)
  const row = byClass.get(c.class) ?? { tried: 0, resolved: 0 }
  row.tried += 1
  if (outcome === 'resolved') row.resolved += 1
  else failures.push(`${c.class} ${c.name} ${outcome}`)
  byClass.set(c.class, row)
}
await client.close()

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a')
let tried = 0, resolved = 0
console.log(`RESOLVER n=${cases.length} project=project:${args.project}`)
console.log('RESOLVER class tried resolved rate')
for (const [cls, row] of byClass) {
  tried += row.tried; resolved += row.resolved
  console.log(`RESOLVER ${cls} ${row.tried} ${row.resolved} ${pct(row.resolved, row.tried)}`)
}
console.log(`RESOLVER overall ${tried} ${resolved} ${pct(resolved, tried)}`)
console.log(`RESOLVER failures=${failures.length}`)
for (const line of failures) console.log(`RESOLVER FAIL ${line}`)
