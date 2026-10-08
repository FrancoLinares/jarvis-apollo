// "Listo, te aviso mañana a las 19" sin haber llamado a ninguna herramienta.
//
// Pasó dos veces el 2026-09-27/28 (un recordatorio de trabajo, uno de salud): el modelo
// confirmaba una acción que nunca ejecutó, y desde afuera es indistinguible de
// una que sí se hizo. Cuando el pedido es de acción y la respuesta suena a
// confirmación sin ninguna herramienta ejecutada, el turno le pide al modelo
// una ronda más obligándolo a usar una herramienta.

// Intenciones que solo se cumplen ejecutando algo.
export const ACTION_INTENT_ID_SET: ReadonlySet<string> = new Set([
  'recordatorio',
  'agenda_crear',
  'pendientes',
]);

// Frases con las que el modelo da algo por hecho. Deliberadamente acotadas a
// confirmaciones: "no puedo", una pregunta o una aclaración no disparan nada.
const CONFIRMATION_PATTERN =
  /\b(listo|hecho|ya est[áa]|qued[óo]|programad[oa]|anotad[oa]|agendad[oa]|cargad[oa]|guardad[oa]|te (lo )?aviso|te (lo )?recuerdo|te voy a avisar|lo (dejo|dejé) )/i;

// Sin intención (Jev no contestó a tiempo) el pedido de acción se reconoce por
// el texto del usuario.
const ACTION_REQUEST_PATTERN =
  /\b(record[aá]|avis[aá]|agend[aá]|anot[aá]|program[aá]|haceme acordar|sac[aá] de|borr[aá])/i;

// "Todos los días" dicho después de programar un aviso de una sola vez.
const RECURRENCE_PATTERN =
  /\b(todos los d[ií]as|cada d[ií]a|de lunes a viernes|d[ií]as (laborales|h[aá]biles)|todas las (semanas|ma[ñn]anas|noches))\b/i;

// Consultas que solo se contestan mirando: la agenda, el clima, un viaje. El
// 2026-09-28 "¿qué tengo entre el 19 y el 25 de octubre?" se contestó "no tenés
// nada cargado" sin llamar al calendario: un dato inventado con tono de dato.
export const DATA_INTENT_ID_SET: ReadonlySet<string> = new Set(['agenda_leer', 'clima', 'viaje']);

export type UnbackedReplyKind = 'accion' | 'dato';

// Una respuesta que ES una pregunta de aclaración ("¿7 u 8? Decime una y lo
// dejo fijo", "¿De qué semana?") pide un dato: no afirma nada. Una afirmación
// con un ofrecimiento al final ("…no hay nada cargado. ¿Querés que revise de
// nuevo?") sí afirma, y es justo la forma de colar un dato inventado.
export function isClarifyingQuestion(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed.startsWith('¿')) {
    return true;
  }
  // Una sola oración que termina en pregunta ("A las 7 u 8?"). Si antes hubo
  // una afirmación ("Listo, te aviso. ¿Algo más?") no cuenta.
  return trimmed.endsWith('?') && !/[.!]/.test(trimmed.slice(0, -1));
}

export function classifyUnbackedReply(input: {
  readonly intentId: string | undefined;
  readonly userText: string;
  readonly replyText: string;
  readonly executedToolNameList: readonly string[];
}): UnbackedReplyKind | undefined {
  if (
    input.intentId !== undefined &&
    DATA_INTENT_ID_SET.has(input.intentId) &&
    input.executedToolNameList.length === 0
  ) {
    const reply = input.replyText.replace(/\[\[[^\]]*\]\]/g, '').trim();
    return reply.length > 0 && !isClarifyingQuestion(reply) ? 'dato' : undefined;
  }
  return looksLikeUnbackedClaim(input) ? 'accion' : undefined;
}

export function looksLikeUnbackedClaim(input: {
  readonly intentId: string | undefined;
  readonly userText: string;
  readonly replyText: string;
  readonly executedToolNameList: readonly string[];
}): boolean {
  const isActionRequest =
    input.intentId === undefined
      ? ACTION_REQUEST_PATTERN.test(input.userText)
      : ACTION_INTENT_ID_SET.has(input.intentId);
  if (!isActionRequest) {
    return false;
  }
  const reply = input.replyText.replace(/\[\[[^\]]*\]\]/g, '').trim();
  if (reply.length === 0 || isClarifyingQuestion(reply)) {
    return false;
  }
  if (input.executedToolNameList.length === 0) {
    return CONFIRMATION_PATTERN.test(reply);
  }
  // Prometió que se repite pero programó uno solo.
  return (
    RECURRENCE_PATTERN.test(reply) &&
    input.executedToolNameList.includes('set_reminder') &&
    !input.executedToolNameList.includes('set_recurring_reminder')
  );
}

export const UNBACKED_CLAIM_NUDGE =
  'Atención: le confirmaste al usuario algo que no hiciste (ninguna herramienta, o un aviso de una sola vez cuando prometiste que se repite). ' +
  'Llamá ahora a la herramienta que corresponde (set_reminder para una vez, set_recurring_reminder si se repite). ' +
  'Si en realidad te falta un dato, no confirmes: preguntalo.';

export const UNBACKED_DATA_NUDGE =
  'Atención: contestaste sin consultar ninguna herramienta, así que ese dato puede ser viejo o inventado. ' +
  'Consultá ahora la herramienta que corresponde (calendario, clima o mapas) y respondé con lo que devuelva.';
