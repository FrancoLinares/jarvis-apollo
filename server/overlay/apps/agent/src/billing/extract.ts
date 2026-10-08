import { z } from 'zod';

import type { BillingMail } from '@/billing/mail';
import { chatWithOpenRouter } from '@/voice/llm';

// Del mail al dato: qué vence, cuándo y cuánto. Una llamada chica al LLM por
// mail (sin herramientas, sin razonar): ~1.500 tokens, fracciones de centavo.

export const billingItemSchema = z.object({
  concepto: z.string().min(1).max(80),
  vence: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  monto: z.string().max(40).nullable().optional(),
  urgente: z.boolean().optional().default(false),
});

export type BillingItem = z.infer<typeof billingItemSchema>;

const billingItemListSchema = z.object({ items: z.array(billingItemSchema).max(10) });

export const BILLING_EXTRACTION_PROMPT =
  'Extraés vencimientos de pagos de un mail en español o inglés. Respondé SOLO un JSON ' +
  '{"items":[{"concepto":"...","vence":"YYYY-MM-DD" o null,"monto":"$ 1.234,56" o null,"urgente":true|false}]}. ' +
  'concepto: nombre corto de lo que hay que pagar o renovar (p. ej. "Prepaga", "Monotributo", "Tarjeta", "Dominio web"). ' +
  'Un item por cada vencimiento distinto; si hay varios del mismo concepto y fecha, uno solo sumando nada. ' +
  'urgente=true solo si el mail avisa deuda vencida, baja, intimación o corte de servicio. ' +
  'Si el mail no trata de pagar ni renovar nada, devolvé {"items":[]}.';

export function parseBillingExtraction(text: string): readonly BillingItem[] {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) {
    return [];
  }
  try {
    const parsed = billingItemListSchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data.items : [];
  } catch {
    return [];
  }
}

export async function extractBillingItems(input: {
  readonly mail: BillingMail;
  readonly openRouterApiKey: string;
  readonly modelId: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<readonly BillingItem[]> {
  const received = new Date(input.mail.receivedAtMilliseconds).toISOString().slice(0, 10);
  const result = await chatWithOpenRouter({
    openRouterApiKey: input.openRouterApiKey,
    modelId: input.modelId,
    reasoningEnabled: false,
    fetchImplementation: input.fetchImplementation,
    messageList: [
      { role: 'system', content: BILLING_EXTRACTION_PROMPT },
      {
        role: 'user',
        content: `Recibido: ${received}\nDe: ${input.mail.from}\nAsunto: ${input.mail.subject}\n\n${input.mail.text}`,
      },
    ],
  });
  return parseBillingExtraction(result.text);
}
