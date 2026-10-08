import type { Connection } from 'agents';
import type { Session } from 'agents/experimental/memory/session';

import type { ApolloState } from '@/agents/apollo';
import { APOLLO_TTS_VOICE } from '@/configuration/identity';
import { createInactiveDeskFocusState, tickDeskFocus } from '@/focus/logic';
import { isNamespacedMcpToolName } from '@/mcp/naming';
import {
  buildRecentTurnHistoryMessageList,
  buildSessionSystemPrompt,
} from '@/memory/session';
import type { MemorySqlExecutor } from '@/memory/store';
import { embedTextWithOpenRouter, recallSemanticMemoryContent } from '@/memory/vector';
import type { BlobStore } from '@/platform/blob';
import type { VectorStore } from '@/platform/vector';
import { resolveDeskSpeechMode } from '@/persona/catalog';
import { createTurnRouter, resolveRouterMode, type TurnRouter } from '@/router/engine';
import { resolveDeskFaceEmotion } from '@/persona/face';
import {
  createSilentPcm,
  playPcmOnSpeaker,
  shouldRouteToSpeaker,
  stopSpeakerVoice,
} from '@/speaker/output';
import { markSpeechFinished, markSpeechStarted } from '@/idle/speech-gate';
import { buildInstalledToolPromptNote } from '@/persona/soul';
import {
  encodeServerToDeviceMessage,
  type ServerToDeviceMessage,
} from '@/protocol/schema';
import type { DeskUiMachine } from '@/session/machine';
import { buildTelemetryPromptNote, type DeskTelemetrySnapshot } from '@/telemetry/logic';
import { createBuiltinToolDefinitionMap } from '@/tools/catalog';
import type {
  DeskToolEffects,
  PendingToolConfirmation,
  ToolDefinition,
} from '@/tools/types';
import { runDeskTurn, type TurnInput, type VoiceAdapters } from '@/turn/run';
import { TTS_PCM_CHANNEL_COUNT, TTS_PCM_SAMPLE_RATE_HZ } from '@/voice/elevenlabs';
import { chatWithOpenRouter } from '@/voice/llm';
import { transcribeAudioWithOpenRouter } from '@/voice/stt';
import {
  streamAudioChunksAtPlaybackPace,
  type PlaybackAckSnapshot,
} from '@/voice/stream';
import { synthesizeApolloSpeech } from '@/voice/synthesize';
import { wrapPcmAsWavBuffer } from '@/voice/wav';

// Structurally just `send`, so the Bun host can pass a raw websocket wrapper
// where the durable object passes an SDK Connection.
export type TurnConnection = Pick<Connection, 'send'>;

type DeskUiStateDeviceMessage = Extract<ServerToDeviceMessage, { type: 'ui_state' }>;
type TtsStartDeviceMessage = Extract<ServerToDeviceMessage, { type: 'tts_start' }>;

type PlaybackPacingOptions = {
  prebufferMilliseconds?: number;
  shouldStop?: () => boolean;
  getPlaybackAck?: () => PlaybackAckSnapshot | null;
};

export type ApolloTurnRuntimeDependencies = {
  readonly environment: Env;
  readonly mediaBlobStore: BlobStore;
  readonly vectorStore: VectorStore | undefined;
  readonly sqlExecutor: MemorySqlExecutor;
  readonly uiMachine: DeskUiMachine;
  readonly currentState: ApolloState;
  readonly getCurrentState: () => ApolloState;
  readonly setAgentState: (nextState: ApolloState) => void;
  readonly scheduleConfirmExpiry: (confirmationId: string) => Promise<void>;
  readonly persistPendingConfirmation: (
    confirmation: PendingToolConfirmation,
  ) => Promise<void>;
  readonly session: Session;
  readonly deviceId: string;
  readonly effects: DeskToolEffects;
  readonly toolDefinitionMap?: ReadonlyMap<string, ToolDefinition>;
  readonly isSpeechAborted?: () => boolean;
  readonly telemetrySnapshot?: DeskTelemetrySnapshot;
  readonly allocateTtsSequence?: () => number;
  readonly getPlaybackAckForSequence?: (sequence: number) => PlaybackAckSnapshot | null;
};

// Un router por base: guarda en memoria los umbrales y el clasificador
// aprendidos, así que no se recrea en cada turno.
const turnRouterBySqlExecutor = new WeakMap<MemorySqlExecutor, TurnRouter>();

