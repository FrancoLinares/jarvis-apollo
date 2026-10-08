import type { MemorySqlExecutor } from '@/memory/store';
import { chooseCharacter, type CharacterId } from '@/persona/characters';
import { predictWithHead, type IntentHead } from '@/router/head';
import {
  ROUTER_INTENT_LIST,
  isRouterIntentId,
  type RouterIntentId,
} from '@/router/intents';
import { askJev, type JevTurnContext, type JevVerdict } from '@/router/jev';
import {
  deriveRouterLabel,
  ensureRouterTables,
  insertRouterDecision,
  judgePreviousOutcome,
  readLatestRouterDecision,
  readRouterState,
  truncateEmbedding,
  writeRouterOutcome,
  type RouterDecisionSource,
  type RouterReasoningDecision,
} from '@/router/log';
import {
  planRoute,
  type RoutePlan,
  type RouteThresholds,
} from '@/router/plan';

// El router del turno. Tres modos, por ROUTER_MODE:
// - off:    no existe (ni siquiera llama a Jev).
// - shadow: decide y anota, pero el turno usa todas las herramientas como
//           siempre. Sirve para medir sin riesgo.
// - on:     el turno usa lo que decidió.
//
// Cualquier falla (Jev caído, lento, respuesta rara) cae en "todas las
// herramientas": en el peor caso Jarvis se comporta como antes del router.

export type RouterMode = 'off' | 'shadow' | 'on';

export function resolveRouterMode(value: string | undefined): RouterMode {
  return value === 'off' || value === 'shadow' ? value : 'on';
}

export type RouteResult = {
  readonly decisionId: string;
  readonly createdAtMilliseconds: number;
  readonly userText: string;
  readonly mode: RouterMode;
  readonly source: RouterDecisionSource;
  // undefined = no hubo decisión utilizable: todas las herramientas.
  readonly plan: RoutePlan | undefined;
  // Si el turno debe obedecer el plan (modo on y hubo plan).
  readonly applied: boolean;
  readonly jevMilliseconds: number | undefined;
  readonly jevVerdictPromise: Promise<JevVerdict | undefined>;
  readonly embeddingPromise: Promise<readonly number[] | undefined>;
  // undefined = el modelo razona como venga por defecto (sin decisión).
  readonly reasoning: RouterReasoningDecision | undefined;
  // Personaje del turno. undefined = sin veredicto de Jev (falla, o decidió el
  // clasificador local sin esperarlo): se contesta normal.
  readonly character: CharacterId | undefined;
};

export type RouteReport = {
  readonly usedToolNameList: readonly string[];
  readonly escalated: boolean;
  readonly llmMilliseconds: number | undefined;
  readonly llmCallCount: number | undefined;
  readonly totalMilliseconds: number | undefined;
  readonly toolSchemaChars: number | undefined;
};

export type TurnRouter = {
  readonly route: (input: {
    readonly userText: string;
    readonly availableToolNameList: readonly string[];
    readonly context: JevTurnContext;
    readonly nowMilliseconds: number;
    readonly embeddingPromise?: Promise<readonly number[] | undefined>;
  }) => Promise<RouteResult>;
  readonly record: (result: RouteResult, report: RouteReport) => Promise<void>;
};

// Estado aprendido (umbrales y clasificador local). Lo escribe learn.ts; acá se
// relee cada tanto para no ir a la base en cada turno.
export const LEARNED_STATE_REFRESH_MILLISECONDS = 10 * 60 * 1000;
export const LOCAL_HEAD_CONFIDENCE = 0.9;

// Razonamiento: se activa si Jev dice que hace falta con al menos esta
// probabilidad. learn.ts puede moverlo según el A/B.
export const DEFAULT_REASONING_THRESHOLD = 0.5;
// A/B: en esta fracción de los turnos se invierte la decisión de Jev, para
// medir qué se pierde o se gana al contradecirlo. Sin esto solo se vería una
// de las dos ramas y no habría con qué comparar.
export const DEFAULT_REASONING_EXPLORATION_RATE = 0.2;

export function decideReasoning(input: {
  readonly probability: number | undefined;
  readonly tier: string;
  readonly threshold: number;
  readonly explorationRate: number;
  readonly random: () => number;
}): RouterReasoningDecision {
  // Sin la opinión de Jev (decidió el clasificador local), razona solo el
  // turno que va con todas las herramientas, que es el complicado.
  const policy =
    input.probability === undefined
      ? input.tier === 'full'
      : input.probability >= input.threshold;
  const explored = input.random() < input.explorationRate;
  return {
    probability: input.probability,
    policy,
    enabled: explored ? !policy : policy,
    explored,
  };
}

export type LearnedRouterState = {
  readonly thresholdsByIntent: ReadonlyMap<RouterIntentId, RouteThresholds>;
  readonly noiseIgnoreThreshold: number | undefined;
  readonly head: IntentHead | undefined;
  readonly reasoningThreshold: number | undefined;
};

