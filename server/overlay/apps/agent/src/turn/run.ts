import { APOLLO_TTS_VOICE } from '@/configuration/identity';
import type { DeskFocusState } from '@/focus/logic';
import { recallMemoryRecords, type MemorySqlExecutor } from '@/memory/store';
import { buildCurrentTimePromptNote } from '@/persona/clock';
import type { VectorStore } from '@/platform/vector';
import { buildApolloSoulPrompt } from '@/persona/soul';
import {
  buildCharacterPromptNote,
  resolveCharacterMode,
  type CharacterId,
} from '@/persona/characters';
import { extractMoodMark, type DeskMood } from '@/persona/mood';
import type { RouteResult, TurnRouter } from '@/router/engine';
import { ROUTER_ESCAPE_TOOL_NAME } from '@/router/intents';
import {
  UNBACKED_CLAIM_NUDGE,
  UNBACKED_DATA_NUDGE,
  classifyUnbackedReply,
} from '@/turn/claims';
import type { DeskUiEventName } from '@/session/machine';
import { noteUserTurnForMessageDraft } from '@/tools/message';
import { executeToolByName, resolvePendingToolConfirmation } from '@/tools/router';
import type {
  DeskToolEffects,
  PendingToolConfirmation,
  ToolDefinition,
  ToolExecutionResult,
} from '@/tools/types';
import { resolveThinkingHint } from '@/turn/caption';
import {
  STREAMING_CAPTION_ACCENT_COLOR,
  createStreamingCaptionEmitter,
} from '@/turn/streaming';
import {
  buildOpenRouterSystemPrompt,
  buildSemanticMemoryPromptNote,
  type OpenRouterChatMessage,
  type OpenRouterToolCall,
} from '@/voice/llm';
import { sanitizeTextForSpeech } from '@/voice/sanitize';
import { isLikelySilenceTranscript } from '@/voice/silence';
import {
  SPEECH_SEGMENT_MAX_CHARACTER_COUNT,
  splitTextIntoSpeechSegmentList,
} from '@/voice/segment';

// Tres rondas alcanzaban para las herramientas propias, que resuelven en una.
// Las de MCP encadenan: el calendario gasta una en pedir la hora, otra en listar
// calendarios y otra en listar eventos, y se quedaba sin ninguna para redactar
// la respuesta. Ahí caía en el fallback y leía el JSON crudo en voz alta.
const DEFAULT_MAX_TOOL_ROUND_COUNT = 6;

export type LanguageModelToolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolDefinition['parameters'];
};

export type VoiceAdapters = {
  readonly stt: (audioBuffer: ArrayBuffer) => Promise<string>;
  readonly llm: (input: {
    readonly messageList: readonly OpenRouterChatMessage[];
    readonly toolDefinitionList: readonly LanguageModelToolDescriptor[];
    // Optional streaming hook: adapters that support it push content deltas
    // as they arrive so the turn can start synthesizing speech early.
    readonly onTextDelta?: (deltaText: string) => void;
    // Lo decide el router (Jev) por turno; sin definir = lo que haga el modelo.
    readonly reasoningEnabled?: boolean;
    // 'required' fuerza una llamada a herramienta (ver turn/claims.ts).
    readonly toolChoice?: 'required';
  }) => Promise<{
    readonly text: string;
    readonly toolCallList: readonly OpenRouterToolCall[];
  }>;
  readonly tts: (text: string, voiceId: string) => Promise<ArrayBuffer>;
};

export type TurnInput = {
  readonly audioBuffer?: ArrayBuffer;
  readonly text?: string;
  readonly speechMode: string;
  readonly focusState: DeskFocusState;
  readonly sqlExecutor: MemorySqlExecutor;
  readonly environment: Env;
  readonly adapters: VoiceAdapters;
  readonly toolDefinitionMap: ReadonlyMap<string, ToolDefinition>;
  readonly pendingConfirmation?: PendingToolConfirmation;
  readonly confirmOk?: boolean;
  readonly nowMilliseconds: number;
  readonly deviceId?: string;
  readonly vectorStore?: VectorStore;
  readonly systemPromptOverride?: string;
  readonly recentHistoryMessageList?: readonly OpenRouterChatMessage[];
  readonly recallSemanticMemoryContentList?: (
    queryText: string,
  ) => Promise<readonly string[]>;
  readonly effects?: DeskToolEffects;
  readonly maxToolRoundCount?: number;
  // Router de intenciones (src/router): decide qué herramientas ve el modelo.
  // Sin router, o si falla, el turno usa todas como siempre.
  readonly router?: TurnRouter;
  // El embedding de la frase, compartido entre la memoria semántica y el
  // router para no pagarlo dos veces.
  readonly embedUserText?: (text: string) => Promise<readonly number[]>;
  // El color acompaña al cartel: el anillo de la cara cambia según la familia de
  // la herramienta, así se distingue de un vistazo si está buscando, mirando el
  // mapa o haciendo memoria.
  readonly onThinkingCaption?: (
    caption: string,
    accentColor?: string,
  ) => void | Promise<void>;
};

