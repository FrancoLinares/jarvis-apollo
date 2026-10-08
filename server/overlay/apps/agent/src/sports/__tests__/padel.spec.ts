import { describe, expect, it } from 'bun:test';

import {
  buildPadelTournamentTitle,
  parsePremierPadelCalendarHtml,
  selectUpcomingPadelTournaments,
} from '@/sports/padel';

// Recorte con la forma real de padelfip.com: las filas vienen envueltas en
// etiquetas y separadas por el enlace "IR AL EVENTO", con ruido de menu en el
// medio — que es justo lo que el LLM confundio con un torneo.
const htmlSample = `
<div class="menu"><a>Ranking Promises Europe FIP Beyond Ranking</a></div>
<div class="row"><h3>CUPRA ROTTERDAM PREMIER PADEL P2</h3>
  <span>del 28/09/2026 al 04/10/2026</span> <span>Rotterdam - Netherlands</span>
  <a href="/x">IR AL EVENTO</a></div>
<div class="row"><h3>GERMANY P2</h3>
  <span>del 05/10/2026 al 11/10/2026</span> <span>Dusseldorf - Germany</span>
  <a href="/y">IR AL EVENTO</a></div>
<div class="row"><h3>DUBAI P1</h3>
  <span>del 08/11/2026 al 15/11/2026</span> <span>Dubai - United Arab Emirates</span>
  <a href="/z">IR AL EVENTO</a></div>
<script>var europe = "Europe P2 del 14/09/2026";</script>
`;

describe('parsePremierPadelCalendarHtml', () => {
  it('lee los torneos con sus fechas exactas', () => {
    const lista = parsePremierPadelCalendarHtml(htmlSample);
    expect(lista.map((t) => t.title)).toEqual([
      'CUPRA ROTTERDAM PREMIER PADEL P2',
      'GERMANY P2',
      'DUBAI P1',
    ]);
  });

  it('DUBAI P1 arranca el 08/11, que es donde el LLM se equivocaba por un día', () => {
    const dubai = parsePremierPadelCalendarHtml(htmlSample).find((t) =>
      t.title.includes('DUBAI'),
    );
    expect(new Date(dubai!.startsAtMilliseconds).toISOString()).toBe(
      '2026-11-08T12:00:00.000Z',
    );
  });

  it('no inventa un torneo con el ruido del menú ni con el de <script>', () => {
    // "Europe" aparece 20 veces en la pagina real, todas en el menu de rankings.
    // El LLM las tomo por un torneo el 14/09; el ancla en "IR AL EVENTO" no.
    const lista = parsePremierPadelCalendarHtml(htmlSample);
    expect(lista.some((t) => t.title.toLowerCase().includes('europe'))).toBe(false);
  });

  it('ancla al mediodía UTC, no a medianoche', () => {
    const [primero] = parsePremierPadelCalendarHtml(htmlSample);
    expect(new Date(primero!.startsAtMilliseconds).toISOString()).toBe(
      '2026-09-28T12:00:00.000Z',
    );
  });

  it('devuelve la sede', () => {
    const [primero] = parsePremierPadelCalendarHtml(htmlSample);
    expect(primero!.venue).toBe('Rotterdam - Netherlands');
    expect(buildPadelTournamentTitle(primero!)).toBe(
      'CUPRA ROTTERDAM PREMIER PADEL P2 en Rotterdam - Netherlands',
    );
  });

  it('devuelve vacío con HTML que no tiene filas, en vez de tirar', () => {
    expect(parsePremierPadelCalendarHtml('<html><body>nada</body></html>')).toEqual([]);
    expect(parsePremierPadelCalendarHtml('')).toEqual([]);
  });

  it('descarta filas donde el final es anterior al inicio', () => {
    const roto = '<p>TORNEO RARO del 10/10/2026 al 01/10/2026 Lugar - Pais IR AL EVENTO</p>';
    expect(parsePremierPadelCalendarHtml(roto)).toEqual([]);
  });

  it('ordena por fecha de inicio', () => {
    const lista = parsePremierPadelCalendarHtml(htmlSample);
    expect(lista[0]!.startsAtMilliseconds).toBeLessThan(lista[1]!.startsAtMilliseconds);
    expect(lista[1]!.startsAtMilliseconds).toBeLessThan(lista[2]!.startsAtMilliseconds);
  });
});

describe('selectUpcomingPadelTournaments', () => {
  it('deja afuera los que ya empezaron', () => {
    const lista = parsePremierPadelCalendarHtml(htmlSample);
    const futuros = selectUpcomingPadelTournaments(lista, Date.parse('2026-10-06T00:00:00Z'));
    expect(futuros.map((t) => t.title)).toEqual(['DUBAI P1']);
  });
});