export function readLearnedRouterState(sqlExecutor: MemorySqlExecutor): LearnedRouterState {
  const thresholdsByIntent = new Map<RouterIntentId, RouteThresholds>();
  const thresholdsJson = readRouterState(sqlExecutor, 'thresholds');
  if (thresholdsJson !== undefined) {
    const parsed = JSON.parse(thresholdsJson) as Record<string, RouteThresholds>;
    for (const [intentId, thresholds] of Object.entries(parsed)) {
      if (isRouterIntentId(intentId)) {
        thresholdsByIntent.set(intentId, thresholds);
      }
    }
  }
  const headJson = readRouterState(sqlExecutor, 'head');
  const headActive = readRouterState(sqlExecutor, 'head_active') === '1';
  const noiseJson = readRouterState(sqlExecutor, 'noise_threshold');
  const reasoningJson = readRouterState(sqlExecutor, 'reasoning_threshold');
  return {
    reasoningThreshold: reasoningJson === undefined ? undefined : Number(reasoningJson),
    thresholdsByIntent,
    noiseIgnoreThreshold: noiseJson === undefined ? undefined : Number(noiseJson),
    head: headActive && headJson !== undefined ? (JSON.parse(headJson) as IntentHead) : undefined,
  };
}

function headProbabilitiesToIntentMap(
  probabilityMap: Record<string, number>,
): Record<RouterIntentId, number> {
  return Object.fromEntries(
    ROUTER_INTENT_LIST.map((intent) => [intent.id, probabilityMap[intent.id] ?? 0]),
  ) as Record<RouterIntentId, number>;
}

function logRouterEvent(payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', message: 'apollo_router', ...payload }));
}

