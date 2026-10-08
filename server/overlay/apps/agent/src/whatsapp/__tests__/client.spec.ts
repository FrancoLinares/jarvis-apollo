import { describe, expect, it } from 'bun:test';

import { createWhatsAppNotifier, toWhatsAppChatId } from '@/whatsapp/client';

describe('WhatsApp client', () => {
  it('normalizes numbers to chat ids', () => {
    expect(toWhatsAppChatId('+54 9 11 1234-5678')).toBe('5491112345678@c.us');
    expect(toWhatsAppChatId('123')).toBeUndefined();
  });

  it('is a no-op without an API key', async () => {
    const notifier = createWhatsAppNotifier({}, (() => {
      throw new Error('no debería llamar');
    }) as unknown as typeof fetch);
    expect(notifier.isConfigured).toBe(false);
    expect((await notifier.send('hola')).ok).toBe(false);
  });

  it('sends to its own linked number', async () => {
    const requestList: { url: string; body?: string; key?: string }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requestList.push({ url, body: init?.body as string | undefined, key: headers['X-Api-Key'] });
      if (url.endsWith('/me')) {
        return new Response(JSON.stringify({ id: '5491112345678@c.us', pushName: 'Marcos' }));
      }
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    const notifier = createWhatsAppNotifier({ WAHA_API_KEY: 'k' }, fakeFetch);
    expect(await notifier.send('⏰ Vitaminas')).toEqual({ ok: true });
    expect(requestList[0]?.url).toBe('http://waha:3000/api/sessions/default/me');
    expect(requestList[1]?.url).toBe('http://waha:3000/api/sendText');
    expect(JSON.parse(requestList[1]?.body ?? '{}')).toEqual({
      session: 'default',
      chatId: '5491112345678@c.us',
      text: '⏰ Vitaminas',
    });
    expect(requestList[1]?.key).toBe('k');
  });

  it('reports a failure instead of throwing', async () => {
    const notifier = createWhatsAppNotifier(
      { WAHA_API_KEY: 'k', WHATSAPP_TO: '5491112345678' },
      (async () => new Response('session not ready', { status: 422 })) as unknown as typeof fetch,
    );
    expect(await notifier.send('hola')).toEqual({ ok: false, reason: 'WAHA respondió 422' });
  });

  describe('confirmación de WhatsApp (ack)', () => {
    const messageId = 'true_5491112345678@c.us_3EB0ABC';
    function fetchWithAckSequence(ackSequence: readonly number[]) {
      let listCallCount = 0;
      const fakeFetch = (async (url: string) => {
        if (url.endsWith('/api/sendText')) {
          return new Response(JSON.stringify({ id: messageId }), { status: 201 });
        }
        if (url.includes('/messages?')) {
          const ack = ackSequence[Math.min(listCallCount, ackSequence.length - 1)];
          listCallCount += 1;
          return new Response(JSON.stringify([{ id: 'otro', ack: 3 }, { id: messageId, ack }]));
        }
        return new Response('{}');
      }) as unknown as typeof fetch;
      return { fakeFetch, listCalls: () => listCallCount };
    }
    const noWait = { wait: async () => {}, pollMilliseconds: 2000, timeoutMilliseconds: 6000 };

    it('espera a que el servidor de WhatsApp lo acepte', async () => {
      const { fakeFetch, listCalls } = fetchWithAckSequence([0, 0, 1]);
      const notifier = createWhatsAppNotifier({ WAHA_API_KEY: 'k', WHATSAPP_TO: '5491112345678' }, fakeFetch, noWait);
      expect(await notifier.send('⏰ Alquiler')).toEqual({ ok: true });
      expect(listCalls()).toBe(3);
    });

    it('si queda en ack 0, no lo da por enviado', async () => {
      const { fakeFetch, listCalls } = fetchWithAckSequence([0]);
      const notifier = createWhatsAppNotifier({ WAHA_API_KEY: 'k', WHATSAPP_TO: '5491112345678' }, fakeFetch, noWait);
      expect(await notifier.send('⏰ Alquiler')).toEqual({ ok: false, reason: 'WhatsApp no confirmó el envío' });
      expect(listCalls()).toBe(4);
    });

    it('si el mensaje no aparece en el chat (id @lid), lo da por enviado sin verificar', async () => {
      const fakeFetch = (async (url: string) => {
        if (url.endsWith('/api/sendText')) {
          return new Response(JSON.stringify({ id: messageId }), { status: 201 });
        }
        if (url.includes('/messages?')) {
          return new Response(JSON.stringify([{ id: 'otro', ack: 3 }]));
        }
        return new Response('{}');
      }) as unknown as typeof fetch;
      const notifier = createWhatsAppNotifier({ WAHA_API_KEY: 'k', WHATSAPP_TO: '5491112345678' }, fakeFetch, noWait);
      expect(await notifier.send('⏰ Alquiler')).toEqual({ ok: true });
    });

    it('un ack de error corta enseguida', async () => {
      const { fakeFetch, listCalls } = fetchWithAckSequence([-1]);
      const notifier = createWhatsAppNotifier({ WAHA_API_KEY: 'k', WHATSAPP_TO: '5491112345678' }, fakeFetch, noWait);
      expect((await notifier.send('⏰ Alquiler')).ok).toBe(false);
      expect(listCalls()).toBe(1);
    });
  });
});
