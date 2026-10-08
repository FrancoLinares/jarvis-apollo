import { describe, expect, it } from 'bun:test';

import { startDashboardSupervisor } from '@/dashboard/supervisor';
import type { DashboardPayload } from '@/dashboard/payload';

const NOW = Date.UTC(2026, 8, 6, 15, 0, 0);

function createHarness(input: {
  readonly connectionCount?: () => number;
  readonly sources?: () => Promise<Record<string, unknown>>;
} = {}) {
  const pushed: DashboardPayload[] = [];
  const stop = startDashboardSupervisor({
    getDeviceConnectionCount: input.connectionCount ?? (() => 1),
    pushDashboard: (payload) => { pushed.push(payload); },
    readSources: (input.sources ?? (async () => ({}))) as never,
    // Sin timer en los tests: la primera vuelta la dispara el arranque.
    intervalMilliseconds: 3_600_000,
    now: () => NOW,
  });
  return { pushed, stop };
}

describe('startDashboardSupervisor', () => {
  it('manda el tablero apenas arranca', async () => {
    const h = createHarness({
      sources: async () => ({ pending: { listName: 'super', count: 2, itemList: ['pan', 'luz'] } }),
    });
    await Bun.sleep(5);
    h.stop();
    expect(h.pushed).toHaveLength(1);
    expect(h.pushed[0]?.pending?.itemList).toEqual(['pan', 'luz']);
  });

  it('no manda nada si no hay ninguna placa conectada', async () => {
    const h = createHarness({ connectionCount: () => 0 });
    await Bun.sleep(5);
    h.stop();
    expect(h.pushed).toEqual([]);
  });

  it('una fuente que explota no tumba el supervisor', async () => {
    const h = createHarness({
      sources: async () => { throw new Error('sin red'); },
    });
    await Bun.sleep(5);
    h.stop();
    expect(h.pushed).toEqual([]);
  });

  it('manda el tablero en CADA vuelta, aunque nada haya cambiado', async () => {
    // Antes se salteaba el envío si el contenido era igual, y una placa que se
    // reiniciaba se quedaba con las tarjetas vacías hasta que algún dato
    // cambiara solo. Repetirse es barato; una pantalla vacía no.
    const pushed: DashboardPayload[] = [];
    const stop = startDashboardSupervisor({
      getDeviceConnectionCount: () => 1,
      pushDashboard: (payload) => { pushed.push(payload); },
      readSources: async () => ({ pending: { listName: 'super', count: 1, itemList: ['pan'] } }),
      intervalMilliseconds: 5,
      now: () => NOW,
    });
    await Bun.sleep(40);
    stop();
    expect(pushed.length).toBeGreaterThan(2);
  });

  it('deja de mandar sin placas y retoma cuando vuelve una', async () => {
    let connected = 1;
    const pushed: DashboardPayload[] = [];
    const stop = startDashboardSupervisor({
      getDeviceConnectionCount: () => connected,
      pushDashboard: (payload) => { pushed.push(payload); },
      readSources: async () => ({ pending: { listName: 'super', count: 1, itemList: ['pan'] } }),
      intervalMilliseconds: 5,
      now: () => NOW,
    });
    await Bun.sleep(25);
    const conPlaca = pushed.length;
    expect(conPlaca).toBeGreaterThan(0);

    connected = 0;
    await Bun.sleep(25);
    // Sin nadie mirando no se lee clima ni tránsito: no crece.
    expect(pushed.length).toBe(conPlaca);

    connected = 1;
    await Bun.sleep(25);
    // Y al volver, la placa recibe el tablero sin esperar a que algo cambie.
    expect(pushed.length).toBeGreaterThan(conPlaca);
  });
});
