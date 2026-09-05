#!/usr/bin/env -S npx tsx
// Slice 5 — in-process measurement of AMPService.load() ranking against the LIVE graph.
//
// Runs the shipped load() path (packages/core/src) in-process, cache-bypassed via
// loadFreshObserved, for every `berry_load` memory case in outcome-cases.jsonl, and reports
// the rank of each case's adjudicated evidence ids in the delivered markdown. Because it
// imports src, a flag flip in the environment is measured without a deploy:
//
//   cd /home/cerebro/gate/repo22 && set -a && . /home/cerebro/projects/memberry/.env && set +a
//   npx tsx bench/eval/memory-load-measure.mts                              # baseline
//   MEMBERRY_MEMORY_RANK_V2=1 npx tsx bench/eval/memory-load-measure.mts
//   MEMBERRY_MEMORY_RANK_V2=1 npx tsx bench/eval/memory-load-measure.mts --inspect om-21
//
// It is NOT a reading from the deployed server (see BASELINE.md §8 on idx004-measure.mjs, the
// precedent). It writes nothing except question embeddings into the shared read-through
// embedding cache, which the live server would compute identically.
//
// ponytail: berry_load cases only; berry_context cases go through the assembler and are
// measured by run-outcome-probe.mjs after deploy.
import { readFileSync } from 'node:fs';
import { createCoreServices } from '../../packages/core/src/services-factory.js';

const args = process.argv.slice(2);
const inspect = args.includes('--inspect') ? args[args.indexOf('--inspect') + 1] : null;
const casesPath = args.includes('--cases') ? args[args.indexOf('--cases') + 1] : 'bench/eval/outcome-cases.jsonl';
type Case = { id: string; plane: string; tool?: string; question: string; input: Record<string, unknown>;
  expectEvidenceIds: string[]; adjudication?: string };
const cases = (readFileSync(casesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) as Case[])
  .filter((c) => c.tool === 'berry_load' && c.adjudication !== 'invalid' && (!inspect || c.id === inspect));
if (cases.length === 0) { console.error('no berry_load cases selected'); process.exit(2); }

const services = createCoreServices();
const HDR = /^##\s+\[([^\]\s]+)\]/gm;
const rows: Array<{ id: string; plane: string; rank: number | null; inCandidates: boolean; n: number }> = [];
try {
  for (const c of cases) {
    const { task: _t, ...input } = c.input as { task?: string } & Record<string, unknown>;
    const { value, observation } = await services.ampService.loadFreshObserved({
      ...(input as object), task: c.question,
    } as Parameters<typeof services.ampService.loadFreshObserved>[0]);
    const got = [...value.markdown.matchAll(HDR)].map((m) => m[1]);
    const expected = new Set(c.expectEvidenceIds);
    const rank = got.findIndex((id) => expected.has(id));
    const candIds = new Set(observation.candidates.map((x) => x.privateId));
    const inCandidates = c.expectEvidenceIds.some((id) => candIds.has(id));
    rows.push({ id: c.id, plane: c.plane, rank: rank < 0 ? null : rank + 1, inCandidates, n: got.length });
    if (inspect) {
      console.log(`channels: ${observation.channels.map((ch) => `${ch.channel}=${ch.outcome}`).join(' ')}`);
      for (const cand of observation.candidates) {
        const flag = expected.has(cand.privateId) ? ' <== EXPECTED' : '';
        const pos = got.indexOf(cand.privateId);
        console.log(`${pos < 0 ? '  -' : String(pos + 1).padStart(3)} ${cand.privateId.padEnd(42)} ${cand.sourceType.padEnd(8)} conf=${cand.evidence.confidence} ${cand.channels.map((ch) => `${ch.channel}#${ch.rank}${ch.score !== undefined ? '@' + ch.score.toFixed(3) : ''}`).join(' ')}${flag}`);
      }
    }
  }
} finally {
  await services.close();
}
const at = (k: number) => rows.filter((r) => r.rank !== null && r.rank <= k).length / rows.length;
const mrr = rows.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0) / rows.length;
console.log(`MEASURE rankV2=${process.env.MEMBERRY_MEMORY_RANK_V2 ?? ''} n=${rows.length} answerAt1=${at(1).toFixed(4)} answerAt5=${at(5).toFixed(4)} answerAt10=${at(10).toFixed(4)} mrr=${mrr.toFixed(4)} inCandidates=${rows.filter((r) => r.inCandidates).length}`);
for (const r of rows) console.log(`MEASURE case=${r.id} plane=${r.plane} rank=${r.rank ?? 'MISS'} inCandidates=${r.inCandidates} delivered=${r.n}`);
