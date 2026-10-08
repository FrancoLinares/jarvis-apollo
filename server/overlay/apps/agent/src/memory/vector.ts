import { z } from 'zod';

import { buildApiCostEntry, openRouterUsageSchema, reportApiCost } from '@/costs/ledger';
import type { VectorStore } from '@/platform/vector';

const openRouterEmbeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
  usage: openRouterUsageSchema.nullable().optional(),
});

const memoryVectorMetadataSchema = z.object({
  content: z.string(),
});

export type MemoryVectorMatch = {
  readonly id: string;
  readonly content: string;
  readonly score: number;
};

export async function embedTextWithOpenRouter(input: {
  readonly openRouterApiKey: string;
  readonly modelId: string;
  readonly text: string;
}): Promise<number[]> {
  const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.openRouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.modelId,
      input: input.text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding falló con status ${response.status}`);
  }

  const payload = openRouterEmbeddingResponseSchema.parse(await response.json());
  reportApiCost(buildApiCostEntry('embedding', input.modelId, payload.usage ?? undefined));
  return payload.data[0].embedding;
}

export async function upsertMemoryVector(input: {
  readonly vectorStore: VectorStore;
  readonly memoryId: string;
  readonly content: string;
  readonly values: number[];
  readonly deviceId: string;
}): Promise<void> {
  await input.vectorStore.upsert({
    id: input.memoryId,
    values: input.values,
    namespace: input.deviceId,
    metadata: {
      content: input.content.slice(0, 2048),
    },
  });
}

export async function queryMemoryVectors(input: {
  readonly vectorStore: VectorStore;
  readonly values: number[];
  readonly deviceId: string;
  readonly topK?: number;
}): Promise<readonly MemoryVectorMatch[]> {
  const matchList = await input.vectorStore.query({
    values: input.values,
    namespace: input.deviceId,
    topK: input.topK ?? 5,
  });

  return matchList.map((match) => {
    const parsedMetadata = memoryVectorMetadataSchema.safeParse(match.metadata);
    return {
      id: match.id,
      content: parsedMetadata.success ? parsedMetadata.data.content : '',
      score: match.score,
    };
  });
}

export async function recallSemanticMemoryContent(input: {
  readonly vectorStore: VectorStore | undefined;
  readonly openRouterApiKey: string;
  readonly embeddingModelId: string;
  readonly queryText: string;
  readonly deviceId: string;
  readonly topK?: number;
  // Si el turno ya pidió el embedding (lo usa también el router), se reusa.
  readonly embedQueryText?: (text: string) => Promise<readonly number[]>;
}): Promise<readonly string[]> {
  if (input.vectorStore === undefined || input.queryText.trim().length === 0) {
    return [];
  }

  try {
    const values = input.embedQueryText
      ? [...(await input.embedQueryText(input.queryText))]
      : await embedTextWithOpenRouter({
          openRouterApiKey: input.openRouterApiKey,
          modelId: input.embeddingModelId,
          text: input.queryText,
        });
    const matchList = await queryMemoryVectors({
      vectorStore: input.vectorStore,
      values,
      deviceId: input.deviceId,
      topK: input.topK,
    });
    return matchList
      .filter((match) => match.content.length > 0)
      .map((match) => match.content);
  } catch {
    return [];
  }
}
