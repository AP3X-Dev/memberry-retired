import type { LabScenarioInput } from '../contracts/scenario.js';
import { LAB_SCENARIO_VERSION } from '../contracts/scenario.js';

/** Public adapter inputs. No relevance, stale, or isolation labels belong here. */
export const TEMPORAL_ISOLATION_INPUTS: readonly LabScenarioInput[] = [
  {
    version: LAB_SCENARIO_VERSION,
    id: 'late-arriving-temporal-update-v1',
    split: 'holdout',
    title: 'Late-arriving temporal update',
    description: 'A correction recorded later must support historical and current queries.',
    dimensions: ['temporal', 'stale-safety', 'recall'],
    requiredCapabilities: ['temporal-filtering'],
    tenant: 'tenant-alpha',
    project: 'project-api',
    tags: ['temporal', 'late-arrival'],
    memories: [
      { id: 'rate-old', content: 'The API rate limit is 100 requests per minute.', tenant: 'tenant-alpha', project: 'project-api', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-04-01T00:00:00.000Z', recordedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'rate-current', content: 'The API rate limit is 1000 requests per minute.', tenant: 'tenant-alpha', project: 'project-api', validFrom: '2026-04-01T00:00:00.000Z', recordedAt: '2026-05-15T00:00:00.000Z' },
      { id: 'rate-noise', content: 'API responses include a correlation identifier.', tenant: 'tenant-alpha', project: 'project-api', recordedAt: '2026-06-01T00:00:00.000Z' },
    ],
    queries: [
      { id: 'rate-history', query: 'What is the API rate limit?', limit: 2, asOf: '2026-03-01T00:00:00.000Z' },
      { id: 'rate-current', query: 'What is the API rate limit?', limit: 2, asOf: '2026-06-01T00:00:00.000Z' },
    ],
  },
  {
    version: LAB_SCENARIO_VERSION,
    id: 'explicit-stale-suppression-v1',
    split: 'dev',
    title: 'Explicit stale suppression',
    description: 'Invalidated implementation guidance must not leak into current context.',
    dimensions: ['stale-safety', 'precision'],
    requiredCapabilities: ['temporal-filtering'],
    tenant: 'tenant-alpha',
    project: 'project-web',
    memories: [
      { id: 'test-jest-old', content: 'Run repository tests with Jest.', tenant: 'tenant-alpha', project: 'project-web', recordedAt: '2026-01-01T00:00:00.000Z', invalidatedAt: '2026-02-01T00:00:00.000Z' },
      { id: 'test-vitest-current', content: 'Run repository tests with Vitest.', tenant: 'tenant-alpha', project: 'project-web', recordedAt: '2026-02-01T00:00:00.000Z' },
    ],
    queries: [{ id: 'current-test-command', query: 'How do I run repository tests?', limit: 2 }],
  },
  {
    version: LAB_SCENARIO_VERSION,
    id: 'project-isolation-v1',
    split: 'dev',
    title: 'Project isolation',
    description: 'Lexically identical knowledge from another project must never enter scoped results.',
    dimensions: ['project-isolation', 'recall'],
    requiredCapabilities: ['project-scope'],
    tenant: 'tenant-alpha',
    project: 'project-api',
    memories: [
      { id: 'api-deploy', content: 'Deploy the service with the blue green API pipeline.', tenant: 'tenant-alpha', project: 'project-api', recordedAt: '2026-03-01T00:00:00.000Z' },
      { id: 'web-deploy', content: 'Deploy the service with the Vercel web pipeline.', tenant: 'tenant-alpha', project: 'project-web', recordedAt: '2026-03-02T00:00:00.000Z' },
    ],
    queries: [{ id: 'api-deployment', query: 'How do we deploy the service?', limit: 2 }],
  },
  {
    version: LAB_SCENARIO_VERSION,
    id: 'tenant-isolation-v1',
    split: 'holdout',
    title: 'Tenant isolation',
    description: 'Knowledge belonging to a different tenant is a hard failure even when highly relevant.',
    dimensions: ['tenant-isolation', 'recall'],
    requiredCapabilities: ['tenant-scope'],
    tenant: 'tenant-alpha',
    project: 'project-shared',
    memories: [
      { id: 'alpha-database', content: 'The customer database is PostgreSQL on cluster alpha.', tenant: 'tenant-alpha', project: 'project-shared', recordedAt: '2026-03-01T00:00:00.000Z' },
      { id: 'beta-database', content: 'The customer database is PostgreSQL on cluster beta.', tenant: 'tenant-beta', project: 'project-shared', recordedAt: '2026-03-02T00:00:00.000Z' },
    ],
    queries: [{ id: 'alpha-database-location', query: 'Where is the customer database?', limit: 2 }],
  },
] as const;
