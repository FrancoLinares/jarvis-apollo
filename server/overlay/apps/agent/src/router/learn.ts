import type { MemorySqlExecutor } from '@/memory/store';
import { fitHeadTemperature, predictWithHead, trainIntentHead, type HeadTrainingExample } from '@/router/head';
import { ROUTER_INTENT_BY_ID, ROUTER_INTENT_LIST, type RouterIntentId } from '@/router/intents';
import {
  OUTCOME_WINDOW_MILLISECONDS,
  STORED_EMBEDDING_DIMENSION_COUNT,
  decodeEmbedding,
  deriveRouterLabel,
  ensureRouterTables,
  readRouterDecisionList,
  writeRouterOutcome,
  writeRouterState,
  type StoredRouterDecision,
} from '@/router/log';
import { DEFAULT_ROUTE_THRESHOLDS, type RouteThresholds } from '@/router/plan';
import { DEFAULT_REASONING_THRESHOLD } from '@/router/engine';
import { readRouterState } from '@/router/log';

// El router aprende de sus propias probabilidades, en tres niveles:
//
// 1. Umbrales por intención. Cada intención tiene su umbral de "acotar" y de
//    "vía rápida", elegido para que en la práctica acierte al menos 90 % y
//    97 %. Si una intención empieza a fallar, pierde el atajo sola; si acierta
//    siempre, lo gana con menos confianza.
// 2. Clasificador local destilado de Jev (head.ts), que se activa solo cuando
//    demuestra que acierta en turnos que no vio al entrenar.
// 3. Un reporte de qué intenciones se confunden, para reescribir sus
//    descripciones en intents.ts.
//
// Lección tomada de laya-browser: un conjunto de evaluación que se filtra al
// entrenamiento infla los números. Acá la validación es siempre sobre los
// turnos MÁS NUEVOS, que el clasificador no vio.

export const THRESHOLD_GRID = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95] as const;
export const MIN_EXAMPLES_PER_THRESHOLD = 8;
export const NARROW_TARGET_PRECISION = 0.9;
export const FAST_TARGET_PRECISION = 0.97;
// Nunca por debajo de esto para la vía rápida, aunque los datos lo permitan.
export const FAST_THRESHOLD_FLOOR = 0.85;
// Umbral que en la práctica apaga un nivel para una intención.
export const DISABLED_THRESHOLD = 1.01;

export const HEAD_MIN_TRAINING_EXAMPLES = 150;
export const HEAD_MAX_EXAMPLES = 2000;
export const HEAD_HOLDOUT_FRACTION = 0.2;
export const HEAD_MIN_CONFIDENT_HOLDOUT = 20;
export const HEAD_TARGET_ACCURACY = 0.97;
export const HEAD_CONFIDENCE = 0.9;
// Cuánto pesa la etiqueta del resultado frente a la probabilidad de Jev.
export const LABEL_TARGET_WEIGHT = 0.6;

// Turnos que no tuvieron un turno siguiente dentro de la ventana: se cierran
// como "ok" y se etiquetan.
export function settleStaleOutcomes(
  sqlExecutor: MemorySqlExecutor,
  decisionList: readonly StoredRouterDecision[],
  nowMilliseconds: number,
): number {
  let settledCount = 0;
  for (const decision of decisionList) {
    if (
      decision.outcome === undefined &&
      nowMilliseconds - decision.createdAtMilliseconds > OUTCOME_WINDOW_MILLISECONDS
    ) {
      const outcome = decision.escalated ? 'escalado' : 'ok';
      writeRouterOutcome(sqlExecutor, decision.id, outcome, deriveRouterLabel(decision, outcome));
      settledCount += 1;
    }
  }
  return settledCount;
}

type ScoredPrediction = {
  readonly intentId: RouterIntentId;
  readonly probability: number;
  readonly correct: boolean;
};

function collectScoredPredictions(
  decisionList: readonly StoredRouterDecision[],
): readonly ScoredPrediction[] {
  // Solo las predicciones de Jev: los umbrales se aplican sobre su escala.
  return decisionList.flatMap((decision) => {
    if (
      decision.source !== 'jev' ||
      decision.intentId === undefined ||
      decision.intentProbability === undefined ||
      decision.label === undefined
    ) {
      return [];
    }
    return [
      {
        intentId: decision.intentId,
        probability: decision.intentProbability,
        correct: decision.label === decision.intentId,
      },
    ];
  });
}

