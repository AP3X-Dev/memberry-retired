import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Lint floor for the MemBerry workspace (spec docs/superpowers/specs/spec-2026-09-02-review-surface.md, item 34).
//
// Type-aware linting (tseslint.configs.recommendedTypeChecked) is DELIBERATELY NOT enabled.
// It needs a project graph spanning all ten workspace packages plus bench/ and scripts/, and it
// runs the TypeScript program per file, which is far too slow for the per-cycle gate. The
// non-type-checked recommended set is the floor; enabling type-aware rules is separate work with
// its own tsconfig plumbing, not part of this slice.
//
// Severity split (measured at 32bf60c, not guessed):
//   error = rules the tree already satisfies. `npm run lint` exits 0; any new violation blocks.
//   warn  = rules with a real backlog behind them. The warning total is metric 15, ratcheted
//           down-only, so later cycles can grind it without blocking this one.
// Measured counts are recorded next to each downgraded rule.

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'wiki/**',
      'memberry-graph-out/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      // --- enforced floor (0 violations at 32bf60c) -------------------------------------------
      // Re-asserted explicitly rather than left implicit in the recommended sets, so the enforced
      // set is readable without expanding the presets.
      'no-empty': 'error',
      'no-constant-condition': 'error',
      'no-fallthrough': 'error',
      // args/caughtErrors are off: unused positional params exist for interface conformance, and
      // unused catch bindings are covered by preserve-caught-error. Unused imports, locals and
      // type-only bindings are still errors, which is the part that keeps dead code out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],

      // --- backlog (metric 15) ----------------------------------------------------------------
      // Counts measured at 32bf60c with this exact config; 469 warnings total, including the
      // legacy unused-binding baseline below. Metric 15 recipe:
      //   npx eslint . --format json > /tmp/eslint.json
      //   node -e "console.log(require('/tmp/eslint.json').reduce((a,f)=>a+f.warningCount,0))"
      '@typescript-eslint/no-explicit-any': 'warn', // 251
      'prefer-const': 'warn', // 60
      'preserve-caught-error': 'warn', // 32
      'no-useless-assignment': 'warn', // 25
      '@typescript-eslint/no-require-imports': 'warn', // 16 (14 in bench/lab/ret010/dev-gate.cjs)
      '@typescript-eslint/no-unused-expressions': 'warn', // 15 (14 in one bench worker)
      'no-useless-escape': 'warn', // 5
      'no-unsafe-finally': 'warn', // 4
      'no-sparse-arrays': 'warn', // 2
      'no-regex-spaces': 'warn', // 2
      'no-control-regex': 'warn', // 1
      'no-irregular-whitespace': 'warn', // 1
      'no-unassigned-vars': 'warn', // 1
      'no-useless-catch': 'warn', // 1
    },
  },
  {
    // Legacy unused-binding baseline: 53 violations across the files below, all predating this
    // floor. The rule stays an error everywhere else, so a new file or a new unused import in any
    // untouched file fails the gate. Fixing a file means deleting its entry from this list; the
    // list is down-only and its warnings are part of metric 15.
    files: [
      'bench/eval/mine-queries.mjs',
      'bench/lab/ret010/dev-gate.cjs',
      'packages/arch/src/__tests__/context.test.ts',
      'packages/code/src/indexer.ts',
      'packages/code/src/__tests__/search.language-filter.test.ts',
      'packages/code/src/__tests__/symbol-identity.test.ts',
      'packages/core/src/admission-shadow.ts',
      'packages/core/src/cli/project.ts',
      'packages/core/src/service.ts',
      'packages/core/src/__tests__/blocks.test.ts',
      'packages/core/src/__tests__/capability-policy.test.ts',
      'packages/core/src/__tests__/consolidation-gds.test.ts',
      'packages/core/src/__tests__/consolidation.regression.test.ts',
      'packages/core/src/__tests__/consolidation.test.ts',
      'packages/core/src/__tests__/import.test.ts',
      'packages/core/src/__tests__/lifecycle-pass.test.ts',
      'packages/core/src/__tests__/path-confine.test.ts',
      'packages/graph/src/tools.ts',
      'packages/mcp/src/__tests__/server.test.ts',
      'packages/mcp/src/__tests__/tools.test.ts',
      'packages/neo4j/src/fact.ts',
      'packages/neo4j/src/__tests__/entity-resolver.test.ts',
      'packages/research/src/campaign.ts',
      'packages/research/src/context.ts',
      'packages/research/src/hypothesis.ts',
      'packages/research/src/__tests__/contradictions.test.ts',
      'packages/research/src/__tests__/experiment.test.ts',
      'packages/research/src/__tests__/research-integration.test.ts',
      'packages/retrieval/src/candidate-channel.ts',
      'packages/retrieval/src/deterministic.ts',
      'packages/retrieval/src/reranker-providers.ts',
      'packages/retrieval/src/runtime-candidate-channel.ts',
      'packages/retrieval/src/__tests__/assembler.test.ts',
      'packages/retrieval/src/__tests__/deterministic.test.ts',
      'packages/retrieval/src/__tests__/feedback.test.ts',
      'packages/retrieval/src/__tests__/retrieval-explanation-view.test.ts',
      'packages/wiki/src/ingest.ts',
      'packages/wiki/src/__tests__/viewer.test.ts',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          args: 'none',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
);
