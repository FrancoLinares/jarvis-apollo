import { describe, expect, it } from 'bun:test';

import {
  buildDepartureAlertMessage,
  buildDistanceMatrixUrl,
  computeDeparturePlan,
  computeRecomputeDelaySeconds,
  DEPARTURE_ALERT_BUFFER_MINUTES,
  describeMinutes,
  formatBuenosAiresClockTime,
  parseDistanceMatrixTravelSeconds,
  planAndScheduleDepartureAlert,
  shouldRecomputeBeforeDeparture,
} from '@/travel/departure';

const MINUTO = 60 * 1000;

describe('buildDistanceMatrixUrl', () => {
  it('pide tráfico para la hora de salida', () => {
    const salida = Math.floor(Date.now() / 1000) + 3600;
    const url = new URL(
      buildDistanceMatrixUrl({
        origin: 'Calle Falsa 123, CABA',
        destination: 'Obelisco',
        apiKey: 'k',
        departureEpochSeconds: salida,
      }),
    );
    expect(url.searchParams.get('departure_time')).toBe(String(salida));
    expect(url.searchParams.get('traffic_model')).toBe('best_guess');
    expect(url.searchParams.get('mode')).toBe('driving');
  });

  it('nunca pide una hora de salida en el pasado: Google la rechaza', () => {
    const url = new URL(
      buildDistanceMatrixUrl({
        origin: 'a',
        destination: 'b',
        apiKey: 'k',
        departureEpochSeconds: 1000, // 1970
      }),
    );
    const pedida = Number(url.searchParams.get('departure_time'));
    expect(pedida).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
  });
});

describe('parseDistanceMatrixTravelSeconds', () => {
  const conTrafico = {
    status: 'OK',
    rows: [{ elements: [{ status: 'OK', duration: { value: 1260 }, duration_in_traffic: { value: 1380 } }] }],
  };

  it('prefiere el tiempo CON tráfico sobre el típico', () => {
    expect(parseDistanceMatrixTravelSeconds(conTrafico)).toEqual({
      travelSeconds: 1380,
      usedTrafficModel: true,
    });
  });

  it('cae al tiempo típico y lo marca, si no vino el de tráfico', () => {
    const sinTrafico = { status: 'OK', rows: [{ elements: [{ status: 'OK', duration: { value: 1260 } }] }] };
    expect(parseDistanceMatrixTravelSeconds(sinTrafico)).toEqual({
      travelSeconds: 1260,
      usedTrafficModel: false,
    });
  });

  it('devuelve undefined cuando Google no encuentra la dirección', () => {
    // Google responde 200 con NOT_FOUND adentro: si no se mira el status del
    // elemento, el viaje sale con duración indefinida.
    const noEncontrada = { status: 'OK', rows: [{ elements: [{ status: 'NOT_FOUND' }] }] };
    expect(parseDistanceMatrixTravelSeconds(noEncontrada)).toBeUndefined();
    expect(parseDistanceMatrixTravelSeconds({ status: 'REQUEST_DENIED' })).toBeUndefined();
    expect(parseDistanceMatrixTravelSeconds({})).toBeUndefined();
    expect(parseDistanceMatrixTravelSeconds(null)).toBeUndefined();
  });
});

describe('computeDeparturePlan', () => {
  const llegada = Date.parse('2026-09-27T18:00:00-03:00');

  it('la salida es la llegada menos el viaje, y el aviso llega antes', () => {
    const plan = computeDeparturePlan({
      arrivalMilliseconds: llegada,
      travelSeconds: 23 * 60,
      nowMilliseconds: Date.parse('2026-09-27T10:00:00-03:00'),
    });
    expect(new Date(plan.departureMilliseconds).toISOString()).toBe('2026-09-27T20:37:00.000Z');
    // 17:37 menos 7 minutos de aviso = 17:30 hora Argentina.
    expect(new Date(plan.alertMilliseconds).toISOString()).toBe('2026-09-27T20:30:00.000Z');
    expect(plan.isAlreadyLate).toBe(false);
  });

  it('marca que ya es tarde cuando el viaje no entra', () => {
    const plan = computeDeparturePlan({
      arrivalMilliseconds: llegada,
      travelSeconds: 40 * 60,
      nowMilliseconds: Date.parse('2026-09-27T17:50:00-03:00'),
    });
    expect(plan.isAlreadyLate).toBe(true);
  });

  it('nunca programa un aviso con delay negativo', () => {
    const plan = computeDeparturePlan({
      arrivalMilliseconds: llegada,
      travelSeconds: 30 * 60,
      nowMilliseconds: Date.parse('2026-09-27T17:59:00-03:00'),
    });
    expect(plan.alertDelaySeconds).toBeGreaterThan(0);
  });
});

