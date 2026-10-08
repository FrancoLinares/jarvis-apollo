import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  createSqliteApiCostSink,
  reportApiCost,
  setApiCostSink,
  summarizeApiCosts,
  type ApiCostEntry,
} from '@/costs/ledger';
import { createBunSqliteExecutor } from '@/platform/bun/sql';
import { chatWithOpenRouter } from '@/voice/llm';
import { transcribeAudioWithOpenRouter } from '@/voice/stt';

afterEach(() => setApiCostSink(undefined));

function collect(): ApiCostEntry[] {
  const entryList: ApiCostEntry[] = [];
  setApiCostSink((entry) => entryList.push(entry));
  return entryList;
}

const jsonResponse = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('API cost ledger', () => {
  it('records the exact cost OpenRouter reports for a chat round', async () => {
    const entryList = collect();
    await chatWithOpenRouter({
      openRouterApiKey: 'k',
      modelId: 'deepseek/deepseek-v4.1-flash',
      messageList: [{ role: 'user', content: 'hola' }],
      fetchImplementation: jsonResponse({
        choices: [{ message: { content: 'Hola.' } }],
        usage: { cost: 0.00004, prompt_tokens: 800, completion_tokens: 12 },
      }),
    });
    expect(entryList).toEqual([
      {
        component: 'llm',
        model: 'deepseek/deepseek-v4.1-flash',
        costUsd: 0.00004,
        inputTokens: 800,
        outputTokens: 12,
        reasoningTokens: undefined,
        audioSeconds: undefined,
      },
    ]);
  });

  it('records the usage chunk at the end of a streamed round', async () => {
    const entryList = collect();
    const streamBody =
      'data: {"choices":[{"delta":{"content":"Hola."}}]}\n\n' +
      'data: {"choices":[],"usage":{"cost":0.00002,"prompt_tokens":700,"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":0}}}\n\n' +
      'data: [DONE]\n\n';
    await chatWithOpenRouter({
      openRouterApiKey: 'k',
      modelId: 'm',
      messageList: [{ role: 'user', content: 'hola' }],
      onTextDelta: () => {},
      fetchImplementation: (async () => new Response(streamBody, { status: 200 })) as unknown as typeof fetch,
    });
    expect(entryList.map((entry) => [entry.component, entry.costUsd, entry.reasoningTokens])).toEqual([
      ['llm', 0.00002, 0],
    ]);
  });

  it('records the transcription cost and audio seconds', async () => {
    const entryList = collect();
    await transcribeAudioWithOpenRouter({
      audioBuffer: new ArrayBuffer(8),
      openRouterApiKey: 'k',
      modelId: 'openai/whisper-large-v3-turbo',
      fetchImplementation: jsonResponse({ text: 'hola', usage: { seconds: 3.9, cost: 0.000013 } }),
    });
    expect(entryList[0]).toMatchObject({ component: 'stt', costUsd: 0.000013, audioSeconds: 3.9 });
  });

  it('stores entries in SQLite and summarizes them by component and model', () => {
    const executor = createBunSqliteExecutor(new Database(':memory:'));
    setApiCostSink(createSqliteApiCostSink(executor, () => 1_000));
    reportApiCost({ component: 'llm', model: 'a', costUsd: 0.001 });
    reportApiCost({ component: 'llm', model: 'a', costUsd: 0.002 });
    reportApiCost({ component: 'jev', model: 'j', costUsd: undefined });
    const summary = summarizeApiCosts(executor, 0);
    expect(summary).toEqual([
      { component: 'llm', model: 'a', calls: 2, costUsd: 0.003, callsWithoutCost: 0 },
      { component: 'jev', model: 'j', calls: 1, costUsd: 0, callsWithoutCost: 1 },
    ]);
  });

  it('never lets a failing sink break the caller', () => {
    setApiCostSink(() => {
      throw new Error('disco lleno');
    });
    expect(() => reportApiCost({ component: 'stt', model: 'm', costUsd: 1 })).not.toThrow();
  });
});