export function createTurnRouter(dependencies: {
  readonly sqlExecutor: MemorySqlExecutor;
  readonly mode: RouterMode;
  readonly jevApiKey: string;
  readonly jevBaseUrl?: string;
  readonly jevModel?: string;
  readonly jevTimeoutMilliseconds?: number;
  readonly askJevImplementation?: typeof askJev;
  readonly createIdentifier?: () => string;
  readonly reasoningExplorationRate?: number;
  readonly random?: () => number;
}): TurnRouter {
  const random = dependencies.random ?? Math.random;
  const reasoningExplorationRate =
    dependencies.reasoningExplorationRate ?? DEFAULT_REASONING_EXPLORATION_RATE;
  ensureRouterTables(dependencies.sqlExecutor);
  const ask = dependencies.askJevImplementation ?? askJev;
  const createIdentifier = dependencies.createIdentifier ?? (() => crypto.randomUUID());
  let learnedState: LearnedRouterState | undefined;
  let learnedStateReadAt = 0;

  function currentLearnedState(nowMilliseconds: number): LearnedRouterState {
    if (
      learnedState === undefined ||
      nowMilliseconds - learnedStateReadAt > LEARNED_STATE_REFRESH_MILLISECONDS
    ) {
      try {
        learnedState = readLearnedRouterState(dependencies.sqlExecutor);
      } catch {
        learnedState = {
          thresholdsByIntent: new Map(),
          noiseIgnoreThreshold: undefined,
          head: undefined,
          reasoningThreshold: undefined,
        };
      }
      learnedStateReadAt = nowMilliseconds;
    }
    return learnedState;
  }

  return {
    async route(input) {
      const decisionId = createIdentifier();
      const embeddingPromise = (input.embeddingPromise ?? Promise.resolve(undefined)).catch(
        () => undefined,
      );
      const jevStartedAt = Date.now();
      let jevMilliseconds: number | undefined;
      let jevFailure: RouterDecisionSource | undefined;
      const jevVerdictPromise: Promise<JevVerdict | undefined> = ask({
        userText: input.userText,
        context: input.context,
        apiKey: dependencies.jevApiKey,
        baseUrl: dependencies.jevBaseUrl,
        model: dependencies.jevModel,
        timeoutMilliseconds: dependencies.jevTimeoutMilliseconds,
      })
        .then((verdict) => {
          jevMilliseconds = Date.now() - jevStartedAt;
          return verdict;
        })
        .catch((error: unknown) => {
          jevMilliseconds = Date.now() - jevStartedAt;
          jevFailure =
            error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
              ? 'timeout'
              : 'error';
          return undefined;
        });

      const learned = currentLearnedState(input.nowMilliseconds);
      const previous = (() => {
        try {
          return readLatestRouterDecision(dependencies.sqlExecutor);
        } catch {
          return undefined;
        }
      })();
      const previousRoute =
        previous === undefined
          ? undefined
          : {
              createdAtMilliseconds: previous.createdAtMilliseconds,
              exposedToolNameList: previous.exposedToolNameList,
              usedToolNameList: previous.usedToolNameList,
            };

      // El clasificador local contesta apenas llega el embedding (que la
      // memoria semántica pide igual). Si está seguro, no se espera a Jev.
      let source: RouterDecisionSource = 'jev';
      let intentProbabilityMap: Record<RouterIntentId, number> | undefined;
      let noiseProbability: number | undefined;
      let reasoningProbability: number | undefined;
      let character: CharacterId | undefined;
      if (learned.head !== undefined) {
        const embedding = await embeddingPromise;
        if (embedding !== undefined) {
          const localMap = headProbabilitiesToIntentMap(
            predictWithHead(learned.head, truncateEmbedding(embedding)),
          );
          const localTop = Math.max(...Object.values(localMap));
          if (localTop >= LOCAL_HEAD_CONFIDENCE) {
            source = 'local';
            intentProbabilityMap = localMap;
          }
        }
      }
      if (intentProbabilityMap === undefined) {
        const verdict = await jevVerdictPromise;
        if (verdict === undefined) {
          source = jevFailure ?? 'error';
        } else {
          intentProbabilityMap = verdict.intentProbabilityMap;
          noiseProbability = verdict.noiseProbability;
          reasoningProbability = verdict.reasoningProbability;
          character = chooseCharacter({
            probabilityMap: verdict.characterProbabilityMap,
            complaintProbability: verdict.complaintProbability,
          });
        }
      }

      const plan =
        intentProbabilityMap === undefined
          ? undefined
          : planRoute({
              intentProbabilityMap,
              noiseProbability,
              availableToolNameList: input.availableToolNameList,
              thresholdsByIntent: learned.thresholdsByIntent,
              noiseIgnoreThreshold: learned.noiseIgnoreThreshold,
              previousRoute,
              nowMilliseconds: input.nowMilliseconds,
            });

      const reasoning =
        plan === undefined || plan.tier === 'ignore'
          ? undefined
          : decideReasoning({
              probability: reasoningProbability,
              tier: plan.tier,
              threshold: learned.reasoningThreshold ?? DEFAULT_REASONING_THRESHOLD,
              explorationRate: reasoningExplorationRate,
              random,
            });

      return {
        decisionId,
        createdAtMilliseconds: input.nowMilliseconds,
        reasoning,
        character: plan?.tier === 'ignore' ? undefined : character,
        userText: input.userText,
        mode: dependencies.mode,
        source,
        plan,
        applied: dependencies.mode === 'on' && plan !== undefined,
        jevMilliseconds,
        jevVerdictPromise,
        embeddingPromise,
      };
    },

    async record(result, report) {
      // Jev puede haber contestado después de que decidió el clasificador
      // local: igual se guarda, es la señal del maestro.
      const [verdict, embedding] = await Promise.all([
        result.jevVerdictPromise,
        result.embeddingPromise,
      ]);
      const intentId = result.plan?.intentId;
      const complaintProbability = verdict?.complaintProbability;

      const previous = readLatestRouterDecision(dependencies.sqlExecutor);
      if (previous !== undefined && previous.outcome === undefined) {
        const outcome = judgePreviousOutcome(previous, {
          createdAtMilliseconds: result.createdAtMilliseconds,
          intentId:
            intentId ??
            (verdict === undefined
              ? undefined
              : (Object.entries(verdict.intentProbabilityMap).sort((l, r) => r[1] - l[1])[0]?.[0] as
                  | RouterIntentId
                  | undefined)),
          complaintProbability,
        });
        writeRouterOutcome(
          dependencies.sqlExecutor,
          previous.id,
          outcome,
          deriveRouterLabel(previous, outcome),
        );
      }

      insertRouterDecision(dependencies.sqlExecutor, {
        id: result.decisionId,
        createdAtMilliseconds: result.createdAtMilliseconds,
        text: result.userText,
        mode: result.mode,
        source: result.source,
        intentId,
        intentProbability: result.plan?.intentProbability,
        // Siempre las del maestro si las hay: son el objetivo del aprendizaje.
        intentProbabilityMap: verdict?.intentProbabilityMap,
        noiseProbability: verdict?.noiseProbability,
        complaintProbability,
        tier: result.plan?.tier ?? 'full',
        reason: result.plan?.reason ?? `sin decisión (${result.source})`,
        // Lo planeado, aunque en modo shadow no se haya aplicado: así se puede
        // medir qué habría pasado.
        exposedToolNameList: result.plan?.toolNameList,
        usedToolNameList: report.usedToolNameList,
        escalated: report.escalated,
        jevMilliseconds: result.jevMilliseconds,
        llmMilliseconds: report.llmMilliseconds,
        totalMilliseconds: report.totalMilliseconds,
        toolSchemaChars: report.toolSchemaChars,
        embedding,
        // Solo cuenta si se aplicó: en shadow el modelo razonó como siempre.
        reasoning: result.applied ? result.reasoning : undefined,
        llmCallCount: report.llmCallCount,
      });

      logRouterEvent({
        mode: result.mode,
        source: result.source,
        tier: result.plan?.tier ?? 'full',
        applied: result.applied,
        intent: intentId,
        p: result.plan?.intentProbability,
        reason: result.plan?.reason,
        exposed: result.plan?.toolNameList?.length,
        used: report.usedToolNameList,
        escalated: report.escalated,
        jevMs: result.jevMilliseconds,
        reasoning: result.applied ? result.reasoning : undefined,
        character: result.character,
      });
    },
  };
}