function chooseThreshold(
  predictionList: readonly ScoredPrediction[],
  targetPrecision: number,
  defaultThreshold: number,
  floor: number,
): number {
  for (const threshold of THRESHOLD_GRID) {
    if (threshold < floor) {
      continue;
    }
    const aboveList = predictionList.filter((prediction) => prediction.probability >= threshold);
    if (aboveList.length < MIN_EXAMPLES_PER_THRESHOLD) {
      continue;
    }
    const precision = aboveList.filter((prediction) => prediction.correct).length / aboveList.length;
    if (precision >= targetPrecision) {
      return threshold;
    }
  }
  // Sin datos suficientes, el valor de fábrica. Con datos y ningún umbral que
  // llegue a la precisión pedida, esa intención deja de usar el atajo.
  const aboveDefault = predictionList.filter((prediction) => prediction.probability >= defaultThreshold);
  if (aboveDefault.length >= MIN_EXAMPLES_PER_THRESHOLD) {
    const precision = aboveDefault.filter((prediction) => prediction.correct).length / aboveDefault.length;
    if (precision < targetPrecision) {
      return DISABLED_THRESHOLD;
    }
  }
  return defaultThreshold;
}

export function calibrateThresholds(
  decisionList: readonly StoredRouterDecision[],
): Record<RouterIntentId, RouteThresholds & { readonly examples: number }> {
  const predictionList = collectScoredPredictions(decisionList);
  const result = {} as Record<RouterIntentId, RouteThresholds & { readonly examples: number }>;
  for (const intent of ROUTER_INTENT_LIST) {
    const intentPredictionList = predictionList.filter(
      (prediction) => prediction.intentId === intent.id,
    );
    result[intent.id] = {
      narrow: chooseThreshold(
        intentPredictionList,
        NARROW_TARGET_PRECISION,
        DEFAULT_ROUTE_THRESHOLDS.narrow,
        0,
      ),
      fast:
        ROUTER_INTENT_BY_ID.get(intent.id)?.fastPath === undefined
          ? DEFAULT_ROUTE_THRESHOLDS.fast
          : chooseThreshold(
              intentPredictionList,
              FAST_TARGET_PRECISION,
              DEFAULT_ROUTE_THRESHOLDS.fast,
              FAST_THRESHOLD_FLOOR,
            ),
      examples: intentPredictionList.length,
    };
  }
  return result;
}

export type ConfusionPair = { readonly predicted: string; readonly actual: string; readonly count: number };

export function summarizeConfusions(
  decisionList: readonly StoredRouterDecision[],
): readonly ConfusionPair[] {
  const countByPair = new Map<string, number>();
  for (const decision of decisionList) {
    if (
      decision.intentId !== undefined &&
      decision.label !== undefined &&
      decision.intentId !== decision.label
    ) {
      const key = `${decision.intentId}→${decision.label}`;
      countByPair.set(key, (countByPair.get(key) ?? 0) + 1);
    }
  }
  return [...countByPair.entries()]
    .map(([key, count]) => {
      const [predicted, actual] = key.split('→');
      return { predicted, actual, count };
    })
    .sort((left, right) => right.count - left.count)
    .slice(0, 5);
}

function buildTarget(decision: StoredRouterDecision): readonly number[] | undefined {
  const labelList = ROUTER_INTENT_LIST.map((intent) => intent.id);
  const teacher = decision.intentProbabilityMap;
  const teacherVector =
    teacher === undefined ? undefined : labelList.map((label) => teacher[label] ?? 0);
  const labelIndex = decision.label === undefined ? -1 : labelList.indexOf(decision.label);
  if (teacherVector === undefined && labelIndex < 0) {
    return undefined;
  }
  let target = teacherVector ?? labelList.map(() => 0);
  if (labelIndex >= 0) {
    const oneHot = labelList.map((_, index) => (index === labelIndex ? 1 : 0));
    target =
      teacherVector === undefined
        ? oneHot
        : teacherVector.map(
            (value, index) => (1 - LABEL_TARGET_WEIGHT) * value + LABEL_TARGET_WEIGHT * oneHot[index],
          );
  } else if (decision.outcome === 'queja' && decision.intentId !== undefined) {
    // Sin etiqueta pero con queja: lo que se predijo estaba mal. Se le quita
    // esa masa al maestro y se renormaliza.
    const wrongIndex = labelList.indexOf(decision.intentId);
    target = target.map((value, index) => (index === wrongIndex ? 0 : value));
  }
  const total = target.reduce((sum, value) => sum + value, 0);
  return total > 0 ? target.map((value) => value / total) : undefined;
}

