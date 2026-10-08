import { z } from 'zod';

// Aviso de "salí ahora" para llegar a horario a un lugar.
//
// El pedido: "cuando digo que voy a ir a un lugar a X hora, avisame de 5 a 10
// minutos antes del horario que tengo que salir".
//
// POR QUE NO SE USA EL MCP DE MAPS.
//
// `maps_distance_matrix` del MCP no acepta hora de salida, asi que devuelve el
// tiempo tipico y NO el de trafico. Para esto es justo lo que hace falta:
// decidir a las 10 de la mañana cuanto vas a tardar a las 18 sin modelar el
// trafico da un numero que no sirve. La API REST de Google si acepta
// `departure_time` y devuelve `duration_in_traffic` — medido desde la Pi, para
// un viaje de prueba al Obelisco daba 23 min ahora y 19 min a las 18 de mañana.
//
// Ademas esto es PUSH, no conversacion: la tool solo toma el pedido y todo el
// calculo vive del lado del servidor, que ademas puede reintentarlo desde un
// schedule. Una tool fina cuesta casi nada de prompt.

export const DEFAULT_TRAVEL_MODE = 'driving';

// "De 5 a 10 minutos antes": 7 queda en el medio y deja margen para ponerse
// las zapatillas sin que el aviso llegue tan temprano que lo ignores.
export const DEPARTURE_ALERT_BUFFER_MINUTES = 7;

// El trafico se vuelve a consultar una hora antes de salir. La prediccion de
// Google para dentro de ocho horas es buena, pero no sabe del choque que pasó
// hace diez minutos. Mismo patron que el resto del sistema: el schedule no
// dispara el aviso, dispara un calculo.
export const DEPARTURE_RECOMPUTE_LEAD_MINUTES = 60;

// Un schedule con delay 0 o negativo no es valido: si el momento ya pasó, se
// dispara casi en el acto.
const MINIMUM_SCHEDULE_DELAY_SECONDS = 5;

const BUENOS_AIRES_TIME_ZONE = 'America/Argentina/Buenos_Aires';

export type TravelEstimate = {
  readonly travelSeconds: number;
  // false = Google devolvio solo el tiempo tipico. Se dice en el aviso: un
  // numero sin trafico merece menos confianza y el usuario tiene que saberlo.
  readonly usedTrafficModel: boolean;
};

export function buildDistanceMatrixUrl(input: {
  readonly origin: string;
  readonly destination: string;
  readonly apiKey: string;
  readonly departureEpochSeconds: number;
  readonly mode?: string;
}): string {
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', input.origin);
  url.searchParams.set('destinations', input.destination);
  url.searchParams.set('mode', input.mode ?? DEFAULT_TRAVEL_MODE);
  // Google rechaza una hora de salida en el pasado: se usa "ahora" como piso.
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  url.searchParams.set(
    'departure_time',
    String(Math.max(nowEpochSeconds, Math.floor(input.departureEpochSeconds))),
  );
  url.searchParams.set('traffic_model', 'best_guess');
  url.searchParams.set('key', input.apiKey);
  return url.toString();
}

// Se lee defensivamente: la respuesta trae un status arriba y otro por
// elemento, y una direccion que Google no encuentra devuelve 200 igual.
export function parseDistanceMatrixTravelSeconds(payload: unknown): TravelEstimate | undefined {
  const root = payload as { status?: unknown; rows?: readonly unknown[] };
  if (root?.status !== 'OK') {
    return undefined;
  }
  const element = (root.rows?.[0] as { elements?: readonly unknown[] })?.elements?.[0] as
    | {
        status?: unknown;
        duration?: { value?: unknown };
        duration_in_traffic?: { value?: unknown };
      }
    | undefined;
  if (element?.status !== 'OK') {
    return undefined;
  }
  const trafficSeconds = element.duration_in_traffic?.value;
  if (typeof trafficSeconds === 'number' && Number.isFinite(trafficSeconds)) {
    return { travelSeconds: Math.round(trafficSeconds), usedTrafficModel: true };
  }
  const plainSeconds = element.duration?.value;
  if (typeof plainSeconds === 'number' && Number.isFinite(plainSeconds)) {
    return { travelSeconds: Math.round(plainSeconds), usedTrafficModel: false };
  }
  return undefined;
}

