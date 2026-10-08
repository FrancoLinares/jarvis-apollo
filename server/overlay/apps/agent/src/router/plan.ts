import {
  ROUTER_ALWAYS_TOOL_PATTERN_LIST,
  ROUTER_INTENT_BY_ID,
  ROUTER_INTENT_LIST,
  matchIntentToolNameList,
  type RouterIntentId,
} from '@/router/intents';

// De probabilidades a qué herramientas ve el modelo. Función pura: no llama a
// la red ni a la base, así los umbrales se pueden testear y recalibrar solos.
//
// Cuatro niveles, del más barato al más seguro:
// - ignore: ruido del transcriptor. No se contesta nada.
// - fast:   intención de solo lectura con confianza alta. El modelo no recibe
//           herramientas (salvo la de escape); si hace falta un dato se trae
//           antes y el modelo solo redacta.
// - narrow: el modelo recibe solo las herramientas de la intención.
// - full:   como antes del router. Es el camino cuando hay duda, así que en el
//           peor caso Jarvis se comporta igual que hoy.

export type RouteTier = 'ignore' | 'fast' | 'narrow' | 'full';

export type RouteThresholds = {
  readonly narrow: number;
  readonly fast: number;
};

// Arranque conservador; `learn.ts` los mueve por intención según cuánto acierta
// cada una en la práctica. En la prueba con 30 frases reales, con p ≥ 0,7
// acertó 29 de 29; el ruido de Whisper dio 0,73-0,91 y el pedido real más
// "ruidoso" ("hola") 0,66.
export const DEFAULT_ROUTE_THRESHOLDS: RouteThresholds = { narrow: 0.7, fast: 0.9 };
export const DEFAULT_NOISE_IGNORE_THRESHOLD = 0.88;

// Si la segunda intención tiene al menos esta probabilidad, sus herramientas
// también viajan: dos listas cortas siguen siendo mucho menos que 41.
export const SECOND_INTENT_MIN_PROBABILITY = 0.15;

// Si la segunda candidata es "no sé qué herramientas" (otro, seguimiento) y
// pesa esto, mejor mandar todas.
export const OPEN_SECOND_INTENT_FULL_PROBABILITY = 0.25;

// Un "sí, dale" solo tiene sentido si el turno anterior fue hace poco.
export const FOLLOW_UP_WINDOW_MILLISECONDS = 5 * 60 * 1000;

export type PreviousRouteSummary = {
  readonly createdAtMilliseconds: number;
  readonly exposedToolNameList: readonly string[] | undefined;
  readonly usedToolNameList: readonly string[];
};

export type RoutePlan = {
  readonly tier: RouteTier;
  readonly intentId: RouterIntentId;
  readonly intentProbability: number;
  // undefined = todas las herramientas.
  readonly toolNameList: readonly string[] | undefined;
  readonly preExecuteToolName?: string;
  // false = el modelo no recibe la herramienta de escape.
  readonly escapeAllowed?: boolean;
  readonly reason: string;
};

export function rankIntentProbabilities(
  intentProbabilityMap: Readonly<Record<RouterIntentId, number>>,
): readonly { readonly intentId: RouterIntentId; readonly probability: number }[] {
  return ROUTER_INTENT_LIST.map((intent) => ({
    intentId: intent.id,
    probability: intentProbabilityMap[intent.id] ?? 0,
  })).sort((left, right) => right.probability - left.probability);
}

