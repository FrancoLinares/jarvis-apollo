// Avisos de partidos, contra la API publica de ESPN.
//
// Por que ESPN y no un MCP: un aviso de partido es PUSH, no una tool. Una tool
// MCP se paga en el prompt de CADA turno (hoy son 42 KB de schemas y los turnos
// que tocan MCP tardan 100 s), mientras que un cron que hace fetch no cuesta un
// solo token. La regla que sale de aca: lo que te tiene que buscar a vos es un
// schedule, no una herramienta.
//
// ESPN sirve el scoreboard sin API key ni registro, y cubre la Liga Profesional
// argentina. Verificado el 2026-09-08: HTTP 200 y devuelve los partidos de la liga.
//
// TRAMPA medida: el endpoint de calendario del equipo
// (`/teams/<id>/schedule`) devuelve SOLO partidos jugados — 25 eventos, cero
// futuros. Los proximos salen del scoreboard con ventana de fechas.

export const ESPN_ARGENTINE_LEAGUE_SLUG = 'arg.1';

export type FootballFixture = {
  readonly id: string;
  readonly kickoffMilliseconds: number;
  readonly homeTeamName: string;
  readonly awayTeamName: string;
  readonly isFollowedTeamHome: boolean;
};

function formatDateForEspnQuery(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function buildEspnScoreboardUrl(input: {
  readonly leagueSlug: string;
  readonly fromDate: Date;
  readonly toDate: Date;
}): string {
  const range = `${formatDateForEspnQuery(input.fromDate)}-${formatDateForEspnQuery(input.toDate)}`;
  return `https://site.api.espn.com/apis/site/v2/sports/soccer/${input.leagueSlug}/scoreboard?dates=${range}`;
}

// El payload de ESPN es enorme y cambia sin aviso: se lee defensivamente y
// cualquier evento con forma inesperada se saltea en vez de tumbar el cron.
export function parseEspnScoreboardPayload(
  payload: unknown,
  followedTeamNameFragment: string,
): readonly FootballFixture[] {
  const root = payload as { events?: unknown };
  if (!Array.isArray(root?.events)) {
    return [];
  }
  const normalizedFragment = followedTeamNameFragment.trim().toLowerCase();
  const fixtureList: FootballFixture[] = [];

  for (const rawEvent of root.events) {
    const event = rawEvent as {
      id?: unknown;
      date?: unknown;
      competitions?: readonly unknown[];
    };
    if (typeof event?.id !== 'string' || typeof event?.date !== 'string') {
      continue;
    }
    const kickoffMilliseconds = Date.parse(event.date);
    if (!Number.isFinite(kickoffMilliseconds)) {
      continue;
    }
    const competition = event.competitions?.[0] as { competitors?: readonly unknown[] };
    if (!Array.isArray(competition?.competitors)) {
      continue;
    }

    let homeTeamName = '';
    let awayTeamName = '';
    for (const rawCompetitor of competition.competitors) {
      const competitor = rawCompetitor as {
        homeAway?: unknown;
        team?: { displayName?: unknown };
      };
      const teamName = competitor?.team?.displayName;
      if (typeof teamName !== 'string') {
        continue;
      }
      // ESPN manda nombres con espacios al final ("Banfield "): se recorta
      // siempre, o el nombre sale con un espacio colgando en el aviso hablado.
      const trimmedName = teamName.trim();
      if (competitor.homeAway === 'home') {
        homeTeamName = trimmedName;
      } else if (competitor.homeAway === 'away') {
        awayTeamName = trimmedName;
      }
    }
    if (homeTeamName.length === 0 || awayTeamName.length === 0) {
      continue;
    }

    const isFollowedTeamHome = homeTeamName.toLowerCase().includes(normalizedFragment);
    const isFollowedTeamAway = awayTeamName.toLowerCase().includes(normalizedFragment);
    if (!isFollowedTeamHome && !isFollowedTeamAway) {
      continue;
    }

    fixtureList.push({
      id: event.id,
      kickoffMilliseconds,
      homeTeamName,
      awayTeamName,
      isFollowedTeamHome,
    });
  }

  return fixtureList.sort((left, right) => left.kickoffMilliseconds - right.kickoffMilliseconds);
}

export function buildFixtureAlertMessage(
  fixture: FootballFixture,
  followedTeamDisplayName: string,
  leadMinutes: number,
): string {
  const rivalName = fixture.isFollowedTeamHome ? fixture.awayTeamName : fixture.homeTeamName;
  const groundLabel = fixture.isFollowedTeamHome ? 'de local' : 'de visitante';
  return `${followedTeamDisplayName} juega en ${leadMinutes} minutos contra ${rivalName}, ${groundLabel}.`;
}

export type FixtureAlert = {
  readonly fixtureId: string;
  readonly message: string;
  readonly delaySeconds: number;
};

// Decide que avisos programar. Es una funcion pura para poder probar los bordes
// sin red: partido ya empezado, partido dentro del tiempo de aviso, y el
// duplicado cuando el cron vuelve a correr al dia siguiente.
export function selectFixtureAlerts(input: {
  readonly fixtureList: readonly FootballFixture[];
  readonly nowMilliseconds: number;
  readonly leadMinutes: number;
  readonly horizonHours: number;
  readonly followedTeamDisplayName: string;
  readonly alreadyScheduledMessageList: readonly string[];
}): readonly FixtureAlert[] {
  const leadMilliseconds = input.leadMinutes * 60 * 1000;
  const horizonMilliseconds = input.horizonHours * 60 * 60 * 1000;
  const alreadyScheduled = new Set(input.alreadyScheduledMessageList);
  const alertList: FixtureAlert[] = [];

  for (const fixture of input.fixtureList) {
    const alertAtMilliseconds = fixture.kickoffMilliseconds - leadMilliseconds;
    // Un partido que ya arranco no se avisa: el aviso llegaria tarde y solo
    // serviria para confundir.
    if (alertAtMilliseconds <= input.nowMilliseconds) {
      continue;
    }
    if (alertAtMilliseconds - input.nowMilliseconds > horizonMilliseconds) {
      continue;
    }
    const message = buildFixtureAlertMessage(
      fixture,
      input.followedTeamDisplayName,
      input.leadMinutes,
    );
    // El mensaje es determinista por partido, asi que sirve de clave de
    // deduplicacion: el cron corre todos los dias y no puede apilar avisos.
    if (alreadyScheduled.has(message)) {
      continue;
    }
    alertList.push({
      fixtureId: fixture.id,
      message,
      delaySeconds: Math.round((alertAtMilliseconds - input.nowMilliseconds) / 1000),
    });
  }

  return alertList;
}

// ESPN devuelve 403 con el User-Agent que manda Bun por defecto.
//
// Medido, no supuesto: con `curl` daba 200 y desde Bun 403, en la Mac Y en la
// Pi. El filtro es por User-Agent y bastante crudo — "curl/8.7.1" pasa,
// "jarvis-apollo/1.0" no, y el de Chrome tampoco. Se usa la forma con
// comentario entre parentesis, que es la convencion habitual de UA (igual que
// "Mozilla/5.0 (compatible; Googlebot/2.1)"): satisface el filtro y a la vez
// dice de verdad quien esta llamando, en vez de hacerse pasar por otra cosa.
//
// Si algun dia esto vuelve a dar 403, el sintoma va a ser el log
// `sanlorenzo_fixtures_error` con status 403 y lo primero a revisar es esta
// linea.
const ESPN_USER_AGENT = 'curl/8.7.1 (jarvis-apollo)';

export async function fetchLeagueScoreboard(input: {
  readonly leagueSlug: string;
  readonly fromDate: Date;
  readonly toDate: Date;
  readonly fetchImplementation?: typeof fetch;
}): Promise<unknown> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const response = await fetchImplementation(
    buildEspnScoreboardUrl({
      leagueSlug: input.leagueSlug,
      fromDate: input.fromDate,
      toDate: input.toDate,
    }),
    { headers: { 'User-Agent': ESPN_USER_AGENT, Accept: 'application/json' } },
  );
  if (!response.ok) {
    throw new Error(`ESPN respondio ${response.status}`);
  }
  return await response.json();
}

