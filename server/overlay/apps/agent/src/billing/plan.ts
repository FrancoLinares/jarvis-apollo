import { APOLLO_TIME_ZONE } from '@/configuration/identity';
import type { BillingItem } from '@/billing/extract';
import { resolveCalendarDateInTimeZone, resolveWallClockInstantMilliseconds } from '@/time/zone';

// Cuándo avisar. Pedido (2026-09-30): el día anterior y el mismo día.
export const BILLING_EVE_HOUR = 10;
export const BILLING_DAY_HOUR = 9;
// Deudas e intimaciones se avisan en el momento, pero solo si el mail es reciente:
// una intimación de hace un mes probablemente ya se resolvió.
export const BILLING_URGENT_MAX_AGE_MILLISECONDS = 3 * 24 * 60 * 60 * 1000;

export type BillingAlert = { readonly delaySeconds: number; readonly message: string };

// Conceptos que ya tienen su aviso fijo mensual (BILLING_SKIP_CONCEPTS, p. ej. "alquiler"):
// lo que llegue por mail de esos no se duplica.
export function resolveBillingSkipList(): readonly string[] {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.BILLING_SKIP_CONCEPTS;
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function speakAmount(monto: string | null | undefined): string {
  return monto ? `, ${monto.replace(/\$\s*/, '$')}` : '';
}

export function planBillingAlerts(input: {
  readonly itemList: readonly BillingItem[];
  readonly mailReceivedAtMilliseconds: number;
  readonly nowMilliseconds: number;
  readonly skipConceptList: readonly string[];
  readonly alreadyScheduledMessageList: readonly string[];
}): readonly BillingAlert[] {
  const alreadyScheduled = new Set(input.alreadyScheduledMessageList);
  const alertList: BillingAlert[] = [];
  const push = (atMilliseconds: number, message: string) => {
    if (atMilliseconds > input.nowMilliseconds + 30_000 && !alreadyScheduled.has(message)) {
      alreadyScheduled.add(message);
      alertList.push({ delaySeconds: Math.round((atMilliseconds - input.nowMilliseconds) / 1000), message });
    }
  };
  for (const item of input.itemList) {
    const concept = item.concepto.trim();
    if (input.skipConceptList.some((skip) => concept.toLowerCase().includes(skip))) {
      continue;
    }
    if (item.urgente) {
      if (input.nowMilliseconds - input.mailReceivedAtMilliseconds <= BILLING_URGENT_MAX_AGE_MILLISECONDS) {
        push(input.nowMilliseconds + 60_000, `Atención: aviso de deuda o baja de ${concept}${speakAmount(item.monto)}. Revisá el mail.`);
      }
      continue;
    }
    if (item.vence === null) {
      continue;
    }
    const [year, month, day] = item.vence.split('-').map(Number);
    const dueDate = { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
    const dueDayAt = resolveWallClockInstantMilliseconds({ timeZone: APOLLO_TIME_ZONE, date: dueDate, hour: BILLING_DAY_HOUR, minute: 0 });
    const eveUtc = new Date(Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000);
    const eveDate = resolveCalendarDateInTimeZone('UTC', eveUtc.getTime());
    const eveAt = resolveWallClockInstantMilliseconds({ timeZone: APOLLO_TIME_ZONE, date: eveDate, hour: BILLING_EVE_HOUR, minute: 0 });
    push(eveAt, `Mañana vence ${concept}${speakAmount(item.monto)}.`);
    push(dueDayAt, `Hoy vence ${concept}${speakAmount(item.monto)}.`);
  }
  return alertList;
}
