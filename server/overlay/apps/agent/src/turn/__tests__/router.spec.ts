import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { createInactiveDeskFocusState } from '@/focus/logic';
import { createBunSqliteExecutor } from '@/platform/bun/sql';
import { createTurnRouter, type RouterMode } from '@/router/engine';
import { ROUTER_ESCAPE_TOOL_NAME, ROUTER_INTENT_LIST, type RouterIntentId } from '@/router/intents';
import type { JevVerdict } from '@/router/jev';
import { readRouterDecisionList } from '@/router/log';
import { buildToolDefinitionMap } from '@/tools/router';
import type { ToolDefinition } from '@/tools/types';
import { runDeskTurn, type LanguageModelToolDescriptor, type TurnInput } from '@/turn/run';
import type { OpenRouterChatMessage, OpenRouterToolCall } from '@/voice/llm';

function fakeTool(name: string, summary = `${name} ok`): ToolDefinition {
  return {
    name,
    safety: 'safe',
    description: `herramienta ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      return { ok: true, summary };
    },
  };
}

const TOOL_MAP = buildToolDefinitionMap([
  fakeTool('weather_now', 'Buenos Aires: 18°C, soleado'),
  fakeTool('dollar_rate', 'Dólar blue a $1.300 para la venta'),
  fakeTool('set_reminder'),
  fakeTool('recall_memory'),
  fakeTool('recall_conversation'),
  fakeTool('send_email'),
  fakeTool('web_search'),
]);

function verdictFor(
  entries: Partial<Record<RouterIntentId, number>>,
  noiseProbability = 0,
): JevVerdict {
  return {
    intentProbabilityMap: Object.fromEntries(
      ROUTER_INTENT_LIST.map((intent) => [intent.id, entries[intent.id] ?? 0]),
    ) as Record<RouterIntentId, number>,
    noiseProbability,
    complaintProbability: 0,
    reasoningProbability: 0.1,
    model: 'fake',
    costUsd: undefined,
  };
}

function createHarness(options: {
  readonly verdict: JevVerdict | Error;
  readonly mode?: RouterMode;
  readonly random?: () => number;
  readonly llmScript: (call: {
    readonly roundIndex: number;
    readonly toolNameList: readonly string[];
    readonly messageList: readonly OpenRouterChatMessage[];
  }) => { text: string; toolCallList: OpenRouterToolCall[] };
}) {
  const sqlExecutor = createBunSqliteExecutor(new Database(':memory:'));
  sqlExecutor.execute(
    'CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL)',
  );
  const router = createTurnRouter({
    sqlExecutor,
    mode: options.mode ?? 'on',
    jevApiKey: 'k',
    random: options.random ?? (() => 1),
    askJevImplementation: async () => {
      if (options.verdict instanceof Error) {
        throw options.verdict;
      }
      return options.verdict;
    },
  });
  const llmCallList: {
    toolNameList: readonly string[];
    reasoningEnabled?: boolean;
    toolChoice?: string;
  }[] = [];
  const input: TurnInput = {
    text: 'pedido',
    speechMode: 'default',
    focusState: createInactiveDeskFocusState(),
    sqlExecutor,
    environment: createFakeApolloEnvironment(),
    toolDefinitionMap: TOOL_MAP,
    nowMilliseconds: 1_000,
    router,
    adapters: {
      stt: async () => '',
      llm: async ({ messageList, toolDefinitionList, reasoningEnabled, toolChoice }) => {
        const toolNameList = toolDefinitionList.map(
          (tool: LanguageModelToolDescriptor) => tool.name,
        );
        llmCallList.push({ toolNameList, reasoningEnabled, toolChoice });
        return options.llmScript({ roundIndex: llmCallList.length - 1, toolNameList, messageList });
      },
      tts: async () => new ArrayBuffer(4),
    },
  };
  // El registro corre sin esperar al turno: se le da una vuelta al loop.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { input, llmCallList, sqlExecutor, settle };
}

describe('runDeskTurn with the intent router', () => {
  it('shows the model only the routed tools plus the escape hatch', async () => {
    const harness = createHarness({
      verdict: verdictFor({ clima: 0.95 }),
      llmScript: ({ roundIndex }) =>
        roundIndex === 0
          ? { text: '', toolCallList: [{ id: 'w', name: 'weather_now', args: {} }] }
          : { text: 'Hace 18 grados.', toolCallList: [] },
    });
    const output = await runDeskTurn(harness.input);
    expect(output.spokenText).toBe('Hace 18 grados.');
    expect(harness.llmCallList[0].toolNameList).toEqual([
      'weather_now',
      'recall_conversation',
      ROUTER_ESCAPE_TOOL_NAME,
    ]);
    await harness.settle();
    const [row] = readRouterDecisionList(harness.sqlExecutor, 0);
    expect(row.tier).toBe('narrow');
    expect(row.escalated).toBe(false);
  });

  it('widens to every tool when the model asks for the escape hatch', async () => {
    const harness = createHarness({
      verdict: verdictFor({ clima: 0.95 }),
      llmScript: ({ roundIndex }) => {
        if (roundIndex === 0) {
          return { text: '', toolCallList: [{ id: 'e1', name: ROUTER_ESCAPE_TOOL_NAME, args: {} }] };
        }
        if (roundIndex === 1) {
          return { text: '', toolCallList: [{ id: 't1', name: 'send_email', args: {} }] };
        }
        return { text: 'Mandé el mail.', toolCallList: [] };
      },
    });
    const output = await runDeskTurn(harness.input);
    expect(output.spokenText).toBe('Mandé el mail.');
    expect(harness.llmCallList[1].toolNameList).toContain('send_email');
    expect(harness.llmCallList[1].toolNameList).not.toContain(ROUTER_ESCAPE_TOOL_NAME);
    // La herramienta de escape no se ejecuta ni cuenta como herramienta usada.
    expect(output.executedToolCallList.map((call) => call.name)).toEqual(['send_email']);
    await harness.settle();
    const [row] = readRouterDecisionList(harness.sqlExecutor, 0);
    expect(row.escalated).toBe(true);
    expect(row.usedToolNameList).toEqual(['send_email']);
  });

  it('pre-executes the read-only tool on the fast path so the model only phrases it', async () => {
    const harness = createHarness({
      verdict: verdictFor({ dolar: 0.99 }),
      llmScript: ({ messageList }) => {
        const toolMessage = messageList.find((message) => message.role === 'tool');
        return {
          text: toolMessage !== undefined ? 'El blue está a 1.300.' : 'No sé.',
          toolCallList: [],
        };
      },
    });
    const output = await runDeskTurn(harness.input);
    expect(output.spokenText).toBe('El blue está a 1.300.');
    expect(harness.llmCallList).toHaveLength(1);
    expect(harness.llmCallList[0].toolNameList).toEqual([ROUTER_ESCAPE_TOOL_NAME]);
    expect(output.executedToolCallList.map((call) => call.name)).toEqual(['dollar_rate']);
  });

  it('gives the model no tools at all for the time', async () => {
    const harness = createHarness({
      verdict: verdictFor({ hora: 0.99 }),
      llmScript: () => ({ text: 'Son las tres.', toolCallList: [] }),
    });
    await runDeskTurn(harness.input);
    expect(harness.llmCallList[0].toolNameList).toEqual([]);
  });

  it('turns reasoning off in every round when Jev says it is not needed', async () => {
    const harness = createHarness({
      verdict: { ...verdictFor({ clima: 0.95 }), reasoningProbability: 0.1 },
      llmScript: ({ roundIndex }) =>
        roundIndex === 0
          ? { text: '', toolCallList: [{ id: 'w', name: 'weather_now', args: {} }] }
          : { text: 'Hace 18.', toolCallList: [] },
    });
    await runDeskTurn(harness.input);
    expect(harness.llmCallList.map((call) => call.reasoningEnabled)).toEqual([false, false]);
  });

  it('keeps the model default when there was no routing decision', async () => {
    const harness = createHarness({
      verdict: new Error('caído'),
      llmScript: () => ({ text: 'Hola.', toolCallList: [] }),
    });
    await runDeskTurn(harness.input);
    expect(harness.llmCallList[0].reasoningEnabled).toBeUndefined();
  });

  it('makes the model actually schedule a reminder it only claimed to set', async () => {
    const harness = createHarness({
      verdict: verdictFor({ recordatorio: 0.98 }),
      llmScript: ({ roundIndex }) => {
        if (roundIndex === 0) {
          return { text: 'Listo, mañana a las 19 te aviso.', toolCallList: [] };
        }
        if (roundIndex === 1) {
          return { text: '', toolCallList: [{ id: 'r', name: 'set_reminder', args: {} }] };
        }
        return { text: 'Ahora sí, programado para mañana a las 19.', toolCallList: [] };
      },
    });
    const output = await runDeskTurn(harness.input);
    expect(harness.llmCallList.map((call) => call.toolChoice)).toEqual([undefined, 'required', undefined]);
    expect(output.executedToolCallList.map((call) => call.name)).toEqual(['set_reminder']);
    expect(output.spokenText).toBe('Ahora sí, programado para mañana a las 19.');
    await harness.settle();
    const [row] = readRouterDecisionList(harness.sqlExecutor, 0);
    expect(row.escalated).toBe(true);
  });

  it('makes the model look before giving weather it never fetched', async () => {
    const harness = createHarness({
      verdict: verdictFor({ clima: 0.95 }),
      llmScript: ({ roundIndex }) => {
        if (roundIndex === 0) {
          return { text: 'Hace 18 grados.', toolCallList: [] };
        }
        if (roundIndex === 1) {
          return { text: '', toolCallList: [{ id: 'w', name: 'weather_now', args: {} }] };
        }
        return { text: 'Buenos Aires: 18°C, soleado.', toolCallList: [] };
      },
    });
    const output = await runDeskTurn(harness.input);
    expect(harness.llmCallList[1].toolChoice).toBe('required');
    expect(output.executedToolCallList.map((call) => call.name)).toEqual(['weather_now']);
  });

  it('does not second-guess a reply that asks for a missing detail', async () => {
    const harness = createHarness({
      verdict: verdictFor({ recordatorio: 0.98 }),
      llmScript: () => ({ text: '¿A las 7 o a las 8? Decime y lo dejo fijo.', toolCallList: [] }),
    });
    await runDeskTurn(harness.input);
    expect(harness.llmCallList).toHaveLength(1);
  });

  it('drops transcriber noise without calling the model', async () => {
    const harness = createHarness({
      verdict: verdictFor({ charla: 0.9 }, 0.95),
      llmScript: () => ({ text: 'De nada.', toolCallList: [] }),
    });
    const output = await runDeskTurn(harness.input);
    expect(output.uiEventList).toContain('CANCEL');
    expect(output.spokenText).toBe('');
    expect(harness.llmCallList).toHaveLength(0);
  });

  it('behaves exactly as before when Jev fails', async () => {
    const harness = createHarness({
      verdict: new Error('Jev respondió 500'),
      llmScript: () => ({ text: 'Hola.', toolCallList: [] }),
    });
    await runDeskTurn(harness.input);
    expect(harness.llmCallList[0].toolNameList).toEqual([...TOOL_MAP.keys()]);
  });

  it('only records in shadow mode', async () => {
    const harness = createHarness({
      mode: 'shadow',
      verdict: verdictFor({ clima: 0.95 }, 0.95),
      llmScript: () => ({ text: 'Hola.', toolCallList: [] }),
    });
    await runDeskTurn(harness.input);
    expect(harness.llmCallList[0].toolNameList).toEqual([...TOOL_MAP.keys()]);
    await harness.settle();
    const [row] = readRouterDecisionList(harness.sqlExecutor, 0);
    expect(row.mode).toBe('shadow');
    expect(row.exposedToolNameList).toEqual(['weather_now', 'recall_conversation']);
  });
});
