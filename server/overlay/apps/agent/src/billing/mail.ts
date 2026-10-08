import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Mails de vencimientos en Gmail, por IMAP con una contraseña de aplicación
// (GMAIL_USER / GMAIL_APP_PASSWORD en .dev.vars). Solo se leen los mails cuyo
// ASUNTO habla de vencimientos o deudas: el resto del buzón nunca sale de
// Google ni pasa por el LLM.

// Asuntos típicos de bancos, tarjetas, suscripciones y prepagas: "Tus servicios
// están por vencer", "Tu resumen vence pronto", "Your annual plan renews on…",
// "Aviso de baja por falta de pago" / "INTIMACIÓN".
export const BILLING_SUBJECT_PATTERN =
  /venc|vence|por vencer|renew|renueva|reclamo de deuda|falta de pago|intimaci/i;

export const BILLING_MAIL_TEXT_MAX_CHARACTERS = 2500;

export type BillingMail = {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly receivedAtMilliseconds: number;
  readonly text: string;
};

const NAMED_ENTITY_MAP: Readonly<Record<string, string>> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", zwnj: '', zwj: '',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  uuml: 'ü', iexcl: '¡', iquest: '¿', deg: '°', ordm: 'º', ordf: 'ª',
};

// Muchos avisos de bancos vienen solo en HTML: se pasa a texto plano.
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => NAMED_ENTITY_MAP[name] ?? entity)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export async function fetchBillingMails(input: {
  readonly user: string;
  readonly password: string;
  readonly sinceMilliseconds: number;
  readonly alreadyProcessedIdSet: ReadonlySet<string>;
}): Promise<readonly BillingMail[]> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: input.user, pass: input.password },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const candidateList: { uid: number; id: string }[] = [];
    for await (const message of client.fetch(
      { since: new Date(input.sinceMilliseconds) },
      { envelope: true, uid: true },
    )) {
      const subject = message.envelope?.subject ?? '';
      const id = message.envelope?.messageId ?? `uid:${message.uid}`;
      if (BILLING_SUBJECT_PATTERN.test(subject) && !input.alreadyProcessedIdSet.has(id)) {
        candidateList.push({ uid: message.uid, id });
      }
    }
    const mailList: BillingMail[] = [];
    for (const candidate of candidateList) {
      const message = await client.fetchOne(String(candidate.uid), { source: true }, { uid: true });
      if (!message || !message.source) {
        continue;
      }
      const parsed = await simpleParser(message.source);
      const plain = parsed.text?.trim() ? parsed.text : htmlToPlainText(String(parsed.html || ''));
      mailList.push({
        id: candidate.id,
        from: parsed.from?.text ?? '',
        subject: parsed.subject ?? '',
        receivedAtMilliseconds: parsed.date?.getTime() ?? Date.now(),
        text: plain.slice(0, BILLING_MAIL_TEXT_MAX_CHARACTERS),
      });
    }
    return mailList;
  } finally {
    lock.release();
    await client.logout();
  }
}
