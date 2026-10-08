// Síntesis con Azure Speech.
//
// Por qué Azure y no EdgeTTS: son LAS MISMAS voces de Microsoft, pero EdgeTTS
// era una puerta trasera al lector de Edge y Microsoft la cerró (404 en la ruta
// vieja, 403 en el host nuevo). Esta es la API oficial, con key y contrato.
//
// Dos cosas la hacen encajar acá mejor que Piper:
//  - `raw-24khz-16bit-mono-pcm` es EXACTAMENTE lo que reproduce el firmware:
//    se elimina el remuestreo de 22050 a 24000 que hoy hace la Pi por software.
//  - La síntesis ocurre del lado del servidor, así que la Pi queda libre. Piper
//    corre a 0,58x tiempo real: decir 10 segundos le cuesta 6 de CPU.

// El firmware espera pcm_24000, s16le mono. Pedirlo así evita convertir nada.
const AZURE_OUTPUT_FORMAT = 'raw-24khz-16bit-mono-pcm';
export const AZURE_TTS_SAMPLE_RATE_HZ = 24000;

// Voz argentina masculina. Es la que se quería desde el principio del proyecto.
export const DEFAULT_AZURE_VOICE = 'es-AR-TomasNeural';

// Brasil es la región cercana: medido desde la Pi, 191ms de handshake contra
// 440-490ms de Estados Unidos o Europa.
export const DEFAULT_AZURE_REGION = 'brazilsouth';

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Escapa el texto para meterlo en SSML. Sin esto, un `&` o un `<` en la
 * respuesta del modelo rompe el XML y Azure devuelve 400 — y Jarvis se queda
 * mudo justo cuando dice algo con "Tom & Jerry" o "a < b".
 */
export function escapeSsmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildAzureSsml(input: {
  readonly text: string;
  readonly voiceName: string;
}): string {
  // El `xml:lang` va en es-AR aunque la voz ya lo implique: sin eso Azure a
  // veces lee los números con entonación neutra.
  return (
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-AR">' +
    `<voice name="${input.voiceName}">${escapeSsmlText(input.text)}</voice>` +
    '</speak>'
  );
}

export function buildAzureEndpoint(region: string): string {
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

export class AzureSpeechError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`Azure Speech respondió ${status}: ${detail.slice(0, 200)}`);
    this.name = 'AzureSpeechError';
    this.status = status;
  }
}

/**
 * Devuelve PCM crudo de 24 kHz, listo para el firmware.
 *
 * Tira `AzureSpeechError` ante cualquier respuesta no OK: quien llama decide si
 * cae a Piper. El 429 (cuota del tier gratis agotada) no se distingue acá a
 * propósito — para el que escucha, "sin cuota" y "sin red" son lo mismo.
 */
export async function synthesizeSpeechWithAzure(input: {
  readonly text: string;
  readonly subscriptionKey: string;
  readonly region?: string;
  readonly voiceName?: string;
  readonly fetchImplementation?: FetchLike;
}): Promise<ArrayBuffer> {
  const performFetch = input.fetchImplementation ?? fetch;
  const region = input.region ?? DEFAULT_AZURE_REGION;
  const voiceName = input.voiceName ?? DEFAULT_AZURE_VOICE;

  const response = await performFetch(buildAzureEndpoint(region), {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': input.subscriptionKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': AZURE_OUTPUT_FORMAT,
      // Azure lo pide para telemetría; sin él algunas regiones rechazan.
      'User-Agent': 'jarvis-desk',
    },
    body: buildAzureSsml({ text: input.text, voiceName }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new AzureSpeechError(response.status, detail);
  }
  return response.arrayBuffer();
}
