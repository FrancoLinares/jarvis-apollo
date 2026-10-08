import { describe, expect, it } from 'bun:test';

import { classifyUnbackedReply, looksLikeUnbackedClaim } from '@/turn/claims';

const base = { intentId: 'recordatorio', userText: 'recordame mañana', executedToolNameList: [] as string[] };

describe('looksLikeUnbackedClaim', () => {
  it('catches a confirmed reminder that was never scheduled (the work reminder case)', () => {
    expect(
      looksLikeUnbackedClaim({
        ...base,
        replyText: 'No problem. Mañana lunes 28 a las 19 te aviso lo de la reunión con el contador.',
      }),
    ).toBe(true);
    expect(looksLikeUnbackedClaim({ ...base, replyText: 'Listo, programado.' })).toBe(true);
  });

  it('lets a real confirmation through', () => {
    expect(
      looksLikeUnbackedClaim({ ...base, replyText: 'Listo, te aviso.', executedToolNameList: ['set_reminder'] }),
    ).toBe(false);
  });

  it('lets questions and refusals through', () => {
    expect(looksLikeUnbackedClaim({ ...base, replyText: '¿7 u 8? Decime una y lo dejo fijo.' })).toBe(false);
    expect(looksLikeUnbackedClaim({ ...base, replyText: 'No puedo hacer eso todavía.' })).toBe(false);
  });

  it('ignores turns that are not action requests', () => {
    expect(looksLikeUnbackedClaim({ ...base, intentId: 'charla', replyText: 'Listo, ya está.' })).toBe(false);
  });

  it('falls back to the user text when there was no intent', () => {
    expect(
      looksLikeUnbackedClaim({ ...base, intentId: undefined, userText: 'avisame a las 5', replyText: 'Listo, te aviso.' }),
    ).toBe(true);
    expect(
      looksLikeUnbackedClaim({ ...base, intentId: undefined, userText: 'contame un chiste', replyText: 'Listo, ahí va.' }),
    ).toBe(false);
  });

  it('catches a promise to repeat backed by a one-off reminder (the daily reminder case)', () => {
    const replyText = 'Listo. Te aviso hoy a las 19:30 y de ahí en adelante todos los días.';
    expect(looksLikeUnbackedClaim({ ...base, replyText, executedToolNameList: ['set_reminder'] })).toBe(true);
    expect(
      looksLikeUnbackedClaim({ ...base, replyText, executedToolNameList: ['set_recurring_reminder'] }),
    ).toBe(false);
  });
});

describe('classifyUnbackedReply', () => {
  it('does not let an invented answer hide behind a closing offer', () => {
    expect(
      classifyUnbackedReply({
        intentId: 'agenda_leer',
        userText: 'y del 16 al 20?',
        replyText:
          'Del 16 al 20 tenés el congreso. Después de esa fecha no hay nada cargado. ¿Querés que revise de nuevo o te cargue algo?',
        executedToolNameList: [],
      }),
    ).toBe('dato');
    expect(
      looksLikeUnbackedClaim({
        intentId: 'recordatorio',
        userText: 'recordame',
        replyText: 'Listo, te aviso a las 7. ¿Algo más?',
        executedToolNameList: [],
      }),
    ).toBe(true);
  });

  it('flags a calendar answer given without looking (the 19-25 October case)', () => {
    expect(
      classifyUnbackedReply({
        intentId: 'agenda_leer',
        userText: '¿qué tengo entre el 19 y el 25 de octubre?',
        replyText: 'Che, entre el 19 y el 25 de octubre no tenés nada cargado.',
        executedToolNameList: [],
      }),
    ).toBe('dato');
  });

  it('accepts a calendar answer backed by a lookup, or a clarifying question', () => {
    const base = { intentId: 'agenda_leer', userText: 'agenda', replyText: 'Tenés una sola cosa.' };
    expect(classifyUnbackedReply({ ...base, executedToolNameList: ['mcp_x_list_events_1'] })).toBeUndefined();
    expect(classifyUnbackedReply({ ...base, replyText: '¿De qué semana?', executedToolNameList: [] })).toBeUndefined();
  });

  it('keeps flagging unbacked actions', () => {
    expect(
      classifyUnbackedReply({ intentId: 'recordatorio', userText: 'recordame', replyText: 'Listo.', executedToolNameList: [] }),
    ).toBe('accion');
  });
});