export type HeadEvaluation = {
  readonly trainedOn: number;
  readonly heldOut: number;
  readonly confidentHeldOut: number;
  readonly confidentAccuracy: number | undefined;
  readonly coverage: number | undefined;
  readonly active: boolean;
};

export async function trainAndEvaluateHead(decisionList: readonly StoredRouterDecision[]): Promise<{
  readonly head: Awaited<ReturnType<typeof trainIntentHead>> | undefined;
  readonly evaluation: HeadEvaluation;
}> {
  const labelList = ROUTER_INTENT_LIST.map((intent) => intent.id);
  const usable = decisionList.flatMap((decision) => {
    if (decision.embedding === undefined) {
      return [];
    }
    const target = buildTarget(decision);
    if (target === undefined) {
      return [];
    }
    // La referencia para evaluar: la etiqueta si existe, si no lo que dijo Jev.
    const reference =
      decision.label ??
      (decision.intentProbabilityMap === undefined
        ? undefined
        : Object.entries(decision.intentProbabilityMap).sort((l, r) => r[1] - l[1])[0]?.[0]);
    return [{ features: decodeEmbedding(decision.embedding), target, reference, labelled: decision.label !== undefined }];
  });

  // Solo lo más reciente: acota el tiempo de entrenamiento en la Pi y sigue
  // los cambios de hábito.
  usable.splice(0, Math.max(0, usable.length - HEAD_MAX_EXAMPLES));
  const holdoutCount = Math.floor(usable.length * HEAD_HOLDOUT_FRACTION);
  const trainList = usable.slice(0, usable.length - holdoutCount);
  const holdoutList = usable.slice(usable.length - holdoutCount);
  const emptyEvaluation: HeadEvaluation = {
    trainedOn: trainList.length,
    heldOut: holdoutList.length,
    confidentHeldOut: 0,
    confidentAccuracy: undefined,
    coverage: undefined,
    active: false,
  };
  if (trainList.length < HEAD_MIN_TRAINING_EXAMPLES) {
    return { head: undefined, evaluation: emptyEvaluation };
  }

  const exampleList: HeadTrainingExample[] = trainList.map((example) => ({
    features: example.features,
    target: example.target,
    // Las etiquetadas por el resultado valen el doble que las que solo tienen
    // la opinión del maestro.
    weight: example.labelled ? 2 : 1,
  }));
  const head = await trainIntentHead({
    labelList,
    dimensionCount: STORED_EMBEDDING_DIMENSION_COUNT,
    exampleList,
  });
  const temperature = fitHeadTemperature(
    head,
    trainList
      .filter((example) => example.reference !== undefined)
      .map((example) => ({
        features: example.features,
        labelIndex: labelList.indexOf(example.reference as RouterIntentId),
      }))
      .filter((example) => example.labelIndex >= 0),
  );
  const calibratedHead = { ...head, temperature };

  let confidentCount = 0;
  let confidentCorrect = 0;
  for (const example of holdoutList) {
    if (example.reference === undefined) {
      continue;
    }
    const probabilityMap = predictWithHead(calibratedHead, example.features);
    const [bestLabel, bestProbability] = Object.entries(probabilityMap).sort((l, r) => r[1] - l[1])[0];
    if (bestProbability >= HEAD_CONFIDENCE) {
      confidentCount += 1;
      if (bestLabel === example.reference) {
        confidentCorrect += 1;
      }
    }
  }
  const confidentAccuracy = confidentCount === 0 ? undefined : confidentCorrect / confidentCount;
  const coverage = holdoutList.length === 0 ? undefined : confidentCount / holdoutList.length;
  return {
    head: calibratedHead,
    evaluation: {
      ...emptyEvaluation,
      confidentHeldOut: confidentCount,
      confidentAccuracy,
      coverage,
      active:
        confidentCount >= HEAD_MIN_CONFIDENT_HOLDOUT &&
        confidentAccuracy !== undefined &&
        confidentAccuracy >= HEAD_TARGET_ACCURACY,
    },
  };
}

