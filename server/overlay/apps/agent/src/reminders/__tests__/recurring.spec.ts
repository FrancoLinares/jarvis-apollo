import { describe, expect, it } from 'bun:test';

import { buildUtcCronFromLocal, describeRecurrence, parseLocalTime } from '@/reminders/recurring';

const BUENOS_AIRES = -180;

describe('recurring reminders', () => {
  it('turns Buenos Aires time into a UTC cron', () => {
    expect(
      buildUtcCronFromLocal({ hour: 11, minute: 30, weekdayList: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'], offsetMinutes: BUENOS_AIRES }),
    ).toBe('30 14 * * 1,2,3,4,5');
  });

  it('moves the days forward when the UTC time crosses midnight', () => {
    // 22:15 del viernes y del domingo en Buenos Aires = 01:15 del sábado y del
    // lunes en UTC.
    expect(
      buildUtcCronFromLocal({ hour: 22, minute: 15, weekdayList: ['viernes', 'domingo'], offsetMinutes: BUENOS_AIRES }),
    ).toBe('15 1 * * 1,6');
  });

  it('uses * for every day', () => {
    expect(
      buildUtcCronFromLocal({
        hour: 19,
        minute: 30,
        weekdayList: ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
        offsetMinutes: BUENOS_AIRES,
      }),
    ).toBe('30 22 * * *');
  });

  it('describes the recurrence the way it is said', () => {
    expect(describeRecurrence(['lunes', 'martes', 'miercoles', 'jueves', 'viernes'], 11, 30)).toBe('de lunes a viernes a las 11:30');
    expect(describeRecurrence(['sabado', 'miercoles'], 9, 5)).toBe('los miércoles, sábado a las 09:05');
    expect(describeRecurrence(['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'], 19, 30)).toBe('todos los días a las 19:30');
  });

  it('parses HH:MM and rejects nonsense', () => {
    expect(parseLocalTime('7:05')).toEqual({ hour: 7, minute: 5 });
    expect(parseLocalTime('25:00')).toBeUndefined();
    expect(parseLocalTime('siete')).toBeUndefined();
  });
});

describe('monthly recurring reminders', () => {
  it('fires on the same day of every month', () => {
    const { buildUtcMonthlyCronFromLocal, describeMonthlyRecurrence } = require('@/reminders/recurring');
    expect(buildUtcMonthlyCronFromLocal({ hour: 10, minute: 0, monthDay: 4, offsetMinutes: -180 })).toBe('0 13 4 * *');
    expect(buildUtcMonthlyCronFromLocal({ hour: 22, minute: 30, monthDay: 14, offsetMinutes: -180 })).toBe('30 1 15 * *');
    expect(buildUtcMonthlyCronFromLocal({ hour: 22, minute: 30, monthDay: 28, offsetMinutes: -180 })).toBeUndefined();
    expect(describeMonthlyRecurrence(5, 9, 0)).toBe('todos los 5 de cada mes a las 09:00');
  });
});

describe('duplicate recurring reminders', () => {
  it('treats the same schedule with the same or a shorter message as one reminder', () => {
    const { isSameRecurringReminder } = require('@/reminders/recurring');
    const original = { cron: '53 19 * * 1,2,3,4,5', message: 'Sacá la basura, hoy pasa el camión' };
    expect(isSameRecurringReminder(original, { cron: original.cron, message: 'Sacá la basura' })).toBe(true);
    expect(isSameRecurringReminder(original, { cron: '0 13 4 * *', message: 'Sacá la basura' })).toBe(false);
    expect(isSameRecurringReminder({ cron: '0 13 4 * *', message: 'Mañana vence el alquiler' }, { cron: '0 13 4 * *', message: 'Mañana vence la prepaga' })).toBe(false);
  });
});
