// packages/core/src/llm.ts
//
// Shared chat-completion client. Before this existed, the only LLM call in the
// codebase was extractFacts() in extract.ts (ad-hoc `new OpenAI()` with a
// hardcoded model). The dialectic tool (berry_ask) and the dream pass both need an
// LLM call, so this gives them one place to do it with per-task model selection
// and transient-error retry. Callers must degrade gracefully when no API key is
// configured: use NullLlmClient (available === false) instead of throwing here.

import OpenAI from 'openai';
import { isTransientError } from './extract.js';

export type LlmTask = 'extraction' | 'synthesis' | 'dream';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Explicit model id; overrides the per-task default. */
  model?: string;
  /** Sampling temperature. Default 0 (deterministic). */
  temperature?: number;
  /** Max completion tokens. Default 1024. */
  maxTokens?: number;
  /** Request a JSON object response (OpenAI response_format). */
  jsonMode?: boolean;
  /** Abort signal for timeouts/cancellation. */
  signal?: AbortSignal;
}

/**
 * Default model per task. Extraction stays cheap (explicit capture); synthesis
 * and dream use a stronger model. Overridable via AMPConfig.models (see the
 * factory) or per-call via ChatOptions.model.
 */
export const DEFAULT_MODELS: Record<LlmTask, string> = {
  extraction: 'gpt-4o-mini',
  synthesis: 'gpt-4o',
  dream: 'gpt-4o',
};

export interface LlmClient {
  /** Run a chat completion and return the assistant message text ('' on empty). */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  /** Resolve the configured model id for a task. */
  modelFor(task: LlmTask): string;
  /** Whether a real backend is configured. False for NullLlmClient. */
  readonly available: boolean;
}

export class OpenAiLlmClient implements LlmClient {
  readonly available = true;
  private client: OpenAI;
  private models: Record<LlmTask, string>;

  constructor(apiKey: string, modelOverrides: Partial<Record<LlmTask, string>> = {}, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.models = {
      extraction: modelOverrides.extraction ?? DEFAULT_MODELS.extraction,
      synthesis: modelOverrides.synthesis ?? DEFAULT_MODELS.synthesis,
      dream: modelOverrides.dream ?? DEFAULT_MODELS.dream,
    };
  }

  modelFor(task: LlmTask): string {
    return this.models[task];
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.client.chat.completions.create(
          {
            model: opts.model ?? this.models.synthesis,
            messages,
            temperature: opts.temperature ?? 0,
            max_tokens: opts.maxTokens ?? 1024,
            ...(opts.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
          },
          opts.signal ? { signal: opts.signal } : {},
        );
        return res.choices[0]?.message?.content ?? '';
      } catch (err) {
        if (attempt < MAX_RETRIES && isTransientError(err)) {
          await new Promise((r) => setTimeout(r, Math.pow(3, attempt) * 1000)); // 1s, 3s
          continue;
        }
        throw err;
      }
    }
    return '';
  }
}

/** No-op client used when no API key is configured. Callers check `.available`. */
export class NullLlmClient implements LlmClient {
  readonly available = false;
  async chat(): Promise<string> {
    return '';
  }
  modelFor(task: LlmTask): string {
    return DEFAULT_MODELS[task];
  }
}
