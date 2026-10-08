import { z } from 'zod';

import type { MemorySqlExecutor } from '@/memory/store';

// Cuánto cuesta cada llamada a OpenRouter, por componente.
//
// El rastreador horario (~/jarvis-costs) sabe cuánto se gastó en total, pero no
// en qué. Con el LLM, la transcripción, Jev y los embeddings compartiendo la
// misma key, sin esto no hay forma de saber si un cambio de modelo encareció
// algo. OpenRouter devuelve el costo exacto en `usage.cost` de cada respuesta:
// se anota tal cual, sin estimar.
//
// El registro es un sumidero global que se enchufa al arrancar el host: las
// funciones de bajo nivel (llm.ts, stt.ts…) reportan sin que haya que pasarles
// la base por todos lados. Sin sumidero (tests, Worker) no hace nada, y si
// anotar falla, el turno sigue igual.

export type ApiCostComponent = 'llm' | 'stt' | 'jev' | 'embedding';

export type ApiCostEntry = {
  readonly component: ApiCostComponent;
  readonly model: string;
  readonly costUsd: number | undefined;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly audioSeconds?: number;
};

// Lo que OpenRouter devuelve en `usage`, en las variantes de cada endpoint.
export const openRouterUsageSchema = z
  .object({
    cost: z.number().optional(),
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    seconds: z.number().optional(),
    completion_tokens_details: z
      .object({ reasoning_tokens: z.number().nullable().optional() })
      .nullable()
      .optional(),
  })
  .passthrough();

export type OpenRouterUsage = z.infer<typeof openRouterUsageSchema>;

export function buildApiCostEntry(
  component: ApiCostComponent,
  model: string,
  usage: OpenRouterUsage | undefined,
): ApiCostEntry {
  return {
    component,
    model,
    costUsd: usage?.cost,
    inputTokens: usage?.prompt_tokens ?? usage?.input_tokens,
    outputTokens: usage?.completion_tokens ?? usage?.output_tokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
    audioSeconds: usage?.seconds,
  };
}

type ApiCostSink = (entry: ApiCostEntry) => void;

let apiCostSink: ApiCostSink | undefined;

export function setApiCostSink(sink: ApiCostSink | undefined): void {
  apiCostSink = sink;
}

export function reportApiCost(entry: ApiCostEntry): void {
  try {
    apiCostSink?.(entry);
  } catch {
    // Anotar un costo nunca puede romper un turno.
  }
}

export const API_COST_TABLE_STATEMENT =
  'CREATE TABLE IF NOT EXISTS api_costs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, ' +
  'component TEXT NOT NULL, model TEXT NOT NULL, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, ' +
  'reasoning_tokens INTEGER, audio_seconds REAL)';

export function createSqliteApiCostSink(
  sqlExecutor: MemorySqlExecutor,
  now: () => number = Date.now,
): ApiCostSink {
  sqlExecutor.execute(API_COST_TABLE_STATEMENT);
  sqlExecutor.execute(
    'CREATE INDEX IF NOT EXISTS api_costs_created_at ON api_costs (created_at)',
  );
  return (entry) => {
    sqlExecutor.execute(
      'INSERT INTO api_costs (created_at, component, model, cost_usd, input_tokens, output_tokens, ' +
        'reasoning_tokens, audio_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      now(),
      entry.component,
      entry.model,
      entry.costUsd ?? null,
      entry.inputTokens ?? null,
      entry.outputTokens ?? null,
      entry.reasoningTokens ?? null,
      entry.audioSeconds ?? null,
    );
  };
}

export type ApiCostSummaryRow = {
  readonly component: string;
  readonly model: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly callsWithoutCost: number;
};

export function summarizeApiCosts(
  sqlExecutor: MemorySqlExecutor,
  sinceMilliseconds: number,
): readonly ApiCostSummaryRow[] {
  return sqlExecutor
    .execute<{ component: string; model: string; calls: number; cost: number | null; missing: number }>(
      'SELECT component, model, COUNT(*) AS calls, SUM(cost_usd) AS cost, ' +
        'SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS missing ' +
        'FROM api_costs WHERE created_at >= ? GROUP BY component, model ORDER BY cost DESC',
      sinceMilliseconds,
    )
    .map((row) => ({
      component: row.component,
      model: row.model,
      calls: row.calls,
      costUsd: row.cost ?? 0,
      callsWithoutCost: row.missing,
    }));
}
