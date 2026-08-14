import type { LabMemory } from '../contracts/adapter.js';
import { tokenize } from './in-memory.js';

/**
 * Candidate-only lexical channel. It intentionally does not share implementation
 * with the frozen BM25 control, so changes cannot contaminate both experiment arms.
 */
export function rankProxyCandidates(
  query: string,
  memories: readonly LabMemory[],
): Array<{ memory: LabMemory; score: number }> {
  const queryTerms = new Set(tokenize(query));
  const documentTerms = memories.map((memory) => tokenize(memory.content));
  const averageLength = documentTerms.reduce((sum, terms) => sum + terms.length, 0) / (documentTerms.length || 1);
  const frequencyByTerm = new Map<string, number>();
  for (const terms of documentTerms) {
    for (const term of new Set(terms)) frequencyByTerm.set(term, (frequencyByTerm.get(term) ?? 0) + 1);
  }

  return memories.map((memory, index) => {
    const occurrences = new Map<string, number>();
    for (const term of documentTerms[index]) occurrences.set(term, (occurrences.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const termFrequency = occurrences.get(term) ?? 0;
      if (!termFrequency) continue;
      const documentFrequency = frequencyByTerm.get(term) ?? 0;
      const inverseFrequency = Math.log(1 + (memories.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      const lengthPenalty = 1.2 * (0.25 + 0.75 * documentTerms[index].length / (averageLength || 1));
      score += inverseFrequency * ((2.2 * termFrequency) / (termFrequency + lengthPenalty));
    }
    return { memory, score };
  })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.memory.recordedAt.localeCompare(left.memory.recordedAt));
}
