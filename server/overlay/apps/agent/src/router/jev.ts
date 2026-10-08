import { z } from 'zod';

import { reportApiCost } from '@/costs/ledger';
import {
  CHARACTER_INSTRUCTIONS,
  CHARACTER_LIST,
  isCharacterId,
  type CharacterId,
} from '@/persona/characters';
import { ROUTER_INTENT_LIST, isRouterIntentId, type RouterIntentId } from '@/router/intents';

// Jev (TypeSafe) es un modelo de decisión NO autorregresivo: no genera texto,
// contesta varias preguntas de opción múltiple en una sola pasada y devuelve una
// probabilidad por opción. Se usa como "sistema 1" antes del LLM.
//
// Medido desde la Pi el 2026-09-26: ~450 ms por llamada, con algún pico de 2 s,
// y USD 0,000014 por turno. Se lanza en paralelo con la memoria semántica (que
// tarda lo mismo), así que en el caso normal no suma latencia. Si no contesta a
// tiempo, el turno sigue como antes: con todas las herramientas.

export const JEV_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const JEV_DEFAULT_MODEL = 'typesafe/jev-1.13';
export const JEV_DEFAULT_TIMEOUT_MILLISECONDS = 1500;

export type JevVerdict = {
  readonly intentProbabilityMap: Readonly<Record<RouterIntentId, number>>;
  readonly noiseProbability: number;
  readonly complaintProbability: number;
  readonly reasoningProbability: number | undefined;
  // undefined = Jev no contestó la pregunta (versión vieja o falla parcial).
  readonly characterProbabilityMap?: Readonly<Partial<Record<CharacterId, number>>> | undefined;
  readonly model: string;
  readonly costUsd: number | undefined;
};

const choiceAnswerSchema = z.object({
  choice: z.string().optional(),
  probabilities: z.record(z.string(), z.number()),
});

const noulAnswerSchema = z.object({
  noul: z.number(),
});

const jevResponseSchema = z.object({
  model: z.string().default('desconocido'),
  answers: z.object({
    intent: choiceAnswerSchema,
    es_ruido: noulAnswerSchema,
    es_queja: noulAnswerSchema,
    requiere_razonar: noulAnswerSchema.optional(),
    personaje: choiceAnswerSchema.optional(),
  }),
  usage: z.object({ cost: z.number().optional() }).partial().optional(),
});

// El texto viene de Whisper: con ruido de fondo inventa muletillas ("Gracias.
// Gracias. Amén."). El filtro de silencio atrapa las exactas; esta pregunta
// atrapa las variantes.
const NOISE_INSTRUCTIONS =
  '¿El texto es ruido del transcriptor o palabras sueltas (gracias repetido, amén, frases cortadas sin sentido) sin ningún pedido real para el asistente?';

// Una queja sobre el turno anterior es la señal de error más clara que hay:
// "otra vez no agendaste", "te pedí que me avises".
const COMPLAINT_INSTRUCTIONS =
  '¿El usuario se queja de que el asistente no hizo bien, no hizo, o hizo mal algo que le pidió antes?';

// Razonar cuesta ~2 s por ronda. Hace falta cuando hay que encadenar pasos o
// hacer cuentas con fechas; para la hora, el clima o una charla sobra.
const REASONING_INSTRUCTIONS =
  '¿Para cumplir bien el pedido el asistente tiene que razonar varios pasos: calcular fechas relativas o recurrentes, hacer cuentas, combinar varios datos o resolver un pedido ambiguo o largo?';

const INTENT_INSTRUCTIONS =
  '¿Qué quiere el usuario de su asistente de voz? El texto viene de un transcriptor y puede tener errores o ruido. Usá el turno anterior solo si la frase no se entiende sola.';

export type JevTurnContext = {
  readonly previousUserText?: string;
  readonly previousAssistantText?: string;
};

export function buildJevRequestBody(
  userText: string,
  context: JevTurnContext,
  model: string,
): Record<string, unknown> {
  const state: Record<string, string> = { transcripcion: userText };
  if (context.previousUserText !== undefined && context.previousUserText.length > 0) {
    state.turno_anterior_usuario = context.previousUserText.slice(0, 200);
  }
  if (
    context.previousAssistantText !== undefined &&
    context.previousAssistantText.length > 0
  ) {
    state.turno_anterior_asistente = context.previousAssistantText.slice(0, 200);
  }
  return {
    model,
    state,
    questions: {
      intent: {
        type: 'choice',
        instructions: INTENT_INSTRUCTIONS,
        criteria: Object.fromEntries(
          ROUTER_INTENT_LIST.map((intent) => [intent.id, intent.description]),
        ),
      },
      es_ruido: { type: 'noul', instructions: NOISE_INSTRUCTIONS },
      es_queja: { type: 'noul', instructions: COMPLAINT_INSTRUCTIONS },
      requiere_razonar: { type: 'noul', instructions: REASONING_INSTRUCTIONS },
      personaje: {
        type: 'choice',
        instructions: CHARACTER_INSTRUCTIONS,
        criteria: Object.fromEntries(
          CHARACTER_LIST.map((character) => [character.id, character.criteria]),
        ),
      },
    },
  };
}

export function parseJevResponse(payload: unknown): JevVerdict {
  const parsed = jevResponseSchema.parse(payload);
  const intentProbabilityMap = Object.fromEntries(
    ROUTER_INTENT_LIST.map((intent) => [intent.id, 0]),
  ) as Record<RouterIntentId, number>;
  for (const [label, probability] of Object.entries(parsed.answers.intent.probabilities)) {
    if (isRouterIntentId(label)) {
      intentProbabilityMap[label] = probability;
    }
  }
  let characterProbabilityMap: Partial<Record<CharacterId, number>> | undefined;
  if (parsed.answers.personaje !== undefined) {
    characterProbabilityMap = {};
    for (const [label, probability] of Object.entries(parsed.answers.personaje.probabilities)) {
      if (isCharacterId(label)) {
        characterProbabilityMap[label] = probability;
      }
    }
  }
  return {
    intentProbabilityMap,
    characterProbabilityMap,
    noiseProbability: parsed.answers.es_ruido.noul,
    complaintProbability: parsed.answers.es_queja.noul,
    reasoningProbability: parsed.answers.requiere_razonar?.noul,
    model: parsed.model,
    costUsd: parsed.usage?.cost,
  };
}

export async function askJev(input: {
  readonly userText: string;
  readonly context: JevTurnContext;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMilliseconds?: number;
  readonly fetchImplementation?: typeof fetch;
}): Promise<JevVerdict> {
  const baseUrl = (input.baseUrl ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const response = await fetchImplementation(`${baseUrl}/systemone`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      buildJevRequestBody(input.userText, input.context, input.model ?? JEV_DEFAULT_MODEL),
    ),
    signal: AbortSignal.timeout(input.timeoutMilliseconds ?? JEV_DEFAULT_TIMEOUT_MILLISECONDS),
  });
  if (!response.ok) {
    throw new Error(`Jev respondió ${response.status}`);
  }
  const verdict = parseJevResponse(await response.json());
  reportApiCost({ component: 'jev', model: verdict.model, costUsd: verdict.costUsd });
  return verdict;
}
