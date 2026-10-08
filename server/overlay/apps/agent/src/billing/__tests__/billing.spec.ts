import { describe, expect, it } from 'bun:test';

import { extractBillingItems, parseBillingExtraction } from '@/billing/extract';
import { BILLING_SUBJECT_PATTERN, htmlToPlainText } from '@/billing/mail';
import { planBillingAlerts } from '@/billing/plan';

describe('billing mails', () => {
  it('matches the real subjects and ignores the rest', () => {
    for (const subject of [
      'Tus servicios están por vencer',
      'Este es el aviso de vencimiento de tu Tarjeta de Crédito',
      'Tu resumen vence pronto',
      'Your annual plan renews on October 7, 2026',
      'IMPORTANTE - Aviso de baja por falta de pago',
      'INTIMACIÓN DE PAGO - PREPAGA',
    ]) {
      expect(BILLING_SUBJECT_PATTERN.test(subject)).toBe(true);
    }
    for (const subject of ['Compra aprobada', '¡Tu tarjeta fue entregada!', 'Introducing Grok 4.7']) {
      expect(BILLING_SUBJECT_PATTERN.test(subject)).toBe(false);
    }
  });

  it('turns a bank HTML mail into readable text', () => {
    const text = htmlToPlainText(
      '<style>.x{}</style><p>Te recordamos que tus servicios est&aacute;n por vencer:</p><td>Expensas del edificio</td><td>21/09/2026</td><td>$12.345,67</td>&zwnj;',
    );
    expect(text).toContain('servicios están por vencer');
    expect(text).toContain('Expensas del edificio');
    expect(text).not.toContain('&');
  });

  it('parses the model answer, even wrapped in prose', () => {
    expect(
      parseBillingExtraction('Claro: {"items":[{"concepto":"Expensas","vence":"2026-10-21","monto":"$ 12.345,67"}]}'),
    ).toEqual([{ concepto: 'Expensas', vence: '2026-10-21', monto: '$ 12.345,67', urgente: false }]);
    expect(parseBillingExtraction('no sé')).toEqual([]);
  });

  it('asks the model with the mail and reads its JSON', async () => {
    let sentBody = '';
    const fetchImplementation = (async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items":[{"concepto":"Dominio","vence":"2026-10-07","monto":null}]}' } }],
        }),
      );
    }) as unknown as typeof fetch;
    const items = await extractBillingItems({
      mail: { id: 'm1', from: 'Dominio', subject: 'Your annual plan renews on October 7, 2026', receivedAtMilliseconds: 0, text: '' },
      openRouterApiKey: 'k',
      modelId: 'm',
      fetchImplementation,
    });
    expect(items[0].concepto).toBe('Dominio');
    expect(JSON.parse(sentBody).reasoning).toEqual({ enabled: false });
  });

  // 30/9 a las 10:00 de Buenos Aires.
  const now = Date.parse('2026-09-30T13:00:00Z');

  it('warns the day before at 10:00 and the same day at 9:00', () => {
    const alerts = planBillingAlerts({
      itemList: [{ concepto: 'Expensas', vence: '2026-10-21', monto: '$ 12.345,67', urgente: false }],
      mailReceivedAtMilliseconds: now,
      nowMilliseconds: now,
      skipConceptList: ['prepaga', 'alquiler'],
      alreadyScheduledMessageList: [],
    });
    expect(alerts.map((alert) => alert.message)).toEqual([
      'Mañana vence Expensas, $12.345,67.',
      'Hoy vence Expensas, $12.345,67.',
    ]);
    // 20/10 10:00 BA = 13:00 UTC; 21/10 09:00 BA = 12:00 UTC.
    expect(now + alerts[0].delaySeconds * 1000).toBe(Date.parse('2026-10-20T13:00:00Z'));
    expect(now + alerts[1].delaySeconds * 1000).toBe(Date.parse('2026-10-21T12:00:00Z'));
  });

  it('skips what already has a fixed monthly reminder, past dates and duplicates', () => {
    const alerts = planBillingAlerts({
      itemList: [
        { concepto: 'Prepaga', vence: '2026-10-15', monto: null, urgente: false },
        { concepto: 'Gas', vence: '2026-09-20', monto: null, urgente: false },
        { concepto: 'Dominio', vence: '2026-10-07', monto: null, urgente: false },
      ],
      mailReceivedAtMilliseconds: now,
      nowMilliseconds: now,
      skipConceptList: ['prepaga', 'alquiler'],
      alreadyScheduledMessageList: ['Mañana vence Dominio.'],
    });
    expect(alerts.map((alert) => alert.message)).toEqual(['Hoy vence Dominio.']);
  });

  it('flags a recent debt notice right away, but not an old one', () => {
    const recent = planBillingAlerts({
      itemList: [{ concepto: 'Obra social', vence: null, monto: '$ 50.000,00', urgente: true }],
      mailReceivedAtMilliseconds: now - 60_000,
      nowMilliseconds: now,
      skipConceptList: [],
      alreadyScheduledMessageList: [],
    });
    expect(recent[0].message).toBe('Atención: aviso de deuda o baja de Obra social, $50.000,00. Revisá el mail.');
    const old = planBillingAlerts({
      itemList: [{ concepto: 'Obra social', vence: null, monto: null, urgente: true }],
      mailReceivedAtMilliseconds: now - 10 * 24 * 60 * 60 * 1000,
      nowMilliseconds: now,
      skipConceptList: [],
      alreadyScheduledMessageList: [],
    });
    expect(old).toHaveLength(0);
  });
});
