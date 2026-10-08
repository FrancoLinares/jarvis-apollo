// Piper corre local en la Pi: sin API key, sin red y sin cuotas. El precio es
// CPU del host — por eso el cache de ttscache.ts pesa más acá que con un
// proveedor cloud: una frase repetida no vuelve a costar inferencia.
//
// Este módulo solo se carga en el host de Bun (usa Bun.spawn y el filesystem),
// nunca en el Worker; synthesize.ts lo importa de forma dinámica.
//
// PROCESO PERSISTENTE: arrancar piper por cada frase costaba 1,28s solo en
// cargar el modelo ONNX de 63MB, contra ~0,85s de síntesis real. Manteniéndolo
// vivo con --json-input el factor baja de 0,94x a 0,38x (medido en la Pi 4).

import { mkdirSync } from 'node:fs';

// El firmware reproduce el PCM directo por I2S y espera 24kHz s16le mono, así
// que la salida de Piper (22050Hz en la mayoría de las voces) se remuestrea acá.
export const TTS_PCM_SAMPLE_RATE_HZ = 24000;

const DEFAULT_PIPER_SAMPLE_RATE_HZ = 22050;
const SYNTHESIS_TIMEOUT_MILLISECONDS = 60_000;
const WAV_HEADER_BYTE_LENGTH = 44;

const sampleRateByModelPath = new Map<string, number>();

async function readVoiceSampleRateHz(voiceModelPath: string): Promise<number> {
  const cached = sampleRateByModelPath.get(voiceModelPath);
  if (cached !== undefined) {
    return cached;
  }
  let sampleRateHz = DEFAULT_PIPER_SAMPLE_RATE_HZ;
  try {
    const descriptor = await Bun.file(`${voiceModelPath}.json`).json();
    const declared = descriptor?.audio?.sample_rate;
    if (typeof declared === 'number' && declared > 0) {
      sampleRateHz = declared;
    }
  } catch {
    // Sin descriptor asumimos el rate habitual de Piper; peor caso, el audio
    // suena levemente desafinado y se corrige poniendo el .json al lado.
  }
  sampleRateByModelPath.set(voiceModelPath, sampleRateHz);
  return sampleRateHz;
}

// Interpolación lineal sobre muestras de 16 bits. Para voz, a un salto de
// 22050→24000, es indistinguible de un resampler con filtro y no agrega
// dependencias ni latencia perceptible.
export function resamplePcm16(
  samples: Int16Array,
  sourceRateHz: number,
  targetRateHz: number,
): Int16Array {
  if (sourceRateHz === targetRateHz || samples.length === 0) {
    return samples;
  }
  const ratio = sourceRateHz / targetRateHz;
  const targetLength = Math.max(1, Math.floor(samples.length / ratio));
  const resampled = new Int16Array(targetLength);
  for (let index = 0; index < targetLength; index += 1) {
    const sourcePosition = index * ratio;
    const lowerIndex = Math.floor(sourcePosition);
    const upperIndex = Math.min(lowerIndex + 1, samples.length - 1);
    const fraction = sourcePosition - lowerIndex;
    resampled[index] =
      (samples[lowerIndex] ?? 0) * (1 - fraction) + (samples[upperIndex] ?? 0) * fraction;
  }
  return resampled;
}

// stdin y stdout quedan como 'pipe' para poder escribirle pedidos y leerle la
// línea de respuesta; stderr se descarta porque Piper loguea cada síntesis.
type PiperSubprocess = Bun.Subprocess<'pipe', 'pipe', 'ignore'>;

// Bun extiende el reader estándar (agrega readMany), así que el tipo se infiere
// del propio getReader en vez de declararlo a mano.
function createStdoutReader(child: PiperSubprocess) {
  return child.stdout.getReader();
}

type PiperProcess = {
  readonly child: PiperSubprocess;
  readonly reader: ReturnType<typeof createStdoutReader>;
  pendingOutput: string;
  readonly voiceModelPath: string;
};

let runningProcess: PiperProcess | null = null;
// Piper responde una línea por pedido y en orden, así que los pedidos se
// encadenan: dos síntesis en paralelo mezclarían las respuestas.
let requestChain: Promise<unknown> = Promise.resolve();

function stopProcess(): void {
  if (runningProcess === null) {
    return;
  }
  try {
    runningProcess.child.kill();
  } catch {
    // Ya estaba muerto; lo único que importa es soltar la referencia.
  }
  runningProcess = null;
}