// ---- A/B del razonamiento ----
//
// Cada turno aplicado queda en una de cuatro celdas: lo que dijo Jev (razonar
// o no) × lo que se aplicó (en el 20 % de exploración se invierte). Comparando
// dentro de lo que dijo Jev se aísla el efecto de razonar:
// - Jev dijo NO: ¿razonar igual (exploración) baja los errores? Si baja
//   claramente, el umbral está alto y baja.
// - Jev dijo SÍ: ¿no razonar (exploración) sube los errores? Si no los sube,
//   razonar no está ayudando ni ahí y el umbral sube.
// "Error" = queja sobre el mismo tema, repetir el pedido, o pedir el escape.

export const AB_MIN_TURNS_PER_ARM = 20;
export const AB_HELP_MARGIN = 0.05;
export const AB_NO_HARM_MARGIN = 0.02;
export const REASONING_THRESHOLD_STEP = 0.1;
export const REASONING_THRESHOLD_MIN = 0.1;
export const REASONING_THRESHOLD_MAX = 0.9;

export type ReasoningArmSummary = {
  readonly turns: number;
  readonly failureRate: number | undefined;
  readonly medianLlmMsPerCall: number | undefined;
};

function isFailedOutcome(decision: StoredRouterDecision): boolean {
  return (
    decision.outcome === 'queja' ||
    decision.outcome === 'repetido' ||
    decision.outcome === 'escalado' ||
    decision.escalated
  );
}

function summarizeArm(decisionList: readonly StoredRouterDecision[]): ReasoningArmSummary {
  const judged = decisionList.filter((decision) => decision.outcome !== undefined);
  const perCallList = decisionList
    .filter(
      (decision) =>
        decision.llmMilliseconds !== undefined &&
        decision.llmCallCount !== undefined &&
        decision.llmCallCount > 0,
    )
    .map((decision) => (decision.llmMilliseconds as number) / (decision.llmCallCount as number))
    .sort((left, right) => left - right);
  return {
    turns: decisionList.length,
    failureRate:
      judged.length === 0 ? undefined : judged.filter(isFailedOutcome).length / judged.length,
    medianLlmMsPerCall:
      perCallList.length === 0 ? undefined : Math.round(perCallList[Math.floor(perCallList.length / 2)]),
  };
}

export function summarizeReasoningAb(decisionList: readonly StoredRouterDecision[]) {
  const withDecision = decisionList.filter(
    (decision) => decision.reasoningPolicy !== undefined && decision.reasoningUsed !== undefined,
  );
  const cell = (policy: boolean, used: boolean) =>
    summarizeArm(
      withDecision.filter(
        (decision) => decision.reasoningPolicy === policy && decision.reasoningUsed === used,
      ),
    );
  return {
    jevNo_sinRazonar: cell(false, false),
    jevNo_razonando: cell(false, true),
    jevSi_razonando: cell(true, true),
    jevSi_sinRazonar: cell(true, false),
    razonando: summarizeArm(withDecision.filter((decision) => decision.reasoningUsed === true)),
    sinRazonar: summarizeArm(withDecision.filter((decision) => decision.reasoningUsed === false)),
  };
}

export function adjustReasoningThreshold(
  current: number,
  ab: ReturnType<typeof summarizeReasoningAb>,
): { readonly threshold: number; readonly reason: string } {
  const comparable = (left: ReasoningArmSummary, right: ReasoningArmSummary) =>
    left.turns >= AB_MIN_TURNS_PER_ARM &&
    right.turns >= AB_MIN_TURNS_PER_ARM &&
    left.failureRate !== undefined &&
    right.failureRate !== undefined;

  if (
    comparable(ab.jevNo_sinRazonar, ab.jevNo_razonando) &&
    (ab.jevNo_sinRazonar.failureRate as number) - (ab.jevNo_razonando.failureRate as number) >
      AB_HELP_MARGIN
  ) {
    return {
      threshold: Math.max(REASONING_THRESHOLD_MIN, Math.round((current - REASONING_THRESHOLD_STEP) * 100) / 100),
      reason: 'razonar ayuda aunque Jev diga que no: se razona más seguido',
    };
  }
  if (
    comparable(ab.jevSi_razonando, ab.jevSi_sinRazonar) &&
    (ab.jevSi_sinRazonar.failureRate as number) - (ab.jevSi_razonando.failureRate as number) <=
      AB_NO_HARM_MARGIN
  ) {
    return {
      threshold: Math.min(REASONING_THRESHOLD_MAX, Math.round((current + REASONING_THRESHOLD_STEP) * 100) / 100),
      reason: 'no razonar no empeora ni cuando Jev dice que sí: se razona menos',
    };
  }
  return { threshold: current, reason: 'sin datos suficientes o sin diferencia clara' };
}