describe('shouldRecomputeBeforeDeparture', () => {
  const salida = Date.parse('2026-09-27T17:37:00-03:00');

  it('recalcula si falta más de una hora para salir', () => {
    expect(
      shouldRecomputeBeforeDeparture({
        departureMilliseconds: salida,
        nowMilliseconds: salida - 180 * MINUTO,
      }),
    ).toBe(true);
  });

  it('no recalcula si ya está cerca: el dato de ahora ya sirve', () => {
    expect(
      shouldRecomputeBeforeDeparture({
        departureMilliseconds: salida,
        nowMilliseconds: salida - 30 * MINUTO,
      }),
    ).toBe(false);
  });

  it('el recálculo queda una hora antes de la salida', () => {
    const ahora = salida - 180 * MINUTO;
    const delay = computeRecomputeDelaySeconds({ departureMilliseconds: salida, nowMilliseconds: ahora });
    expect(delay).toBe(120 * 60);
  });
});

describe('formatBuenosAiresClockTime', () => {
  it('usa hora de Buenos Aires en formato 24 horas', () => {
    // 21:00 UTC son las 18:00 en Buenos Aires. Si saliera "06:00" estaria
    // usando 12 horas sin marcador, que es el bug de ICU que ya nos mordio.
    expect(formatBuenosAiresClockTime(Date.parse('2026-09-27T21:00:00Z'))).toBe('18:00');
  });
});

describe('describeMinutes', () => {
  it('redondea a minutos y usa singular cuando corresponde', () => {
    expect(describeMinutes(1380)).toBe('23 minutos');
    expect(describeMinutes(50)).toBe('1 minuto');
    expect(describeMinutes(0)).toBe('1 minuto');
  });
});

describe('buildDepartureAlertMessage', () => {
  const llegada = Date.parse('2026-09-27T18:00:00-03:00');

  it('dice cuándo salir, cuánto dura el viaje y a qué hora llega', () => {
    expect(
      buildDepartureAlertMessage({
        placeLabel: 'el dentista',
        arrivalMilliseconds: llegada,
        travelSeconds: 23 * 60,
        usedTrafficModel: true,
        isAlreadyLate: false,
      }),
    ).toBe(
      `En ${DEPARTURE_ALERT_BUFFER_MINUTES} minutos salí hacia el dentista. El viaje está en 23 minutos y llegás a las 18:00.`,
    );
  });

  it('cambia el texto si ya es tarde', () => {
    const texto = buildDepartureAlertMessage({
      placeLabel: 'el dentista',
      arrivalMilliseconds: llegada,
      travelSeconds: 40 * 60,
      usedTrafficModel: true,
      isAlreadyLate: true,
    });
    expect(texto).toContain('Salí ya');
    expect(texto).not.toContain('llegás a las');
  });

  it('avisa cuando el número no tiene tráfico: merece menos confianza', () => {
    const texto = buildDepartureAlertMessage({
      placeLabel: 'el dentista',
      arrivalMilliseconds: llegada,
      travelSeconds: 23 * 60,
      usedTrafficModel: false,
      isAlreadyLate: false,
    });
    expect(texto).toContain('sin datos de tráfico');
  });
});

