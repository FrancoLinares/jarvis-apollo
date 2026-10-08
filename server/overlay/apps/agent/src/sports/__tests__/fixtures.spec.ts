import { describe, expect, it } from 'bun:test';

import {
  buildEspnScoreboardUrl,
  buildFixtureAlertMessage,
  type FootballFixture,
  parseEspnScoreboardPayload,
  selectFixtureAlerts,
} from '@/sports/fixtures';

// Recorte del payload real de ESPN del 2026-09-08, con la forma exacta que
// devuelve: incluye el espacio al final de "Banfield " que trae la API.
const espnPayloadSample = {
  events: [
    {
      id: '401841568',
      date: '2026-09-13T22:15Z',
      name: 'Banfield at Independiente',
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: { displayName: 'Independiente' } },
            { homeAway: 'away', team: { displayName: 'Banfield ' } },
          ],
        },
      ],
    },
    {
      id: '401841570',
      date: '2026-09-20T17:45Z',
      name: 'Boca Juniors at Banfield',
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: { displayName: 'Banfield' } },
            { homeAway: 'away', team: { displayName: 'Boca Juniors' } },
          ],
        },
      ],
    },
    {
      id: '401841571',
      date: '2026-09-14T20:00Z',
      name: 'River Plate at Racing Club',
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: { displayName: 'Racing Club' } },
            { homeAway: 'away', team: { displayName: 'River Plate' } },
          ],
        },
      ],
    },
  ],
};

describe('parseEspnScoreboardPayload', () => {
  it('se queda solo con los partidos del equipo seguido', () => {
    const fixtureList = parseEspnScoreboardPayload(espnPayloadSample, 'Banfield');
    expect(fixtureList.map((fixture) => fixture.id)).toEqual(['401841568', '401841570']);
  });

  it('recorta el espacio que ESPN deja al final del nombre', () => {
    const [visita] = parseEspnScoreboardPayload(espnPayloadSample, 'Banfield');
    expect(visita!.awayTeamName).toBe('Banfield');
  });

  it('distingue local de visitante', () => {
    const [visita, local] = parseEspnScoreboardPayload(espnPayloadSample, 'Banfield');
    expect(visita!.isFollowedTeamHome).toBe(false);
    expect(local!.isFollowedTeamHome).toBe(true);
  });

  it('devuelve los partidos ordenados por fecha', () => {
    const fixtureList = parseEspnScoreboardPayload(espnPayloadSample, 'Banfield');
    expect(fixtureList[0]!.kickoffMilliseconds).toBeLessThan(fixtureList[1]!.kickoffMilliseconds);
  });

  it('no explota con payloads rotos: devuelve vacío en vez de tirar', () => {
    expect(parseEspnScoreboardPayload(undefined, 'Banfield')).toEqual([]);
    expect(parseEspnScoreboardPayload({}, 'Banfield')).toEqual([]);
    expect(parseEspnScoreboardPayload({ events: 'no es lista' }, 'Banfield')).toEqual([]);
    expect(
      parseEspnScoreboardPayload({ events: [{ id: 1, date: 'ayer' }] }, 'Banfield'),
    ).toEqual([]);
  });

  it('saltea eventos sin los dos equipos en vez de inventarlos', () => {
    const incompleto = {
      events: [
        {
          id: 'x',
          date: '2026-09-13T22:15Z',
          competitions: [{ competitors: [{ homeAway: 'home', team: { displayName: 'Banfield' } }] }],
        },
      ],
    };
    expect(parseEspnScoreboardPayload(incompleto, 'Banfield')).toEqual([]);
  });
});

describe('buildEspnScoreboardUrl', () => {
  it('arma la ventana de fechas en el formato que espera ESPN', () => {
    const url = buildEspnScoreboardUrl({
      leagueSlug: 'arg.1',
      fromDate: new Date('2026-09-08T12:00:00Z'),
      toDate: new Date('2026-09-28T12:00:00Z'),
    });
    expect(url).toContain('/soccer/arg.1/scoreboard?dates=20260908-20260928');
  });
});

describe('buildFixtureAlertMessage', () => {
  it('dice contra quién y si es de local o visitante', () => {
    const [visita, local] = parseEspnScoreboardPayload(espnPayloadSample, 'Banfield');
    expect(buildFixtureAlertMessage(visita!, 'Banfield', 30)).toBe(
      'Banfield juega en 30 minutos contra Independiente, de visitante.',
    );
    expect(buildFixtureAlertMessage(local!, 'Banfield', 30)).toBe(
      'Banfield juega en 30 minutos contra Boca Juniors, de local.',
    );
  });
});

describe('selectFixtureAlerts', () => {
  const partido: FootballFixture = {
    id: '1',
    kickoffMilliseconds: Date.parse('2026-09-13T22:15Z'),
    homeTeamName: 'Independiente',
    awayTeamName: 'Banfield',
    isFollowedTeamHome: false,
  };
  const base = {
    fixtureList: [partido],
    leadMinutes: 30,
    horizonHours: 26,
    followedTeamDisplayName: 'Banfield',
    alreadyScheduledMessageList: [],
  };

  it('programa el aviso con la anticipación pedida', () => {
    const [alerta] = selectFixtureAlerts({
      ...base,
      nowMilliseconds: Date.parse('2026-09-13T20:00:00Z'),
    });
    // 21:45 (aviso) menos 20:00 (ahora) = 105 minutos
    expect(alerta!.delaySeconds).toBe(105 * 60);
  });

  it('no avisa de un partido que ya empezó', () => {
    expect(
      selectFixtureAlerts({
        ...base,
        nowMilliseconds: Date.parse('2026-09-13T22:30:00Z'),
      }),
    ).toEqual([]);
  });

  it('tampoco cuando ya pasó la hora del aviso pero todavía no empezó', () => {
    // A las 22:00 el aviso de las 21:45 ya vencio: mandarlo diciendo "en 30
    // minutos" seria mentir.
    expect(
      selectFixtureAlerts({
        ...base,
        nowMilliseconds: Date.parse('2026-09-13T22:00:00Z'),
      }),
    ).toEqual([]);
  });

  it('ignora partidos más allá del horizonte', () => {
    expect(
      selectFixtureAlerts({
        ...base,
        nowMilliseconds: Date.parse('2026-09-10T20:00:00Z'),
      }),
    ).toEqual([]);
  });

  it('no duplica un aviso que ya está programado', () => {
    const mensaje = 'Banfield juega en 30 minutos contra Independiente, de visitante.';
    expect(
      selectFixtureAlerts({
        ...base,
        nowMilliseconds: Date.parse('2026-09-13T20:00:00Z'),
        alreadyScheduledMessageList: [mensaje],
      }),
    ).toEqual([]);
  });
});
