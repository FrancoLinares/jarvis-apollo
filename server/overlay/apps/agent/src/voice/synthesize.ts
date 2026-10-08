import type { BlobStore } from '@/platform/blob';
import { DEFAULT_AZURE_REGION, DEFAULT_AZURE_VOICE } from '@/voice/azure';
import { synthesizeSpeechWithElevenLabs } from '@/voice/elevenlabs';
import { synthesizeSpeechThroughCache } from '@/voice/ttscache';

const DEFAULT_PIPER_BINARY_PATH = '/piper/piper/piper';
const DEFAULT_PIPER_LIBRARY_DIRECTORY = '/piper/piper';
const DEFAULT_PIPER_VOICE_MODEL_PATH = '/piper/voices/es_MX-ald-medium.onnx';

// El Worker no expone process.env y el host de Bun sí; el acceso defensivo
// permite que este módulo siga sirviendo a los dos runtimes sin ramificarse.
function readHostEnvironmentValue(name: string): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[name];
}

// The one production speech path: every caller gets the blob cache, so a
// repeated utterance never costs credits (ElevenLabs) or CPU (Piper) twice.
// Piper vive detrás de una función porque es el plan B de Azure además de ser
// un proveedor por derecho propio.
async function synthesizeWithLocalPiper(text: string): Promise<ArrayBuffer> {
  const { synthesizeSpeechWithPiper } = await import('@/voice/piper');
  return synthesizeSpeechWithPiper({
    text,
    binaryPath: readHostEnvironmentValue('PIPER_BINARY') ?? DEFAULT_PIPER_BINARY_PATH,
    voiceModelPath:
      readHostEnvironmentValue('PIPER_VOICE_MODEL') ?? DEFAULT_PIPER_VOICE_MODEL_PATH,
    libraryDirectory:
      readHostEnvironmentValue('PIPER_LIBRARY_DIR') ?? DEFAULT_PIPER_LIBRARY_DIRECTORY,
  });
}

export async function synthesizeApolloSpeech(input: {
  readonly environment: Env;
  readonly mediaBlobStore: BlobStore;
  readonly text: string;
  readonly voiceId: string;
}): Promise<ArrayBuffer> {
  const provider = readHostEnvironmentValue('TTS_PROVIDER') ?? 'elevenlabs';

  if (provider === 'azure') {
    const subscriptionKey = readHostEnvironmentValue('AZURE_SPEECH_KEY');
    const region = readHostEnvironmentValue('AZURE_SPEECH_REGION') ?? DEFAULT_AZURE_REGION;
    const voiceName = readHostEnvironmentValue('AZURE_SPEECH_VOICE') ?? DEFAULT_AZURE_VOICE;
    if (subscriptionKey !== undefined && subscriptionKey.length > 0) {
      return synthesizeSpeechThroughCache({
        mediaBlobStore: input.mediaBlobStore,
        text: input.text,
        voiceId: input.voiceId,
        // La voz de Azure va como modelId igual que el modelo de Piper: cambiar
        // de voz tiene que invalidar el cache, no servir audio con la anterior.
        modelId: `azure:${voiceName}`,
        synthesize: async () => {
          const { synthesizeSpeechWithAzure } = await import('@/voice/azure');
          try {
            return await synthesizeSpeechWithAzure({
              text: input.text,
              subscriptionKey,
              region,
              voiceName,
            });
          } catch (error) {
            // Sin voz no hay asistente. Cuota agotada, red caída o key vencida
            // caen todos acá: se avisa en el log y suena Piper, que es local y
            // no depende de nadie. Peor acento, pero nunca mudo.
            console.log(
              JSON.stringify({
                level: 'warn',
                message: 'azure_tts_fallback_a_piper',
                detail: error instanceof Error ? error.message : String(error),
              }),
            );
            return synthesizeWithLocalPiper(input.text);
          }
        },
      });
    }
    console.log(
      JSON.stringify({
        level: 'warn',
        message: 'azure_tts_sin_key_usando_piper',
      }),
    );
  }

  if (provider === 'piper' || provider === 'azure') {
    const voiceModelPath =
      readHostEnvironmentValue('PIPER_VOICE_MODEL') ?? DEFAULT_PIPER_VOICE_MODEL_PATH;
    return synthesizeSpeechThroughCache({
      mediaBlobStore: input.mediaBlobStore,
      text: input.text,
      voiceId: input.voiceId,
      // Con Piper la voz vive en el modelo, no en voiceId: usarlo como modelId
      // hace que cambiar de voz invalide el cache en vez de servir audio viejo.
      modelId: voiceModelPath,
      synthesize: async () => synthesizeWithLocalPiper(input.text),
    });
  }

  return synthesizeSpeechThroughCache({
    mediaBlobStore: input.mediaBlobStore,
    text: input.text,
    voiceId: input.voiceId,
    modelId: input.environment.ELEVENLABS_TTS_MODEL,
    synthesize: () =>
      synthesizeSpeechWithElevenLabs({
        text: input.text,
        voiceId: input.voiceId,
        elevenLabsApiKey: input.environment.ELEVENLABS_API_KEY,
        modelId: input.environment.ELEVENLABS_TTS_MODEL,
      }),
  });
}
