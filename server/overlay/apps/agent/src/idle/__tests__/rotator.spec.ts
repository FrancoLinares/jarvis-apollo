import { describe, expect, it } from 'bun:test';

import {
  buildIdleCaptionList,
  formatTimeUntil,
  selectIdleCaption,
  truncateNoteContent,
} from '@/idle/rotator';

const NOW = Date.UTC(2026, 8, 6, 15, 0, 0);

describe('formatTimeUntil', () => {
  it('habla en minutos, horas y días según la distancia', () => {
    expect(formatTimeUntil(NOW + 30_000, NOW)).toBe('en menos de un minuto');
    expect(formatTimeUntil(NOW + 60_000, NOW)).toBe('en 1 minuto');
    expect(formatTimeUntil(NOW + 20 * 60_000, NOW)).toBe('en 20 minutos');
    expect(formatTimeUntil(NOW + 3 * 3_600_000, NOW)).toBe('en 3 horas');
    expect(formatTimeUntil(NOW + 24 * 3_600_000, NOW)).toBe('mañana');
    expect(formatTimeUntil(NOW + 3 * 24 * 3_600_000, NOW)).toBe('en 3 días');
  });

  it('un recordatorio vencido dice "ahora", no un número negativo', () => {
    expect(formatTimeUntil(NOW - 5_000, NOW)).toBe('ahora');
  });
});

describe('truncateNoteContent', () => {
  it('deja pasar una nota corta tal cual', () => {
    expect(truncateNoteContent('  el molde  está  en el altillo ')).toBe(
      'el molde está en el altillo',
    );
  });

  it('corta una nota larga en la última palabra entera', () => {
    const long =
      'acordate de que el molde de tarta quedó guardado en la caja de arriba del altillo';
    const result = truncateNoteContent(long);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(53);
    expect(long.startsWith(result.slice(0, -1))).toBe(true);
  });
});

describe('buildIdleCaptionList', () => {
  it('arma un cartel por dato disponible, de lo más perecedero a lo más estable', () => {
    expect(
      buildIdleCaptionList({
        nowMilliseconds: NOW,
        nextCalendarEvent: {
          title: 'Reunión con Juan',
          startsAtMilliseconds: NOW + 40 * 60_000,
        },
        nextReminder: { text: 'Llamar al dentista', dueAtMilliseconds: NOW + 20 * 60_000 },
        travelTime: { destinationLabel: 'Al centro', minutes: 23.6 },
        weather: { locationLabel: 'CABA', temperatureC: 21.4, conditionLabel: 'Despejado' },
        pendingList: { listName: 'super', count: 3 },
        lastNote: { content: 'el molde de tarta está en el altillo' },
      }),
    ).toEqual([
      'Agenda: Reunión con Juan · en 40 minutos',
      'Recordar: Llamar al dentista · en 20 minutos',
      'Al centro: 24 min',
      '21° · Despejado',
      '3 pendientes en super',
      '“el molde de tarta está en el altillo”',
    ]);
  });

  it('el singular de la lista está bien conjugado', () => {
    expect(
      buildIdleCaptionList({
        nowMilliseconds: NOW,
        pendingList: { listName: 'super', count: 1 },
      }),
    ).toEqual(['1 pendiente en super']);
  });

  it('una lista vacía no es noticia', () => {
    expect(
      buildIdleCaptionList({
        nowMilliseconds: NOW,
        pendingList: { listName: 'super', count: 0 },
      }),
    ).toEqual([]);
  });

  it('saltea el clima cuando el proveedor no respondió', () => {
    // "Sin datos" es lo que devuelve el cache ante un fallo: mostrarlo sería
    // peor que no mostrar nada.
    expect(
      buildIdleCaptionList({
        nowMilliseconds: NOW,
        weather: { locationLabel: 'CABA', temperatureC: 0, conditionLabel: 'Sin datos' },
      }),
    ).toEqual([]);
  });

  it('una fuente todavía sin cablear no deja hueco en el ciclo', () => {
    // Es la garantía que permite ir conectando las fuentes de a una.
    expect(
      buildIdleCaptionList({
        nowMilliseconds: NOW,
        weather: { locationLabel: 'CABA', temperatureC: 10, conditionLabel: 'Nublado' },
        pendingList: { listName: 'super', count: 2 },
      }),
    ).toEqual(['10° · Nublado', '2 pendientes en super']);
  });

  it('sin ningún dato devuelve una lista vacía', () => {
    expect(buildIdleCaptionList({ nowMilliseconds: NOW })).toEqual([]);
  });
});

describe('selectIdleCaption', () => {
  it('rota en orden y vuelve a empezar', () => {
    const list = ['a', 'b', 'c'];
    expect([0, 1, 2, 3, 4].map((i) => selectIdleCaption(list, i))).toEqual([
      'a', 'b', 'c', 'a', 'b',
    ]);
  });

  it('tolera índices que quedaron viejos al cambiar la lista', () => {
    // La lista se rearma en cada vuelta: si desaparece un dato, el índice
    // acumulado no debe salirse del rango ni devolver undefined.
    expect(selectIdleCaption(['a'], 7)).toBe('a');
    expect(selectIdleCaption([], 3)).toBeUndefined();
  });
});