export type TurnOutput = {
  readonly uiEventList: readonly DeskUiEventName[];
  readonly transcript: string;
  readonly spokenText: string;
  readonly ttsAudio?: ArrayBuffer;
  // Segments after the first, still as text: the caller synthesizes them while
  // the device is already playing ttsAudio, hiding synthesis latency.
  readonly ttsFollowUpSegmentTextList?: readonly string[];
  // El texto del primer segmento, el que corresponde a ttsAudio. Lo necesita el
  // runtime para poner en el cartel la frase que está diciendo: sin esto la
  // pantalla se quedaba con el último fragmento a medio escribir del streaming.
  readonly ttsSegmentText?: string;
  // Ánimo que el modelo marcó con [[cara:...]]: la placa lo usa para la cara.
  readonly mood?: DeskMood;
  readonly pendingConfirmation?: PendingToolConfirmation;
  readonly speechMode: string;
  readonly focusState: DeskFocusState;
  readonly memoryContentList: readonly string[];
  readonly toolResultList: readonly ToolExecutionResult[];
  readonly executedToolCallList: readonly {
    readonly name: string;
    readonly summary: string;
  }[];
  // Whether the reply asks the user for something, so the device should
  // reopen the mic after speaking instead of returning to idle.
  readonly expectsReply: boolean;
};

// Los esquemas de herramientas viajan en CADA llamada al modelo. Medido en la
// Pi con 77 herramientas: 123 KB de esquemas contra 11 KB de conversación —
// once veces más pesado que lo que se está hablando, y se paga aunque el turno
// no use ninguna herramienta.
//
// Las descripciones de los servidores MCP son la mayor parte: están escritas
// para documentar (párrafos, ejemplos, notas de uso), no para caber en un
// prompt. Recortarlas a la primera oración conserva lo que el modelo necesita
// para elegir —qué hace la herramienta— y tira el resto.
export const TOOL_DESCRIPTION_MAX_CHARACTER_COUNT = 180;

export function condenseToolDescription(description: string): string {
  const collapsed = description.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TOOL_DESCRIPTION_MAX_CHARACTER_COUNT) {
    return collapsed;
  }
  // La primera oración suele ser exactamente el resumen que hace falta.
  const sentenceEnd = collapsed.search(/[.!?](\s|$)/);
  if (sentenceEnd > 0 && sentenceEnd < TOOL_DESCRIPTION_MAX_CHARACTER_COUNT) {
    return collapsed.slice(0, sentenceEnd + 1);
  }
  const clipped = collapsed.slice(0, TOOL_DESCRIPTION_MAX_CHARACTER_COUNT);
  const lastSpaceIndex = clipped.lastIndexOf(' ');
  return `${lastSpaceIndex > 40 ? clipped.slice(0, lastSpaceIndex) : clipped}…`;
}

function buildToolDefinitionListFromMap(
  toolDefinitionMap: ReadonlyMap<string, ToolDefinition>,
): readonly LanguageModelToolDescriptor[] {
  return [...toolDefinitionMap.values()].map((toolDefinition) => ({
    name: toolDefinition.name,
    description: condenseToolDescription(toolDefinition.description),
    parameters: toolDefinition.parameters,
  }));
}

