import { describe, expect, it } from 'bun:test';

import { chatWithOpenRouter } from '@/voice/llm';

function captureRequestBody(): {
  readonly fetchImplementation: typeof fetch;
  readonly bodyList: Record<string, unknown>[];
} {
  const bodyList: Record<string, unknown>[] = [];
  const fetchImplementation = (async (_url: string, init?: RequestInit) => {
    bodyList.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hola.' } }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImplementation, bodyList };
}

describe('chatWithOpenRouter reasoning', () => {
  it('asks the provider to skip reasoning only when told to', async () => {
    const { fetchImplementation, bodyList } = captureRequestBody();
    const base = {
      openRouterApiKey: 'k',
      modelId: 'deepseek/deepseek-v4-flash-0731',
      messageList: [{ role: 'user' as const, content: 'hola' }],
      fetchImplementation,
    };
    await chatWithOpenRouter({ ...base, reasoningEnabled: false });
    await chatWithOpenRouter({ ...base, reasoningEnabled: true });
    await chatWithOpenRouter(base);
    expect(bodyList[0].reasoning).toEqual({ enabled: false });
    // Razonar = dejar que el modelo haga lo suyo; no se manda nada.
    expect(bodyList[1].reasoning).toBeUndefined();
    expect(bodyList[2].reasoning).toBeUndefined();
  });
});
