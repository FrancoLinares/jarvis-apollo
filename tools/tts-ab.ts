#!/usr/bin/env bun
/**
 * A/B objetivo entre Piper (local) y Azure Speech (nube).
 *
 * Corre DENTRO del contenedor de Apollo, que es donde viven las dos rutas y la
 * red real de la Pi. Mide lo que se percibe, no lo que se supone:
 *
 *   - tiempo hasta tener el audio completo de cada frase
 *   - el "factor": milisegundos de trabajo por segundo de audio producido.
 *     Menor que 1 significa que sintetiza más rápido de lo que se escucha, que
 *     es lo que permite que la síntesis especulativa esconda la latencia.
 *
 * Uso (en la Pi):
 *   docker cp tools/tts-ab.ts docker-apollo-1:/app/tts-ab.ts
 *   docker exec docker-apollo-1 sh -lc "cd /app && bun tts-ab.ts"
 *
 * Las keys salen del entorno del contenedor (el .dev.vars que sube
 * scripts/push-secrets.sh). Nunca las pases con -e: quedan en el historial.
 */

import { synthesizeSpeechWithAzure } from '@/voice/azure';
import { synthesizeSpeechWithPiper } from '@/voice/piper';

const SAMPLE_RATE_HZ = 24000;

// Frases reales del uso diario, de corta a larga: la primera es la que más
// pesa, porque es la que el usuario espera antes de escuchar cualquier cosa.
const PHRASE_LIST = [
  'Son las nueve y media.',
  'Hoy está nublado, nueve grados en Chacarita.',
  'Tenés cuatro pendientes en la lista y el partido de fútbol a las ocho de la noche.',
  'Revisé tu calendario. Esta semana tenés un solo evento: pagar las expensas del edificio, el viernes once a las diez y media de la mañana. El resto de la semana está despejada.',
];

const REPEAT_COUNT = 3;

type Measurement = { milliseconds: number; audioSeconds: number };

function summarize(label: string, measurementList: readonly Measurement[]): void {
  if (measurementList.length === 0) {
    console.log(`  ${label.padEnd(8)} sin muestras`);
    return;
  }
  const sorted = [...measurementList].sort((a, b) => a.milliseconds - b.milliseconds);
  const median = sorted[Math.floor(sorted.length / 2)];
  const totalMs = measurementList.reduce((sum, m) => sum + m.milliseconds, 0);
  const totalAudio = measurementList.reduce((sum, m) => sum + m.audioSeconds, 0);
  console.log(
    `  ${label.padEnd(8)} mediana ${String(median.milliseconds).padStart(5)}ms` +
      `  ·  min ${String(sorted[0].milliseconds).padStart(5)}ms` +
      `  ·  max ${String(sorted[sorted.length - 1].milliseconds).padStart(5)}ms` +
      `  ·  factor ${(totalMs / 1000 / totalAudio).toFixed(2)}x`,
  );
}

async function measure(
  synthesize: () => Promise<ArrayBuffer>,
): Promise<Measurement | undefined> {
  const startedAt = Date.now();
  try {
    const audio = await synthesize();
    return {
      milliseconds: Date.now() - startedAt,
      // PCM 16 bits mono: dos bytes por muestra.
      audioSeconds: audio.byteLength / 2 / SAMPLE_RATE_HZ,
    };
  } catch (error) {
    console.log(`    fallo: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const azureKey = process.env.AZURE_SPEECH_KEY;
const azureRegion = process.env.AZURE_SPEECH_REGION ?? 'brazilsouth';
const azureVoice = process.env.AZURE_SPEECH_VOICE ?? 'es-AR-TomasNeural';
const piperBinary = process.env.PIPER_BINARY ?? '/piper/piper/piper';
const piperVoice = process.env.PIPER_VOICE_MODEL ?? '/piper/voices/es_MX-ald-medium.onnx';
const piperLibrary = process.env.PIPER_LIBRARY_DIR ?? '/piper/piper';

console.log(`\nA/B de voz · ${REPEAT_COUNT} repeticiones por frase`);
console.log(`  Piper: ${piperVoice.split('/').pop()}`);
console.log(`  Azure: ${azureVoice} en ${azureRegion}${azureKey ? '' : '  (SIN KEY, se saltea)'}\n`);

// Calentamiento: la primera llamada a Piper arranca el proceso y carga 63 MB de
// modelo ONNX. Medirla mezclaría el arranque con la síntesis.
await measure(() =>
  synthesizeSpeechWithPiper({
    text: 'hola',
    binaryPath: piperBinary,
    voiceModelPath: piperVoice,
    libraryDirectory: piperLibrary,
  }),
);
if (azureKey) {
  await measure(() =>
    synthesizeSpeechWithAzure({ text: 'hola', subscriptionKey: azureKey, region: azureRegion, voiceName: azureVoice }),
  );
}

const piperAll: Measurement[] = [];
const azureAll: Measurement[] = [];

for (const phrase of PHRASE_LIST) {
  const piperRuns: Measurement[] = [];
  const azureRuns: Measurement[] = [];
  for (let round = 0; round < REPEAT_COUNT; round++) {
    const piperRun = await measure(() =>
      synthesizeSpeechWithPiper({
        text: phrase,
        binaryPath: piperBinary,
        voiceModelPath: piperVoice,
        libraryDirectory: piperLibrary,
      }),
    );
    if (piperRun) piperRuns.push(piperRun);

    if (azureKey) {
      const azureRun = await measure(() =>
        synthesizeSpeechWithAzure({
          text: phrase,
          subscriptionKey: azureKey,
          region: azureRegion,
          voiceName: azureVoice,
        }),
      );
      if (azureRun) azureRuns.push(azureRun);
    }
  }
  const seconds = piperRuns[0]?.audioSeconds ?? azureRuns[0]?.audioSeconds ?? 0;
  console.log(`"${phrase.slice(0, 58)}${phrase.length > 58 ? '…' : ''}"  (${phrase.length} car., ~${seconds.toFixed(1)}s de audio)`);
  summarize('Piper', piperRuns);
  if (azureKey) summarize('Azure', azureRuns);
  console.log('');
  piperAll.push(...piperRuns);
  azureAll.push(...azureRuns);
}

console.log('TOTAL');
summarize('Piper', piperAll);
if (azureKey) summarize('Azure', azureAll);

if (azureKey && piperAll.length > 0 && azureAll.length > 0) {
  const piperMedian = [...piperAll].sort((a, b) => a.milliseconds - b.milliseconds)[Math.floor(piperAll.length / 2)].milliseconds;
  const azureMedian = [...azureAll].sort((a, b) => a.milliseconds - b.milliseconds)[Math.floor(azureAll.length / 2)].milliseconds;
  const ratio = piperMedian / azureMedian;
  console.log(
    `\n  Veredicto: Azure es ${ratio.toFixed(2)}x ${ratio > 1 ? 'MÁS RÁPIDO' : 'más lento'} que Piper.`,
  );
}
process.exit(0);
