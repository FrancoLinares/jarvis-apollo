import { z } from 'zod';

import {
  formatCancelRemindersSummary,
  formatListRemindersSummary,
} from '@/reminders/logic';
import { APOLLO_TIME_ZONE } from '@/configuration/identity';
import { resolveTimeZoneOffsetMilliseconds } from '@/time/zone';
import {
  WEEKDAY_NAME_LIST,
  buildUtcCronFromLocal,
  buildUtcMonthlyCronFromLocal,
  describeMonthlyRecurrence,
  describeRecurrence,
  parseLocalTime,
} from '@/reminders/recurring';
import type { ToolDefinition } from '@/tools/types';

// Antes el tope era 24 h (86400 s) sin motivo técnico: el scheduler del host
// guarda los recordatorios en SQLite y se re-arma solo, así que aguanta
// semanas. Con ese tope "el 7 de octubre avisame una semana antes" se rechazaba
// o el modelo lo "resolvía" poniendo el aviso para mañana. 60 días cubre lo que
// se pide hablando; lo recurrente sigue siendo trabajo de un cron.
export const MAX_REMINDER_DELAY_SECONDS = 60 * 24 * 60 * 60;

const setReminderArgsSchema = z.object({
  message: z.string().min(1).max(500),
  delaySeconds: z.number().int().min(1).max(MAX_REMINDER_DELAY_SECONDS),
});

const cancelReminderArgsSchema = z
  .object({
    message: z.string().min(1).max(500).optional(),
    cancelAll: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.cancelAll !== true &&
      (value.message === undefined || value.message.trim() === '')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'message or cancelAll required',
      });
    }
  });

export const setReminderTool: ToolDefinition = {
  name: 'set_reminder',
  safety: 'safe',
  description:
    'Programa un recordatorio de una sola vez, hasta 60 días adelante. delaySeconds = segundos desde la hora actual hasta el momento del aviso.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      delaySeconds: { type: 'number', minimum: 1, maximum: MAX_REMINDER_DELAY_SECONDS },
    },
    required: ['message', 'delaySeconds'],
    additionalProperties: false,
  },
  async handler(args, context) {
    if (!context.effects) {
      return { ok: false, summary: 'Effects no disponibles' };
    }

    const parsedArgs = setReminderArgsSchema.parse(args);
    await context.effects.scheduleReminder({
      delaySeconds: parsedArgs.delaySeconds,
      message: parsedArgs.message,
    });

    return {
      ok: true,
      summary: `Recordatorio programado: ${parsedArgs.message}`,
    };
  },
};

export const listRemindersTool: ToolDefinition = {
  name: 'list_reminders',
  safety: 'safe',
  description: 'Lista los recordatorios pendientes',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, context) {
    if (!context.effects) {
      return { ok: false, summary: 'Effects no disponibles' };
    }

    const reminderList = await context.effects.listReminders();
    return {
      ok: true,
      summary: formatListRemindersSummary(reminderList, context.nowMilliseconds),
      data: reminderList,
    };
  },
};

const setRecurringReminderArgsSchema = z
  .object({
    message: z.string().min(1).max(500),
    time: z.string().min(1),
    days: z.array(z.enum(WEEKDAY_NAME_LIST)).min(1).max(7).optional(),
    monthDay: z.number().int().min(1).max(28).optional(),
  })
  .refine((value) => (value.days !== undefined) !== (value.monthDay !== undefined), {
    message: 'days o monthDay, uno de los dos',
  });