export type DeparturePlan = {
  readonly departureMilliseconds: number;
  readonly alertMilliseconds: number;
  readonly alertDelaySeconds: number;
  // El viaje no entra en el tiempo que queda: hay que salir ya (o llegar tarde).
  readonly isAlreadyLate: boolean;
};

export function computeDeparturePlan(input: {
  readonly arrivalMilliseconds: number;
  readonly travelSeconds: number;
  readonly nowMilliseconds: number;
  readonly bufferMinutes?: number;
}): DeparturePlan {
  const bufferMilliseconds =
    (input.bufferMinutes ?? DEPARTURE_ALERT_BUFFER_MINUTES) * 60 * 1000;
  const departureMilliseconds = input.arrivalMilliseconds - input.travelSeconds * 1000;
  const alertMilliseconds = departureMilliseconds - bufferMilliseconds;
  const rawDelaySeconds = Math.round((alertMilliseconds - input.nowMilliseconds) / 1000);
  return {
    departureMilliseconds,
    alertMilliseconds,
    alertDelaySeconds: Math.max(MINIMUM_SCHEDULE_DELAY_SECONDS, rawDelaySeconds),
    isAlreadyLate: departureMilliseconds <= input.nowMilliseconds,
  };
}

// Hora de pared en Buenos Aires.
//
// Con opciones explicitas y hour12: false a proposito. `toLocaleString` pelado
// NO sirve en este contenedor: al ICU le falta el marcador AM/PM del locale
// es-AR y las 18:45 salen como "06:45". Costo perseguir un bug que no existia.
export function formatBuenosAiresClockTime(milliseconds: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BUENOS_AIRES_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(milliseconds));
}

export function describeMinutes(totalSeconds: number): string {
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  return minutes === 1 ? '1 minuto' : `${minutes} minutos`;
}

// El texto lo lee el TTS en voz alta, asi que va en frases cortas y sin
// abreviaturas.
export function buildDepartureAlertMessage(input: {
  readonly placeLabel: string;
  readonly arrivalMilliseconds: number;
  readonly travelSeconds: number;
  readonly usedTrafficModel: boolean;
  readonly isAlreadyLate: boolean;
  readonly bufferMinutes?: number;
}): string {
  const arrivalText = formatBuenosAiresClockTime(input.arrivalMilliseconds);
  const travelText = describeMinutes(input.travelSeconds);
  const trafficNote = input.usedTrafficModel ? '' : ' Ojo que es sin datos de tráfico.';

  if (input.isAlreadyLate) {
    return `Salí ya hacia ${input.placeLabel}. El viaje está en ${travelText} y tenías que llegar a las ${arrivalText}.${trafficNote}`;
  }
  const bufferText = describeMinutes(
    (input.bufferMinutes ?? DEPARTURE_ALERT_BUFFER_MINUTES) * 60,
  );
  return `En ${bufferText} salí hacia ${input.placeLabel}. El viaje está en ${travelText} y llegás a las ${arrivalText}.${trafficNote}`;
}

// Si falta mucho para salir conviene volver a preguntar mas cerca: la
// prediccion mejora y aparecen los cortes del dia.
export function shouldRecomputeBeforeDeparture(input: {
  readonly departureMilliseconds: number;
  readonly nowMilliseconds: number;
}): boolean {
  const leadMilliseconds = DEPARTURE_RECOMPUTE_LEAD_MINUTES * 60 * 1000;
  return input.departureMilliseconds - input.nowMilliseconds > leadMilliseconds;
}

