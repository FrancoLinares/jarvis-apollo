// Vigilancia de eventos por busqueda web, para lo que NO tiene una API.
//
// Premier Padel es el caso que lo motiva: no publica API, y premierpadel.com
// es una SPA — /es/tournaments responde 200 pero sin __NEXT_DATA__ ni ld+json,
// asi que no hay nada que scrapear. Lo unico que queda es buscar.
//
// La diferencia con `web_search` es el FORMATO. `synthesizeQuickWebAnswer`
// devuelve prosa, que sirve para contestar y no para programar una alarma.
// Medido el 2026-09-08 preguntando por el calendario de Premier Padel: la
// respuesta mezclo torneos pasados y futuros (dio Madrid del 1 al 6 de
// septiembre, que ya habia pasado). De ahi salen las dos reglas de este modulo:
// se pide JSON, y **todo lo que este en el pasado se descarta aca**, sin
// confiar en que el modelo lo haya filtrado.

export type UpcomingEvent = {
  readonly title: string;
  readonly startsAtMilliseconds: number;
};

// Una fecha sin hora ("2026-09-28") se ancla al mediodia UTC, que son las 9 de
// la mañana en Buenos Aires. Un torneo que "empieza el 28" no empieza a las
// 00:00, y anclarlo a medianoche daria un aviso la noche anterior.
const DATE_ONLY_ANCHOR_HOUR_UTC = 12;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Mas de un año adelante es casi siempre un error de lectura del modelo, no un
// evento real que valga la pena agendar hoy.
const MAXIMUM_HORIZON_DAYS = 400;

export function buildEventExtractionInstruction(extractionHint: string): string {
  return [
    'Extraés eventos futuros de fuentes web y devolvés SOLO JSON, sin texto alrededor.',
    'Formato exacto: {"eventos":[{"titulo":"...","comienzaIso":"YYYY-MM-DD" o "YYYY-MM-DDTHH:mm:ssZ"}]}',
    'Reglas:',
    '- Solo eventos que TODAVIA NO EMPEZARON. Si ya pasó, no lo incluyas.',
    '- Si una fecha no está explícita en las fuentes, no la inventes: omití el evento.',
    '- Si no hay ningún evento futuro claro, devolvé {"eventos":[]}.',
    `- Qué buscar: ${extractionHint}`,
  ].join('\n');
}

// Los modelos envuelven el JSON en ```json aunque se les pida que no. Se
// recorta la cerca antes de parsear en vez de fallar por eso.
function stripCodeFence(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

export function parseExtractedEventList(
  rawText: string,
  nowMilliseconds: number,
): readonly UpcomingEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFence(rawText));
  } catch {
    return [];
  }
  const root = payload as { eventos?: unknown };
  if (!Array.isArray(root?.eventos)) {
    return [];
  }

  const eventList: UpcomingEvent[] = [];
  for (const rawEvent of root.eventos) {
    const event = rawEvent as { titulo?: unknown; comienzaIso?: unknown };
    if (typeof event?.titulo !== 'string' || typeof event?.comienzaIso !== 'string') {
      continue;
    }
    const title = event.titulo.trim();
    if (title.length === 0) {
      continue;
    }
    const rawDate = event.comienzaIso.trim();
    const isoText = DATE_ONLY_PATTERN.test(rawDate)
      ? `${rawDate}T${String(DATE_ONLY_ANCHOR_HOUR_UTC).padStart(2, '0')}:00:00Z`
      : rawDate;
    const startsAtMilliseconds = Date.parse(isoText);
    if (!Number.isFinite(startsAtMilliseconds)) {
      continue;
    }
    // La red de seguridad contra el modo de falla medido: el modelo devuelve
    // eventos pasados aunque se le pida lo contrario.
    if (startsAtMilliseconds <= nowMilliseconds) {
      continue;
    }
    if (startsAtMilliseconds - nowMilliseconds > MAXIMUM_HORIZON_DAYS * 24 * 3600 * 1000) {
      continue;
    }
    eventList.push({ title, startsAtMilliseconds });
  }

  return eventList.sort(
    (left, right) => left.startsAtMilliseconds - right.startsAtMilliseconds,
  );
}

export type EventAlert = {
  readonly message: string;
  readonly delaySeconds: number;
};

export function buildEventAlertMessage(event: UpcomingEvent, leadLabel: string): string {
  return `${event.title} ${leadLabel}.`;
}

