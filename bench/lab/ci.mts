#!/usr/bin/env tsx

import { runDeterministicCiGate } from './baselines/ci-gate.js';

try {
  await runDeterministicCiGate();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
