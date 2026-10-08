import { formatTimeUntil } from '@/idle/rotator';
import type { ServerToDeviceMessage } from '@/protocol/schema';
import type { DeskWeatherSnapshot } from '@/weather/fetch';

// Armado del tablero que se le manda a la placa.
//
// La rotación de reposo mostraba UN dato por vez porque el motor de caras solo
// sabía dibujar una franja de texto. Con LVGL la pantalla muestra todo junto, y
// eso cambia la forma del mensaje: en vez de un `caption`, un payload con una
// entrada por tarjeta.
//
// El mensaje `dashboard` YA existe en el protocolo (con `clock` y `weather`),
// solo que el firmware nunca le dio UI. Se lo extiende con las tarjetas nuevas
// en vez de inventar un mensaje paralelo, y el clima conserva la forma de
// `DeskWeatherSnapshot` para no tener dos formatos de lo mismo.
//
// El módulo es puro: recibe los datos ya resueltos y devuelve el objeto que
// viaja por el WebSocket. Los recortes viven acá y no en el firmware, porque
// ajustar un número en TypeScript es gratis y en C cuesta un reflasheo.

// Límites que impone la pantalla de 800x480 con el reparto de la opción A.
export const DASHBOARD_AGENDA_MAX_ENTRY_COUNT = 2;
export const DASHBOARD_PENDING_MAX_ITEM_COUNT = 4;
// Medido en la placa: 34 caracteres no entraban en los 288px de la columna y
// LVGL los recortaba con puntos, que se lee peor que un corte por palabra hecho
// acá. Los ítems son notas libres y pueden ser larguísimos: en una tarjeta que
// se mira de reojo importa reconocer cuál es, no leerlo entero.
export const DASHBOARD_PENDING_MAX_CHARACTER_COUNT = 24;
export const DASHBOARD_AGENDA_MAX_CHARACTER_COUNT = 22;

// El tipo se DERIVA del esquema del protocolo en vez de escribirse a mano.
// Así no pueden divergir, y sobre todo: agregar un campo al payload sin
// declararlo en el esquema pasa a ser un error de compilación en vez de un
// campo que `encodeServerToDeviceMessage` descarta en silencio.
export type DashboardPayload = Extract<ServerToDeviceMessage, { type: 'dashboard' }>;
export type DashboardAgendaEntry = NonNullable<DashboardPayload['agendaList']>[number];
export type DashboardPendingTile = NonNullable<DashboardPayload['pending']>;
export type DashboardTravelTile = NonNullable<DashboardPayload['travel']>;

export type DashboardSourceData = {
  readonly weather?: DeskWeatherSnapshot;
  readonly clock?: { readonly timezone: string; readonly isoNow: string };
  // Eventos del calendario y recordatorios se mezclan en una sola lista: para
  // quien mira la pantalla las dos cosas son "algo que se viene", y separarlas
  // en dos tarjetas gastaría el doble de espacio para la mitad de información.
  readonly calendarEventList?: readonly {
    readonly title: string;
    readonly startsAtMilliseconds: number;
  }[];
  readonly reminderList?: readonly {
    readonly text: string;
    readonly dueAtMilliseconds: number;
  }[];
  readonly pending?: {
    readonly listName: string;
    readonly count: number;
    readonly itemList: readonly string[];
  };
  readonly travel?: { readonly destinationLabel: string; readonly minutes: number };
  readonly nowMilliseconds: number;
};

// "Sin datos" es lo que devuelve el clima cuando el proveedor falla: dejar la
// tarjeta afuera se lee mejor que mostrarla vacía.
const UNAVAILABLE_CONDITION_LABEL = 'Sin datos';

export function clipDashboardText(text: string, maximumCharacterCount: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maximumCharacterCount) {
    return collapsed;
  }
  const clipped = collapsed.slice(0, maximumCharacterCount);
  const lastSpaceIndex = clipped.lastIndexOf(' ');
  // Un corte muy al principio deja una palabra sola y se entiende menos que
  // cortar al medio de la última.
  const trimmed = lastSpaceIndex > maximumCharacterCount / 2
    ? clipped.slice(0, lastSpaceIndex)
    : clipped;
  return `${trimmed}…`;
}

export function buildDashboardPayload(input: DashboardSourceData): DashboardPayload {
  const payload: DashboardPayload = { type: 'dashboard', agendaList: [] };

  if (input.clock !== undefined) {
    payload.clock = input.clock;
  }

  // El clima viaja con la forma de upstream y sin redondear: cuántos decimales
  // mostrar es decisión de la pantalla, no del servidor.
  if (
    input.weather !== undefined &&
    input.weather.conditionLabel !== UNAVAILABLE_CONDITION_LABEL
  ) {
    payload.weather = input.weather;
  }

  const upcomingList = [
    ...(input.calendarEventList ?? []).map((event) => ({
      title: event.title,
      atMilliseconds: event.startsAtMilliseconds,
    })),
    ...(input.reminderList ?? []).map((reminder) => ({
      title: reminder.text,
      atMilliseconds: reminder.dueAtMilliseconds,
    })),
  ]
    .filter((entry) => Number.isFinite(entry.atMilliseconds))
    // Lo que ya pasó no es agenda. El recordatorio que suena justo ahora lo
    // anuncia la voz, no hace falta que además ocupe la tarjeta.
    .filter((entry) => entry.atMilliseconds > input.nowMilliseconds)
    .sort((left, right) => left.atMilliseconds - right.atMilliseconds)
    .slice(0, DASHBOARD_AGENDA_MAX_ENTRY_COUNT);

  payload.agendaList = upcomingList.map((entry) => ({
    title: clipDashboardText(entry.title, DASHBOARD_AGENDA_MAX_CHARACTER_COUNT),
    whenLabel: formatTimeUntil(entry.atMilliseconds, input.nowMilliseconds),
  }));

  if (input.pending !== undefined && input.pending.count > 0) {
    payload.pending = {
      listName: input.pending.listName,
      count: input.pending.count,
      itemList: input.pending.itemList
        .slice(0, DASHBOARD_PENDING_MAX_ITEM_COUNT)
        .map((item) => clipDashboardText(item, DASHBOARD_PENDING_MAX_CHARACTER_COUNT))
        .filter((item) => item.length > 0),
    };
  }

  if (input.travel !== undefined) {
    payload.travel = {
      label: input.travel.destinationLabel,
      minutes: Math.round(input.travel.minutes),
    };
  }

  return payload;
}

/**
 * Compara dos tableros por contenido. La placa se repinta con cada mensaje, así
 * que mandar uno idéntico es trabajo y parpadeo al pedo: el supervisor solo
 * empuja cuando algo cambió de verdad.
 */
export function isSameDashboardPayload(
  left: DashboardPayload,
  right: DashboardPayload,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
