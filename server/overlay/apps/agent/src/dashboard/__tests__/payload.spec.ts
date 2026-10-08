import { describe, expect, it } from 'bun:test';

import {
  buildDashboardPayload,
  clipDashboardText,
  isSameDashboardPayload,
} from '@/dashboard/payload';

const NOW = Date.UTC(2026, 8, 6, 15, 0, 0);

describe('clipDashboardText', () => {
  it('deja pasar lo que entra', () => {
    expect(clipDashboardText('  pan   integral ', 34)).toBe('pan integral');
  });

  it('corta en la última palabra entera', () => {
    expect(clipDashboardText('Revisar qué refleja el localhost del tablero', 24))
      .toBe('Revisar qué refleja el…');
  });

  it('recorta a lo que entra en la columna de 288px', () => {
    // Los ítems son notas libres; en la placa entran unos 24 caracteres.
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      pending: {
        listName: 'super',
        count: 1,
        itemList: ['Mejorar la UI, la pantalla esta se maneja usando HTML?'],
      },
    });
    expect(payload.pending?.itemList[0]?.length).toBeLessThanOrEqual(25);
  });

  it('con una palabra larguísima corta al medio antes que dejarla sola', () => {
    expect(clipDashboardText('a ' + 'b'.repeat(40), 10)).toBe('a bbbbbbbb…');
  });
});

describe('buildDashboardPayload', () => {
  it('mezcla calendario y recordatorios en una agenda ordenada por hora', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      reminderList: [{ text: 'Llamar al gasista', dueAtMilliseconds: NOW + 120 * 60_000 }],
      calendarEventList: [
        { title: 'Reunión con Juan', startsAtMilliseconds: NOW + 40 * 60_000 },
      ],
    });
    expect(payload.agendaList).toEqual([
      { title: 'Reunión con Juan', whenLabel: 'en 40 minutos' },
      { title: 'Llamar al gasista', whenLabel: 'en 2 horas' },
    ]);
  });

  it('no muestra en la agenda lo que ya pasó', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      reminderList: [{ text: 'Ya sonó', dueAtMilliseconds: NOW - 60_000 }],
    });
    expect(payload.agendaList).toEqual([]);
  });

  it('la agenda no pasa de dos entradas', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      reminderList: [
        { text: 'uno', dueAtMilliseconds: NOW + 60_000 },
        { text: 'dos', dueAtMilliseconds: NOW + 120_000 },
        { text: 'tres', dueAtMilliseconds: NOW + 180_000 },
      ],
    });
    expect((payload.agendaList ?? []).map((entry) => entry.title)).toEqual(['uno', 'dos']);
  });

  it('recorta los pendientes a cuatro y les guarda el total real', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      pending: {
        listName: 'super',
        count: 7,
        itemList: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      },
    });
    expect(payload.pending?.count).toBe(7);
    expect(payload.pending?.itemList).toEqual(['a', 'b', 'c', 'd']);
  });

  it('una lista vacía no manda tarjeta', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      pending: { listName: 'super', count: 0, itemList: [] },
    });
    expect(payload.pending).toBeUndefined();
  });

  it('saltea el clima cuando el proveedor no respondió', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      weather: {
        temperatureC: 0,
        conditionLabel: 'Sin datos',
        locationLabel: 'CABA',
        updatedAt: '2026-09-06T15:00:00.000Z',
      },
    });
    expect(payload.weather).toBeUndefined();
  });

  it('redondea los minutos de viaje, que son un dato nuevo y entero por naturaleza', () => {
    const payload = buildDashboardPayload({
      nowMilliseconds: NOW,
      travel: { destinationLabel: 'Al centro', minutes: 23.6 },
    });
    expect(payload.travel?.minutes).toBe(24);
  });

  it('el clima viaja sin tocar: cuántos decimales mostrar lo decide la pantalla', () => {
    const snapshot = {
      temperatureC: 8.4,
      conditionLabel: 'Nublado',
      locationLabel: 'Chacarita',
      updatedAt: '2026-09-06T15:00:00.000Z',
    };
    const payload = buildDashboardPayload({ nowMilliseconds: NOW, weather: snapshot });
    expect(payload.weather).toEqual(snapshot);
  });

  it('sin ningún dato manda un tablero vacío, no rompe', () => {
    const payload = buildDashboardPayload({ nowMilliseconds: NOW });
    expect(payload).toEqual({ type: 'dashboard', agendaList: [] });
  });
});

describe('isSameDashboardPayload', () => {
  it('reconoce dos tableros iguales', () => {
    const source = {
      nowMilliseconds: NOW,
      weather: {
        temperatureC: 8,
        conditionLabel: 'Nublado',
        locationLabel: 'Chacarita',
        updatedAt: '2026-09-06T15:00:00.000Z',
      },
    };
    expect(
      isSameDashboardPayload(buildDashboardPayload(source), buildDashboardPayload(source)),
    ).toBe(true);
  });

  it('detecta que cambió un dato', () => {
    const base = {
      conditionLabel: 'Nublado',
      locationLabel: 'Chacarita',
      updatedAt: '2026-09-06T15:00:00.000Z',
    };
    const before = buildDashboardPayload({
      nowMilliseconds: NOW,
      weather: { ...base, temperatureC: 8 },
    });
    const after = buildDashboardPayload({
      nowMilliseconds: NOW,
      weather: { ...base, temperatureC: 9 },
    });
    expect(isSameDashboardPayload(before, after)).toBe(false);
  });
});
