import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Parlante externo: el jack de la Raspberry Pi, manejado por jarvis-speaker
// (deploy/pi/speaker), un servicio del host que mezcla Spotify con la voz de
// Jarvis y baja la música mientras Jarvis habla o la placa escucha.
//
// Pedido (2026-10-04): los avisos (noticia roja, apertura, vencimientos,
// recordatorios) por el parlante, para que se escuchen en todo el ambiente; la
// conversación sigue en la placa, que es donde están los micrófonos y la
// cancelación de eco. "Modo parlante" manda todo al parlante.
//
// Cuando el audio va al parlante, la placa recibe SILENCIO del mismo largo en
// vez de nada: así su máquina de estados (hablando → reposo, acks de
// reproducción, el overlay del recordatorio) sigue exactamente igual que antes
// y el ritmo del envío no cambia. Si el parlante no contesta, el audio vuelve a
// la placa: un aviso nunca se pierde por el parlante.

export type SpeakerRoute = 'apagado' | 'avisos' | 'todo';
export type SpeakerAudioKind = 'aviso' | 'respuesta';

export const SPEAKER_ROUTE_LIST: readonly SpeakerRoute[] = ['apagado', 'avisos', 'todo'];
export const SPEAKER_DEFAULT_ROUTE: SpeakerRoute = 'avisos';
export const SPEAKER_REQUEST_TIMEOUT_MILLISECONDS = 2500;
// Lo que dura una escucha larga de la placa; el fin del turno la levanta antes.
export const SPEAKER_LISTEN_DUCK_SECONDS = 20;

const SPEAKER_STATE_FILE_NAME = 'speaker.json';

function readHostEnvironmentValue(name: string): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[name];
}

type SpeakerConfiguration = {
  readonly baseUrl: string;
  readonly token: string;
};

export function resolveSpeakerConfiguration(): SpeakerConfiguration | undefined {
  const baseUrl = readHostEnvironmentValue('SPEAKER_URL')?.trim();
  const token = readHostEnvironmentValue('SPEAKER_TOKEN')?.trim();
  if (baseUrl === undefined || baseUrl.length === 0 || token === undefined || token.length === 0) {
    return undefined;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

export function isSpeakerRoute(value: string): value is SpeakerRoute {
  return (SPEAKER_ROUTE_LIST as readonly string[]).includes(value);
}

// --- modo (persistido en el volumen de datos) ------------------------------

let cachedRoute: SpeakerRoute | undefined;

function resolveStateFilePath(): string {
  return join(readHostEnvironmentValue('APOLLO_DATA_DIRECTORY') ?? './data', SPEAKER_STATE_FILE_NAME);
}

function resolveDefaultRoute(): SpeakerRoute {
  const configuredRoute = readHostEnvironmentValue('SPEAKER_ROUTE')?.trim();
  return configuredRoute !== undefined && isSpeakerRoute(configuredRoute)
    ? configuredRoute
    : SPEAKER_DEFAULT_ROUTE;
}

export function resolveSpeakerRoute(): SpeakerRoute {
  if (cachedRoute !== undefined) {
    return cachedRoute;
  }
  try {
    const parsed = JSON.parse(readFileSync(resolveStateFilePath(), 'utf8')) as { route?: unknown };
    cachedRoute =
      typeof parsed.route === 'string' && isSpeakerRoute(parsed.route)
        ? parsed.route
        : resolveDefaultRoute();
  } catch {
    cachedRoute = resolveDefaultRoute();
  }
  return cachedRoute;
}

export function setSpeakerRoute(route: SpeakerRoute): void {
  cachedRoute = route;
  try {
    const stateFilePath = resolveStateFilePath();
    mkdirSync(dirname(stateFilePath), { recursive: true });
    writeFileSync(stateFilePath, JSON.stringify({ route }));
  } catch (error) {
    console.log(
      JSON.stringify({
        level: 'warn',
        message: 'apollo_parlante_modo_no_guardado',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export function resetSpeakerRouteCacheForTests(): void {
  cachedRoute = undefined;
}

// Qué audio va al parlante según el modo. Sin configuración, nada.
export function shouldRouteToSpeaker(
  kind: SpeakerAudioKind,
  route: SpeakerRoute = resolveSpeakerRoute(),
  configured: boolean = resolveSpeakerConfiguration() !== undefined,
): boolean {
  if (!configured || route === 'apagado') {
    return false;
  }
  return route === 'todo' || kind === 'aviso';
}

// --- llamadas al servicio del host -----------------------------------------

async function callSpeaker(
  path: string,
  init: { readonly method: 'GET' | 'POST'; readonly body?: ArrayBuffer },
  fetchImplementation: typeof fetch = fetch,
): Promise<Record<string, unknown> | undefined> {
  const configuration = resolveSpeakerConfiguration();
  if (configuration === undefined) {
    return undefined;
  }
  try {
    const response = await fetchImplementation(`${configuration.baseUrl}${path}`, {
      method: init.method,
      headers: {
        'X-Speaker-Token': configuration.token,
        'Content-Type': 'application/octet-stream',
      },
      body: init.body,
      signal: AbortSignal.timeout(SPEAKER_REQUEST_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) {
      throw new Error(`jarvis-speaker respondió ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    console.log(
      JSON.stringify({
        level: 'warn',
        message: 'apollo_parlante_error',
        ruta: path.split('?')[0],
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return undefined;
  }
}

// Encola el PCM (24 kHz mono S16LE, el formato del TTS) en el parlante.
// true = el parlante lo aceptó; false = hay que mandarlo a la placa.
export async function playPcmOnSpeaker(
  audioBuffer: ArrayBuffer,
  input: {
    readonly sampleRateHz: number;
    readonly channelCount: number;
    readonly fetchImplementation?: typeof fetch;
  },
): Promise<boolean> {
  if (audioBuffer.byteLength === 0) {
    return false;
  }
  const result = await callSpeaker(
    `/play?rate=${input.sampleRateHz}&channels=${input.channelCount}`,
    { method: 'POST', body: audioBuffer },
    input.fetchImplementation,
  );
  return result?.ok === true;
}

// Las tres de abajo son "dispara y olvida": si el parlante no está, no frenan
// el turno ni la escucha.
export function stopSpeakerVoice(): void {
  void callSpeaker('/stop', { method: 'POST' });
}

export function duckSpeakerMusic(seconds: number = SPEAKER_LISTEN_DUCK_SECONDS): void {
  if (resolveSpeakerConfiguration() === undefined) {
    return;
  }
  void callSpeaker(`/duck?seconds=${seconds}`, { method: 'POST' });
}

export function unduckSpeakerMusic(): void {
  if (resolveSpeakerConfiguration() === undefined) {
    return;
  }
  void callSpeaker('/unduck', { method: 'POST' });
}

export async function setSpeakerVoiceVolume(volume: number): Promise<boolean> {
  const result = await callSpeaker(`/volume?voice=${Math.round(volume)}`, { method: 'POST' });
  return result?.ok === true;
}

export async function readSpeakerHealth(): Promise<Record<string, unknown> | undefined> {
  return callSpeaker('/health', { method: 'GET' });
}

// Silencio con el mismo largo que el audio que fue al parlante (ver arriba).
export function createSilentPcm(byteLength: number): ArrayBuffer {
  return new ArrayBuffer(byteLength);
}
