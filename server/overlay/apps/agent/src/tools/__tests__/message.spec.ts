import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  confirmMessageTool,
  draftMessageTool,
  findMessageContact,
  isAffirmativeAnswer,
  noteUserTurnForMessageDraft,
  parseMessageContacts,
  resetMessageDraftForTests,
} from '@/tools/message';
import type { ToolExecutionContext } from '@/tools/types';

const savedEnv = { ...process.env };
let sentList: { url: string; body: string }[] = [];
const originalFetch = globalThis.fetch;

function contextAt(nowMilliseconds: number, userTranscript?: string): ToolExecutionContext {
  return { environment: {} as ToolExecutionContext['environment'], nowMilliseconds, userTranscript };
}

beforeEach(() => {
  process.env.WHATSAPP_CONTACTS = 'Ana=5491100000000';
  process.env.WAHA_API_KEY = 'k';
  sentList = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sentList.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response('{}', { status: 201 });
  }) as typeof fetch;
  resetMessageDraftForTests();
});

afterEach(() => {
  process.env = { ...savedEnv };
  globalThis.fetch = originalFetch;
  resetMessageDraftForTests();
});

describe('contactos permitidos', () => {
  it('lee la lista del entorno', () => {
    expect(parseMessageContacts('Ana=5491100000000, Juan=+54 9 11 1111-2222, roto')).toEqual([
      { name: 'Ana', chatId: '5491100000000@c.us' },
      { name: 'Juan', chatId: '5491111112222@c.us' },
    ]);
  });

  it('reconoce a Ana como lo diga el transcriptor, y a nadie más', () => {
    const contactList = parseMessageContacts('Ana=5491100000000');
    expect(findMessageContact('Ana', contactList)?.name).toBe('Ana');
    expect(findMessageContact('a ana', contactList)?.name).toBe('Ana');
    expect(findMessageContact('Anabella', contactList)?.name).toBe('Ana');
    expect(findMessageContact('Juan', contactList)).toBeUndefined();
    expect(findMessageContact('mi novia', contactList)).toBeUndefined();
  });
});

describe('isAffirmativeAnswer', () => {
  it('acepta un sí claro', () => {
    for (const answer of ['Sí', 'sí, mandalo', 'Dale.', 'ok', 'de una', 'Sí, perfecto']) {
      expect(isAffirmativeAnswer(answer)).toBe(true);
    }
  });

  it('rechaza dudas, cambios y negativas', () => {
    for (const answer of ['No', 'no, esperá', 'cambiale el horario', 'mejor no', 'sí pero esperá', '', undefined]) {
      expect(isAffirmativeAnswer(answer)).toBe(false);
    }
  });
});

describe('mandar_mensaje + confirmar_mensaje', () => {
  it('no manda nada al armar el borrador', async () => {
    const result = await draftMessageTool.handler({ contacto: 'Ana', texto: 'Llego a las 9' }, contextAt(1000));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('TODAVÍA NO ESTÁ ENVIADO');
    // Lo que se dice es fijo: una pregunta, sin "listo".
    expect(result.spokenText).toBe('Para Ana: "Llego a las 9". ¿Se lo mando?');
    expect(sentList).toHaveLength(0);
  });

  it('se niega con alguien que no está en la lista', async () => {
    const result = await draftMessageTool.handler({ contacto: 'Juan', texto: 'hola' }, contextAt(1000));
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('solo puedo mandarle mensajes a: Ana');
  });

  it('el modelo no puede confirmar en el mismo turno del borrador', async () => {
    await draftMessageTool.handler({ contacto: 'Ana', texto: 'Llego a las 9' }, contextAt(1000, 'mandale a Ana que llego a las 9'));
    const result = await confirmMessageTool.handler({}, contextAt(1000, 'mandale a Ana que llego a las 9'));
    expect(result.ok).toBe(false);
    expect(sentList).toHaveLength(0);
  });

  it('sin un sí del usuario no se manda', async () => {
    await draftMessageTool.handler({ contacto: 'Ana', texto: 'Llego a las 9' }, contextAt(1000));
    noteUserTurnForMessageDraft(5000);
    const result = await confirmMessageTool.handler({}, contextAt(5000, 'no, cambiale a las 10'));
    expect(result.ok).toBe(false);
    expect(sentList).toHaveLength(0);
  });

  it('con un sí en el turno siguiente lo manda a Ana', async () => {
    await draftMessageTool.handler({ contacto: 'Ana', texto: 'Llego a las 9' }, contextAt(1000));
    noteUserTurnForMessageDraft(5000);
    const result = await confirmMessageTool.handler({}, contextAt(5000, 'Sí, mandalo'));
    expect(result).toEqual({
      ok: true,
      summary: 'Mensaje enviado a Ana.',
      spokenText: 'Listo, se lo mandé a Ana.',
    });
    const sendRequest = sentList.find((request) => request.url.endsWith('/api/sendText'));
    expect(JSON.parse(sendRequest?.body ?? '{}')).toEqual({
      session: 'default',
      chatId: '5491100000000@c.us',
      text: 'Llego a las 9',
    });
    // Ya se usó: un segundo "sí" no lo vuelve a mandar.
    noteUserTurnForMessageDraft(6000);
    expect((await confirmMessageTool.handler({}, contextAt(6000, 'sí'))).ok).toBe(false);
  });

  it('el borrador vence a los 3 minutos', async () => {
    await draftMessageTool.handler({ contacto: 'Ana', texto: 'Llego a las 9' }, contextAt(1000));
    noteUserTurnForMessageDraft(1000 + 3 * 60 * 1000 + 1);
    const result = await confirmMessageTool.handler({}, contextAt(1000 + 3 * 60 * 1000 + 1, 'sí'));
    expect(result.ok).toBe(false);
    expect(sentList).toHaveLength(0);
  });

  it('un "no" descarta el borrador: un "sí" posterior a otra cosa no lo manda', async () => {
    await draftMessageTool.handler({ contacto: 'Ana', texto: 'Llego a las 9' }, contextAt(1000));
    noteUserTurnForMessageDraft(5000); // "no, no lo mandes"
    noteUserTurnForMessageDraft(60_000); // "¿va a llover?" … "sí"
    const result = await confirmMessageTool.handler({}, contextAt(60_000, 'sí'));
    expect(result.ok).toBe(false);
    expect(sentList).toHaveLength(0);
  });
});
