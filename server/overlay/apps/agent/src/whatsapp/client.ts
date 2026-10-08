// Avisos por WhatsApp a través de WAHA (deploy/pi/whatsapp): un contenedor en la
// Pi vinculado a la cuenta del dueño como un dispositivo más, igual que
// WhatsApp Web. Los mensajes llegan al chat "Vos" (mensajes a uno mismo).
//
// Si falta WAHA_API_KEY, todo esto es un no-op: Jarvis se comporta como antes.
//
// Variables (.dev.vars):
//   WAHA_API_KEY   obligatoria para activar
//   WAHA_URL       default http://waha:3000 (red de Docker jarvis-mcp)
//   WAHA_SESSION   default "default" (WAHA Core admite una sola sesión)
//   WHATSAPP_TO    número destino, solo dígitos con código de país (5491112345678).
//                  Default: el propio número vinculado.

export const WHATSAPP_DEFAULT_URL = 'http://waha:3000';
export const WHATSAPP_DEFAULT_SESSION = 'default';
const WHATSAPP_TIMEOUT_MILLISECONDS = 10_000;
// Que WAHA acepte el pedido no significa que WhatsApp recibió el mensaje: el
// 2026-10-05 los avisos quedaban en ack=0 para siempre (motor NOWEB con el
// cifrado roto) y acá se anotaban como "enviados". Ahora se espera el ack del
// servidor de WhatsApp (ack ≥ 1) antes de dar el envío por bueno.
export const WHATSAPP_ACK_TIMEOUT_MILLISECONDS = 10_000;
export const WHATSAPP_ACK_POLL_MILLISECONDS = 2_000;
// WhatsApp corta los mensajes larguísimos y un aviso no necesita más.
const WHATSAPP_MAX_TEXT_LENGTH = 3000;

export type WhatsAppEnvironment = {
  readonly WAHA_API_KEY?: string;
  readonly WAHA_URL?: string;
  readonly WAHA_SESSION?: string;
  readonly WHATSAPP_TO?: string;
};

export type WhatsAppSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type WhatsAppNotifier = {
  readonly isConfigured: boolean;
  // Al chat del propio usuario ("Vos").
  readonly send: (text: string) => Promise<WhatsAppSendResult>;
  // A otra persona. Quien llama decide a quién se puede (ver tools/message.ts).
  readonly sendToChat: (chatId: string, text: string) => Promise<WhatsAppSendResult>;
};

export function toWhatsAppChatId(rawNumber: string): string | undefined {
  if (rawNumber.endsWith('@c.us')) {
    return rawNumber;
  }
  const digits = rawNumber.replace(/\D/g, '');
  return digits.length >= 8 ? `${digits}@c.us` : undefined;
}

function logWhatsApp(level: 'info' | 'warn', message: string, extra: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, message, ...extra }));
}

export type WhatsAppAckOptions = {
  readonly timeoutMilliseconds?: number;
  readonly pollMilliseconds?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
};

type AckCheck = 'confirmado' | 'rechazado' | 'pendiente' | 'no_encontrado' | 'sin_verificar';

