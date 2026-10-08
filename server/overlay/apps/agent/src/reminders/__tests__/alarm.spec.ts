import { describe, expect, it } from 'bun:test';

import {
  ALARM_SAMPLE_RATE_HZ,
  buildReminderAlarmPcm,
  concatenateAudioBuffers,
  DEFAULT_ALARM_PEAK_AMPLITUDE,
} from '@/reminders/alarm';

const SIXTEEN_BIT_MAXIMUM_AMPLITUDE = 32767;

function readSampleList(audioBuffer: ArrayBuffer): number[] {
  const audioView = new DataView(audioBuffer);
  const sampleList: number[] = [];
  for (let offset = 0; offset < audioBuffer.byteLength; offset += 2) {
    sampleList.push(audioView.getInt16(offset, true));
  }
  return sampleList;
}

describe('buildReminderAlarmPcm', () => {
  it('produce PCM de 16 bits alineado a muestras enteras', () => {
    const audioBuffer = buildReminderAlarmPcm();
    expect(audioBuffer.byteLength % 2).toBe(0);
    expect(audioBuffer.byteLength).toBeGreaterThan(0);
  });

  it('dura entre 1,5 y 3 segundos: alcanza para registrarse, no tanto como para molestar', () => {
    const sampleCount = buildReminderAlarmPcm().byteLength / 2;
    const durationSeconds = sampleCount / ALARM_SAMPLE_RATE_HZ;
    expect(durationSeconds).toBeGreaterThan(1.5);
    expect(durationSeconds).toBeLessThan(3);
  });

  it('nunca supera la amplitud pedida', () => {
    const amplitude = 0.22;
    const sampleList = readSampleList(buildReminderAlarmPcm(amplitude));
    const peak = Math.max(...sampleList.map((sample) => Math.abs(sample)));
    expect(peak).toBeLessThanOrEqual(Math.ceil(amplitude * SIXTEEN_BIT_MAXIMUM_AMPLITUDE));
  });

  it('suena de verdad: el pico llega cerca del volumen pedido', () => {
    // Sin esto, un generador que devolviera silencio puro pasaría el test de
    // arriba. El pico tiene que acercarse al objetivo, no solo no pasarse.
    const amplitude = 0.22;
    const sampleList = readSampleList(buildReminderAlarmPcm(amplitude));
    const peak = Math.max(...sampleList.map((sample) => Math.abs(sample)));
    expect(peak).toBeGreaterThan(0.7 * amplitude * SIXTEEN_BIT_MAXIMUM_AMPLITUDE);
  });

  it('arranca y termina en silencio, así no chasquea el parlante', () => {
    const sampleList = readSampleList(buildReminderAlarmPcm());
    expect(Math.abs(sampleList[0] ?? 0)).toBeLessThan(50);
    expect(Math.abs(sampleList[sampleList.length - 1] ?? 0)).toBe(0);
  });

  it('no da saltos bruscos entre muestras consecutivas', () => {
    // Un clic es exactamente eso: un escalón grande de una muestra a la
    // siguiente. La cota no es arbitraria: una senoidal muestreada sube como
    // máximo 2·sin(π·f/fs) por muestra, y la nota más aguda del arpegio son
    // 1318,51 Hz a 24 kHz. Cualquier salto por encima de ese techo no lo pudo
    // haber generado el tono: es una discontinuidad entre segmentos.
    const highestNoteFrequencyHz = 1318.51;
    const maximumSlopePerSample =
      2 * Math.sin((Math.PI * highestNoteFrequencyHz) / ALARM_SAMPLE_RATE_HZ);

    const sampleList = readSampleList(buildReminderAlarmPcm(1));
    let largestJump = 0;
    for (let index = 1; index < sampleList.length; index++) {
      largestJump = Math.max(largestJump, Math.abs(sampleList[index]! - sampleList[index - 1]!));
    }
    expect(largestJump).toBeLessThanOrEqual(maximumSlopePerSample * SIXTEEN_BIT_MAXIMUM_AMPLITUDE);
  });

  it('termina con un tramo de silencio antes de que arranque el habla', () => {
    // Los últimos 420 ms son la pausa entre alarma y frase hablada.
    const sampleList = readSampleList(buildReminderAlarmPcm());
    const silenceSampleCount = Math.round(0.4 * ALARM_SAMPLE_RATE_HZ);
    const tail = sampleList.slice(-silenceSampleCount);
    expect(Math.max(...tail.map((sample) => Math.abs(sample)))).toBe(0);
  });

  it('recorta amplitudes fuera de rango en vez de saturar o invertir la fase', () => {
    const overdriven = readSampleList(buildReminderAlarmPcm(4));
    expect(Math.max(...overdriven.map((sample) => Math.abs(sample)))).toBeLessThanOrEqual(
      SIXTEEN_BIT_MAXIMUM_AMPLITUDE,
    );

    const negative = readSampleList(buildReminderAlarmPcm(-1));
    expect(Math.max(...negative.map((sample) => Math.abs(sample)))).toBe(0);
  });

  it('el volumen por defecto es bajo, como se pidió', () => {
    expect(DEFAULT_ALARM_PEAK_AMPLITUDE).toBeLessThan(0.35);
    expect(DEFAULT_ALARM_PEAK_AMPLITUDE).toBeGreaterThan(0);
  });
});

describe('concatenateAudioBuffers', () => {
  it('conserva los dos buffers, en orden y sin perder bytes', () => {
    const leading = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer;
    const trailing = new Uint8Array([4, 5]).buffer as ArrayBuffer;
    const combined = concatenateAudioBuffers(leading, trailing);
    expect(combined.byteLength).toBe(5);
    expect([...new Uint8Array(combined)]).toEqual([1, 2, 3, 4, 5]);
  });

  it('la alarma queda ADELANTE del habla', () => {
    const alarm = buildReminderAlarmPcm();
    const speech = new Uint8Array([9, 9, 9, 9]).buffer as ArrayBuffer;
    const combined = concatenateAudioBuffers(alarm, speech);
    expect(combined.byteLength).toBe(alarm.byteLength + speech.byteLength);
    const combinedBytes = new Uint8Array(combined);
    expect([...combinedBytes.slice(alarm.byteLength)]).toEqual([9, 9, 9, 9]);
  });
});
