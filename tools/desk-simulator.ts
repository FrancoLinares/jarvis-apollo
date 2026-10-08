#!/usr/bin/env bun
/**
 * Simulador del "desk" de Apollo: se conecta al host haciéndose pasar por el
 * ESP32 y deja conversar por texto desde la terminal.
 *
 * Sirve para dos cosas:
 *  1. Validar LLM + herramientas + TTS end-to-end SIN tener el firmware portado.
 *  2. Quedar como banco de pruebas del protocolo cuando se encare ese port:
 *     si el simulador funciona y la placa no, el problema está en el firmware.
 *
 * El audio del TTS llega como frames binarios de PCM crudo (24kHz, s16le mono),
 * exactamente lo que la placa reproduciría por I2S. Acá se acumula y se guarda
 * como WAV para poder escucharlo.
 *
 * Uso:
 *   bun tools/desk-simulator.ts --host <ip-del-servidor>:8799 --device jarvis
 *
 * Los secretos NO van por argumentos (quedarían en el historial y en `ps`):
 * se leen de DEVICE_SHARED_SECRET / DASHBOARD_SHARED_SECRET en el entorno o,
 * en macOS, del Llavero (servicio JARVIS_KEYCHAIN_SERVICE, default "jarvis").
 *   bun tools/desk-simulator.ts ... --say "Hola, cómo andás?"     (una sola pregunta y sale)
 */

const TTS_SAMPLE_RATE_HZ = 24000;

// Entorno primero; si no está y hay Llavero (macOS), de ahí. Nunca de argv.
function readSecret(name: string): string {
  const fromEnvironment = process.env[name];
  if (fromEnvironment) {
    return fromEnvironment;
  }
  if (process.platform !== 'darwin') {
    return '';
  }
  const service = process.env.JARVIS_KEYCHAIN_SERVICE ?? 'jarvis';
  const result = Bun.spawnSync(['security', 'find-generic-password', '-s', service, '-a', name, '-w']);
  return result.exitCode === 0 ? result.stdout.toString().trim() : '';
}

function parseArguments(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument?.startsWith('--')) {
      values.set(argument.slice(2), argv[index + 1] ?? '');
      index += 1;
    }
  }
  return {
    host: values.get('host') ?? process.env.JARVIS_APOLLO_HOST ?? '',
    device: values.get('device') ?? 'jarvis',
    token: readSecret('DEVICE_SHARED_SECRET'),
    dashboardToken:
      readSecret('DASHBOARD_SHARED_SECRET'),
    say: values.get('say'),
    audioOut: values.get('audio-out') ?? './jarvis-respuesta.wav',
  };
}

function buildWavFile(pcm: Uint8Array, sampleRateHz: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.length, true);
  const file = new Uint8Array(44 + pcm.length);
  file.set(new Uint8Array(header), 0);
  file.set(pcm, 44);
  return file;
}

