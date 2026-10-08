import { describe, expect, it } from 'bun:test';

import {
  parseExtractedEventList,
  PREMIER_PADEL_WATCH,
  selectEventAlerts,
  type UpcomingEvent,
} from '@/events/watch';

const AHORA = Date.parse('2026-09-08T22:00:00Z');
const DIA = 24 * 3600 * 1000;

describe('parseExtractedEventList', () => {
  it('lee el JSON que devuelve el modelo', () => {
    const crudo = JSON.stringify({
      eventos: [
        { titulo: 'Rotterdam P2', comienzaIso: '2026-09-28' },
        { titulo: 'Milán P1', comienzaIso: '2026-10-12T09:00:00Z' },
      ],
    });
    const lista = parseExtractedEventList(crudo, AHORA);
    expect(lista.map((evento) => evento.title)).toEqual(['Rotterdam P2', 'Milán P1']);
  });

  it('ancla una fecha sin hora al mediodía UTC, no a medianoche', () => {
    const [evento] = parseExtractedEventList(
      JSON.stringify({ eventos: [{ titulo: 'Rotterdam P2', comienzaIso: '2026-09-28' }] }),
      AHORA,
    );
    expect(new Date(evento!.startsAtMilliseconds).toISOString()).toBe('2026-09-28T12:00:00.000Z');
  });

  it('DESCARTA eventos pasados aunque el modelo los devuelva', () => {
    // Es el modo de falla medido: preguntando por el calendario de Premier
    // Padel, la respuesta incluyó Madrid del 1 al 6 de septiembre, ya jugado.
    const lista = parseExtractedEventList(
      JSON.stringify({
        eventos: [
          { titulo: 'Madrid P1', comienzaIso: '2026-09-01' },
          { titulo: 'Rotterdam P2', comienzaIso: '2026-09-28' },
        ],
      }),
      AHORA,
    );
    expect(lista.map((evento) => evento.title)).toEqual(['Rotterdam P2']);
  });

  it('descarta fechas absurdamente lejanas', () => {
    expect(
      parseExtractedEventList(
        JSON.stringify({ eventos: [{ titulo: 'Torneo', comienzaIso: '2099-01-01' }] }),
        AHORA,
      ),
    ).toEqual([]);
  });

  it('aguanta la cerca de ```json que el modelo pone igual', () => {
    const crudo = '```json\n{"eventos":[{"titulo":"Rotterdam P2","comienzaIso":"2026-09-28"}]}\n```';
    expect(parseExtractedEventList(crudo, AHORA)).toHaveLength(1);
  });

  it('devuelve vacío ante basura en vez de tirar', () => {
    for (const crudo of ['no soy json', '{}', '{"eventos":"no es lista"}', '']) {
      expect(parseExtractedEventList(crudo, AHORA)).toEqual([]);
    }
  });

  it('omite eventos sin título o sin fecha parseable', () => {
    const lista = parseExtractedEventList(
      JSON.stringify({
        eventos: [
          { titulo: '', comienzaIso: '2026-09-28' },
          { titulo: 'Sin fecha', comienzaIso: 'la semana que viene' },
          { titulo: 'Bueno', comienzaIso: '2026-09-28' },
        ],
      }),
      AHORA,
    );
    expect(lista.map((evento) => evento.title)).toEqual(['Bueno']);
  });

  it('ordena por fecha', () => {
    const lista = parseExtractedEventList(
      JSON.stringify({
        eventos: [
          { titulo: 'Después', comienzaIso: '2026-10-12' },
          { titulo: 'Antes', comienzaIso: '2026-09-28' },
        ],
      }),
      AHORA,
    );
    expect(lista.map((evento) => evento.title)).toEqual(['Antes', 'Después']);
  });
});

describe('selectEventAlerts', () => {
  const torneo: UpcomingEvent = {
    title: 'Rotterdam P2',
    startsAtMilliseconds: Date.parse('2026-09-28T12:00:00Z'),
  };
  const base = {
    eventList: [torneo],
    leadHours: PREMIER_PADEL_WATCH.leadHours,
    leadLabel: PREMIER_PADEL_WATCH.leadLabel,
    horizonDays: PREMIER_PADEL_WATCH.horizonDays,
    alreadyScheduledMessageList: [],
  };

  it('avisa un día antes', () => {
    const [alerta] = selectEventAlerts({
      ...base,
      nowMilliseconds: Date.parse('2026-09-25T12:00:00Z'),
    });
    // Aviso el 27 a las 12:00, o sea 2 días después del 25.
    expect(alerta!.delaySeconds).toBe((2 * DIA) / 1000);
    expect(alerta!.message).toBe('Rotterdam P2 empieza mañana.');
  });

  it('no avisa si el momento del aviso ya pasó', () => {
    expect(
      selectEventAlerts({ ...base, nowMilliseconds: Date.parse('2026-09-27T18:00:00Z') }),
    ).toEqual([]);
  });

  it('no mira más allá del horizonte', () => {
    expect(
      selectEventAlerts({ ...base, nowMilliseconds: Date.parse('2026-09-01T12:00:00Z') }),
    ).toEqual([]);
  });

  it('no duplica un aviso ya programado', () => {
    expect(
      selectEventAlerts({
        ...base,
        nowMilliseconds: Date.parse('2026-09-25T12:00:00Z'),
        alreadyScheduledMessageList: ['Rotterdam P2 empieza mañana.'],
      }),
    ).toEqual([]);
  });
});
