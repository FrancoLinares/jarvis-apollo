import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// Estos tests existen por un pedido explícito: que la implementación anterior
// (Piper) NO se pueda perder al agregar Azure, y que volver atrás sea una
// variable de entorno. Fijan las cuatro rutas del selector para que un cambio
// futuro no rompa la vuelta atrás en silencio.

// Se capturan los modulos REALES antes de mockearlos. `mock.module` de bun es
// global al proceso, asi que sin restaurarlos al final este archivo le rompe el
// import a azure.spec.ts, que corre despues en el mismo run:
//   SyntaxError: Export named 'AZURE_TTS_SAMPLE_RATE_HZ' not found in module
// Completar el mock con la constante que falta seria peor: azure.spec.ts pasaria
// a testear estos stubs en vez del codigo de verdad.
const realAzureModule = { ...(await import('@/voice/azure')) };
const realPiperModule = { ...(await import('@/voice/piper')) };

const piperCallList: string[] = [];
const azureCallList: string[] = [];
let azureShouldFail = false;

mock.module('@/voice/piper', () => ({
  synthesizeSpeechWithPiper: async (input: { text: string }) => {
    piperCallList.push(input.text);
    return new ArrayBuffer(16);
  },
}));

mock.module('@/voice/azure', () => ({
  DEFAULT_AZURE_REGION: 'brazilsouth',
  DEFAULT_AZURE_VOICE: 'es-AR-TomasNeural',
  synthesizeSpeechWithAzure: async (input: { text: string }) => {
    azureCallList.push(input.text);
    if (azureShouldFail) {
      throw new Error('Azure Speech respondió 429: quota');
    }
    return new ArrayBuffer(32);
  },
}));

// El cache normalmente evita sintetizar dos veces lo mismo; acá estorba.
mock.module('@/voice/ttscache', () => ({
  synthesizeSpeechThroughCache: async (input: { synthesize: () => Promise<ArrayBuffer> }) =>
    input.synthesize(),
}));

const { synthesizeApolloSpeech } = await import('@/voice/synthesize');

const originalEnvironment = { ...process.env };

function callSynthesize(text = 'hola') {
  return synthesizeApolloSpeech({
    environment: {} as never,
    mediaBlobStore: {} as never,
    text,
    voiceId: 'voz',
  });
}

beforeEach(() => {
  piperCallList.length = 0;
  azureCallList.length = 0;
  azureShouldFail = false;
  delete process.env.AZURE_SPEECH_KEY;
});

afterEach(() => {
  process.env = { ...originalEnvironment };
});

// Devolver los modulos de verdad al registro: lo que mockea este archivo no
// puede seguir mockeado para los que corren despues.
afterAll(() => {
  mock.module('@/voice/azure', () => realAzureModule);
  mock.module('@/voice/piper', () => realPiperModule);
});

describe('selector de proveedor de voz', () => {
  it('TTS_PROVIDER=piper usa Piper y NUNCA llama a Azure', async () => {
    process.env.TTS_PROVIDER = 'piper';
    process.env.AZURE_SPEECH_KEY = 'una-key-que-no-se-debe-usar';
    await callSynthesize('probando piper');
    expect(piperCallList).toEqual(['probando piper']);
    expect(azureCallList).toEqual([]);
  });

  it('TTS_PROVIDER=azure con key usa Azure y no toca Piper', async () => {
    process.env.TTS_PROVIDER = 'azure';
    process.env.AZURE_SPEECH_KEY = 'key-valida';
    await callSynthesize('probando azure');
    expect(azureCallList).toEqual(['probando azure']);
    expect(piperCallList).toEqual([]);
  });

  it('TTS_PROVIDER=azure SIN key cae a Piper en vez de quedarse mudo', async () => {
    process.env.TTS_PROVIDER = 'azure';
    await callSynthesize('sin key');
    expect(azureCallList).toEqual([]);
    expect(piperCallList).toEqual(['sin key']);
  });

  it('si Azure falla (cuota, red, key vencida) cae a Piper solo', async () => {
    process.env.TTS_PROVIDER = 'azure';
    process.env.AZURE_SPEECH_KEY = 'key-valida';
    azureShouldFail = true;
    const audio = await callSynthesize('azure caido');
    // Se intentó Azure, falló, y sonó Piper: el usuario escucha algo igual.
    expect(azureCallList).toEqual(['azure caido']);
    expect(piperCallList).toEqual(['azure caido']);
    expect(audio.byteLength).toBe(16);
  });

  it('volver atrás es cambiar UNA variable, sin tocar código', async () => {
    process.env.TTS_PROVIDER = 'azure';
    process.env.AZURE_SPEECH_KEY = 'key-valida';
    await callSynthesize('con azure');
    expect(azureCallList).toHaveLength(1);

    // El rollback completo: TTS_PROVIDER=piper y reiniciar.
    process.env.TTS_PROVIDER = 'piper';
    await callSynthesize('de vuelta en piper');
    expect(azureCallList).toHaveLength(1); // no creció
    expect(piperCallList).toEqual(['de vuelta en piper']);
  });
});