export const setRecurringReminderTool: ToolDefinition = {
  name: 'set_recurring_reminder',
  safety: 'safe',
  description:
    'Programa un recordatorio que se REPITE a una hora fija: por días de la semana (days) o un día de cada mes (monthDay, 1-28, p. ej. vencimientos). Uno de los dos. Para una sola vez usá set_reminder. Se cancela con cancel_reminder.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      time: { type: 'string', description: 'Hora local de Buenos Aires, HH:MM (24 h)' },
      days: {
        type: 'array',
        items: { type: 'string', enum: [...WEEKDAY_NAME_LIST] },
        description: 'Días en que suena; los 7 para todos los días',
      },
      monthDay: {
        type: 'number',
        minimum: 1,
        maximum: 28,
        description: 'Día del mes en que suena (en vez de days), p. ej. 5 para "todos los 5"',
      },
    },
    required: ['message', 'time'],
    additionalProperties: false,
  },
  async handler(args, context) {
    const scheduleRecurringReminder = context.effects?.scheduleRecurringReminder;
    if (scheduleRecurringReminder === undefined) {
      return { ok: false, summary: 'Los recordatorios que se repiten no están disponibles acá' };
    }
    const parsedArgs = setRecurringReminderArgsSchema.parse(args);
    const localTime = parseLocalTime(parsedArgs.time);
    if (localTime === undefined) {
      return { ok: false, summary: `No entendí la hora "${parsedArgs.time}"; tiene que ser HH:MM` };
    }
    const offsetMinutes = Math.round(
      resolveTimeZoneOffsetMilliseconds(APOLLO_TIME_ZONE, context.nowMilliseconds) / 60_000,
    );
    let cron: string | undefined;
    let recurrence: string;
    if (parsedArgs.monthDay !== undefined) {
      cron = buildUtcMonthlyCronFromLocal({
        hour: localTime.hour,
        minute: localTime.minute,
        monthDay: parsedArgs.monthDay,
        offsetMinutes,
      });
      recurrence = describeMonthlyRecurrence(parsedArgs.monthDay, localTime.hour, localTime.minute);
    } else {
      const weekdayList = parsedArgs.days ?? [];
      cron = buildUtcCronFromLocal({
        hour: localTime.hour,
        minute: localTime.minute,
        weekdayList,
        offsetMinutes,
      });
      recurrence = describeRecurrence(weekdayList, localTime.hour, localTime.minute);
    }
    if (cron === undefined) {
      return { ok: false, summary: 'Ese día y hora no se pueden repetir cada mes; probá con un día del 1 al 28 y otra hora' };
    }
    const { nextFireMilliseconds, alreadyExisted } = await scheduleRecurringReminder({
      cron,
      message: parsedArgs.message,
      recurrence,
    });
    const nextLabel = new Intl.DateTimeFormat('es-AR', {
      timeZone: APOLLO_TIME_ZONE,
      weekday: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(nextFireMilliseconds));
    if (alreadyExisted) {
      return {
        ok: true,
        summary: `Ya existía un recordatorio ${recurrence} con ese mensaje; no lo dupliqué. El próximo suena el ${nextLabel}.`,
      };
    }
    return {
      ok: true,
      summary: `Recordatorio ${recurrence}: ${parsedArgs.message}. El primero suena el ${nextLabel}.`,
    };
  },
};

export const cancelReminderTool: ToolDefinition = {
  name: 'cancel_reminder',
  safety: 'safe',
  description: 'Cancela recordatorios por mensaje parcial o todos',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      cancelAll: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  async handler(args, context) {
    if (!context.effects) {
      return { ok: false, summary: 'Effects no disponibles' };
    }

    const parsedArgsResult = cancelReminderArgsSchema.safeParse(args);
    if (!parsedArgsResult.success) {
      return {
        ok: false,
        summary: 'Indicá un mensaje o cancelAll',
      };
    }

    const parsedArgs = parsedArgsResult.data;
    const isCancelAll = parsedArgs.cancelAll === true;
    const cancelResult = await context.effects.cancelReminders({
      message: parsedArgs.message,
      cancelAll: isCancelAll,
    });

    const summary = formatCancelRemindersSummary({
      cancelledMessageList: cancelResult.cancelledMessageList,
      searchedMessage: isCancelAll ? undefined : parsedArgs.message,
    });

    if (isCancelAll) {
      return { ok: true, summary, data: cancelResult };
    }

    return {
      ok: cancelResult.cancelledCount > 0,
      summary,
      data: cancelResult,
    };
  },
};
