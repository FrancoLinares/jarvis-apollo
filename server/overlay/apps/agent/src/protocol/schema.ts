import { z } from 'zod';

export const deskUiStateSchema = z.enum([
  'idle',
  'listening',
  'thinking',
  'confirm',
  'speaking',
  'focus',
  'dashboard',
]);

export type DeskUiStateName = z.infer<typeof deskUiStateSchema>;

export const deskFaceEmotionSchema = z.enum([
  'neutral',
  'curious',
  'focused',
  'questioning',
  'talking',
  'calm',
]);

export type DeskFaceEmotionName = z.infer<typeof deskFaceEmotionSchema>;

export const deviceGestureSchema = z.enum([
  'tap',
  'double_tap',
  'swipe_left',
  'swipe_right',
]);

export const deskSoundEffectSchema = z.enum(['ding', 'chime', 'error', 'low_battery']);

export type DeskSoundEffectName = z.infer<typeof deskSoundEffectSchema>;

export const confirmCloseReasonSchema = z.enum(['resolved', 'expired', 'orphaned']);

export type ConfirmCloseReasonName = z.infer<typeof confirmCloseReasonSchema>;

export const deviceToServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    deviceId: z.string().min(1),
    ts: z.number().int().nonnegative(),
    // Lo que sabe hacer este firmware. "reminder_seen": avisa cuando se
    // descarta un recordatorio de la pantalla.
    features: z.array(z.string().max(40)).max(20).optional(),
  }),
  // El recordatorio a pantalla completa se descartó (toque o empezar a hablar).
  z.object({
    type: z.literal('reminder_seen'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('hold_start'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('hold_end'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('wake'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('audio_end'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('listen_cancel'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('gesture'),
    gesture: deviceGestureSchema,
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('confirm'),
    ok: z.boolean(),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('text_input'),
    text: z.string().min(1),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('abort'),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('telemetry'),
    battery: z.number().int().nonnegative().max(100).optional(),
    charging: z.boolean().optional(),
    volume: z.number().int().nonnegative().optional(),
    wifiRssi: z.number().int().optional(),
    firmwareVersion: z.string().min(1).optional(),
    ts: z.number().int().nonnegative(),
  }),
  // Al conectarse después de un arranque, la placa cuenta por qué se reinició:
  // el motivo del chip (energía, pánico, watchdog, esp_restart), lo que anotó el
  // guardián del firmware antes de reiniciar, y el resumen del volcado si hubo un
  // cuelgue. Sin esto una placa que "se quedó muda" y volvió no deja rastro.
  z.object({
    type: z.literal('boot_report'),
    resetReason: z.string().min(1).max(40),
    guardianReason: z.string().max(200).optional(),
    crash: z
      .object({
        task: z.string().max(40).optional(),
        pc: z.string().max(20).optional(),
        backtrace: z.string().max(600).optional(),
      })
      .optional(),
    firmwareVersion: z.string().min(1).max(40).optional(),
  }),
  z.object({
    type: z.literal('mcp'),
    payload: z.object({
      jsonrpc: z.literal('2.0'),
      id: z.number().int(),
      result: z.unknown().optional(),
      error: z
        .object({
          code: z.number().int().optional(),
          message: z.string().min(1),
        })
        .optional(),
    }),
    ts: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('playback_ack'),
    sequence: z.number().int().nonnegative(),
    playedMilliseconds: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
  }),
]);

export type DeviceToServerMessage = z.infer<typeof deviceToServerMessageSchema>;

export const serverToDeviceMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ui_state'),
    state: deskUiStateSchema,
    speechMode: z.string().min(1),
    caption: z.string().optional(),
    focusRemainingSec: z.number().int().nonnegative().optional(),
    // Epoch seconds: ui_state pushes are event-driven, so the device needs the
    // whole window to count down locally between pushes.
    focusStartedAt: z.number().int().nonnegative().optional(),
    focusEndsAt: z.number().int().nonnegative().optional(),
    emotion: deskFaceEmotionSchema.optional(),
    accentColor: z.string().optional(),
    // Ánimo de la respuesta ([[cara:...]] del modelo): la cara de Einstein lo
    // usa mientras habla. Firmware viejo lo ignora.
    mood: z.enum(['festejo', 'triste', 'apurado', 'pensativo']).optional(),
  }),
  z.object({
    type: z.literal('confirm_request'),
    id: z.string().min(1),
    summary: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('confirm_close'),
    id: z.string().min(1),
    reason: confirmCloseReasonSchema,
  }),
  z.object({
    type: z.literal('tts_start'),
    format: z.enum(['mp3', 'wav', 'pcm']),
    // Optional since tts_end closes runs; firmware before 2.7.0 treats a
    // missing total as an empty run, so keep sending it whenever it is known.
    bytes: z.number().int().nonnegative().optional(),
    sequence: z.number().int().nonnegative().optional(),
    sampleRate: z.number().int().positive().optional(),
    channels: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('tts_end'),
  }),
  z.object({
    type: z.literal('tts_aborted'),
  }),
  z.object({
    type: z.literal('timer'),
    // Epoch seconds; both absent means clear whatever arc is showing.
    endsAt: z.number().int().nonnegative().optional(),
    durationSeconds: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('turn_end'),
    expectsReply: z.boolean(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
  // Tablero de la pantalla. `clock` y `weather` ya existían pero eran
  // obligatorios: pasan a opcionales porque una tarjeta puede no tener dato
  // (el clima se cae, todavía no hay destino de viaje) y el resto tiene que
  // poder viajar igual. Las tarjetas nuevas son las de la opción A del diseño.
  //
  // OJO: `encodeServerToDeviceMessage` hace `schema.parse()`, que DESCARTA las
  // claves que no estén acá. Un campo que se agregue al payload y no a este
  // esquema desaparece en silencio.
  z.object({
    type: z.literal('dashboard'),
    clock: z
      .object({
        timezone: z.string().min(1),
        isoNow: z.string().min(1),
      })
      .optional(),
    weather: z
      .object({
        locationLabel: z.string().min(1),
        temperatureC: z.number(),
        conditionLabel: z.string().min(1),
        updatedAt: z.string().min(1),
      })
      .optional(),
    agendaList: z
      .array(
        z.object({
          title: z.string().min(1),
          whenLabel: z.string().min(1),
        }),
      )
      .optional(),
    pending: z
      .object({
        listName: z.string().min(1),
        count: z.number().int().nonnegative(),
        itemList: z.array(z.string().min(1)),
      })
      .optional(),
    travel: z
      .object({
        label: z.string().min(1),
        minutes: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('background_result'),
    summary: z.string().min(1),
    prompt: z.string().min(1),
    documentKey: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('reminder'),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal('play_effect'),
    name: deskSoundEffectSchema,
  }),
  z.object({
    type: z.literal('mcp'),
    payload: z.object({
      jsonrpc: z.literal('2.0'),
      // The device's McpServer silently drops string ids, so the integer
      // constraint here is what keeps every request answerable.
      id: z.number().int(),
      method: z.string().min(1),
      params: z.record(z.unknown()).optional(),
    }),
  }),
]);

export type ServerToDeviceMessage = z.infer<typeof serverToDeviceMessageSchema>;

export function parseDeviceToServerMessage(
  rawMessageText: string,
): DeviceToServerMessage {
  return deviceToServerMessageSchema.parse(JSON.parse(rawMessageText));
}

export function encodeServerToDeviceMessage(message: ServerToDeviceMessage): string {
  return JSON.stringify(serverToDeviceMessageSchema.parse(message));
}