export function selectEventAlerts(input: {
  readonly eventList: readonly UpcomingEvent[];
  readonly nowMilliseconds: number;
  readonly leadHours: number;
  readonly leadLabel: string;
  readonly horizonDays: number;
  readonly alreadyScheduledMessageList: readonly string[];
}): readonly EventAlert[] {
  const leadMilliseconds = input.leadHours * 3600 * 1000;
  const horizonMilliseconds = input.horizonDays * 24 * 3600 * 1000;
  const alreadyScheduled = new Set(input.alreadyScheduledMessageList);
  const alertList: EventAlert[] = [];

  for (const event of input.eventList) {
    const alertAtMilliseconds = event.startsAtMilliseconds - leadMilliseconds;
    if (alertAtMilliseconds <= input.nowMilliseconds) {
      continue;
    }
    if (alertAtMilliseconds - input.nowMilliseconds > horizonMilliseconds) {
      continue;
    }
    const message = buildEventAlertMessage(event, input.leadLabel);
    if (alreadyScheduled.has(message)) {
      continue;
    }
    alertList.push({
      message,
      delaySeconds: Math.round((alertAtMilliseconds - input.nowMilliseconds) / 1000),
    });
  }

  return alertList;
}

export async function extractUpcomingEvents(input: {
  readonly tavilyApiKey: string;
  readonly openRouterApiKey: string;
  readonly modelId: string;
  readonly query: string;
  readonly extractionHint: string;
  readonly nowMilliseconds: number;
  readonly maxResults?: number;
}): Promise<readonly UpcomingEvent[]> {
  const { searchWebSourcesWithTavily } = await import('@/search/tavily');
  const { chatWithOpenRouter } = await import('@/voice/llm');

  const sourceList = await searchWebSourcesWithTavily({
    tavilyApiKey: input.tavilyApiKey,
    query: input.query,
    maxResults: input.maxResults ?? 6,
  });
  if (sourceList.length === 0) {
    return [];
  }

  const sourceBlock = sourceList
    .map(
      (source, index) =>
        `[${index + 1}] ${source.title}\nURL: ${source.url}\n${source.text}`,
    )
    .join('\n\n');

  const chatResult = await chatWithOpenRouter({
    openRouterApiKey: input.openRouterApiKey,
    modelId: input.modelId,
    messageList: [
      { role: 'system', content: buildEventExtractionInstruction(input.extractionHint) },
      {
        role: 'user',
        content: `Hoy es ${new Date(input.nowMilliseconds).toISOString()}.\n\nFuentes:\n${sourceBlock}`,
      },
    ],
  });

  return parseExtractedEventList(chatResult.text, input.nowMilliseconds);
}

// Una vigilancia = una consulta + que extraer + cuanta anticipacion. Agregar un
// interes nuevo (un recital, otro torneo) es agregar una fila aca, no un modulo.
export type EventWatchDefinition = {
  readonly id: string;
  readonly query: string;
  readonly extractionHint: string;
  readonly leadHours: number;
  readonly leadLabel: string;
  readonly horizonDays: number;
};

export const PREMIER_PADEL_WATCH: EventWatchDefinition = {
  id: 'premier-padel',
  query: 'Premier Padel calendario proximos torneos fechas y sede',
  extractionHint:
    'torneos del circuito Premier Padel que todavía no empezaron, con su fecha de inicio',
  // Un dia antes: alcanza para acomodarse y no tan lejos como para olvidarlo.
  leadHours: 24,
  leadLabel: 'empieza mañana',
  horizonDays: 10,
};

// Diario a las 10:00 UTC (7 de la mañana en Buenos Aires).
//
// Semanal parecia alcanzar —los torneos se anuncian con semanas de
// anticipacion— pero deja dos huecos reales. Con el cron semanal registrado un
// martes, la primera corrida caia el lunes siguiente: un torneo que empezaba
// ESE lunes ya tenia su aviso (el dia anterior) en el pasado. Y cualquier
// corrida fallida abria una ventana ciega de siete dias.
//
// Diario cuesta ~30 busquedas al mes contra un tier gratuito de 1000, y
// convierte una corrida perdida en algo intrascendente. La deduplicacion por
// mensaje evita que se apilen avisos.
export const EVENT_WATCH_CHECK_CRON = '0 10 * * *';

function readHostEnvironmentValue(name: string): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[name];
}

export function areEventWatchesEnabled(): boolean {
  return readHostEnvironmentValue('EVENT_WATCHES') === 'on';
}
