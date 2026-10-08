// Calendario de Premier Padel, leido de la fuente oficial de la FIP.
//
// POR QUE NO ALCANZABA CON BUSCAR.
//
// El primer intento fue Tavily + extraccion con LLM, porque premierpadel.com es
// una SPA sin datos estructurados. Contrastado contra el calendario de la FIP
// el 2026-09-08, de 6 torneos extraidos: 4 exactos, uno corrido un dia
// (Dubai P1: dijo 09/11, es 08/11) y uno INVENTADO ("Europe P2" el 14/09, que
// no existe — el modelo tomo por torneo las menciones de "Europe" del menu de
// rankings). Y el unico aviso que se habria programado era justo el inventado.
//
// padelfip.com/es/calendario-premier-padel sirve HTML del lado del servidor con
// las fechas en texto plano ("del 28/09/2026 al 04/10/2026"), asi que se puede
// leer sin modelo de por medio. Determinista, sin alucinaciones, gratis.
//
// La busqueda con LLM queda como respaldo para cuando esta pagina cambie.

export const PREMIER_PADEL_CALENDAR_URL =
  'https://www.padelfip.com/es/calendario-premier-padel';

export type PadelTournament = {
  readonly title: string;
  readonly startsAtMilliseconds: number;
  readonly endsAtMilliseconds: number;
  readonly venue: string;
};

// Una fecha sin hora se ancla al mediodia UTC = 9 de la mañana en Buenos Aires.
// Mismo criterio que events/watch.ts: un torneo que "empieza el 28" no empieza
// a las 00:00, y anclarlo a medianoche daria el aviso la noche anterior.
const DATE_ONLY_ANCHOR_HOUR_UTC = 12;

// El nombre en mayusculas, "del DD/MM/YYYY al DD/MM/YYYY", la sede, y el enlace
// que cierra cada fila. Anclar en "IR AL EVENTO" es lo que evita arrastrar
// texto del menu: sin ese ancla, cualquier titulo suelto de la pagina entra.
const TOURNAMENT_ROW_PATTERN =
  /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s\-.&]{3,60}?)\s+del\s+(\d{2}\/\d{2}\/\d{4})\s+al\s+(\d{2}\/\d{2}\/\d{4})\s+([A-Za-zÀ-ÿ\s-]+?)\s+IR AL EVENTO/g;

function parseDayMonthYear(text: string): number {
  const [day, month, year] = text.split('/').map((part) => Number(part));
  if (day === undefined || month === undefined || year === undefined) {
    return Number.NaN;
  }
  return Date.UTC(year, month - 1, day, DATE_ONLY_ANCHOR_HOUR_UTC);
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

export function parsePremierPadelCalendarHtml(html: string): readonly PadelTournament[] {
  const text = stripHtmlToText(html);
  const tournamentList: PadelTournament[] = [];

  for (const match of text.matchAll(TOURNAMENT_ROW_PATTERN)) {
    const [, rawTitle, rawStart, rawEnd, rawVenue] = match;
    if (
      rawTitle === undefined ||
      rawStart === undefined ||
      rawEnd === undefined ||
      rawVenue === undefined
    ) {
      continue;
    }
    const startsAtMilliseconds = parseDayMonthYear(rawStart);
    const endsAtMilliseconds = parseDayMonthYear(rawEnd);
    if (!Number.isFinite(startsAtMilliseconds) || !Number.isFinite(endsAtMilliseconds)) {
      continue;
    }
    // Un torneo que termina antes de empezar es una fila mal leida.
    if (endsAtMilliseconds < startsAtMilliseconds) {
      continue;
    }
    tournamentList.push({
      title: rawTitle.trim(),
      startsAtMilliseconds,
      endsAtMilliseconds,
      venue: rawVenue.trim(),
    });
  }

  return tournamentList.sort(
    (left, right) => left.startsAtMilliseconds - right.startsAtMilliseconds,
  );
}

export function selectUpcomingPadelTournaments(
  tournamentList: readonly PadelTournament[],
  nowMilliseconds: number,
): readonly PadelTournament[] {
  return tournamentList.filter(
    (tournament) => tournament.startsAtMilliseconds > nowMilliseconds,
  );
}

export function buildPadelTournamentTitle(tournament: PadelTournament): string {
  return `${tournament.title} en ${tournament.venue}`;
}

export async function fetchPremierPadelCalendarHtml(
  fetchImplementation: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImplementation(PREMIER_PADEL_CALENDAR_URL, {
    headers: { 'User-Agent': 'curl/8.7.1 (jarvis-apollo)', Accept: 'text/html' },
  });
  if (!response.ok) {
    throw new Error(`padelfip respondio ${response.status}`);
  }
  return await response.text();
}