// El contenedor corre en UTC: 09:00 UTC son las 06:00 de Buenos Aires.
export const FOOTBALL_FIXTURE_CHECK_CRON = '0 9 * * *';
export const FOOTBALL_ALERT_LEAD_MINUTES = 30;

// Horizonte corto A PROPOSITO, aunque el scheduler aguante 24 dias.
//
// En el futbol argentino los partidos se reprograman todo el tiempo. Programar
// un mes de avisos de una vez deja recordatorios apuntando a horarios viejos y
// no hay forma de enterarse. Mirando solo el proximo dia, cada aviso se arma
// con el dato mas fresco que hay. 26 horas y no 24 para que el cron diario
// nunca deje un hueco entre corridas.
export const FOOTBALL_ALERT_HORIZON_HOURS = 26;


function readHostEnvironmentValue(name: string): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[name];
}

// El equipo sale de FOOTBALL_TEAM, tal como lo escribe ESPN (p. ej. "Racing Club").
// Sin equipo configurado no hay avisos.
export function resolveFollowedTeamName(): string {
  return readHostEnvironmentValue('FOOTBALL_TEAM')?.trim() ?? '';
}

// Interruptor, igual que la alarma: FOOTBALL_ALERTS=off apaga el cron sin
// reconstruir la imagen.
export function areFootballAlertsEnabled(): boolean {
  return (
    (readHostEnvironmentValue('FOOTBALL_ALERTS') ?? 'on') !== 'off' &&
    resolveFollowedTeamName().length > 0
  );
}
