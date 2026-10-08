import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import type { MemorySqlExecutor } from '@/memory/store';
import { createBunSqliteExecutor } from '@/platform/bun/sql';
import { createTurnRouter, decideReasoning, readLearnedRouterState } from '@/router/engine';
import { predictWithHead, trainIntentHead } from '@/router/head';
import { ROUTER_INTENT_LIST, type RouterIntentId } from '@/router/intents';
import type { JevVerdict } from '@/router/jev';
import {
  decodeEmbedding,
  encodeEmbedding,
  ensureRouterTables,
  insertRouterDecision,
  judgePreviousOutcome,
  readRouterDecisionList,
  type RouterDecisionEntry,
  type StoredRouterDecision,
} from '@/router/log';
import {
  DISABLED_THRESHOLD,
  adjustReasoningThreshold,
  calibrateThresholds,
  summarizeReasoningAb,
  millisecondsUntilNextLearning,
  runRouterLearning,
  trainAndEvaluateHead,
} from '@/router/learn';

function createSqlExecutor(): MemorySqlExecutor {
  const executor = createBunSqliteExecutor(new Database(':memory:'));
  ensureRouterTables(executor);
  return executor;
}

function probabilities(
  entries: Partial<Record<RouterIntentId, number>>,
): Record<RouterIntentId, number> {
  return Object.fromEntries(
    ROUTER_INTENT_LIST.map((intent) => [intent.id, entries[intent.id] ?? 0]),
  ) as Record<RouterIntentId, number>;
}

function verdictFor(entries: Partial<Record<RouterIntentId, number>>, complaint = 0): JevVerdict {
  return {
    intentProbabilityMap: probabilities(entries),
    noiseProbability: 0,
    complaintProbability: complaint,
    reasoningProbability: 0.1,
    model: 'fake',
    costUsd: undefined,
  };
}

// Embeddings sintéticos: cada intención apunta a un eje, con algo de ruido
// determinístico, así el clasificador tiene algo real que separar.
function embeddingForIntent(intentIndex: number, seed: number): number[] {
  const values = new Array<number>(1536).fill(0);
  for (let index = 0; index < 256; index += 1) {
    values[index] = Math.sin(seed * 12.9898 + index * 78.233) * 0.05;
  }
  values[intentIndex * 7] += 1;
  return values;
}

function decisionEntry(
  overrides: Partial<RouterDecisionEntry> & Pick<RouterDecisionEntry, 'id' | 'createdAtMilliseconds'>,
): RouterDecisionEntry {
  return {
    text: 'frase',
    mode: 'on',
    source: 'jev',
    intentId: 'clima',
    intentProbability: 0.9,
    intentProbabilityMap: probabilities({ clima: 0.9, busqueda_web: 0.1 }),
    noiseProbability: 0,
    complaintProbability: 0,
    tier: 'narrow',
    reason: 'test',
    exposedToolNameList: ['weather_now'],
    usedToolNameList: ['weather_now'],
    escalated: false,
    jevMilliseconds: 300,
    llmMilliseconds: 1500,
    totalMilliseconds: 3000,
    toolSchemaChars: 500,
    embedding: undefined,
    reasoning: undefined,
    llmCallCount: 1,
    ...overrides,
  };
}

function storedDecision(overrides: Partial<StoredRouterDecision>): StoredRouterDecision {
  return {
    id: 'p',
    createdAtMilliseconds: 0,
    text: 'agendame el partido',
    mode: 'on',
    source: 'jev',
    intentId: 'agenda_crear',
    intentProbability: 0.9,
    intentProbabilityMap: undefined,
    noiseProbability: 0,
    complaintProbability: 0,
    tier: 'narrow',
    exposedToolNameList: [],
    usedToolNameList: [],
    escalated: false,
    outcome: undefined,
    label: undefined,
    embedding: undefined,
    reasoningPolicy: undefined,
    reasoningUsed: undefined,
    reasoningExplored: undefined,
    llmMilliseconds: undefined,
    llmCallCount: undefined,
    totalMilliseconds: undefined,
    ...overrides,
  };
}