export function createWhatsAppNotifier(
  environment: WhatsAppEnvironment,
  fetchImplementation: typeof fetch = fetch,
  ackOptions: WhatsAppAckOptions = {},
): WhatsAppNotifier {
  const apiKey = environment.WAHA_API_KEY?.trim() ?? '';
  const baseUrl = (environment.WAHA_URL?.trim() || WHATSAPP_DEFAULT_URL).replace(/\/+$/, '');
  const session = environment.WAHA_SESSION?.trim() || WHATSAPP_DEFAULT_SESSION;
  const configuredChatId =
    environment.WHATSAPP_TO === undefined ? undefined : toWhatsAppChatId(environment.WHATSAPP_TO);
  let ownChatId: string | undefined;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    return fetchImplementation(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(WHATSAPP_TIMEOUT_MILLISECONDS),
    });
  }

  // El número vinculado sale de la propia sesión: así no hay que configurarlo.
  async function resolveChatId(): Promise<string | undefined> {
    if (configuredChatId !== undefined) {
      return configuredChatId;
    }
    if (ownChatId !== undefined) {
      return ownChatId;
    }
    const response = await request(`/api/sessions/${encodeURIComponent(session)}/me`);
    if (!response.ok) {
      return undefined;
    }
    const me = (await response.json()) as { id?: unknown } | null;
    if (me !== null && typeof me.id === 'string') {
      ownChatId = toWhatsAppChatId(me.id.replace(/@.*$/, ''));
    }
    return ownChatId;
  }

  // Busca el mensaje en el chat y mira su ack: -1 error, 0 pendiente,
  // 1 servidor, 2 entregado, 3 leído. Si no se puede consultar, o el mensaje no
  // aparece (GOWS a veces guarda el chat bajo un id @lid), no frena el envío:
  // queda "sin_verificar" y se da por enviado, como antes. Solo falla lo que se
  // VE trabado o rechazado.
  async function checkAck(chatId: string, messageId: string): Promise<AckCheck> {
    const response = await request(
      `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages?limit=10&downloadMedia=false`,
    );
    if (!response.ok) {
      return 'sin_verificar';
    }
    const messageList = (await response.json()) as unknown;
    if (!Array.isArray(messageList)) {
      return 'sin_verificar';
    }
    const message = messageList.find(
      (candidate): candidate is { ack?: unknown } =>
        typeof candidate === 'object' && candidate !== null && (candidate as { id?: unknown }).id === messageId,
    );
    if (message === undefined || typeof message.ack !== 'number') {
      return 'no_encontrado';
    }
    if (message.ack < 0) {
      return 'rechazado';
    }
    return message.ack >= 1 ? 'confirmado' : 'pendiente';
  }

  async function waitForAck(chatId: string, messageId: string): Promise<AckCheck> {
    const timeoutMilliseconds = ackOptions.timeoutMilliseconds ?? WHATSAPP_ACK_TIMEOUT_MILLISECONDS;
    const pollMilliseconds = ackOptions.pollMilliseconds ?? WHATSAPP_ACK_POLL_MILLISECONDS;
    const wait =
      ackOptions.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    let elapsedMilliseconds = 0;
    for (;;) {
      const check = await checkAck(chatId, messageId);
      const settled = check !== 'pendiente' && check !== 'no_encontrado';
      if (settled || elapsedMilliseconds >= timeoutMilliseconds) {
        return check === 'no_encontrado' ? 'sin_verificar' : check;
      }
      await wait(pollMilliseconds);
      elapsedMilliseconds += pollMilliseconds;
    }
  }

  async function sendText(
    text: string,
    resolveTarget: () => Promise<string | undefined>,
  ): Promise<WhatsAppSendResult> {
    if (apiKey.length === 0) {
      return { ok: false, reason: 'WhatsApp no está configurado' };
    }
    const trimmed = text.trim().slice(0, WHATSAPP_MAX_TEXT_LENGTH);
    if (trimmed.length === 0) {
      return { ok: false, reason: 'mensaje vacío' };
    }
    try {
      const chatId = await resolveTarget();
      if (chatId === undefined) {
        logWhatsApp('warn', 'apollo_whatsapp_error', { motivo: 'sin sesión vinculada' });
        return { ok: false, reason: 'la sesión de WhatsApp no está vinculada' };
      }
      const response = await request('/api/sendText', {
        method: 'POST',
        body: JSON.stringify({ session, chatId, text: trimmed }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        logWhatsApp('warn', 'apollo_whatsapp_error', { status: response.status, detail });
        return { ok: false, reason: `WAHA respondió ${response.status}` };
      }
      const sent = (await response.json().catch(() => null)) as { id?: unknown } | null;
      const messageId = sent !== null && typeof sent.id === 'string' ? sent.id : undefined;
      const ack = messageId === undefined ? 'sin_verificar' : await waitForAck(chatId, messageId);
      if (ack === 'pendiente' || ack === 'rechazado') {
        logWhatsApp('warn', 'apollo_whatsapp_sin_confirmar', { chars: trimmed.length, ack });
        return { ok: false, reason: 'WhatsApp no confirmó el envío' };
      }
      logWhatsApp('info', 'apollo_whatsapp_enviado', { chars: trimmed.length, ack });
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logWhatsApp('warn', 'apollo_whatsapp_error', { motivo: reason });
      return { ok: false, reason };
    }
  }

  return {
    isConfigured: apiKey.length > 0,
    send: (text) => sendText(text, resolveChatId),
    sendToChat: (chatId, text) => sendText(text, async () => chatId),
  };
}

let sharedNotifier: WhatsAppNotifier | undefined;

// Uno solo por proceso: así el número vinculado se resuelve una vez.
export function getWhatsAppNotifier(): WhatsAppNotifier {
  if (sharedNotifier === undefined) {
    const environment =
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    sharedNotifier = createWhatsAppNotifier(environment);
  }
  return sharedNotifier;
}