describe('planAndScheduleDepartureAlert', () => {
  const LLEGADA = Date.parse('2026-09-27T18:00:00-03:00');

  function respuestaGoogle(segundos: number, conTrafico = true) {
    const elemento: Record<string, unknown> = { status: 'OK', duration: { value: segundos } };
    if (conTrafico) {
      elemento.duration_in_traffic = { value: segundos };
    }
    return {
      ok: true,
      json: async () => ({ status: 'OK', rows: [{ elements: [elemento] }] }),
    } as unknown as Response;
  }

  function armarEntorno(respuesta: () => Response) {
    process.env.IDLE_TRAVEL_ORIGIN = 'Calle Falsa 123, CABA, Argentina';
    process.env.GOOGLE_MAPS_API_KEY = 'clave-de-prueba';
    const agendado: { delaySeconds: number; callback: string; payload: Record<string, unknown> }[] = [];
    return {
      agendado,
      schedule: async (delaySeconds: number, callback: string, payload: Record<string, unknown>) => {
        agendado.push({ delaySeconds, callback, payload });
      },
      listScheduledReminderMessages: async () => [] as readonly string[],
      fetchImplementation: (async () => respuesta()) as unknown as typeof fetch,
    };
  }

  it('si falta mucho, agenda un RECÁLCULO en vez de fijar el aviso', async () => {
    const entorno = armarEntorno(() => respuestaGoogle(23 * 60));
    const r = await planAndScheduleDepartureAlert({
      placeLabel: 'el dentista',
      destination: 'Plaza de Mayo, CABA',
      arrivalMilliseconds: LLEGADA,
      nowMilliseconds: Date.parse('2026-09-27T10:00:00-03:00'),
      ...entorno,
    });
    expect(r.ok).toBe(true);
    expect(entorno.agendado).toHaveLength(1);
    expect(entorno.agendado[0]!.callback).toBe('recomputeDeparture');
    // Salida 17:37, recálculo una hora antes = 16:37, o sea 6h37 después de las 10.
    expect(entorno.agendado[0]!.delaySeconds).toBe(397 * 60);
  });

  it('si ya está cerca, agenda el aviso definitivo', async () => {
    const entorno = armarEntorno(() => respuestaGoogle(23 * 60));
    const r = await planAndScheduleDepartureAlert({
      placeLabel: 'el dentista',
      destination: 'Plaza de Mayo, CABA',
      arrivalMilliseconds: LLEGADA,
      nowMilliseconds: Date.parse('2026-09-27T17:00:00-03:00'),
      ...entorno,
    });
    expect(r.ok).toBe(true);
    expect(entorno.agendado).toHaveLength(1);
    expect(entorno.agendado[0]!.callback).toBe('deliverReminder');
    expect(String(entorno.agendado[0]!.payload.message)).toContain('salí hacia el dentista');
  });

  it('el recálculo nunca vuelve a posponerse: agenda el aviso sí o sí', async () => {
    const entorno = armarEntorno(() => respuestaGoogle(23 * 60));
    await planAndScheduleDepartureAlert({
      placeLabel: 'el dentista',
      destination: 'x',
      arrivalMilliseconds: LLEGADA,
      nowMilliseconds: Date.parse('2026-09-27T10:00:00-03:00'),
      isRecompute: true,
      ...entorno,
    });
    expect(entorno.agendado[0]!.callback).toBe('deliverReminder');
  });

  it('no duplica el aviso si ya está en la cola', async () => {
    const entorno = armarEntorno(() => respuestaGoogle(23 * 60));
    const mensaje = buildDepartureAlertMessage({
      placeLabel: 'el dentista',
      arrivalMilliseconds: LLEGADA,
      travelSeconds: 23 * 60,
      usedTrafficModel: true,
      isAlreadyLate: false,
    });
    const r = await planAndScheduleDepartureAlert({
      placeLabel: 'el dentista',
      destination: 'x',
      arrivalMilliseconds: LLEGADA,
      nowMilliseconds: Date.parse('2026-09-27T17:00:00-03:00'),
      ...entorno,
      listScheduledReminderMessages: async () => [mensaje],
    });
    expect(r.ok).toBe(true);
    expect(entorno.agendado).toHaveLength(0);
  });

  it('avisa que ya es tarde cuando el viaje no entra', async () => {
    const entorno = armarEntorno(() => respuestaGoogle(40 * 60));
    const r = await planAndScheduleDepartureAlert({
      placeLabel: 'el dentista',
      destination: 'x',
      arrivalMilliseconds: LLEGADA,
      nowMilliseconds: Date.parse('2026-09-27T17:50:00-03:00'),
      ...entorno,
    });
    expect(r.summary).toContain('ya tendrías que estar saliendo');
  });

  it('no inventa un viaje si Google no responde bien', async () => {
    const entorno = armarEntorno(() => ({ ok: false } as unknown as Response));
    const r = await planAndScheduleDepartureAlert({
      placeLabel: 'el dentista',
      destination: 'x',
      arrivalMilliseconds: LLEGADA,
      nowMilliseconds: Date.parse('2026-09-27T10:00:00-03:00'),
      ...entorno,
    });
    expect(r.ok).toBe(false);
    expect(entorno.agendado).toHaveLength(0);
  });

  it('rechaza una hora que ya pasó', async () => {
    const entorno = armarEntorno(() => respuestaGoogle(23 * 60));
    const r = await planAndScheduleDepartureAlert({
      placeLabel: 'x',
      destination: 'x',
      arrivalMilliseconds: Date.parse('2026-09-27T09:00:00-03:00'),
      nowMilliseconds: Date.parse('2026-09-27T10:00:00-03:00'),
      ...entorno,
    });
    expect(r.ok).toBe(false);
    expect(entorno.agendado).toHaveLength(0);
  });
});