describe('router log', () => {
  it('round-trips a truncated, normalized embedding', () => {
    const decoded = decodeEmbedding(encodeEmbedding(embeddingForIntent(2, 1)));
    expect(decoded.length).toBe(256);
    const norm = Math.sqrt(decoded.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('judges a complaint about the same topic as a failed previous turn', () => {
    const outcome = judgePreviousOutcome(
      storedDecision({ usedToolNameList: ['mcp_9386143d_create_event_cd2e3216'] }),
      { createdAtMilliseconds: 60_000, intentId: 'agenda_crear', complaintProbability: 0.9 },
    );
    expect(outcome).toBe('queja');
  });

  it('does not count a complaint-sounding request on another topic', () => {
    // "necesito que remuevas…" sacó 0,90 de queja en los turnos históricos.
    const outcome = judgePreviousOutcome(storedDecision({}), {
      createdAtMilliseconds: 60_000,
      intentId: 'pendientes',
      complaintProbability: 0.9,
    });
    expect(outcome).toBe('ok');
  });

  it('treats an immediate repeat of a narrowed request that used no tools as a failure', () => {
    const outcome = judgePreviousOutcome(storedDecision({ intentId: 'recordatorio' }), {
      createdAtMilliseconds: 30_000,
      intentId: 'recordatorio',
      complaintProbability: 0,
    });
    expect(outcome).toBe('repetido');
  });

  it('never judges shadow-mode turns as repeats', () => {
    const outcome = judgePreviousOutcome(storedDecision({ intentId: 'recordatorio', mode: 'shadow' }), {
      createdAtMilliseconds: 30_000,
      intentId: 'recordatorio',
      complaintProbability: 0,
    });
    expect(outcome).toBe('ok');
  });
});

describe('calibrateThresholds', () => {
  it('turns off an intent whose confident predictions keep failing', () => {
    const decisionList = Array.from({ length: 10 }, (_, index) =>
      storedDecision({
        id: `d${index}`,
        intentId: 'clima',
        intentProbability: 0.95,
        label: index < 5 ? 'clima' : 'busqueda_web',
      }),
    );
    expect(calibrateThresholds(decisionList).clima.narrow).toBe(DISABLED_THRESHOLD);
  });

  it('lowers the threshold of an intent that is always right', () => {
    const decisionList = Array.from({ length: 12 }, (_, index) =>
      storedDecision({ id: `d${index}`, intentId: 'viaje', intentProbability: 0.55, label: 'viaje' }),
    );
    expect(calibrateThresholds(decisionList).viaje.narrow).toBe(0.5);
  });

  it('keeps the defaults without enough examples', () => {
    const thresholds = calibrateThresholds([
      storedDecision({ intentId: 'hora', intentProbability: 0.95, label: 'dolar' }),
    ]);
    expect(thresholds.hora).toEqual({ narrow: 0.7, fast: 0.9, examples: 1 });
  });
});

describe('local head', () => {
  it('learns to separate intents from embeddings', async () => {
    const labelList = ROUTER_INTENT_LIST.map((intent) => intent.id);
    const exampleList = Array.from({ length: 160 }, (_, index) => {
      const intentIndex = index % 4;
      return {
        features: decodeEmbedding(encodeEmbedding(embeddingForIntent(intentIndex, index))),
        target: labelList.map((_, labelIndex) => (labelIndex === intentIndex ? 1 : 0)),
        weight: 1,
      };
    });
    const head = await trainIntentHead({ labelList, dimensionCount: 256, exampleList, epochCount: 150 });
    const probabilityMap = predictWithHead(
      head,
      decodeEmbedding(encodeEmbedding(embeddingForIntent(2, 999))),
    );
    const [best] = Object.entries(probabilityMap).sort((left, right) => right[1] - left[1]);
    expect(best[0]).toBe(labelList[2]);
    // En la Pi entrenar tarda más que el límite de 5 s por defecto.
  }, 60_000);

  it('stays inactive until it has enough examples', async () => {
    const { head, evaluation } = await trainAndEvaluateHead([]);
    expect(head).toBeUndefined();
    expect(evaluation.active).toBe(false);
  });
});

describe('router engine and learning, end to end on SQLite', () => {
  it('routes, records, labels the previous turn, and learns', async () => {
    const sqlExecutor = createSqlExecutor();
    let identifier = 0;
    const verdictQueue: JevVerdict[] = [
      verdictFor({ agenda_crear: 0.95 }),
      verdictFor({ agenda_crear: 0.9 }, 0.92),
    ];
    const router = createTurnRouter({
      sqlExecutor,
      mode: 'on',
      jevApiKey: 'k',
      askJevImplementation: async () => verdictQueue.shift() ?? verdictFor({ charla: 1 }),
      createIdentifier: () => `turn-${(identifier += 1)}`,
    });

    const first = await router.route({
      userText: 'agendame el partido del lunes',
      availableToolNameList: ['mcp_9386143d_create_event_cd2e3216', 'recall_memory'],
      context: {},
      nowMilliseconds: 1_000,
      embeddingPromise: Promise.resolve(embeddingForIntent(3, 1)),
    });
    expect(first.applied).toBe(true);
    expect(first.plan?.tier).toBe('narrow');
    await router.record(first, {
      usedToolNameList: ['mcp_9386143d_create_event_cd2e3216'],
      escalated: false,
      llmMilliseconds: 1200,
      llmCallCount: 2,
      totalMilliseconds: 2500,
      toolSchemaChars: 400,
    });

    const second = await router.route({
      userText: 'otra vez no agendaste el partido',
      availableToolNameList: ['mcp_9386143d_create_event_cd2e3216', 'recall_memory'],
      context: { previousUserText: 'agendame el partido del lunes' },
      nowMilliseconds: 40_000,
    });
    await router.record(second, {
      usedToolNameList: [],
      escalated: false,
      llmMilliseconds: 900,
      llmCallCount: 1,
      totalMilliseconds: 1800,
      toolSchemaChars: 400,
    });

    const [firstRow, secondRow] = readRouterDecisionList(sqlExecutor, 0);
    expect(firstRow.outcome).toBe('queja');
    expect(firstRow.label).toBe('agenda_crear');
    expect(firstRow.embedding).toBeDefined();
    expect(secondRow.outcome).toBeUndefined();

    const summary = await runRouterLearning(sqlExecutor, 60 * 60 * 1000);
    expect(summary.decisions).toBe(2);
    expect(summary.complaints).toBe(1);
    const learned = readLearnedRouterState(sqlExecutor);
    expect(learned.thresholdsByIntent.get('agenda_crear')).toEqual({
      narrow: 0.7,
      fast: 0.9,
      examples: 2,
    } as never);
    expect(learned.head).toBeUndefined();
  });

  it('decides nothing in shadow mode and nothing at all when Jev fails', async () => {
    const sqlExecutor = createSqlExecutor();
    const shadowRouter = createTurnRouter({
      sqlExecutor,
      mode: 'shadow',
      jevApiKey: 'k',
      askJevImplementation: async () => verdictFor({ hora: 0.99 }),
    });
    const shadow = await shadowRouter.route({
      userText: 'qué hora es',
      availableToolNameList: [],
      context: {},
      nowMilliseconds: 0,
    });
    expect(shadow.plan?.tier).toBe('fast');
    expect(shadow.applied).toBe(false);

    const failingRouter = createTurnRouter({
      sqlExecutor,
      mode: 'on',
      jevApiKey: 'k',
      askJevImplementation: async () => {
        throw Object.assign(new Error('lento'), { name: 'TimeoutError' });
      },
    });
    const failed = await failingRouter.route({
      userText: 'qué hora es',
      availableToolNameList: [],
      context: {},
      nowMilliseconds: 0,
    });
    expect(failed.plan).toBeUndefined();
    expect(failed.applied).toBe(false);
    expect(failed.source).toBe('timeout');
  });

  it('lets a proven local head answer without waiting for Jev', async () => {
    const sqlExecutor = createSqlExecutor();
    const labelList = ROUTER_INTENT_LIST.map((intent) => intent.id);
    // Historia sintética suficiente para activar el clasificador: 250 turnos
    // de 5 intenciones bien separadas, etiquetados por las herramientas usadas.
    const toolByIntent: Partial<Record<RouterIntentId, string>> = {
      clima: 'weather_now',
      dolar: 'dollar_rate',
      pendientes: 'read_list',
      recordatorio: 'set_reminder',
      viaje: 'mcp_7c6ade76_maps_distance_matrix_03a63731',
    };
    const intentList = Object.keys(toolByIntent) as RouterIntentId[];
    for (let index = 0; index < 250; index += 1) {
      const intentId = intentList[index % intentList.length];
      insertRouterDecision(
        sqlExecutor,
        decisionEntry({
          id: `h${index}`,
          createdAtMilliseconds: index * 1000,
          intentId,
          intentProbability: 0.9,
          intentProbabilityMap: probabilities({ [intentId]: 0.9, charla: 0.1 }),
          usedToolNameList: [toolByIntent[intentId] as string],
          embedding: embeddingForIntent(labelList.indexOf(intentId), index),
        }),
      );
    }
    const summary = (await runRouterLearning(sqlExecutor, 250 * 1000 + 10 * 60 * 1000)) as {
      head: { active: boolean };
    };
    expect(summary.head.active).toBe(true);

    let jevCalled = false;
    let releaseJev: (verdict: JevVerdict) => void = () => {};
    const router = createTurnRouter({
      sqlExecutor,
      mode: 'on',
      jevApiKey: 'k',
      askJevImplementation: () => {
        jevCalled = true;
        // Jev nunca contesta durante la decisión: si el router lo esperara,
        // este test se colgaría.
        return new Promise<JevVerdict>((resolve) => {
          releaseJev = resolve;
        });
      },
    });
    const result = await router.route({
      userText: 'cuánto está el dólar',
      availableToolNameList: ['dollar_rate'],
      context: {},
      nowMilliseconds: 300 * 1000,
      embeddingPromise: Promise.resolve(embeddingForIntent(labelList.indexOf('dolar'), 7777)),
    });
    expect(result.source).toBe('local');
    expect(result.plan?.intentId).toBe('dolar');
    // El maestro igual se consulta, para seguir aprendiendo.
    expect(jevCalled).toBe(true);
    releaseJev(verdictFor({ dolar: 0.97 }));
    // Entrenar 200 ejemplos tarda ~1 s en la Mac y bastante más en la Pi.
  }, 60_000);
});

describe('millisecondsUntilNextLearning', () => {
  it('schedules the next run at 07:00 UTC', () => {
    const now = Date.UTC(2026, 8, 26, 12, 0, 0);
    expect(millisecondsUntilNextLearning(now)).toBe(19 * 60 * 60 * 1000);
    const early = Date.UTC(2026, 8, 26, 6, 30, 0);
    expect(millisecondsUntilNextLearning(early)).toBe(30 * 60 * 1000);
  });
});

describe('reasoning decision and A/B', () => {
  it('follows Jev unless the turn falls in the exploration slice', () => {
    const base = { tier: 'narrow', threshold: 0.5, explorationRate: 0.2 };
    expect(decideReasoning({ ...base, probability: 0.8, random: () => 0.9 })).toEqual({
      probability: 0.8,
      policy: true,
      enabled: true,
      explored: false,
    });
    expect(decideReasoning({ ...base, probability: 0.8, random: () => 0.1 }).enabled).toBe(false);
    expect(decideReasoning({ ...base, probability: 0.2, random: () => 0.9 }).enabled).toBe(false);
  });

  it('reasons only on full-tool turns when Jev gave no opinion', () => {
    const base = { probability: undefined, threshold: 0.5, explorationRate: 0, random: () => 1 };
    expect(decideReasoning({ ...base, tier: 'full' }).enabled).toBe(true);
    expect(decideReasoning({ ...base, tier: 'narrow' }).enabled).toBe(false);
  });

  it('records the applied decision, including explored turns', async () => {
    const sqlExecutor = createSqlExecutor();
    const router = createTurnRouter({
      sqlExecutor,
      mode: 'on',
      jevApiKey: 'k',
      random: () => 0,
      askJevImplementation: async () => ({ ...verdictFor({ clima: 0.95 }), reasoningProbability: 0.9 }),
    });
    const result = await router.route({
      userText: 'qué clima hace',
      availableToolNameList: ['weather_now'],
      context: {},
      nowMilliseconds: 0,
    });
    expect(result.reasoning).toEqual({ probability: 0.9, policy: true, enabled: false, explored: true });
    await router.record(result, {
      usedToolNameList: ['weather_now'],
      escalated: false,
      llmMilliseconds: 3000,
      llmCallCount: 2,
      totalMilliseconds: 4000,
      toolSchemaChars: 100,
    });
    const [row] = readRouterDecisionList(sqlExecutor, 0);
    expect(row.reasoningPolicy).toBe(true);
    expect(row.reasoningUsed).toBe(false);
    expect(row.reasoningExplored).toBe(true);
    expect(row.llmCallCount).toBe(2);
  });

  it('adds the new columns to a table created before the A/B existed', () => {
    const executor = createBunSqliteExecutor(new Database(':memory:'));
    executor.execute(
      'CREATE TABLE router_decisions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, text TEXT NOT NULL, ' +
        'mode TEXT NOT NULL, source TEXT NOT NULL, intent TEXT, intent_p REAL, probs_json TEXT, noise_p REAL, ' +
        'complaint_p REAL, tier TEXT NOT NULL, reason TEXT, exposed_json TEXT, used_json TEXT, ' +
        'escalated INTEGER NOT NULL DEFAULT 0, jev_ms INTEGER, llm_ms INTEGER, total_ms INTEGER, ' +
        'tool_schema_chars INTEGER, outcome TEXT, label TEXT, embedding TEXT)',
    );
    ensureRouterTables(executor);
    ensureRouterTables(executor);
    const columnNameList = executor
      .execute<{ name: string }>('PRAGMA table_info(router_decisions)')
      .map((column) => column.name);
    expect(columnNameList).toContain('reasoning_used');
    expect(columnNameList).toContain('llm_calls');
  });

  function armDecisions(policy: boolean, used: boolean, count: number, failures: number) {
    return Array.from({ length: count }, (_, index) =>
      storedDecision({
        id: `${policy}-${used}-${index}`,
        reasoningPolicy: policy,
        reasoningUsed: used,
        outcome: index < failures ? 'queja' : 'ok',
        llmMilliseconds: used ? 4000 : 2000,
        llmCallCount: 1,
      }),
    );
  }

  it('reasons less when skipping it does not hurt even where Jev asked for it', () => {
    const ab = summarizeReasoningAb([
      ...armDecisions(true, true, 25, 2),
      ...armDecisions(true, false, 25, 2),
    ]);
    expect(ab.razonando.medianLlmMsPerCall).toBe(4000);
    expect(adjustReasoningThreshold(0.5, ab).threshold).toBe(0.6);
  });

  it('reasons more when it clearly helps where Jev said no', () => {
    const ab = summarizeReasoningAb([
      ...armDecisions(false, false, 25, 6),
      ...armDecisions(false, true, 25, 1),
    ]);
    expect(adjustReasoningThreshold(0.5, ab).threshold).toBe(0.4);
  });

  it('does not move without enough turns in both arms', () => {
    const ab = summarizeReasoningAb([
      ...armDecisions(false, false, 25, 10),
      ...armDecisions(false, true, 5, 0),
    ]);
    expect(adjustReasoningThreshold(0.5, ab).threshold).toBe(0.5);
  });
});