function resolveTurnRouter(
  sqlExecutor: MemorySqlExecutor,
  environment: Env,
): TurnRouter | undefined {
  const processEnvironment = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {};
  const mode = resolveRouterMode(processEnvironment.ROUTER_MODE);
  const apiKey = processEnvironment.ROUTER_JEV_API_KEY || environment.OPENROUTER_API_KEY;
  if (mode === 'off' || !apiKey) {
    return undefined;
  }
  const existing = turnRouterBySqlExecutor.get(sqlExecutor);
  if (existing !== undefined) {
    return existing;
  }
  try {
    const timeoutValue = Number(processEnvironment.ROUTER_JEV_TIMEOUT_MS);
    const explorationValue = Number(processEnvironment.ROUTER_REASONING_EXPLORE);
    const router = createTurnRouter({
      sqlExecutor,
      mode,
      jevApiKey: apiKey,
      jevBaseUrl: processEnvironment.ROUTER_JEV_BASE_URL || undefined,
      jevModel: processEnvironment.ROUTER_JEV_MODEL || undefined,
      jevTimeoutMilliseconds: Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : undefined,
      reasoningExplorationRate:
        processEnvironment.ROUTER_REASONING_EXPLORE !== undefined &&
        Number.isFinite(explorationValue) &&
        explorationValue >= 0 &&
        explorationValue <= 1
          ? explorationValue
          : undefined,
    });
    turnRouterBySqlExecutor.set(sqlExecutor, router);
    return router;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'apollo_router_no_arranco',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }
}

