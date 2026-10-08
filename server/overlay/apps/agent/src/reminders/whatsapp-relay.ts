// Cuándo un recordatorio también (o en vez de la placa) va por WhatsApp.
// Decidido el 2026-10-01:
//   - placa desconectada al momento del aviso → WhatsApp en vez de la cola;
//   - sonó en la placa y en 10 minutos nadie lo vio → WhatsApp además.

export const REMINDER_SEEN_TIMEOUT_SECONDS = 600;

export function formatReminderForWhatsApp(message: string): string {
  return `⏰ ${message}`;
}

export function shouldRelayOfflineReminder(input: {
  readonly whatsAppConfigured: boolean;
  readonly connectedDeviceCount: number;
}): boolean {
  return input.whatsAppConfigured && input.connectedDeviceCount === 0;
}

// Hace falta que la placa sepa avisar que se descartó el recordatorio
// (firmware con "reminder_seen"). Con firmware viejo el descarte por toque no
// llega al servidor y esto mandaría un WhatsApp por cada aviso ya visto.
export function shouldWatchReminderSeen(input: {
  readonly whatsAppConfigured: boolean;
  readonly deviceReportsReminderSeen: boolean;
  readonly connectedDeviceCount: number;
}): boolean {
  return (
    input.whatsAppConfigured && input.deviceReportsReminderSeen && input.connectedDeviceCount > 0
  );
}

// Visto = la placa avisó que lo descartaron, o el usuario habló/tocó la placa
// después de que sonó.
export function wasReminderSeen(input: {
  readonly deliveredAtMilliseconds: number;
  readonly lastUserActivityAtMilliseconds: number | undefined;
}): boolean {
  return (
    input.lastUserActivityAtMilliseconds !== undefined &&
    input.lastUserActivityAtMilliseconds >= input.deliveredAtMilliseconds
  );
}