export function planRoute(input: {
  readonly intentProbabilityMap: Readonly<Record<RouterIntentId, number>>;
  readonly noiseProbability: number | undefined;
  readonly availableToolNameList: readonly string[];
  readonly thresholdsByIntent?: ReadonlyMap<RouterIntentId, RouteThresholds>;
  readonly noiseIgnoreThreshold?: number;
  readonly previousRoute?: PreviousRouteSummary;
  readonly nowMilliseconds: number;
}): RoutePlan {
  const [first, second] = rankIntentProbabilities(input.intentProbabilityMap);
  const firstIntent = ROUTER_INTENT_BY_ID.get(first.intentId);
  const thresholds =
    input.thresholdsByIntent?.get(first.intentId) ?? DEFAULT_ROUTE_THRESHOLDS;
  const base = { intentId: first.intentId, intentProbability: first.probability };
  const full = (reason: string): RoutePlan => ({
    ...base,
    tier: 'full',
    toolNameList: undefined,
    reason,
  });

  // Solo se descarta si además no parece un pedido: un "recordame…" cortado
  // por el ruido igual tiene que llegar al modelo.
  const noiseIgnoreThreshold = input.noiseIgnoreThreshold ?? DEFAULT_NOISE_IGNORE_THRESHOLD;
  if (
    input.noiseProbability !== undefined &&
    input.noiseProbability >= noiseIgnoreThreshold &&
    (first.intentId === 'charla' || first.intentId === 'seguimiento')
  ) {
    return { ...base, tier: 'ignore', toolNameList: [], reason: 'ruido' };
  }

  if (firstIntent === undefined) {
    return full('intención desconocida');
  }

  if (first.intentId === 'seguimiento') {
    const previous = input.previousRoute;
    if (
      previous === undefined ||
      input.nowMilliseconds - previous.createdAtMilliseconds > FOLLOW_UP_WINDOW_MILLISECONDS ||
      previous.exposedToolNameList === undefined
    ) {
      return full('seguimiento sin turno anterior acotado');
    }
    if (first.probability < thresholds.narrow) {
      return full('seguimiento con poca confianza');
    }
    const toolNameList = [
      ...new Set([...previous.exposedToolNameList, ...previous.usedToolNameList]),
    ].filter((toolName) => input.availableToolNameList.includes(toolName));
    return { ...base, tier: 'narrow', toolNameList, reason: 'herramientas del turno anterior' };
  }

  const firstToolNameList = matchIntentToolNameList(firstIntent, input.availableToolNameList);
  if (firstToolNameList === undefined) {
    return full(`la intención ${first.intentId} no acota herramientas`);
  }

  if (
    firstIntent.fastPath !== undefined &&
    first.probability >= thresholds.fast &&
    (firstIntent.fastPath.preExecuteToolName === undefined ||
      input.availableToolNameList.includes(firstIntent.fastPath.preExecuteToolName))
  ) {
    return {
      ...base,
      tier: 'fast',
      toolNameList: [],
      preExecuteToolName: firstIntent.fastPath.preExecuteToolName,
      escapeAllowed: firstIntent.fastPath.withoutEscape !== true,
      reason: 'vía rápida',
    };
  }

  if (first.probability < thresholds.narrow) {
    return full('poca confianza');
  }

  let toolNameList = firstToolNameList;
  if (second !== undefined && second.probability >= SECOND_INTENT_MIN_PROBABILITY) {
    const secondIntent = ROUTER_INTENT_BY_ID.get(second.intentId);
    const secondToolNameList =
      secondIntent === undefined
        ? undefined
        : matchIntentToolNameList(secondIntent, input.availableToolNameList);
    if (secondToolNameList === undefined) {
      if (second.probability >= OPEN_SECOND_INTENT_FULL_PROBABILITY) {
        return full(`segunda intención abierta (${second.intentId})`);
      }
    } else {
      toolNameList = [...new Set([...toolNameList, ...secondToolNameList])];
    }
  }

  const alwaysToolNameList = input.availableToolNameList.filter((toolName) =>
    ROUTER_ALWAYS_TOOL_PATTERN_LIST.some((pattern) => pattern.test(toolName)),
  );
  toolNameList = [...new Set([...toolNameList, ...alwaysToolNameList])];
  return { ...base, tier: 'narrow', toolNameList, reason: 'acotado por intención' };
}
