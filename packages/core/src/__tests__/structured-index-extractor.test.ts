import { describe, expect, it, vi } from 'vitest';
import type { LlmClient } from '../llm.js';
import { extractEpisodeStructuredIndexV1 } from '../structured-index-extractor.js';

function llm(response: string): LlmClient {
  return {
    available: true,
    modelFor: vi.fn(() => 'local-model'),
    chat: vi.fn(async () => response),
  };
}

describe('IDX-001A local structured-index extractor', () => {
  it('accepts bounded explicit facts through the shared trust-boundary validator', async () => {
    const client = llm('{"facts":["MemBerry uses Neo4j.","Redis carries signals."]}');
    const result = await extractEpisodeStructuredIndexV1({
      content: 'MemBerry uses Neo4j. Redis carries signals.',
      projectScope: 'project:memberry',
      llm: client,
      model: 'qwen-test',
    });
    expect(result?.facts).toEqual(['MemBerry uses Neo4j.', 'Redis carries signals.']);
    expect(client.chat).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      model: 'qwen-test', temperature: 0, jsonMode: true,
    }));
  });

  it.each([
    'not json',
    '{"facts":[],"aliases":[]}',
    '{"facts":["same","SAME"]}',
    '{"facts":["ok"],"extra":true}',
  ])('fails closed without persisting malformed model output: %s', async (response) => {
    await expect(extractEpisodeStructuredIndexV1({
      content: 'content', projectScope: 'project:memberry', llm: llm(response),
    })).resolves.toBeUndefined();
  });

  it('never invokes an unavailable model', async () => {
    const chat = vi.fn();
    const result = await extractEpisodeStructuredIndexV1({
      content: 'content', projectScope: 'project:memberry',
      llm: { available: false, modelFor: () => 'none', chat },
    });
    expect(result).toBeUndefined();
    expect(chat).not.toHaveBeenCalled();
  });
});
