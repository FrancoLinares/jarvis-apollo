import { z } from 'zod';

import type { ToolDefinition } from '@/tools/types';
import { getWhatsAppNotifier, toWhatsAppChatId } from '@/whatsapp/client';

// Mensajes a OTRA persona, por WhatsApp desde la cuenta del dueño.
//
// Pedido (2026-10-05): "mandale un mensaje a Ana que…" tiene que funcionar sin
// decir "WhatsApp" (es el único canal), y SOLO a una lista cerrada, "para no hacer
// cagadas". Dos candados, los dos en código y no en el prompt:
//
// 1. Lista cerrada de contactos (WHATSAPP_CONTACTS en .dev.vars). Un nombre que
//    no está en la lista no se resuelve contra la agenda: no hay forma de que
//    el modelo le escriba a otra persona.
// 2. Confirmación por voz. mandar_mensaje solo deja un borrador; el envío lo
//    hace confirmar_mensaje, que exige que la frase del usuario de un turno
//    POSTERIOR al borrador sea un "sí". La placa no muestra el cartel de
//    confirmación en esta pantalla, así que la confirmación no puede ser por
//    toque, y el modelo no puede confirmar por su cuenta.

export const MESSAGE_DRAFT_TTL_MILLISECONDS = 3 * 60 * 1000;

export type MessageContact = {
  readonly name: string;
  readonly chatId: string;
};

type MessageDraft = {
  readonly contact: MessageContact;
  readonly text: string;
  readonly createdAtMilliseconds: number;
  // Turnos del usuario desde el borrador. Solo se confirma en el inmediato
  // siguiente: un "no" (o cualquier otra cosa) lo descarta, así un "sí" a otra
  // pregunta minutos después no lo manda.
  turnsSinceDraft: number;
};

let pendingDraft: MessageDraft | undefined;

export function resetMessageDraftForTests(): void {
  pendingDraft = undefined;
}

// Lo llama turn/run.ts al empezar cada turno del usuario.
export function noteUserTurnForMessageDraft(nowMilliseconds: number): void {
  if (pendingDraft === undefined || nowMilliseconds <= pendingDraft.createdAtMilliseconds) {
    return;
  }
  pendingDraft.turnsSinceDraft += 1;
  if (pendingDraft.turnsSinceDraft > 1) {
    pendingDraft = undefined;
  }
}

function readHostEnvironmentValue(name: string): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[name];
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// "Ana=5491100000000, Juan=549…" → contactos permitidos.
export function parseMessageContacts(rawValue: string | undefined): readonly MessageContact[] {
  if (rawValue === undefined) {
    return [];
  }
  return rawValue.split(',').flatMap((entry) => {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      return [];
    }
    const name = entry.slice(0, separatorIndex).trim();
    const chatId = toWhatsAppChatId(entry.slice(separatorIndex + 1).trim());
    return name.length > 0 && chatId !== undefined ? [{ name, chatId }] : [];
  });
}

export function findMessageContact(
  requestedName: string,
  contactList: readonly MessageContact[],
): MessageContact | undefined {
  const requested = normalizeName(requestedName);
  if (requested.length === 0) {
    return undefined;
  }
  return contactList.find((contact) => {
    const allowed = normalizeName(contact.name);
    // "Ana", "a Ana", "Anabella" → Ana. Nada más laxo que eso.
    return (
      requested === allowed ||
      requested.split(/\s+/).includes(allowed) ||
      requested.startsWith(allowed)
    );
  });
}

// Un "sí" claro, sin un "no" o un "esperá" en la misma frase.
const AFFIRMATIVE_PATTERN =
  /\b(si|sii+|dale|mandalo|mandaselo|mandalo ya|envialo|enviaselo|ok|okey|okay|confirmo|confirmado|de una|perfecto|obvio|claro|correcto|exacto|listo)\b/;
const NEGATIVE_PATTERN = /\b(no|nop|cancela\w*|espera\w*|para|frena\w*|cambia\w*|mejor no|todavia no)\b/;

export function isAffirmativeAnswer(userTranscript: string | undefined): boolean {
  if (userTranscript === undefined) {
    return false;
  }
  const normalized = normalizeName(userTranscript).replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return AFFIRMATIVE_PATTERN.test(normalized) && !NEGATIVE_PATTERN.test(normalized);
}

function resolveContactList(): readonly MessageContact[] {
  return parseMessageContacts(readHostEnvironmentValue('WHATSAPP_CONTACTS'));
}

const draftArgsSchema = z.object({
  contacto: z.string().min(1).max(80),
  texto: z.string().min(1).max(2000),
});

