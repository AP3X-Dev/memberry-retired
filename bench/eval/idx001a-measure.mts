import { resolve } from 'node:path';
import { MemBerryRetrievalCoreFunnelAdapter } from '../lab/adapters/memberry-retrieval-core-funnel.js';
import type { LabAdapter } from '../lab/contracts/adapter.js';
import { MemBerryRetrievalCoreFunnelStructuredAdapter } from '../lab/adapters/memberry-retrieval-core-funnel-structured.js';
import { loadMultiHopV4ScenariosForScoring } from '../lab/datasets/load-multihop-v4.js';
import { runAdapter } from '../lab/runner.js';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const scenarios = await loadMultiHopV4ScenariosForScoring('dev', repoRoot);
const run = (adapter: LabAdapter, suffix: string) => runAdapter({
  runId: `idx001a-${suffix}`, adapter, scenarios, splits: ['dev'],
});
const [control, candidate] = await Promise.all([
  run(new MemBerryRetrievalCoreFunnelAdapter(), 'control'),
  run(new MemBerryRetrievalCoreFunnelStructuredAdapter(), 'candidate'),
]);
const passed = (report: typeof control) => report.scenarioReports.map((row) => row.metrics.answerCoverage === 1);
const controlRows = passed(control);
const candidateRows = passed(candidate);
const controlSuccess = controlRows.filter(Boolean).length;
const candidateSuccess = candidateRows.filter(Boolean).length;
const improved = candidateRows.filter((value, index) => value && !controlRows[index]).length;
const regressed = candidateRows.filter((value, index) => !value && controlRows[index]).length;
const delta = (candidateSuccess - controlSuccess) / scenarios.length;

// Deterministic paired bootstrap (xorshift32), percentile interval over scenario deltas.
let state = 0x1d001a;
const random = () => {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  return (state >>> 0) / 0x1_0000_0000;
};
const samples: number[] = [];
for (let sample = 0; sample < 20_000; sample += 1) {
  let sum = 0;
  for (let index = 0; index < scenarios.length; index += 1) {
    const picked = Math.floor(random() * scenarios.length);
    sum += Number(candidateRows[picked]) - Number(controlRows[picked]);
  }
  samples.push(sum / scenarios.length);
}
samples.sort((left, right) => left - right);
const lower = samples[Math.floor(samples.length * 0.025)]!;
const upper = samples[Math.floor(samples.length * 0.975)]!;
console.log(JSON.stringify({
  n: scenarios.length, controlSuccess, candidateSuccess,
  controlAnswerAt5: controlSuccess / scenarios.length,
  candidateAnswerAt5: candidateSuccess / scenarios.length,
  delta, interval95: [lower, upper], improved, regressed,
}));
