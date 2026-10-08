import { describe, expect, it } from 'bun:test';

import {
  ROUTER_ESCAPE_TOOL_NAME,
  ROUTER_INTENT_LIST,
  resolveIntentForUsedToolList,
  type RouterIntentId,
} from '@/router/intents';
import { buildJevRequestBody, parseJevResponse } from '@/router/jev';
import { planRoute } from '@/router/plan';

const AVAILABLE_TOOL_NAME_LIST = [
  'weather_now',
  'set_weather_location',
  'set_reminder',
  'list_reminders',
  'cancel_reminder',
  'set_timer',
  'dollar_rate',
  'web_search',
  'start_research',
  'recall_memory',
  'recall_conversation',
  'read_list',
  'add_to_list',
  'remove_from_list',
  'send_email',
  'mcp_9386143d_create_event_cd2e3216',
  'mcp_9386143d_list_events_40d5d8e7',
  'mcp_9386143d_search_events_4b74d717',
  'mcp_9386143d_delete_event_96d96635',
  'mcp_7c6ade76_maps_distance_matrix_03a63731',
  'mcp_1a796539_API_post_search_8d5a0bc6',
];

function probabilities(
  entries: Partial<Record<RouterIntentId, number>>,
): Record<RouterIntentId, number> {
  return Object.fromEntries(
    ROUTER_INTENT_LIST.map((intent) => [intent.id, entries[intent.id] ?? 0]),
  ) as Record<RouterIntentId, number>;
}

describe('planRoute', () => {
  it('narrows to the tools of a confident intent plus the conversation recall', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ viaje: 0.96, charla: 0.04 }),
      noiseProbability: 0.1,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      nowMilliseconds: 0,
    });
    expect(plan.tier).toBe('narrow');
    expect(plan.toolNameList).toEqual([
      'web_search',
      'mcp_7c6ade76_maps_distance_matrix_03a63731',
      'recall_conversation',
    ]);
  });

  it('adds the tools of a plausible second intent', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ recordatorio: 0.75, agenda_crear: 0.2 }),
      noiseProbability: 0,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      nowMilliseconds: 0,
    });
    expect(plan.tier).toBe('narrow');
    expect(plan.toolNameList).toContain('mcp_9386143d_delete_event_96d96635');
    expect(plan.toolNameList).toContain('cancel_reminder');
  });

  it('falls back to every tool when confidence is low', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ clima: 0.5, busqueda_web: 0.5 }),
      noiseProbability: 0,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      nowMilliseconds: 0,
    });
    expect(plan.tier).toBe('full');
    expect(plan.toolNameList).toBeUndefined();
  });

  it('sends every tool when an open-ended intent is a serious second candidate', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ pendientes: 0.7, otro: 0.3 }),
      noiseProbability: 0,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      nowMilliseconds: 0,
    });
    expect(plan.tier).toBe('full');
  });

  it('takes the fast path for a confident read-only intent and pre-executes its tool', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ dolar: 0.99 }),
      noiseProbability: 0,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      nowMilliseconds: 0,
    });
    expect(plan.tier).toBe('fast');
    expect(plan.toolNameList).toEqual([]);
    expect(plan.preExecuteToolName).toBe('dollar_rate');
  });

  it('answers the time with no tools at all, not even the escape hatch', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ hora: 0.99 }),
      noiseProbability: 0,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      nowMilliseconds: 0,
    });
    expect(plan.tier).toBe('fast');
    expect(plan.escapeAllowed).toBe(false);
  });

  it('does not take the fast path when the pre-executed tool is not installed', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ dolar: 0.99 }),
      noiseProbability: 0,
      availableToolNameList: ['web_search'],
      nowMilliseconds: 0,
    });
    expect(plan.tier).toBe('narrow');
  });

  it('respects learned per-intent thresholds', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ hora: 0.93 }),
      noiseProbability: 0,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      thresholdsByIntent: new Map([['hora', { narrow: 0.7, fast: 1.01 }]]),
      nowMilliseconds: 0,
    });
    expect(plan.tier).toBe('narrow');
  });

  it('ignores transcriber noise only when it does not look like a request', () => {
    const noise = planRoute({
      intentProbabilityMap: probabilities({ charla: 0.8 }),
      noiseProbability: 0.9,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      nowMilliseconds: 0,
    });
    expect(noise.tier).toBe('ignore');

    const noisyRequest = planRoute({
      intentProbabilityMap: probabilities({ recordatorio: 0.8 }),
      noiseProbability: 0.9,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      nowMilliseconds: 0,
    });
    expect(noisyRequest.tier).toBe('narrow');
  });

  it('keeps a real follow-up that scored just under the noise threshold', () => {
    // "Gracias. Y también lo mismo con el resto." sacó 0,85 en los turnos
    // históricos: es un pedido, no ruido.
    const plan = planRoute({
      intentProbabilityMap: probabilities({ seguimiento: 0.9 }),
      noiseProbability: 0.85,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      nowMilliseconds: 0,
    });
    expect(plan.tier).not.toBe('ignore');
  });

  it('resolves a recent follow-up with the tools of the previous turn', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ seguimiento: 0.95 }),
      noiseProbability: 0,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      previousRoute: {
        createdAtMilliseconds: 1_000,
        exposedToolNameList: ['set_reminder'],
        usedToolNameList: ['mcp_9386143d_create_event_cd2e3216'],
      },
      nowMilliseconds: 61_000,
    });
    expect(plan.tier).toBe('narrow');
    expect(plan.toolNameList).toEqual(['set_reminder', 'mcp_9386143d_create_event_cd2e3216']);
  });

  it('sends every tool for a follow-up with no recent narrowed turn', () => {
    const plan = planRoute({
      intentProbabilityMap: probabilities({ seguimiento: 0.95 }),
      noiseProbability: 0,
      availableToolNameList: AVAILABLE_TOOL_NAME_LIST,
      previousRoute: {
        createdAtMilliseconds: 0,
        exposedToolNameList: ['set_reminder'],
        usedToolNameList: [],
      },
      nowMilliseconds: 10 * 60 * 1000,
    });
    expect(plan.tier).toBe('full');
  });
});

