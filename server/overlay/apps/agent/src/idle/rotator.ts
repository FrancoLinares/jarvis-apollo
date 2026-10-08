// Qué muestra la pantalla cuando Jarvis no está haciendo nada.
//
// En reposo el dispositivo mostraba solo la cara y el reloj. Esta rotación
// aprovecha ese rato para dar información útil de un vistazo.
//
// El módulo es puro a propósito: recibe los datos ya resueltos y devuelve los
// carteles. Quien lo usa decide cada cuánto rota y de dónde saca los datos, y
// así todo el armado de texto queda testeable sin red ni relojes.
//
// Cada fuente es opcional y la que no tiene datos no ocupa lugar en el ciclo:
// eso deja cablear las fuentes de a una sin que la pantalla muestre huecos.

export type IdleWeatherSnapshot = {
  readonly locationLabel: string;
  readonly temperatureC: number;
  readonly conditionLabel: string;
};

export type IdleReminder = {
  readonly text: string;
  /** Epoch en milisegundos. */
  readonly dueAtMilliseconds: number;
};

export type IdleCalendarEvent = {
  readonly title: string;
  /** Epoch en milisegundos. */
  readonly startsAtMilliseconds: number;
};

export type IdleTravelTime = {
  readonly destinationLabel: string;
  readonly minutes: number;
};

export type IdlePendingList = {
  readonly listName: string;
  readonly count: number;
};

export type IdleNote = {
  readonly content: string;
};

export type IdleCaptionInput = {
  readonly nextCalendarEvent?: IdleCalendarEvent;
  readonly nextReminder?: IdleReminder;
  readonly travelTime?: IdleTravelTime;
  readonly weather?: IdleWeatherSnapshot;
  readonly pendingList?: IdlePendingList;
  readonly lastNote?: IdleNote;
  readonly nowMilliseconds: number;
};

// "Sin datos" es lo que devuelve el clima cuando el proveedor falla: mostrarlo
// en la pantalla de reposo sería peor que no mostrar nada.
const UNAVAILABLE_CONDITION_LABEL = 'Sin datos';

// Una nota puede ser larga. La franja scrollea, pero un texto de tres renglones
// dando vueltas en loop cansa más de lo que informa: se corta por palabra.
const NOTE_MAX_CHARACTER_COUNT = 52;

const MINUTE_MILLISECONDS = 60_000;
const HOUR_MILLISECONDS = 60 * MINUTE_MILLISECONDS;
const DAY_MILLISECONDS = 24 * HOUR_MILLISECONDS;

/** "en 20 minutos", "en 3 horas", "mañana" — hablado, no una fecha cruda. */
export function formatTimeUntil(
  dueAtMilliseconds: number,
  nowMilliseconds: number,
): string {
  const remaining = dueAtMilliseconds - nowMilliseconds;
  if (remaining <= 0) {
    return 'ahora';
  }
  if (remaining < MINUTE_MILLISECONDS) {
    return 'en menos de un minuto';
  }
  if (remaining < HOUR_MILLISECONDS) {
    const minutes = Math.round(remaining / MINUTE_MILLISECONDS);
    return `en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  }
  if (remaining < DAY_MILLISECONDS) {
    const hours = Math.round(remaining / HOUR_MILLISECONDS);
    return `en ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  }
  const days = Math.round(remaining / DAY_MILLISECONDS);
  return days === 1 ? 'mañana' : `en ${days} días`;
}

export function truncateNoteContent(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= NOTE_MAX_CHARACTER_COUNT) {
    return collapsed;
  }
  const clipped = collapsed.slice(0, NOTE_MAX_CHARACTER_COUNT);
  const lastSpaceIndex = clipped.lastIndexOf(' ');
  const trimmed = lastSpaceIndex > 20 ? clipped.slice(0, lastSpaceIndex) : clipped;
  return `${trimmed}…`;
}

/**
 * El orden es el de la rotación, y va de lo más perecedero a lo más estable:
 * un evento que empieza en diez minutos importa más que una nota de la semana
 * pasada. El clima queda en el medio porque es lo que más se mira de reojo.
 */
export function buildIdleCaptionList(input: IdleCaptionInput): readonly string[] {
  const captionList: string[] = [];

  if (input.nextCalendarEvent !== undefined) {
    const whenLabel = formatTimeUntil(
      input.nextCalendarEvent.startsAtMilliseconds,
      input.nowMilliseconds,
    );
    captionList.push(`Agenda: ${input.nextCalendarEvent.title} · ${whenLabel}`);
  }

  if (input.nextReminder !== undefined) {
    const whenLabel = formatTimeUntil(
      input.nextReminder.dueAtMilliseconds,
      input.nowMilliseconds,
    );
    captionList.push(`Recordar: ${input.nextReminder.text} · ${whenLabel}`);
  }

  if (input.travelTime !== undefined) {
    captionList.push(
      `${input.travelTime.destinationLabel}: ${Math.round(input.travelTime.minutes)} min`,
    );
  }

  if (
    input.weather !== undefined &&
    input.weather.conditionLabel !== UNAVAILABLE_CONDITION_LABEL
  ) {
    captionList.push(
      `${Math.round(input.weather.temperatureC)}° · ${input.weather.conditionLabel}`,
    );
  }

  // Una lista vacía no es noticia: solo se muestra si hay algo pendiente.
  if (input.pendingList !== undefined && input.pendingList.count > 0) {
    const noun = input.pendingList.count === 1 ? 'pendiente' : 'pendientes';
    captionList.push(
      `${input.pendingList.count} ${noun} en ${input.pendingList.listName}`,
    );
  }

  if (input.lastNote !== undefined) {
    const content = truncateNoteContent(input.lastNote.content);
    if (content.length > 0) {
      captionList.push(`“${content}”`);
    }
  }

  return captionList;
}

/**
 * Elige qué mostrar en cada vuelta. Se avanza por índice en vez de guardar
 * estado adentro: la lista cambia sola (aparece un recordatorio, se cae el
 * clima) y un índice viejo no debe romper nada.
 */
export function selectIdleCaption(
  captionList: readonly string[],
  rotationIndex: number,
): string | undefined {
  if (captionList.length === 0) {
    return undefined;
  }
  const safeIndex = ((rotationIndex % captionList.length) + captionList.length) %
    captionList.length;
  return captionList[safeIndex];
}