// La herramienta de escape del router: con la lista recortada, el modelo la
// pide si le falta algo y la ronda siguiente recibe todas. No hace nada más.
const ROUTER_ESCAPE_TOOL_DESCRIPTOR: LanguageModelToolDescriptor = {
  name: ROUTER_ESCAPE_TOOL_NAME,
  description:
    'Llamala SOLO si para cumplir el pedido necesitás una herramienta que no está en tu lista; después vas a tener todas. No la uses para la hora, la fecha ni para charlar: eso ya lo sabés.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

function selectRoutedToolDefinitionList(
  fullToolDefinitionList: readonly LanguageModelToolDescriptor[],
  route: RouteResult | undefined,
): readonly LanguageModelToolDescriptor[] {
  const toolNameList = route?.applied ? route.plan?.toolNameList : undefined;
  if (toolNameList === undefined) {
    return fullToolDefinitionList;
  }
  const routedToolDefinitionList = fullToolDefinitionList.filter((tool) =>
    toolNameList.includes(tool.name),
  );
  return route?.plan?.escapeAllowed === false
    ? routedToolDefinitionList
    : [...routedToolDefinitionList, ROUTER_ESCAPE_TOOL_DESCRIPTOR];
}

// El router anota cómo terminó cada turno para aprender. Nunca puede romper ni
// demorar la respuesta: se dispara y se ignora el resultado.
function recordRouteWithoutWaiting(
  router: TurnRouter | undefined,
  route: RouteResult | undefined,
  report: Parameters<TurnRouter['record']>[1],
): void {
  if (router === undefined || route === undefined) {
    return;
  }
  void router.record(route, report).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'apollo_router_registro_fallo',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}

function buildAssistantToolCallMessage(
  llmText: string,
  toolCallList: readonly OpenRouterToolCall[],
): OpenRouterChatMessage {
  return {
    role: 'assistant',
    content: llmText.trim().length > 0 ? llmText : null,
    tool_calls: toolCallList.map((toolCall) => ({
      id: toolCall.id,
      type: 'function' as const,
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.args),
      },
    })),
  };
}

function buildToolResultMessage(
  toolCallId: string,
  toolResult: ToolExecutionResult,
): OpenRouterChatMessage {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(toolResult),
  };
}

// Instrumentación de latencia: el turno cruza STT, memoria, N llamadas al LLM,
// herramientas y TTS, y hasta ahora solo se veía el total. Cada etapa se acumula
// acá y se emite una línea al final, para poder optimizar con datos en vez de
// suposiciones. Coste: un Date.now() por etapa.
type StageTimings = Map<string, number>;

async function measureStage<T>(
  timings: StageTimings,
  stageName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    timings.set(stageName, (timings.get(stageName) ?? 0) + (Date.now() - startedAt));
  }
}

function formatStageTimings(timings: StageTimings, totalMilliseconds: number): string {
  const parts = [...timings.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([stageName, elapsed]) => `${stageName}=${elapsed}ms`);
  const measured = [...timings.values()].reduce((sum, value) => sum + value, 0);
  return `total=${totalMilliseconds}ms ${parts.join(' ')} sin_medir=${totalMilliseconds - measured}ms`;
}


// El cartel de la pantalla es una franja angosta: una transcripción larga se
// leería cortada al azar. Se recorta en la última palabra completa que entra.
const HEARD_CAPTION_MAX_CHARACTER_COUNT = 48;

export function buildHeardCaption(transcribedText: string): string {
  const collapsed = transcribedText.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= HEARD_CAPTION_MAX_CHARACTER_COUNT) {
    return `“${collapsed}”`;
  }
  const clipped = collapsed.slice(0, HEARD_CAPTION_MAX_CHARACTER_COUNT);
  const lastSpaceIndex = clipped.lastIndexOf(' ');
  const trimmed = lastSpaceIndex > 20 ? clipped.slice(0, lastSpaceIndex) : clipped;
  return `“${trimmed}…”`;
}

// El cartel en vivo no puede esperar a que drene el WebSocket: un await acá
// frenaría el consumo del stream del LLM. Se dispara y se ignora el resultado,
// pero se atrapa el rechazo para no dejar una promesa colgada.
function emitCaptionWithoutWaiting(
  onThinkingCaption: TurnInput['onThinkingCaption'],
  caption: string,
  accentColor: string,
): void {
  try {
    void Promise.resolve(onThinkingCaption?.(caption, accentColor)).catch(
      () => undefined,
    );
  } catch {
    // Un onThinkingCaption sincrono que tira no debe romper el turno.
  }
}

// Qué decir cuando el modelo gastó todas las rondas sin escribir la respuesta.
//
// Antes se juntaban los `summary` de las herramientas y se mandaban al TTS. Para
// las herramientas propias eso está bien ("Anotado en la lista super: pan"),
// pero las de MCP devuelven el resultado APLANADO A JSON, y Jarvis terminaba
// leyendo `{"currentTime":"2026-09-07T11:31:42..."}` en voz alta.
export function buildToolFallbackSpeech(
  summaryList: readonly string[],
): string {
  const humanSummaryList = summaryList
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0)
    .filter((summary) => !looksLikeMachineOutput(summary));
  if (humanSummaryList.length > 0) {
    return humanSummaryList.join(' ');
  }
  return 'Encontré los datos pero no llegué a armar la respuesta. ¿Te lo repito?';
}