function startProcess(input: {
  readonly binaryPath: string;
  readonly voiceModelPath: string;
  readonly libraryDirectory?: string;
  readonly outputDirectory: string;
}): PiperProcess {
  mkdirSync(input.outputDirectory, { recursive: true });
  const child: PiperSubprocess = Bun.spawn(
    [
      input.binaryPath,
      '--model',
      input.voiceModelPath,
      '--json-input',
      '--output_dir',
      input.outputDirectory,
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env: {
        ...process.env,
        ...(input.libraryDirectory ? { LD_LIBRARY_PATH: input.libraryDirectory } : {}),
      },
    },
  );
  return {
    child,
    reader: createStdoutReader(child),
    pendingOutput: '',
    voiceModelPath: input.voiceModelPath,
  };
}

/** Lee de stdout hasta completar una línea: el path del WAV recién generado. */
async function readGeneratedFilePath(piper: PiperProcess): Promise<string> {
  const decoder = new TextDecoder();
  for (;;) {
    const newlineIndex = piper.pendingOutput.indexOf('\n');
    if (newlineIndex >= 0) {
      const line = piper.pendingOutput.slice(0, newlineIndex).trim();
      piper.pendingOutput = piper.pendingOutput.slice(newlineIndex + 1);
      if (line.length > 0) {
        return line;
      }
      continue;
    }
    const { done, value } = await piper.reader.read();
    if (done) {
      throw new Error('Piper cerró stdout');
    }
    piper.pendingOutput += decoder.decode(value, { stream: true });
  }
}

export async function synthesizeSpeechWithPiper(input: {
  readonly text: string;
  readonly binaryPath: string;
  readonly voiceModelPath: string;
  /** Directorio con las .so que trae el bundle de Piper. */
  readonly libraryDirectory?: string;
  readonly outputDirectory?: string;
}): Promise<ArrayBuffer> {
  const outputDirectory = input.outputDirectory ?? '/tmp/piper-out';

  const attempt = async (): Promise<ArrayBuffer> => {
    // Un cambio de voz obliga a rearrancar: el modelo se fija al lanzar.
    if (runningProcess !== null && runningProcess.voiceModelPath !== input.voiceModelPath) {
      stopProcess();
    }
    if (runningProcess === null) {
      runningProcess = startProcess({ ...input, outputDirectory });
    }
    const piper = runningProcess;

    // Piper lee una línea JSON por vez; los saltos internos cortarían la frase.
    piper.child.stdin.write(
      `${JSON.stringify({ text: input.text.replace(/\s*\n\s*/g, ' ') })}\n`,
    );
    piper.child.stdin.flush();

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Piper no respondió a tiempo')),
        SYNTHESIS_TIMEOUT_MILLISECONDS,
      ),
    );
    const generatedFilePath = await Promise.race([readGeneratedFilePath(piper), timeout]);

    const wavBytes = new Uint8Array(await Bun.file(generatedFilePath).arrayBuffer());
    // El WAV se consumió entero; dejarlo llenaría /tmp con una respuesta por turno.
    await Bun.file(generatedFilePath)
      .delete()
      .catch(() => undefined);
    if (wavBytes.byteLength <= WAV_HEADER_BYTE_LENGTH) {
      throw new Error(`Piper devolvió un WAV vacío (${wavBytes.byteLength} bytes)`);
    }

    const pcmBytes = wavBytes.subarray(WAV_HEADER_BYTE_LENGTH);
    const sourceRateHz = await readVoiceSampleRateHz(input.voiceModelPath);
    // Copia alineada: subarray hereda el offset del WAV y Int16Array exige
    // alineación a 2 bytes.
    const alignedLength = pcmBytes.byteLength - (pcmBytes.byteLength % 2);
    const samples = new Int16Array(pcmBytes.slice(0, alignedLength).buffer);
    if (sourceRateHz === TTS_PCM_SAMPLE_RATE_HZ) {
      return samples.buffer as ArrayBuffer;
    }
    const resampled = resamplePcm16(samples, sourceRateHz, TTS_PCM_SAMPLE_RATE_HZ);
    return resampled.buffer.slice(
      resampled.byteOffset,
      resampled.byteOffset + resampled.byteLength,
    ) as ArrayBuffer;
  };

  const run = requestChain.then(attempt, attempt).catch(async (error) => {
    // Un proceso muerto o trabado deja la cola envenenada: se descarta y el
    // siguiente pedido arranca uno limpio. Un reintento, para no enmascarar
    // un fallo real de configuración.
    stopProcess();
    if (error instanceof Error && /stdout|no respondió|vacío/.test(error.message)) {
      return attempt();
    }
    throw error;
  });
  requestChain = run.catch(() => undefined);
  return run;
}
