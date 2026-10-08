import { z } from 'zod';

import { initiativePrioritySchema, initiativeSourceSchema } from '@/initiative/logic';
import { deskSoundEffectSchema } from '@/protocol/schema';

export const notifyBackgroundResultInputSchema = z.object({
  prompt: z.string().min(1),
  summary: z.string().min(1),
  documentKey: z.string().min(1).optional(),
});

export const deliverReminderPayloadSchema = z.object({
  message: z.string().min(1),
  // Cuántas veces se corrió por caer en medio de un turno (reminders/defer.ts).
  deferCount: z.number().int().min(0).optional(),
  // Recordatorios que se repiten: cómo decirlo ("todos los días a las 19:30").
  recurrence: z.string().optional(),
});

export const expireConfirmPayloadSchema = z.object({
  confirmationId: z.string().min(1),
});

export const retryInitiativeUtterancePayloadSchema = z.object({
  source: initiativeSourceSchema,
  priority: initiativePrioritySchema,
  message: z.string().min(1),
  earconName: deskSoundEffectSchema.optional(),
  deferCount: z.number().int().min(0).max(5),
  utteranceKey: z.string().min(1).optional(),
});