// Heurística deliberadamente amplia: ante la duda, callar es mejor que leer
// llaves y comillas en voz alta.
function looksLikeMachineOutput(summary: string): boolean {
  if (/^[[{]/.test(summary)) {
    return true;
  }
  // Pares "clave":valor son el patrón de un JSON aplanado.
  if (/"[A-Za-z_][\w]*"\s*:/.test(summary)) {
    return true;
  }
  return false;
}

function findLastMessageText(
  messageList: readonly OpenRouterChatMessage[],
  role: 'user' | 'assistant',
): string | undefined {
  for (let index = messageList.length - 1; index >= 0; index -= 1) {
    const message = messageList[index];
    if (message.role === role && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}

export async function runDeskTurn(input: TurnInput): Promise<TurnOutput> {
  const turnStartedAt = Date.now();
  const stageTimings: StageTimings = new Map();
  const uiEventList: DeskUiEventName[] = ['START_THINK'];
  const toolResultList: ToolExecutionResult[] = [];
  const executedToolCallList: { name: string; summary: string }[] = [];
  let pendingConfirmation = input.pendingConfirmation;
  let resolvedConfirmation: PendingToolConfirmation | undefined;
  let resolvedConfirmationResult: ToolExecutionResult | undefined;

  if (pendingConfirmation !== undefined && input.confirmOk !== undefined) {
    const resolved = await resolvePendingToolConfirmation(
      input.toolDefinitionMap,
      pendingConfirmation,
      input.confirmOk,
      {
        environment: input.environment,
        nowMilliseconds: input.nowMilliseconds,
        deviceId: input.deviceId,
        vectorStore: input.vectorStore,
        effects: input.effects,
      },
    );
    if (!('cancelled' in resolved)) {
      resolvedConfirmation = pendingConfirmation;
      resolvedConfirmationResult = resolved;
      executedToolCallList.push({
        name: pendingConfirmation.toolName,
        summary: resolved.summary,
      });
    }
    pendingConfirmation = undefined;
    if ('cancelled' in resolved) {
      uiEventList.push('CANCEL');
      return {
        uiEventList,
        transcript: input.text?.trim() ?? '',
        spokenText: 'Cancelado.',
        speechMode: input.speechMode,
        focusState: input.focusState,
        memoryContentList: [],
        toolResultList,
        executedToolCallList,
        expectsReply: false,
      };
    }
    toolResultList.push(resolved);
  }

  let userText = input.text?.trim() ?? '';
  if (userText.length === 0 && input.audioBuffer !== undefined) {
    userText = (
      await measureStage(stageTimings, 'stt', () => input.adapters.stt(input.audioBuffer!))
    ).trim();
  }
  // Whisper alucina muletillas ("Gracias", "Subtítulos por…") cuando el audio
  // es silencio o ruido. Con el micrófono reabriéndose tras cada respuesta eso
  // pasa seguido, y cada falso positivo costaba una llamada al LLM más una
  // síntesis de voz para contestar algo que nadie dijo. Se descarta antes de
  // gastar nada, y sin mostrarlo en pantalla: el usuario no habló.
  //
  // Se loguea SIEMPRE lo que transcribio el STT y si se descarto. Sin esto un
  // turno descartado es invisible: sale por CANCEL antes del LLM, no deja
  // apollo_turn_timings, y desde afuera "lo escucho y lo tiro" es
  // indistinguible de "el microfono nunca se abrio".
  if (input.audioBuffer !== undefined) {
    const wasDiscarded = isLikelySilenceTranscript(userText);
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'apollo_stt_resultado',
        transcript: userText,
        descartado: wasDiscarded,
        audioBytes: input.audioBuffer.byteLength,
      }),
    );
    if (wasDiscarded) {
      userText = '';
    }
  }

  // (1) Devolver lo transcrito: si el STT escuchó mal, se ve en la pantalla en
  // vez de descubrirlo por una respuesta absurda. Se recorta porque el cartel
  // vive en una franja angosta.
  if (input.audioBuffer !== undefined && userText.length > 0) {
    await input.onThinkingCaption?.(buildHeardCaption(userText));
  }

  if (userText.length === 0) {
    uiEventList.push('CANCEL');
    return {
      uiEventList,
      transcript: '',
      // Silencio: se vuelve a idle sin decir nada. Con el modo conversación el
      // micrófono se reabre tras cada respuesta, así que anunciar "no te
      // escuché" cada vez que la charla termina sería insoportable.
      spokenText: '',
      speechMode: input.speechMode,
      focusState: input.focusState,
      memoryContentList: [],
      toolResultList,
      executedToolCallList,
      expectsReply: false,
    };
  }

  await input.onThinkingCaption?.('Pensando…');

  // El router y el embedding arrancan ya, en paralelo con la memoria: Jev
  // tarda lo mismo que la memoria semántica, así que no suma latencia.
  const embeddingPromise = input.embedUserText?.(userText);
  const previousHistoryMessageList = input.recentHistoryMessageList ?? [];
  const routePromise: Promise<RouteResult | undefined> =
    input.router === undefined
      ? Promise.resolve(undefined)
      : input.router
          .route({
            userText,
            availableToolNameList: [...input.toolDefinitionMap.keys()],
            context: {
              previousUserText: findLastMessageText(previousHistoryMessageList, 'user'),
              previousAssistantText: findLastMessageText(previousHistoryMessageList, 'assistant'),
            },
            nowMilliseconds: input.nowMilliseconds,
            embeddingPromise,
          })
          .catch(() => undefined);

  const recalledMemoryList = await measureStage(stageTimings, 'memoria_sql', () =>
    recallMemoryRecords(input.sqlExecutor, userText, 8),
  );
  const keywordMemoryContentList = recalledMemoryList.map(
    (memoryRecord) => memoryRecord.content,
  );
  const semanticMemoryContentList =
    (await measureStage(stageTimings, 'memoria_semantica', async () =>
      input.recallSemanticMemoryContentList?.(userText),
    )) ?? [];
  const memoryContentList = [
    ...new Set([...semanticMemoryContentList, ...keywordMemoryContentList]),
  ];
  const systemPromptBase =
    input.systemPromptOverride === undefined
      ? buildOpenRouterSystemPrompt({
          soulSystemPrompt: buildApolloSoulPrompt(input.speechMode),
          memoryContentList,
          isFocusActive: input.focusState.active,
        })
      : input.systemPromptOverride +
        buildSemanticMemoryPromptNote(semanticMemoryContentList);
  const systemPrompt =
    systemPromptBase + buildCurrentTimePromptNote(input.nowMilliseconds);

  const route = await measureStage(stageTimings, 'router_espera', () => routePromise);
  if (route?.applied && route.plan?.tier === 'ignore') {
    console.log(
      JSON.stringify({
        level: 'info',
        message: 'apollo_router_ruido_descartado',
        transcript: userText,
      }),
    );
    recordRouteWithoutWaiting(input.router, route, {
      usedToolNameList: [],
      escalated: false,
      llmMilliseconds: undefined,
      llmCallCount: 0,
      totalMilliseconds: Date.now() - turnStartedAt,
      toolSchemaChars: 0,
    });
    uiEventList.push('CANCEL');
    return {
      uiEventList,
      transcript: userText,
      spokenText: '',
      speechMode: input.speechMode,
      focusState: input.focusState,
      memoryContentList,
      toolResultList,
      executedToolCallList,
      expectsReply: false,
    };
  }

  const fullToolDefinitionList = buildToolDefinitionListFromMap(input.toolDefinitionMap);
  let toolDefinitionList = selectRoutedToolDefinitionList(fullToolDefinitionList, route);
  let routerEscalated = false;
  let llmCallCount = 0;
  let unbackedClaimRetried = false;
  let nextToolChoice: 'required' | undefined;
  const reasoningEnabled = route?.applied ? route.reasoning?.enabled : undefined;
  const toolExecutionContext = {
    environment: input.environment,
    nowMilliseconds: input.nowMilliseconds,
    deviceId: input.deviceId,
    vectorStore: input.vectorStore,
    effects: input.effects,
    userTranscript: userText,
  };
  noteUserTurnForMessageDraft(input.nowMilliseconds);
  const maxToolRoundCount = input.maxToolRoundCount ?? DEFAULT_MAX_TOOL_ROUND_COUNT;

  // El personaje lo eligió Jev en la misma llamada del router. Solo se suma si
  // el router se aplicó: en modo shadow el turno tiene que ser idéntico al de
  // antes. PERSONAJES=off lo apaga sin tocar el router.
  const character: CharacterId | undefined =
    route?.applied && resolveCharacterMode(readRuntimeEnvironment()?.PERSONAJES) === 'on'
      ? route.character
      : undefined;
  const messageList: OpenRouterChatMessage[] = [
    { role: 'system', content: systemPrompt + buildCharacterPromptNote(character) },
    ...(input.recentHistoryMessageList ?? []),
    { role: 'user', content: userText },
  ];
  if (resolvedConfirmation !== undefined && resolvedConfirmationResult !== undefined) {
    messageList.push(
      buildAssistantToolCallMessage('', [
        {
          id: resolvedConfirmation.id,
          name: resolvedConfirmation.toolName,
          args: resolvedConfirmation.args ?? null,
        },
      ]),
      buildToolResultMessage(resolvedConfirmation.id, resolvedConfirmationResult),
    );
  }

  // Vía rápida con dato: la herramienta de solo lectura se ejecuta antes y el
  // modelo solo redacta, en una ronda y sin esquemas.
  const preExecuteToolName = route?.applied ? route.plan?.preExecuteToolName : undefined;
  if (preExecuteToolName !== undefined && input.toolDefinitionMap.has(preExecuteToolName)) {
    const preExecuteCallId = `router-${preExecuteToolName}`;
    const outcome = await measureStage(stageTimings, `tool:${preExecuteToolName}`, () =>
      executeToolByName(input.toolDefinitionMap, preExecuteToolName, {}, toolExecutionContext),
    );
    if (outcome.status !== 'needs_confirm') {
      toolResultList.push(outcome.result);
      executedToolCallList.push({ name: preExecuteToolName, summary: outcome.result.summary });
      messageList.push(
        buildAssistantToolCallMessage('', [
          { id: preExecuteCallId, name: preExecuteToolName, args: {} },
        ]),
        buildToolResultMessage(preExecuteCallId, outcome.result),
      );
    }
  }

  let spokenText = '';

  // While the reply streams in, the first sentence-sized segment is closed as
  // soon as more text follows it — synthesis starts right then, overlapping
  // the rest of the generation. If the round turns out to be a tool call, the
  // speculation is discarded (its text was never going to be spoken).
  let speculativeSegment:
    | {
        readonly text: string;
        readonly audioPromise: Promise<ArrayBuffer | undefined>;
      }
    | undefined;
  let streamedRoundText = '';
  // (A) Respuesta en vivo: el mismo stream que ya adelantaba el TTS ahora
  // alimenta el cartel, así se ve la respuesta formándose en vez de un
  // “Pensando…” fijo durante los 1,5-3,7s que tarda el modelo.
  const streamingCaptionEmitter = createStreamingCaptionEmitter();
  let streamedDisplayText = '';

  for (let toolRoundIndex = 0; toolRoundIndex < maxToolRoundCount; toolRoundIndex += 1) {
    streamedRoundText = '';
    streamedDisplayText = '';
    llmCallCount += 1;
    const toolChoice = nextToolChoice;
    nextToolChoice = undefined;
    const llmResult = await measureStage(stageTimings, 'llm', () => input.adapters.llm({
      messageList,
      toolDefinitionList,
      reasoningEnabled,
      toolChoice,
      onTextDelta: (deltaText) => {
        streamedDisplayText += deltaText;
        const liveCaption = streamingCaptionEmitter.nextCaption(
          streamedDisplayText,
          Date.now(),
        );
        if (liveCaption !== undefined) {
          emitCaptionWithoutWaiting(
            input.onThinkingCaption,
            liveCaption,
            STREAMING_CAPTION_ACCENT_COLOR,
          );
        }
        if (speculativeSegment !== undefined) {
          return;
        }
        streamedRoundText += deltaText;
        if (streamedRoundText.length <= SPEECH_SEGMENT_MAX_CHARACTER_COUNT) {
          return;
        }
        const partialSegmentList = splitTextIntoSpeechSegmentList(
          sanitizeTextForSpeech(streamedRoundText),
        );
        if (partialSegmentList.length < 2) {
          return;
        }
        const firstClosedSegmentText = partialSegmentList[0];
        speculativeSegment = {
          text: firstClosedSegmentText,
          audioPromise: input.adapters
            .tts(firstClosedSegmentText, APOLLO_TTS_VOICE)
            .catch(() => undefined),
        };
      },
    }));

    if (llmResult.toolCallList.length === 0) {
      const unbackedKind =
        !unbackedClaimRetried &&
        toolRoundIndex < maxToolRoundCount - 1 &&
        toolDefinitionList.length > 0
          ? classifyUnbackedReply({
              intentId: route?.plan?.intentId,
              userText,
              replyText: llmResult.text,
              executedToolNameList: executedToolCallList.map((call) => call.name),
            })
          : undefined;
      if (unbackedKind !== undefined) {
        // Confirmó algo que no hizo, o dio un dato sin mirarlo: no se dice,
        // se le pide que lo haga.
        unbackedClaimRetried = true;
        routerEscalated = true;
        speculativeSegment = undefined;
        console.log(
          JSON.stringify({
            level: 'warn',
            message: unbackedKind === 'accion' ? 'apollo_confirmacion_sin_accion' : 'apollo_dato_sin_consultar',
            intent: route?.plan?.intentId,
            respuesta: llmResult.text.slice(0, 200),
          }),
        );
        messageList.push(
          { role: 'assistant', content: llmResult.text },
          { role: 'system', content: unbackedKind === 'accion' ? UNBACKED_CLAIM_NUDGE : UNBACKED_DATA_NUDGE },
        );
        nextToolChoice = 'required';
        continue;
      }
      spokenText = llmResult.text.trim();
      break;
    }

    speculativeSegment = undefined;

    messageList.push(
      buildAssistantToolCallMessage(llmResult.text, llmResult.toolCallList),
    );

    for (const toolCall of llmResult.toolCallList) {
      if (toolCall.name === ROUTER_ESCAPE_TOOL_NAME) {
        // El router le quitó algo que necesitaba: desde la próxima ronda tiene
        // todas. Queda anotado como error del router para que aprenda.
        routerEscalated = true;
        toolDefinitionList = fullToolDefinitionList;
        messageList.push(
          buildToolResultMessage(toolCall.id, {
            ok: true,
            summary: 'Listo: ahora tenés todas las herramientas disponibles.',
          }),
        );
        continue;
      }
      const thinkingHint = resolveThinkingHint(toolCall.name);
      await input.onThinkingCaption?.(thinkingHint.caption, thinkingHint.accentColor);
      // Se mide por nombre: una tool lenta (búsqueda web, research) domina el
      // turno entero y sin esto aparecía como tiempo "sin medir".
      const outcome = await measureStage(stageTimings, `tool:${toolCall.name}`, () =>
        executeToolByName(
          input.toolDefinitionMap,
          toolCall.name,
          toolCall.args,
          toolExecutionContext,
        ),
      );
      if (outcome.status === 'needs_confirm') {
        uiEventList.push('NEED_CONFIRM');
        recordRouteWithoutWaiting(input.router, route, {
          usedToolNameList: [...executedToolCallList.map((call) => call.name), toolCall.name],
          escalated: routerEscalated,
          llmMilliseconds: stageTimings.get('llm'),
          llmCallCount,
          totalMilliseconds: Date.now() - turnStartedAt,
          toolSchemaChars: JSON.stringify(toolDefinitionList).length,
        });
        return {
          uiEventList,
          transcript: userText,
          spokenText: outcome.pending.summary,
          pendingConfirmation: outcome.pending,
          speechMode: input.speechMode,
          focusState: input.focusState,
          memoryContentList,
          toolResultList,
          executedToolCallList,
          expectsReply: false,
        };
      }
      toolResultList.push(outcome.result);
      // (3) Progreso: una herramienta lenta dejaba el cartel congelado en
      // "Buscando…" hasta que hablaba. Este paso intermedio muestra que ya
      // volvió con el dato y que falta redactar.
      await input.onThinkingCaption?.('Armando la respuesta…');
      executedToolCallList.push({
        name: toolCall.name,
        summary: outcome.result.summary,
      });
      messageList.push(buildToolResultMessage(toolCall.id, outcome.result));
    }

    if (toolRoundIndex === maxToolRoundCount - 1) {
      spokenText = llmResult.text.trim();
    }
  }

  // Una herramienta que trae su propia frase manda sobre la del modelo (ver
  // ToolExecutionResult.spokenText). Si hubo varias, la última.
  const imposedSpokenText = [...toolResultList]
    .reverse()
    .find((result) => result.spokenText !== undefined)?.spokenText;
  if (imposedSpokenText !== undefined) {
    spokenText = imposedSpokenText;
  }
  if (spokenText.length === 0) {
    spokenText = buildToolFallbackSpeech(toolResultList.map((result) => result.summary));
  }
  // The model appends [[escucho]] when its reply asks the user for something;
  // a reply that ends in a question counts even if the model forgot the mark.
  const hasListenMark = /\[\[escucho\]\]/i.test(spokenText);
  spokenText = spokenText.replace(/\s*\[\[escucho\]\]\s*/gi, ' ').trim();
  const moodExtraction = extractMoodMark(spokenText);
  spokenText = moodExtraction.text;
  // Modo conversación: por defecto el micrófono se reabre después de CADA
  // respuesta, así se puede encadenar sin repetir la wake word. No queda
  // abierto indefinidamente: el firmware cierra solo a los ~3s de silencio
  // (kNoSpeechTimeoutUs en application.cc), que es justo la ventana buscada.
  // Poner CONVERSATION_MODE=off vuelve al comportamiento original, donde el
  // micrófono solo se reabre si el modelo lo pide o la respuesta es pregunta.
  const runtimeEnvironment = readRuntimeEnvironment();
  const conversationModeEnabled = runtimeEnvironment?.CONVERSATION_MODE !== 'off';
  const expectsReply =
    hasListenMark || /\?\s*$/.test(spokenText) || conversationModeEnabled;
  spokenText = sanitizeTextForSpeech(spokenText);

  const [firstSegmentText, ...ttsFollowUpSegmentTextList] =
    splitTextIntoSpeechSegmentList(spokenText);
  const targetFirstSegmentText = firstSegmentText ?? spokenText;

  uiEventList.push('START_SPEAK');
  const speculativeAudio =
    speculativeSegment !== undefined && speculativeSegment.text === targetFirstSegmentText
      ? await speculativeSegment.audioPromise
      : undefined;
  const ttsAudio =
    speculativeAudio ??
    (await measureStage(stageTimings, 'tts', () =>
      input.adapters.tts(targetFirstSegmentText, APOLLO_TTS_VOICE),
    ));
  uiEventList.push('SPEAK_DONE');

  const totalMilliseconds = Date.now() - turnStartedAt;
  recordRouteWithoutWaiting(input.router, route, {
    usedToolNameList: executedToolCallList.map((call) => call.name),
    escalated: routerEscalated,
    llmMilliseconds: stageTimings.get('llm'),
    llmCallCount,
    totalMilliseconds,
    toolSchemaChars: JSON.stringify(toolDefinitionList).length,
  });

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'apollo_turn_timings',
      detail: formatStageTimings(stageTimings, totalMilliseconds),
      toolRounds: toolResultList.length,
      router: route === undefined
        ? undefined
        : {
            tier: route.plan?.tier ?? 'full',
            applied: route.applied,
            intent: route.plan?.intentId,
            source: route.source,
            escalated: routerEscalated,
            reasoning: reasoningEnabled,
            reasoningExplored: route.reasoning?.explored,
          },
      // El resultado de una tool viaja al modelo en el próximo prompt: si es
      // enorme, infla el contexto y el LLM se vuelve lento. Medirlo permite
      // distinguir "el proveedor está lento" de "le estamos mandando demasiado".
      toolResultChars: toolResultList.reduce(
        (total, result) => total + JSON.stringify(result).length,
        0,
      ),
      // Cada herramienta habilitada viaja con su esquema JSON en TODAS las
      // llamadas al modelo. Con 49 MCP habilitadas eso puede pesar más que la
      // conversación entera, y es lo primero a mirar cuando el LLM se pone lento.
      toolCount: toolDefinitionList.length,
      toolSchemaChars: JSON.stringify(toolDefinitionList).length,
      promptChars: JSON.stringify(messageList).length,
      // Las 5 herramientas más pesadas: con 77 conectadas, unas pocas explican
      // casi todo el peso, y saber CUÁLES es lo que permite podar con criterio.
      heaviestTools: [...toolDefinitionList]
        .map((tool) => ({
          name: tool.name,
          chars: JSON.stringify(tool.parameters ?? {}).length,
        }))
        .sort((left, right) => right.chars - left.chars)
        .slice(0, 5),
    }),
  );

  return {
    uiEventList,
    transcript: userText,
    spokenText,
    ttsAudio,
    ttsFollowUpSegmentTextList,
    ttsSegmentText: targetFirstSegmentText,
    mood: moodExtraction.mood,
    speechMode: input.speechMode,
    focusState: input.focusState,
    memoryContentList,
    toolResultList,
    executedToolCallList,
    expectsReply,
  };
}

function readRuntimeEnvironment(): Record<string, string | undefined> | undefined {
  return (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
}
