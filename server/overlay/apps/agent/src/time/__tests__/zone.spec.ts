import { describe, expect, it } from 'bun:test';

import {
  resolveCalendarDateInTimeZone,
  resolveTimeZoneOffsetMilliseconds,
  resolveWallClockInstantMilliseconds,
} from '@/time/zone';

const HORA = 60 * 60 * 1000;
const MADRID = 'Europe/Madrid';
const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';

describe('resolveTimeZoneOffsetMilliseconds', () => {
  it('da UTC+2 para Madrid en horario de verano', () => {
    expect(resolveTimeZoneOffsetMilliseconds(MADRID, Date.parse('2026-07-15T12:00:00Z'))).toBe(2 * HORA);
  });

  it('da UTC+1 para Madrid en invierno', () => {
    expect(resolveTimeZoneOffsetMilliseconds(MADRID, Date.parse('2026-01-15T12:00:00Z'))).toBe(1 * HORA);
  });

  it('da UTC-3 para Buenos Aires todo el año', () => {
    expect(resolveTimeZoneOffsetMilliseconds(BUENOS_AIRES, Date.parse('2026-07-15T12:00:00Z'))).toBe(-3 * HORA);
    expect(resolveTimeZoneOffsetMilliseconds(BUENOS_AIRES, Date.parse('2026-01-15T12:00:00Z'))).toBe(-3 * HORA);
  });

  it('da cero para UTC', () => {
    expect(resolveTimeZoneOffsetMilliseconds('UTC', Date.parse('2026-06-01T00:00:00Z'))).toBe(0);
  });
});

describe('resolveWallClockInstantMilliseconds', () => {
  it('las 10:00 de Madrid en verano son las 08:00 UTC', () => {
    const instante = resolveWallClockInstantMilliseconds({
      timeZone: MADRID,
      date: { year: 2026, month: 7, day: 15, weekday: 3 },
      hour: 10,
      minute: 0,
    });
    expect(new Date(instante).toISOString()).toBe('2026-07-15T08:00:00.000Z');
  });

  it('acierta el día siguiente al cambio de hora', () => {
    // El horario de verano europeo termina el domingo 25/10/2026. El lunes 26
    // ya es UTC+1: las 10:00 son 09:00 UTC, no 08:00. Es el día en que un cron
    // fijo en UTC erraría por una hora.
    const instante = resolveWallClockInstantMilliseconds({
      timeZone: MADRID,
      date: { year: 2026, month: 10, day: 26, weekday: 1 },
      hour: 10,
      minute: 0,
    });
    expect(new Date(instante).toISOString()).toBe('2026-10-26T09:00:00.000Z');
  });

  it('las 09:00 de Buenos Aires son las 12:00 UTC', () => {
    const instante = resolveWallClockInstantMilliseconds({
      timeZone: BUENOS_AIRES,
      date: { year: 2026, month: 10, day: 21, weekday: 3 },
      hour: 9,
      minute: 0,
    });
    expect(new Date(instante).toISOString()).toBe('2026-10-21T12:00:00.000Z');
  });
});

describe('resolveCalendarDateInTimeZone', () => {
  it('usa el día de la zona, no el de UTC', () => {
    // 01:00 UTC del martes son las 22:00 del LUNES en Buenos Aires.
    const fecha = resolveCalendarDateInTimeZone(BUENOS_AIRES, Date.parse('2026-09-15T01:00:00Z'));
    expect(fecha).toEqual({ year: 2026, month: 9, day: 14, weekday: 1 });
  });
});