export const draftMessageTool: ToolDefinition = {
  name: 'mandar_mensaje',
  safety: 'safe',
  description:
    'Prepara un mensaje para OTRA persona ("mandale un mensaje a Ana…", "decile a Ana que…", "escribile a Ana"). Va por WhatsApp aunque el usuario no lo diga: es el único canal. NO lo envía: deja un borrador. Después leele al usuario el texto exacto y preguntale si lo mandás; si dice que sí, llamá a confirmar_mensaje. Para mandarle algo al propio usuario, usá send_whatsapp.',
  parameters: {
    type: 'object',
    properties: {
      contacto: { type: 'string', description: 'A quién, tal como lo dijo el usuario (p. ej. "Ana").' },
      texto: {
        type: 'string',
        description:
          'El mensaje como lo va a leer esa persona, en primera persona del usuario. Sin inventar contenido: lo que pidió decir, con la ortografía arreglada. No le agregues saludo ni el nombre de la persona al principio si el usuario no lo dijo.',
      },
    },
    required: ['contacto', 'texto'],
    additionalProperties: false,
  },
  async handler(args, context) {
    const parsedArgs = draftArgsSchema.parse(args);
    const contactList = resolveContactList();
    const contact = findMessageContact(parsedArgs.contacto, contactList);
    if (contact === undefined) {
      const allowedNames = contactList.map((candidate) => candidate.name).join(', ');
      return {
        ok: false,
        summary:
          allowedNames.length > 0
            ? `Por ahora solo puedo mandarle mensajes a: ${allowedNames}.`
            : 'Todavía no tengo contactos habilitados para mandar mensajes.',
      };
    }
    if (!getWhatsAppNotifier().isConfigured) {
      return { ok: false, summary: 'WhatsApp no está configurado.' };
    }
    pendingDraft = {
      contact,
      text: parsedArgs.texto.trim(),
      createdAtMilliseconds: context.nowMilliseconds,
      turnsSinceDraft: 0,
    };
    const quotedText = pendingDraft.text.replace(/[\s.]+$/, '');
    return {
      ok: true,
      summary: `Borrador para ${contact.name}: "${pendingDraft.text}". TODAVÍA NO ESTÁ ENVIADO. Leéselo al usuario y preguntale si lo mandás; se envía solo si en su próxima respuesta dice que sí.`,
      // Frase fija: termina en pregunta (reabre el micrófono) y no arranca con
      // "listo", que suena a enviado.
      spokenText: `Para ${contact.name}: "${quotedText}". ¿Se lo mando?`,
    };
  },
};

export const confirmMessageTool: ToolDefinition = {
  name: 'confirmar_mensaje',
  safety: 'safe',
  description:
    'Envía el borrador de mandar_mensaje. Usar SOLO cuando el usuario acaba de responder que sí a "¿lo mando?". Si pidió cambios, volvé a llamar a mandar_mensaje con el texto nuevo.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, context) {
    const draft = pendingDraft;
    if (draft === undefined) {
      return { ok: false, summary: 'No hay ningún mensaje esperando confirmación.' };
    }
    if (context.nowMilliseconds - draft.createdAtMilliseconds > MESSAGE_DRAFT_TTL_MILLISECONDS) {
      pendingDraft = undefined;
      return { ok: false, summary: 'El borrador venció. Pedime el mensaje de nuevo.' };
    }
    // Mismo turno que el borrador: el usuario todavía no escuchó el texto.
    if (context.nowMilliseconds <= draft.createdAtMilliseconds || draft.turnsSinceDraft === 0) {
      return {
        ok: false,
        summary: 'Primero leele el mensaje al usuario y esperá que diga que sí.',
      };
    }
    if (!isAffirmativeAnswer(context.userTranscript)) {
      return {
        ok: false,
        summary: 'El usuario no dijo que sí: no lo mandé. Si pidió cambios, armá el borrador de nuevo.',
      };
    }
    pendingDraft = undefined;
    const result = await getWhatsAppNotifier().sendToChat(draft.contact.chatId, draft.text);
    console.log(
      JSON.stringify({
        level: result.ok ? 'info' : 'warn',
        message: 'apollo_mensaje_a_contacto',
        contacto: draft.contact.name,
        chars: draft.text.length,
        ok: result.ok,
      }),
    );
    return result.ok
      ? {
          ok: true,
          summary: `Mensaje enviado a ${draft.contact.name}.`,
          spokenText: `Listo, se lo mandé a ${draft.contact.name}.`,
        }
      : {
          ok: false,
          summary: `No pude mandarle el mensaje a ${draft.contact.name}: ${result.reason}`,
          spokenText: `No se lo pude mandar a ${draft.contact.name}: ${result.reason}.`,
        };
  },
};
