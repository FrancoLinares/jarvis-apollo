import { describe, expect, it } from 'bun:test';

import {
  AZURE_TTS_SAMPLE_RATE_HZ,
  AzureSpeechError,
  buildAzureEndpoint,
  buildAzureSsml,
  escapeSsmlText,
  synthesizeSpeechWithAzure,
} from '@/voice/azure';

describe('escapeSsmlText', () => {
  it('escapa lo que rompería el XML', () => {
    // Sin esto un "&" en la respuesta del modelo devuelve 400 y Jarvis se queda
    // mudo justo cuando dice algo con "Tom & Jerry".
    expect(escapeSsmlText('Tom & Jerry')).toBe('Tom &amp; Jerry');
    expect(escapeSsmlText('a < b > c')).toBe('a &lt; b &gt; c');
    expect(escapeSsmlText(`dijo "hola" y 'chau'`)).toBe(
      'dijo &quot;hola&quot; y &apos;chau&apos;',
    );
  });

  it('deja intactos los acentos y la ñ', () => {
    expect(escapeSsmlText('El niño comió mañana')).toBe('El niño comió mañana');
  });
});

describe('buildAzureSsml', () => {
  it('arma el SSML con la voz pedida y el idioma argentino', () => {
    const ssml = buildAzureSsml({ text: 'Hola', voiceName: 'es-AR-TomasNeural' });
    expect(ssml).toContain('xml:lang="es-AR"');
    expect(ssml).toContain('<voice name="es-AR-TomasNeural">Hola</voice>');
  });

  it('el texto escapado no puede romper la estructura', () => {
    const ssml = buildAzureSsml({
      text: '</voice><voice name="hackeada">',
      voiceName: 'es-AR-TomasNeural',
    });
    // Una sola apertura y un solo cierre: la inyección quedó como texto.
    expect(ssml.match(/<voice /g)).toHaveLength(1);
    expect(ssml.match(/<\/voice>/g)).toHaveLength(1);
  });
});

describe('buildAzureEndpoint', () => {
  it('apunta a la región que se le pasa', () => {
    expect(buildAzureEndpoint('brazilsouth')).toBe(
      'https://brazilsouth.tts.speech.microsoft.com/cognitiveservices/v1',
    );
  });
});

describe('synthesizeSpeechWithAzure', () => {
  const base = { text: 'Hola Marcos', subscriptionKey: 'k' };

  it('pide PCM de 24 kHz, que es lo que reproduce el firmware', async () => {
    let requestInit: RequestInit | undefined;
    await synthesizeSpeechWithAzure({
      ...base,
      fetchImplementation: async (_url, init) => {
        requestInit = init;
        return new Response(new ArrayBuffer(64), { status: 200 });
      },
    });
    const headers = requestInit?.headers as Record<string, string>;
    expect(headers['X-Microsoft-OutputFormat']).toBe('raw-24khz-16bit-mono-pcm');
    expect(AZURE_TTS_SAMPLE_RATE_HZ).toBe(24000);
  });

  it('manda la key en la cabecera que espera Azure', async () => {
    let headers: Record<string, string> = {};
    await synthesizeSpeechWithAzure({
      ...base,
      subscriptionKey: 'secreta',
      fetchImplementation: async (_url, init) => {
        headers = init?.headers as Record<string, string>;
        return new Response(new ArrayBuffer(8), { status: 200 });
      },
    });
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('secreta');
  });

  it('usa Brasil y la voz argentina por defecto', async () => {
    let url = '';
    let body = '';
    await synthesizeSpeechWithAzure({
      ...base,
      fetchImplementation: async (requestUrl, init) => {
        url = String(requestUrl);
        body = String(init?.body);
        return new Response(new ArrayBuffer(8), { status: 200 });
      },
    });
    expect(url).toContain('brazilsouth');
    expect(body).toContain('es-AR-TomasNeural');
  });

  it('devuelve el audio tal cual, sin convertir', async () => {
    const audio = new ArrayBuffer(4800);
    const result = await synthesizeSpeechWithAzure({
      ...base,
      fetchImplementation: async () => new Response(audio, { status: 200 }),
    });
    expect(result.byteLength).toBe(4800);
  });

  it('un 401 (key mala) sube como error para que el llamador caiga a Piper', async () => {
    await expect(
      synthesizeSpeechWithAzure({
        ...base,
        fetchImplementation: async () => new Response('unauthorized', { status: 401 }),
      }),
    ).rejects.toBeInstanceOf(AzureSpeechError);
  });

  it('un 429 (cuota agotada) también, y conserva el código', async () => {
    try {
      await synthesizeSpeechWithAzure({
        ...base,
        fetchImplementation: async () => new Response('quota', { status: 429 }),
      });
      throw new Error('debería haber fallado');
    } catch (error) {
      expect(error).toBeInstanceOf(AzureSpeechError);
      expect((error as AzureSpeechError).status).toBe(429);
    }
  });
});