export async function executeApolloTurn(
  connection: TurnConnection,
  dependencies: ApolloTurnRuntimeDependencies,
  turnPart: {
    readonly text?: string;
    readonly audioBuffer?: ArrayBuffer;
    readonly confirmOk?: boolean;
    readonly pendingConfirmation?: PendingToolConfirmation;
  },
): Promise<void> {
  const nowMilliseconds = Date.now();
  const focusState = tickDeskFocus(
    dependencies.currentState.focusEndsAt === null
      ? createInactiveDeskFocusState()
      : {
          active: true,
          endsAt: dependencies.currentState.focusEndsAt,
        },
    nowMilliseconds,
  );

  const isMockVoice = dependencies.environment.MOCK_VOICE === '1';
  const sessionSystemPrompt = await buildSessionSystemPrompt(dependencies.session);
  const recentHistoryMessageList = await buildRecentTurnHistoryMessageList(
    dependencies.session,
  );
  // Un solo pedido de embedding por frase, compartido entre la memoria
  // semántica y el router.
  const embeddingByText = new Map<string, Promise<readonly number[]>>();
  const embedUserText = (text: string): Promise<readonly number[]> => {
    const cached = embeddingByText.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const pending = embedTextWithOpenRouter({
      openRouterApiKey: dependencies.environment.OPENROUTER_API_KEY,
      modelId: dependencies.environment.OPENROUTER_EMBEDDING_MODEL,
      text,
    });
    embeddingByText.set(text, pending);
    return pending;
  };
  const recallSemanticMemoryContentList = async (
    queryText: string,
  ): Promise<readonly string[]> =>
    recallSemanticMemoryContent({
      vectorStore: dependencies.vectorStore,
      openRouterApiKey: dependencies.environment.OPENROUTER_API_KEY,
      embeddingModelId: dependencies.environment.OPENROUTER_EMBEDDING_MODEL,
      queryText,
      deviceId: dependencies.deviceId,
      embedQueryText: embedUserText,
    });

  const focusNote = focusState.active
    ? '\n\nFocus activo: evitá announces ruidosos; sé breve.'
    : '\n\nFocus inactivo.';
  const telemetryNote = buildTelemetryPromptNote(
    dependencies.telemetrySnapshot,
    nowMilliseconds,
  );
  const toolDefinitionMap =
    dependencies.toolDefinitionMap ?? createBuiltinToolDefinitionMap();
  const installedToolNote = buildInstalledToolPromptNote(
    [...toolDefinitionMap.keys()].filter((toolName) => isNamespacedMcpToolName(toolName)),
  );

  const voiceAdapters: VoiceAdapters = isMockVoice
    ? {
        stt: async () => turnPart.text ?? 'hola',
        llm: async ({ messageList }) => {
          const userMessage = messageList.findLast((message) => message.role === 'user');
          const userText = userMessage?.role === 'user' ? userMessage.content : '';
          return {
            text: `Mock: ${userText}`,
            toolCallList: [],
          };
        },
        tts: async (text) => encodeMockSpeechAudio(text),
      }
    : {
        stt: async (audioBuffer) =>
          transcribeAudioWithOpenRouter({
            audioBuffer: wrapPcmAsWavBuffer({ pcmBuffer: audioBuffer }),
            openRouterApiKey: dependencies.environment.OPENROUTER_API_KEY,
            modelId: dependencies.environment.OPENROUTER_STT_MODEL,
          }),
        llm: async ({ messageList, toolDefinitionList, onTextDelta, reasoningEnabled, toolChoice }) => {
          const baseChatRequest = {
            openRouterApiKey: dependencies.environment.OPENROUTER_API_KEY,
            modelId: dependencies.environment.OPENROUTER_MODEL,
            messageList,
            toolDefinitionList,
            reasoningEnabled,
            toolChoice,
          };
          return chatWithOpenRouter(
            onTextDelta === undefined
              ? baseChatRequest
              : { ...baseChatRequest, onTextDelta },
          );
        },
        tts: async (text, voiceId) =>
          synthesizeApolloSpeech({
            environment: dependencies.environment,
            mediaBlobStore: dependencies.mediaBlobStore,
            text,
            voiceId,
          }),
      };

  const baseTurnInput: TurnInput = {
    text: turnPart.text,
    audioBuffer: turnPart.audioBuffer,
    speechMode: dependencies.currentState.speechMode,
    focusState,
    sqlExecutor: dependencies.sqlExecutor,
    environment: dependencies.environment,
    toolDefinitionMap,
    pendingConfirmation: turnPart.pendingConfirmation,
    confirmOk: turnPart.confirmOk,
    nowMilliseconds,
    deviceId: dependencies.deviceId,
    vectorStore: dependencies.vectorStore,
    systemPromptOverride: `${sessionSystemPrompt}${focusNote}${telemetryNote}${installedToolNote}`,
    recentHistoryMessageList,
    effects: dependencies.effects,
    onThinkingCaption: async (caption, accentColor) => {
      const liveState = dependencies.getCurrentState();
      dependencies.setAgentState({
        ...liveState,
        uiState: 'thinking',
        caption,
      });
      const thinkingUiStateMessage: DeskUiStateDeviceMessage = {
        type: 'ui_state',
        state: 'thinking',
        speechMode: liveState.speechMode,
        caption,
        emotion: resolveDeskFaceEmotion('thinking'),
        // El color de la herramienta gana sobre el del modo de habla mientras
        // dura el trabajo; al terminar el turno el ui_state vuelve al del modo.
        accentColor: accentColor ?? resolveDeskSpeechMode(liveState.speechMode).accentColor,
      };
      if (liveState.focusEndsAt !== null) {
        thinkingUiStateMessage.focusRemainingSec = Math.max(
          0,
          Math.ceil((liveState.focusEndsAt - Date.now()) / 1000),
        );
        thinkingUiStateMessage.focusEndsAt = Math.floor(liveState.focusEndsAt / 1000);
        if (liveState.focusStartedAt !== null) {
          thinkingUiStateMessage.focusStartedAt = Math.floor(
            liveState.focusStartedAt / 1000,
          );
        }
      }
      connection.send(encodeServerToDeviceMessage(thinkingUiStateMessage));
    },
    adapters: voiceAdapters,
  };
  const turnRouter = isMockVoice
    ? undefined
    : resolveTurnRouter(dependencies.sqlExecutor, dependencies.environment);
  const turnOutput = await runDeskTurn(
    isMockVoice
      ? baseTurnInput
      : {
          ...baseTurnInput,
          recallSemanticMemoryContentList,
          embedUserText,
          router: turnRouter,
        },
  );

  for (const uiEventName of turnOutput.uiEventList) {
    dependencies.uiMachine.transition(uiEventName);
  }

  if (turnOutput.pendingConfirmation !== undefined) {
    // Persisted before confirm_request goes out below: the device can answer
    // the moment the screen appears, while the TTS at the bottom of this
    // function is still streaming, and #resolveConfirm must find it by then.
    await dependencies.persistPendingConfirmation(turnOutput.pendingConfirmation);
    await dependencies.scheduleConfirmExpiry(turnOutput.pendingConfirmation.id);
  }

  // `set_focus`/`clear_focus` tool effects (see @/agents/effects) may have
  // updated focusEndsAt on the live agent state mid-turn, ahead of the
  // uiEventList replay above. Reconcile against that live value instead of
  // the pre-turn snapshot so the tool's change isn't clobbered below, while
  // still honoring the tick-based expiry computed into turnOutput.focusState
  // when no focus tool ran this turn.
  const liveState = dependencies.getCurrentState();
  const focusChangedDuringTurn =
    liveState.focusEndsAt !== dependencies.currentState.focusEndsAt;
  const finalFocusEndsAt = focusChangedDuringTurn
    ? liveState.focusEndsAt
    : turnOutput.focusState.endsAt;
  const isFocusActiveNow =
    finalFocusEndsAt !== null && finalFocusEndsAt > nowMilliseconds;

  if (isFocusActiveNow && dependencies.uiMachine.state !== 'focus') {
    dependencies.uiMachine.transition('ENTER_FOCUS');
  } else if (!isFocusActiveNow && dependencies.uiMachine.state === 'focus') {
    dependencies.uiMachine.transition('EXIT_FOCUS');
  }

  dependencies.setAgentState({
    ...liveState,
    uiState: dependencies.uiMachine.state,
    caption: turnOutput.spokenText,
    pendingConfirmId: turnOutput.pendingConfirmation?.id ?? null,
    pendingConfirmSummary: turnOutput.pendingConfirmation?.summary ?? null,
    focusEndsAt: finalFocusEndsAt,
    focusStartedAt: finalFocusEndsAt === null ? null : liveState.focusStartedAt,
  });

  if (turnOutput.pendingConfirmation !== undefined) {
    connection.send(encodeServerToDeviceMessage({ type: 'play_effect', name: 'chime' }));
    connection.send(
      encodeServerToDeviceMessage({
        type: 'confirm_request',
        id: turnOutput.pendingConfirmation.id,
        summary: turnOutput.pendingConfirmation.summary,
        expiresAt: turnOutput.pendingConfirmation.expiresAt,
      }),
    );
  }

  let speechWasAborted = false;
  if (turnOutput.ttsAudio !== undefined) {
    // La rotación de reposo mira este semáforo: mientras haya audio en vuelo no
    // toca el cartel, así la frase que se está diciendo no se tapa con el clima.
    markSpeechStarted();
    const followUpSegmentTextList = turnOutput.ttsFollowUpSegmentTextList ?? [];
    let currentAudioBuffer: ArrayBuffer | undefined = turnOutput.ttsAudio;
    let followUpIndex = 0;
    let wasAborted = false;

    const synthesizeFollowUpSegmentAudio = async (
      segmentText: string,
    ): Promise<ArrayBuffer | undefined> => {
      try {
        return await voiceAdapters.tts(segmentText, APOLLO_TTS_VOICE);
      } catch (synthesisError) {
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'apollo_tts_follow_up_segment_failed',
            error:
              synthesisError instanceof Error
                ? synthesisError.message
                : String(synthesisError),
          }),
        );
        return undefined;
      }
    };

    // Modo parlante: la respuesta suena en el parlante de la Pi y la placa
    // recibe silencio del mismo largo (ver speaker/output.ts). Si un segmento
    // no entra al parlante, ese y los que siguen van a la placa: mejor que una
    // respuesta partida entre dos lugares.
    let speakerActive = !isMockVoice && shouldRouteToSpeaker('respuesta');
    let speakerUsed = false;

    while (currentAudioBuffer !== undefined) {
      // The next segment renders while this one plays, so synthesis latency
      // hides behind the paced stream instead of gapping the speech. A failed
      // follow-up just ends the reply early — the turn already committed.
      const nextAudioBufferPromise =
        followUpIndex < followUpSegmentTextList.length
          ? synthesizeFollowUpSegmentAudio(followUpSegmentTextList[followUpIndex])
          : undefined;
      const isFirstSegment = followUpIndex === 0;
      // La frase que está por sonar, para ponerla en el cartel. El label de la
      // placa scrollea el texto largo, así que entra entera aunque la franja
      // sea de una línea.
      const currentSegmentText = isFirstSegment
        ? turnOutput.ttsSegmentText
        : followUpSegmentTextList[followUpIndex - 1];
      followUpIndex += 1;
      const ttsSequence = dependencies.allocateTtsSequence?.();

      // Cierre del texto en vivo: mientras el modelo escribía, el cartel iba
      // mostrando la cola del stream; al empezar a hablar pasa a la frase
      // completa. Sin esto la pantalla se quedaba con un fragmento cortado a
      // mitad de palabra hasta que la rotación de reposo lo tapaba.
      if (currentSegmentText !== undefined && currentSegmentText.length > 0) {
        const speakingState = dependencies.getCurrentState();
        const speakingUiStateMessage: DeskUiStateDeviceMessage = {
          type: 'ui_state',
          state: 'speaking',
          speechMode: speakingState.speechMode,
          caption: currentSegmentText,
          emotion: resolveDeskFaceEmotion('speaking'),
          accentColor: resolveDeskSpeechMode(speakingState.speechMode).accentColor,
        };
        if (turnOutput.mood !== undefined) {
          speakingUiStateMessage.mood = turnOutput.mood;
        }
        connection.send(encodeServerToDeviceMessage(speakingUiStateMessage));
      }

      const ttsStartMessage: TtsStartDeviceMessage = {
        type: 'tts_start',
        format: 'pcm',
        bytes: currentAudioBuffer.byteLength,
        sampleRate: TTS_PCM_SAMPLE_RATE_HZ,
        channels: TTS_PCM_CHANNEL_COUNT,
      };
      if (ttsSequence !== undefined) {
        ttsStartMessage.sequence = ttsSequence;
      }
      connection.send(encodeServerToDeviceMessage(ttsStartMessage));

      const playedOnSpeaker =
        speakerActive &&
        (await playPcmOnSpeaker(currentAudioBuffer, {
          sampleRateHz: TTS_PCM_SAMPLE_RATE_HZ,
          channelCount: TTS_PCM_CHANNEL_COUNT,
        }));
      speakerActive = playedOnSpeaker;
      speakerUsed = speakerUsed || playedOnSpeaker;
      const deviceAudioBuffer = playedOnSpeaker
        ? createSilentPcm(currentAudioBuffer.byteLength)
        : currentAudioBuffer;

      const getPlaybackAckForSequence = dependencies.getPlaybackAckForSequence;
      const playbackPacingOptions: PlaybackPacingOptions = {};
      if (!isFirstSegment) {
        // Follow-up segments land on a device that is still draining the
        // previous one, so the full 2 s burst would risk the same queue
        // overflow the pacing exists to avoid; a small allowance only
        // covers network jitter.
        playbackPacingOptions.prebufferMilliseconds = 500;
      }
      if (dependencies.isSpeechAborted !== undefined) {
        playbackPacingOptions.shouldStop = dependencies.isSpeechAborted;
      }
      if (ttsSequence !== undefined && getPlaybackAckForSequence !== undefined) {
        playbackPacingOptions.getPlaybackAck = () =>
          getPlaybackAckForSequence(ttsSequence);
      }
      await streamAudioChunksAtPlaybackPace({
        audioBuffer: deviceAudioBuffer,
        sampleRateHz: TTS_PCM_SAMPLE_RATE_HZ,
        channelCount: TTS_PCM_CHANNEL_COUNT,
        send: (audioChunk) => {
          connection.send(audioChunk);
        },
        ...playbackPacingOptions,
      });

      if (dependencies.isSpeechAborted?.() === true) {
        wasAborted = true;
        break;
      }
      connection.send(encodeServerToDeviceMessage({ type: 'tts_end' }));
      currentAudioBuffer = await nextAudioBufferPromise;
    }

    if (wasAborted) {
      // Tocar la pantalla corta la respuesta también en el parlante.
      if (speakerUsed) {
        stopSpeakerVoice();
      }
      // The device counts bytes against what tts_start promised to know when
      // speech ends, and that total will never arrive now.
      connection.send(encodeServerToDeviceMessage({ type: 'tts_aborted' }));
    }
    speechWasAborted = wasAborted;
    markSpeechFinished();
  }

  // An aborted reply never reopens the mic: the user already cut it off.
  connection.send(
    encodeServerToDeviceMessage({
      type: 'turn_end',
      expectsReply: turnOutput.expectsReply && !speechWasAborted,
    }),
  );

  if (turnOutput.transcript.length > 0) {
    await dependencies.session.appendMessage({
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: turnOutput.transcript }],
      createdAt: new Date(),
    });
    await dependencies.session.appendMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [
        { type: 'text', text: turnOutput.spokenText },
        ...turnOutput.executedToolCallList.map((executedToolCall) => ({
          type: 'tool-call',
          toolName: executedToolCall.name,
          output: executedToolCall.summary,
        })),
      ],
      createdAt: new Date(),
    });
  }
}

function encodeMockSpeechAudio(spokenText: string): ArrayBuffer {
  const encodedSpokenTextBytes = new TextEncoder().encode(spokenText);
  const mockSpeechAudioBuffer = new ArrayBuffer(encodedSpokenTextBytes.byteLength);
  new Uint8Array(mockSpeechAudioBuffer).set(encodedSpokenTextBytes);
  return mockSpeechAudioBuffer;
}

export function concatenateArrayBufferList(
  arrayBufferList: readonly ArrayBuffer[],
): ArrayBuffer {
  const totalByteLength = arrayBufferList.reduce(
    (sum, buffer) => sum + buffer.byteLength,
    0,
  );
  const mergedBytes = new Uint8Array(totalByteLength);
  let offset = 0;
  for (const buffer of arrayBufferList) {
    mergedBytes.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return mergedBytes.buffer;
}
