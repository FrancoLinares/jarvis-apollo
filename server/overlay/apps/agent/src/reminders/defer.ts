// Un aviso no puede hablar encima de una respuesta.
//
// Pasó el 2026-09-27: "a la 1 tengo el cumpleaños, ¿a qué hora salgo?" programó
// el aviso de salida para dentro de 5 s (ya era la hora de avisar), y el aviso
// sonó mientras Jarvis todavía estaba armando la respuesta: dos audios juntos y
// la placa se trabó. Lo mismo le podía pasar a cualquier aviso (partidos, vencimientos)
// que cayera en medio de una charla.
//
// Mientras haya un turno en curso el aviso se corre unos segundos. Con tope: si
// el estado quedara trabado en "pensando", el aviso igual sale, tarde pero sale.

export const REMINDER_DEFER_SECONDS = 10;
export const REMINDER_MAX_DEFER_COUNT = 12;

const BUSY_UI_STATE_SET = new Set(['listening', 'thinking', 'speaking']);

export function shouldDeferReminder(input: {
  readonly uiState: string;
  readonly isSpeechInFlight: boolean;
  readonly deferCount: number;
}): boolean {
  if (input.deferCount >= REMINDER_MAX_DEFER_COUNT) {
    return false;
  }
  return input.isSpeechInFlight || BUSY_UI_STATE_SET.has(input.uiState);
}