// Cuánta historia mira: suficiente para que los umbrales se muevan con el uso
// real, y acotada para que entrenar en la Pi siga siendo cuestión de segundos.
export const LEARNING_WINDOW_MILLISECONDS = 60 * 24 * 60 * 60 * 1000;

export async function runRouterLearning(
  sqlExecutor: MemorySqlExecutor,
  nowMilliseconds: number,
): Promise<Record<string, unknown>> {
  ensureRouterTables(sqlExecutor);
  const since = nowMilliseconds - LEARNING_WINDOW_MILLISECONDS;
  settleStaleOutcomes(sqlExecutor, readRouterDecisionList(sqlExecutor, since), nowMilliseconds);
  const decisionList = readRouterDecisionList(sqlExecutor, since);

  const thresholds = calibrateThresholds(decisionList);
  writeRouterState(sqlExecutor, 'thresholds', JSON.stringify(thresholds), nowMilliseconds);

  const startedAt = Date.now();
  const { head, evaluation } = await trainAndEvaluateHead(decisionList);
  if (head !== undefined) {
    writeRouterState(sqlExecutor, 'head', JSON.stringify(head), nowMilliseconds);
  }
  writeRouterState(sqlExecutor, 'head_active', evaluation.active ? '1' : '0', nowMilliseconds);

  const reasoningAb = summarizeReasoningAb(decisionList);
  const currentReasoningThreshold = Number(
    readRouterState(sqlExecutor, 'reasoning_threshold') ?? DEFAULT_REASONING_THRESHOLD,
  );
  const reasoningAdjustment = adjustReasoningThreshold(currentReasoningThreshold, reasoningAb);
  writeRouterState(
    sqlExecutor,
    'reasoning_threshold',
    String(reasoningAdjustment.threshold),
    nowMilliseconds,
  );
  writeRouterState(sqlExecutor, 'reasoning_ab', JSON.stringify(reasoningAb), nowMilliseconds);

  const labelled = decisionList.filter((decision) => decision.label !== undefined);
  const jevCorrect = labelled.filter(
    (decision) => decision.source === 'jev' && decision.intentId === decision.label,
  ).length;
  const jevLabelled = labelled.filter((decision) => decision.source === 'jev').length;
  const summary = {
    decisions: decisionList.length,
    labelled: labelled.length,
    jevAccuracy: jevLabelled === 0 ? undefined : Math.round((jevCorrect / jevLabelled) * 1000) / 1000,
    escalated: decisionList.filter((decision) => decision.escalated).length,
    complaints: decisionList.filter((decision) => decision.outcome === 'queja').length,
    thresholdsMoved: Object.entries(thresholds)
      .filter(
        ([, value]) =>
          value.narrow !== DEFAULT_ROUTE_THRESHOLDS.narrow || value.fast !== DEFAULT_ROUTE_THRESHOLDS.fast,
      )
      .map(([intentId, value]) => `${intentId}:${value.narrow}/${value.fast}`),
    head: { ...evaluation, trainMs: Date.now() - startedAt },
    confusions: summarizeConfusions(decisionList),
    reasoning: {
      threshold: reasoningAdjustment.threshold,
      change: reasoningAdjustment.reason,
      ab: reasoningAb,
    },
  };
  writeRouterState(sqlExecutor, 'last_learning', JSON.stringify(summary), nowMilliseconds);
  console.log(JSON.stringify({ level: 'info', message: 'apollo_router_aprendizaje', ...summary }));
  return summary;
}

// Una vez por día, a las 4 de la mañana de Buenos Aires (07:00 UTC, Argentina
// no cambia de hora): es cuando nadie le habla a Jarvis.
export const ROUTER_LEARNING_HOUR_UTC = 7;

export function millisecondsUntilNextLearning(nowMilliseconds: number): number {
  const next = new Date(nowMilliseconds);
  next.setUTCHours(ROUTER_LEARNING_HOUR_UTC, 0, 0, 0);
  if (next.getTime() <= nowMilliseconds) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - nowMilliseconds;
}

export function startRouterLearning(sqlExecutor: MemorySqlExecutor): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(async () => {
      try {
        await runRouterLearning(sqlExecutor, Date.now());
      } catch (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'apollo_router_aprendizaje_fallo',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      schedule();
    }, millisecondsUntilNextLearning(Date.now()));
  };
  schedule();
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}