export function computeRecomputeDelaySeconds(input: {
  readonly departureMilliseconds: number;
  readonly nowMilliseconds: number;
}): number {
  const atMilliseconds =
    input.departureMilliseconds - DEPARTURE_RECOMPUTE_LEAD_MINUTES * 60 * 1000;
  return Math.max(
    MINIMUM_SCHEDULE_DELAY_SECONDS,
    Math.round((atMilliseconds - input.nowMilliseconds) / 1000),
  );
}

export async function fetchTravelEstimate(input: {
  readonly origin: string;
  readonly destination: string;
  readonly apiKey: string;
  readonly departureEpochSeconds: number;
  readonly mode?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<TravelEstimate | undefined> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const response = await fetchImplementation(buildDistanceMatrixUrl(input));
  if (!response.ok) {
    return undefined;
  }
  return parseDistanceMatrixTravelSeconds(await response.json());
}

// El payload del schedule de recalculo viaja por SQLite y vuelve como unknown:
// se valida al leerlo, igual que el resto de los callbacks del host.

export const recomputeDeparturePayloadSchema = z.object({
  placeLabel: z.string().min(1),
  destination: z.string().min(1),
  arrivalMilliseconds: z.number().int().positive(),
});

function readHostEnvironmentValue(name: string): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[name]?.trim();
}

// El origen por defecto es la casa. Ya existia como IDLE_TRAVEL_ORIGIN para la
// tarjeta de viaje del tablero, asi que se reusa en vez de agregar otra
// variable que pueda quedar desincronizada.
export function resolveTravelOrigin(): string | undefined {
  const origin = readHostEnvironmentValue('IDLE_TRAVEL_ORIGIN');
  return origin === undefined || origin.length === 0 ? undefined : origin;
}

export function resolveGoogleMapsApiKey(): string | undefined {
  const key = readHostEnvironmentValue('GOOGLE_MAPS_API_KEY');
  return key === undefined || key.length === 0 ? undefined : key;
}

export function areDepartureAlertsEnabled(): boolean {
  return (readHostEnvironmentValue('DEPARTURE_ALERTS') ?? 'on') !== 'off';
}

// Orquestador: calcula el viaje y programa lo que corresponda.
//
// Vive aca y no dentro del actor porque hay DOS anfitriones que arman los
// efectos de las tools — el host de Bun (host/actor.ts) y el agente del Worker
// (agents/apollo.ts) — y duplicar esta logica en los dos es como se desincronizan.
// Las dependencias entran por parametro, asi que ademas se puede probar con un
// fetch falso, sin red ni reloj real.
export type DepartureAlertOutcome = {
  readonly ok: boolean;
  readonly summary: string;
};