// El protocolo del dispositivo manda audio, nunca el texto: la placa tiene
// parlante y cara, no necesita leer. Para poder VER lo que contesta Jarvis se
// abre en paralelo una conexión con rol 'dashboard' y se consulta el historial.
class DashboardChannel {
  private socket: WebSocket | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly host: string,
    private readonly deviceName: string,
    private readonly secret: string,
  ) {}

  async connect(): Promise<boolean> {
    if (this.secret === '') return false;
    const url =
      `ws://${this.host}/agents/apollo/${this.deviceName}` +
      `?token=${encodeURIComponent(this.secret)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let payload: any;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload?.type !== 'rpc') return;
      const waiter = this.pending.get(String(payload.id));
      if (waiter === undefined) return;
      this.pending.delete(String(payload.id));
      if (payload.success) waiter.resolve(payload.result);
      else waiter.reject(new Error(JSON.stringify(payload.error)));
    };
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(true);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  private call(method: string, args: unknown): Promise<unknown> {
    const socket = this.socket;
    if (socket === null) return Promise.reject(new Error('sin conexión'));
    const id = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout en ${method}`));
      }, 10_000);
      socket.send(JSON.stringify({ type: 'rpc', id, method, args: [args] }));
    });
  }

  /** Texto del último mensaje del asistente en el hilo activo. */
  async readLatestAssistantText(): Promise<string | null> {
    try {
      const threads: any = await this.call('listConsoleThreads', { secret: this.secret });
      const list = Array.isArray(threads) ? threads : (threads?.threads ?? []);
      const active = list.find((thread: any) => thread?.isActive) ?? list[0];
      if (active?.id === undefined) return null;
      const history: any = await this.call('getConsoleThread', {
        secret: this.secret,
        threadId: active.id,
      });
      const messages = Array.isArray(history) ? history : (history?.messages ?? []);
      // El historial usa `text`, no `content`.
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'assistant' && typeof message?.text === 'string') {
          return message.text;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

const options = parseArguments(Bun.argv.slice(2));
if (options.token === '') {
  console.error('Falta DEVICE_SHARED_SECRET: cargalo con `scripts/secrets.sh set DEVICE_SHARED_SECRET`');
  process.exit(1);
}
if (options.host === '') {
  console.error('Falta --host <ip-del-servidor>:8799 (o JARVIS_APOLLO_HOST)');
  process.exit(1);
}

const endpoint =
  `ws://${options.host}/agents/apollo/${options.device}` +
  `?token=${encodeURIComponent(options.token)}`;

console.log(`→ conectando a ${endpoint.replace(options.token, '***')}`);
const socket = new WebSocket(endpoint);
socket.binaryType = 'arraybuffer';

const audioChunks: Uint8Array[] = [];
let turnStartedAt = 0;

function send(message: Record<string, unknown>) {
  socket.send(JSON.stringify({ ...message, ts: Date.now() }));
}

function ask(text: string) {
  audioChunks.length = 0;
  turnStartedAt = Date.now();
  console.log(`\x1b[36m>> vos:\x1b[0m ${text}`);
  send({ type: 'text_input', text });
}

const dashboard = new DashboardChannel(options.host, options.device, options.dashboardToken);

socket.onopen = async () => {
  console.log('✅ conectado — mandando hello');
  const dashboardReady = await dashboard.connect();
  console.log(
    dashboardReady
      ? '✅ canal de texto activo (vas a ver lo que responde, no solo escucharlo)'
      : '⚠️  sin canal de texto: cargá DASHBOARD_SHARED_SECRET en el Llavero para ver las respuestas escritas',
  );
  send({ type: 'hello', deviceId: `simulador-${process.pid}` });
  setTimeout(() => {
    if (options.say !== undefined) {
      ask(options.say);
    } else {
      console.log('\nEscribí y Enter para hablarle a Jarvis. Ctrl+C para salir.\n');
      prompt_loop();
    }
  }, 500);
};

async function prompt_loop() {
  for await (const line of console) {
    const text = line.trim();
    if (text !== '') ask(text);
  }
}

socket.onmessage = async (event) => {
  // El audio del TTS viaja como frames binarios; todo lo demás es JSON.
  if (typeof event.data !== 'string') {
    audioChunks.push(new Uint8Array(event.data as ArrayBuffer));
    return;
  }
  let message: any;
  try {
    message = JSON.parse(event.data);
  } catch {
    console.log('  (mensaje no-JSON)', event.data.slice(0, 120));
    return;
  }

  switch (message.type) {
    case 'ui_state': {
      const extras = [
        message.emotion ? `emoción=${message.emotion}` : null,
        message.caption ? `caption="${message.caption}"` : null,
        message.accentColor ? `color=${message.accentColor}` : null,
      ].filter((part) => part !== null);
      console.log(
        `  \x1b[90m[estado] ${message.state}${extras.length > 0 ? ' · ' + extras.join(' · ') : ''}\x1b[0m`,
      );
      break;
    }
    case 'tts_start':
      console.log(`\x1b[32m<< jarvis:\x1b[0m ${message.text ?? '(audio)'}`);
      break;
    case 'confirm_request':
      console.log(`  \x1b[33m[pide confirmación] ${JSON.stringify(message)}\x1b[0m`);
      console.log('  → respondiendo que SÍ');
      send({ type: 'confirm', accepted: true, id: message.id });
      break;
    case 'error':
      console.log(`  \x1b[31m[error] ${JSON.stringify(message)}\x1b[0m`);
      break;
    case 'turn_end': {
      const totalBytes = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const elapsedSeconds = (Date.now() - turnStartedAt) / 1000;
      const spokenText = await dashboard.readLatestAssistantText();
      if (spokenText !== null) {
        console.log(`\x1b[32m<< jarvis (texto):\x1b[0m ${spokenText}`);
        console.log(`  \x1b[90m[${spokenText.length} caracteres]\x1b[0m`);
      }
      if (totalBytes > 0) {
        const pcm = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of audioChunks) {
          pcm.set(chunk, offset);
          offset += chunk.length;
        }
        await Bun.write(options.audioOut, buildWavFile(pcm, TTS_SAMPLE_RATE_HZ));
        console.log(
          `  \x1b[90m[audio] ${(totalBytes / (TTS_SAMPLE_RATE_HZ * 2)).toFixed(2)}s ` +
            `guardado en ${options.audioOut} — turno completo en ${elapsedSeconds.toFixed(2)}s\x1b[0m\n`,
        );
      } else {
        console.log(`  \x1b[90m[turno terminado en ${elapsedSeconds.toFixed(2)}s, sin audio]\x1b[0m\n`);
      }
      if (options.say !== undefined) {
        socket.close();
        process.exit(0);
      }
      break;
    }
    default:
      console.log(`  \x1b[90m[${message.type}] ${JSON.stringify(message).slice(0, 160)}\x1b[0m`);
  }
};

socket.onerror = () => console.error('❌ error de websocket');
socket.onclose = (event) => {
  console.log(`conexión cerrada (code=${event.code} reason="${event.reason}")`);
  process.exit(event.code === 1000 ? 0 : 1);
};
