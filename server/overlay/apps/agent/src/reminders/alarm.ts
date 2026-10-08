// Tono de alarma para los recordatorios, sintetizado en el servidor.
//
// Se pidió "una música tipo alarma, a bajo volumen". Había dos caminos y este
// es el barato: el firmware solo sabe reproducir los OGG que trae embebidos
// (OGG_VIBRATION, OGG_SUCCESS, OGG_POPUP...) y ninguno suena a alarma, así que
// la alternativa era agregar un asset y reflashear la placa por cada ajuste de
// melodía o de volumen. Generarlo acá lo vuelve un parámetro: el canal de PCM
// crudo hacia el dispositivo YA existe (`announcePcmToConnections`), habla
// 24 kHz mono 16-bit, y el volumen es literalmente un multiplicador.
//
// El tono se pega ADELANTE del audio del TTS y viaja como un solo buffer, no
// como dos anuncios seguidos. El dispositivo abre la reproducción con un
// `tts_start` que promete una cantidad exacta de bytes y la cierra con
// `tts_end`; mandar dos ciclos haría que el segundo llegue cuando el primero ya
// devolvió el control, y el firmware trataría al segundo como habla nueva.

// El firmware reproduce exactamente este formato. No hay remuestreo en el medio:
// lo que se genera acá es lo que sale por el parlante.
export const ALARM_SAMPLE_RATE_HZ = 24000;

const SIXTEEN_BIT_MAXIMUM_AMPLITUDE = 32767;

// Arpegio ascendente de La mayor (La5 - Do#5 - Mi6). Un intervalo que sube lee
// como "atención" sin el chillido de las alarmas de dos tonos alternados, que a
// bajo volumen se vuelven molestas en vez de discretas.
const ALARM_NOTE_FREQUENCY_HZ_LIST: readonly number[] = [880, 1108.73, 1318.51];

const ALARM_NOTE_DURATION_MILLISECONDS = 150;
const ALARM_NOTE_GAP_MILLISECONDS = 45;
const ALARM_PATTERN_REPEAT_COUNT = 2;
const ALARM_PATTERN_GAP_MILLISECONDS = 320;

// Silencio entre el final de la alarma y el comienzo de la frase hablada. Sin
// esta pausa las dos cosas se pisan y la primera sílaba se pierde.
const ALARM_TO_SPEECH_GAP_MILLISECONDS = 420;

// "A bajo volumen" es el pedido explícito. 0.22 de la escala completa se
// escucha con claridad en el escritorio sin sobresaltar.
export const DEFAULT_ALARM_PEAK_AMPLITUDE = 0.22;

type ToneSegment = {
  // `undefined` es silencio: un segmento sin frecuencia no genera muestras
  // distintas de cero, y así el silencio y las notas comparten el mismo bucle.
  readonly frequencyHz?: number;
  readonly durationMilliseconds: number;
};

// Envolvente por nota: ataque suave y caída exponencial.
//
// Existe para no producir clics. Arrancar o cortar una senoidal en una muestra
// cualquiera deja un escalón de amplitud, y ese escalón es un chasquido audible
// en el parlante. El ataque en coseno elevado entra desde cero y la caída llega
// casi a cero; el tramo final de release termina de cerrar el resto.
function computeNoteEnvelope(sampleIndex: number, totalSampleCount: number): number {
  if (totalSampleCount <= 0) {
    return 0;
  }
  const progress = sampleIndex / totalSampleCount;

  const attackSampleCount = Math.max(1, Math.floor(totalSampleCount * 0.08));
  const attack =
    sampleIndex < attackSampleCount
      ? 0.5 - 0.5 * Math.cos((Math.PI * sampleIndex) / attackSampleCount)
      : 1;

  const decay = Math.exp(-4.2 * progress);

  // El último 8% baja a cero con la misma forma de coseno. La caída exponencial
  // sola termina en ~0.015, que multiplicado por la escala de 16 bits sigue
  // siendo un salto de ~100 unidades contra el silencio que viene después.
  const releaseStartProgress = 0.92;
  const release =
    progress > releaseStartProgress
      ? 0.5 + 0.5 * Math.cos((Math.PI * (progress - releaseStartProgress)) / (1 - releaseStartProgress))
      : 1;

  return attack * decay * release;
}