describe('resolveIntentForUsedToolList', () => {
  it('reads the intent from the tools the model used', () => {
    expect(
      resolveIntentForUsedToolList(['mcp_7c6ade76_maps_distance_matrix_03a63731'], 'charla'),
    ).toBe('viaje');
  });

  it('keeps the predicted intent when it also owns every used tool', () => {
    expect(resolveIntentForUsedToolList(['set_reminder'], 'agenda_crear')).toBe('agenda_crear');
  });

  it('ignores the escape tool and unknown tools', () => {
    expect(resolveIntentForUsedToolList([ROUTER_ESCAPE_TOOL_NAME], 'hora')).toBeUndefined();
    expect(resolveIntentForUsedToolList(['send_email'], 'hora')).toBeUndefined();
  });
});

describe('Jev request and response', () => {
  it('gives every question instructions, which the endpoint requires', () => {
    const body = buildJevRequestBody('qué hora es', {}, 'typesafe/jev-1.13') as {
      questions: Record<string, { instructions?: string; type: string }>;
      state: Record<string, string>;
    };
    for (const question of Object.values(body.questions)) {
      expect(typeof question.instructions).toBe('string');
    }
    expect(Object.keys(body.questions)).toEqual(['intent', 'es_ruido', 'es_queja', 'requiere_razonar', 'personaje']);
    expect(body.state.transcripcion).toBe('qué hora es');
  });

  it('includes the previous turn only when there is one', () => {
    const body = buildJevRequestBody('sí, dale', { previousUserText: 'agendame el partido' }, 'm') as {
      state: Record<string, string>;
    };
    expect(body.state.turno_anterior_usuario).toBe('agendame el partido');
    expect(body.state.turno_anterior_asistente).toBeUndefined();
  });

  it('maps a response onto every known intent and drops unknown labels', () => {
    const verdict = parseJevResponse({
      model: 'typesafe/jev-1.13-20260917',
      answers: {
        intent: { choice: 'hora', probabilities: { hora: 0.9, clima: 0.1, inventada: 0.5 } },
        es_ruido: { noul: 0.1 },
        es_queja: { noul: 0.05 },
      },
      usage: { cost: 0.000014 },
    });
    expect(verdict.intentProbabilityMap.hora).toBe(0.9);
    expect(verdict.intentProbabilityMap.viaje).toBe(0);
    expect('inventada' in verdict.intentProbabilityMap).toBe(false);
    expect(verdict.noiseProbability).toBe(0.1);
    expect(verdict.costUsd).toBe(0.000014);
  });
});