export async function planAndScheduleDepartureAlert(input: {
  readonly placeLabel: string;
  readonly destination: string;
  readonly arrivalMilliseconds: number;
  readonly nowMilliseconds: number;
  // true cuando lo dispara el schedule de recalculo: ahi ya no se vuelve a
  // posponer, se programa el aviso definitivo.
  readonly isRecompute?: boolean;
  readonly schedule: (
    delaySeconds: number,
    callback: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  readonly listScheduledReminderMessages: () => Promise<readonly string[]>;
  readonly fetchImplementation?: typeof fetch;
  readonly log?: (entry: Record<string, unknown>) => void;
}): Promise<DepartureAlertOutcome> {
  if (!areDepartureAlertsEnabled()) {
    return { ok: false, summary: 'Los avisos para salir están apagados' };
  }
  const apiKey = resolveGoogleMapsApiKey();
  const origin = resolveTravelOrigin();
  if (apiKey === undefined || origin === undefined) {
    return { ok: false, summary: 'Me falta la configuración del mapa para calcular el viaje' };
  }
  if (input.arrivalMilliseconds <= input.nowMilliseconds) {
    return { ok: false, summary: 'Esa hora ya pasó' };
  }

  const pedirViaje = async (departureMilliseconds: number) =>
    await fetchTravelEstimate({
      origin,
      destination: input.destination,
      apiKey,
      departureEpochSeconds: Math.floor(departureMilliseconds / 1000),
      fetchImplementation: input.fetchImplementation,
    });

  // Primera consulta usando la hora de LLEGADA como hora de salida: es una cota
  // superior util y evita adivinar la salida antes de conocer el viaje.
  let estimate = await pedirViaje(input.arrivalMilliseconds);
  if (estimate === undefined) {
    return { ok: false, summary: `No pude calcular el viaje hasta ${input.placeLabel}` };
  }

  // Segunda pasada solo en viajes largos: ahi la salida cae en otra franja de
  // transito y la primera estimacion se corre. En viajes cortos no cambia nada
  // y seria una llamada paga al pedo.
  if (estimate.travelSeconds > 30 * 60) {
    const refined = await pedirViaje(
      input.arrivalMilliseconds - estimate.travelSeconds * 1000,
    );
    if (refined !== undefined) {
      estimate = refined;
    }
  }

  const plan = computeDeparturePlan({
    arrivalMilliseconds: input.arrivalMilliseconds,
    travelSeconds: estimate.travelSeconds,
    nowMilliseconds: input.nowMilliseconds,
  });

  if (
    input.isRecompute !== true &&
    shouldRecomputeBeforeDeparture({
      departureMilliseconds: plan.departureMilliseconds,
      nowMilliseconds: input.nowMilliseconds,
    })
  ) {
    await input.schedule(
      computeRecomputeDelaySeconds({
        departureMilliseconds: plan.departureMilliseconds,
        nowMilliseconds: input.nowMilliseconds,
      }),
      'recomputeDeparture',
      {
        placeLabel: input.placeLabel,
        destination: input.destination,
        arrivalMilliseconds: input.arrivalMilliseconds,
      },
    );
    input.log?.({
      level: 'info',
      message: 'salida_recalculo_programado',
      lugar: input.placeLabel,
      viajeMinutos: Math.round(estimate.travelSeconds / 60),
      salidaEstimada: formatBuenosAiresClockTime(plan.departureMilliseconds),
    });
    return {
      ok: true,
      summary: `Listo. Con el tránsito de ahora saldrías a las ${formatBuenosAiresClockTime(plan.departureMilliseconds)}; lo recalculo más cerca y te aviso.`,
    };
  }

  const alertMessage = buildDepartureAlertMessage({
    placeLabel: input.placeLabel,
    arrivalMilliseconds: input.arrivalMilliseconds,
    travelSeconds: estimate.travelSeconds,
    usedTrafficModel: estimate.usedTrafficModel,
    isAlreadyLate: plan.isAlreadyLate,
  });

  // Pedirlo dos veces no programa dos avisos: el texto es determinista.
  const alreadyScheduled = await input.listScheduledReminderMessages();
  if (!alreadyScheduled.includes(alertMessage)) {
    await input.schedule(plan.alertDelaySeconds, 'deliverReminder', { message: alertMessage });
  }

  input.log?.({
    level: 'info',
    message: 'salida_aviso_programado',
    lugar: input.placeLabel,
    viajeMinutos: Math.round(estimate.travelSeconds / 60),
    conTrafico: estimate.usedTrafficModel,
    yaEsTarde: plan.isAlreadyLate,
  });

  if (plan.isAlreadyLate) {
    return {
      ok: true,
      summary: `Con ${describeMinutes(estimate.travelSeconds)} de viaje ya tendrías que estar saliendo hacia ${input.placeLabel}.`,
    };
  }
  return {
    ok: true,
    summary: `Te aviso a las ${formatBuenosAiresClockTime(plan.alertMilliseconds)} para salir hacia ${input.placeLabel}. El viaje está en ${describeMinutes(estimate.travelSeconds)}.`,
  };
}