function buildAlarmToneSegmentList(): readonly ToneSegment[] {
  const segmentList: ToneSegment[] = [];
  for (let repeat = 0; repeat < ALARM_PATTERN_REPEAT_COUNT; repeat++) {
    for (const frequencyHz of ALARM_NOTE_FREQUENCY_HZ_LIST) {
      segmentList.push({ frequencyHz, durationMilliseconds: ALARM_NOTE_DURATION_MILLISECONDS });
      segmentList.push({ durationMilliseconds: ALARM_NOTE_GAP_MILLISECONDS });
    }
    if (repeat < ALARM_PATTERN_REPEAT_COUNT - 1) {
      segmentList.push({ durationMilliseconds: ALARM_PATTERN_GAP_MILLISECONDS });
    }
  }
  segmentList.push({ durationMilliseconds: ALARM_TO_SPEECH_GAP_MILLISECONDS });
  return segmentList;
}

function countSamplesForMilliseconds(durationMilliseconds: number): number {
  return Math.round((durationMilliseconds / 1000) * ALARM_SAMPLE_RATE_HZ);
}

// PCM 16-bit mono little-endian, listo para `announcePcmToConnections`.
export function buildReminderAlarmPcm(
  peakAmplitude: number = DEFAULT_ALARM_PEAK_AMPLITUDE,
): ArrayBuffer {
  // Un volumen fuera de rango satura o invierte la fase; se recorta en vez de
  // confiar en quien llama.
  const clampedAmplitude = Math.min(1, Math.max(0, peakAmplitude));

  const segmentList = buildAlarmToneSegmentList();
  const totalSampleCount = segmentList.reduce(
    (runningTotal, segment) => runningTotal + countSamplesForMilliseconds(segment.durationMilliseconds),
    0,
  );

  const audioBuffer = new ArrayBuffer(totalSampleCount * 2);
  const audioView = new DataView(audioBuffer);

  let writeSampleIndex = 0;
  for (const segment of segmentList) {
    const segmentSampleCount = countSamplesForMilliseconds(segment.durationMilliseconds);
    if (segment.frequencyHz === undefined) {
      // El buffer ya viene en cero: el silencio solo avanza el cursor.
      writeSampleIndex += segmentSampleCount;
      continue;
    }
    const angularStep = (2 * Math.PI * segment.frequencyHz) / ALARM_SAMPLE_RATE_HZ;
    for (let sampleIndex = 0; sampleIndex < segmentSampleCount; sampleIndex++) {
      const envelope = computeNoteEnvelope(sampleIndex, segmentSampleCount);
      const sampleValue =
        Math.sin(angularStep * sampleIndex) * envelope * clampedAmplitude * SIXTEEN_BIT_MAXIMUM_AMPLITUDE;
      // `true` = little-endian, explícito para no depender del endianness del
      // host que corra el servidor.
      audioView.setInt16((writeSampleIndex + sampleIndex) * 2, Math.round(sampleValue), true);
    }
    writeSampleIndex += segmentSampleCount;
  }

  return audioBuffer;
}

export function concatenateAudioBuffers(
  leadingBuffer: ArrayBuffer,
  trailingBuffer: ArrayBuffer,
): ArrayBuffer {
  const combinedBuffer = new ArrayBuffer(leadingBuffer.byteLength + trailingBuffer.byteLength);
  const combinedBytes = new Uint8Array(combinedBuffer);
  combinedBytes.set(new Uint8Array(leadingBuffer), 0);
  combinedBytes.set(new Uint8Array(trailingBuffer), leadingBuffer.byteLength);
  return combinedBuffer;
}

// El Worker no expone process.env y el host de Bun sí. Mismo acceso defensivo
// que usa voice/synthesize.ts.
function readHostEnvironmentValue(name: string): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[name];
}

// Interruptor de la alarma. Viene prendida porque es lo que se pidió, pero se
// apaga sin reconstruir la imagen: REMINDER_ALARM=off vuelve al comportamiento
// anterior (recordatorio hablado, sin tono).
export function isReminderAlarmEnabled(): boolean {
  return (readHostEnvironmentValue('REMINDER_ALARM') ?? 'on') !== 'off';
}

// Volumen configurable en caliente por si 0.22 queda corto o alto en el
// escritorio. Un valor ilegible cae al default en vez de romper el anuncio.
export function resolveReminderAlarmAmplitude(): number {
  const rawValue = readHostEnvironmentValue('REMINDER_ALARM_VOLUME');
  if (rawValue === undefined) {
    return DEFAULT_ALARM_PEAK_AMPLITUDE;
  }
  const parsedValue = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0 || parsedValue > 1) {
    return DEFAULT_ALARM_PEAK_AMPLITUDE;
  }
  return parsedValue;
}
