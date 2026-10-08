import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createBunSqliteExecutor } from '@/platform/bun/sql';
import { addListItemRecord } from '@/lists/store';
import { createExpiringReader, readLastNote, readPendingList, readTravelTime } from '@/idle/sources';

function createSqlExecutor() {
  const database = new Database(':memory:');
  database.run(
    'CREATE TABLE list_items (id TEXT PRIMARY KEY, list_name TEXT, content TEXT, created_at INTEGER)',
  );
  database.run(
    'CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT, created_at INTEGER)',
  );
  return createBunSqliteExecutor(database);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe('readPendingList', () => {
  it('sin listas no devuelve nada', async () => {
    expect(await readPendingList(createSqlExecutor())).toBeUndefined();
  });

  it('elige la lista con más pendientes', async () => {
    const sqlExecutor = createSqlExecutor();
    let counter = 0;
    const add = (listName: string, content: string) =>
      addListItemRecord(sqlExecutor, { listName, content }, 1_000, () => `i${counter++}`);
    await add('super', 'pan');
    await add('super', 'leche');
    await add('super', 'yerba');
    await add('tareas', 'llamar');

    expect(await readPendingList(sqlExecutor)).toEqual({ listName: 'super', count: 3 });
  });
});

describe('readLastNote', () => {
  it('sin memorias no devuelve nada', async () => {
    expect(await readLastNote(createSqlExecutor())).toBeUndefined();
  });

  it('trae la última guardada, no la primera', async () => {
    const sqlExecutor = createSqlExecutor();
    sqlExecutor.execute('INSERT INTO memories VALUES (?, ?, ?)', 'a', 'vieja', 1_000);
    sqlExecutor.execute('INSERT INTO memories VALUES (?, ?, ?)', 'b', 'nueva', 2_000);
    expect(await readLastNote(sqlExecutor)).toEqual({ content: 'nueva' });
  });

  it('ignora una memoria en blanco', async () => {
    const sqlExecutor = createSqlExecutor();
    sqlExecutor.execute('INSERT INTO memories VALUES (?, ?, ?)', 'a', '   ', 1_000);
    expect(await readLastNote(sqlExecutor)).toBeUndefined();
  });
});

describe('readTravelTime', () => {
  const base = {
    apiKey: 'k',
    originAddress: 'Calle Falsa 123, CABA',
    destinationAddress: 'Obelisco, CABA',
    destinationLabel: 'Al centro',
  };

  it('prefiere el tiempo con tránsito al ideal', async () => {
    const result = await readTravelTime({
      ...base,
      fetchImplementation: async () =>
        jsonResponse({
          status: 'OK',
          rows: [{ elements: [{ status: 'OK', duration: { value: 900 }, duration_in_traffic: { value: 1_440 } }] }],
        }),
    });
    expect(result).toEqual({ destinationLabel: 'Al centro', minutes: 24 });
  });

  it('cae al tiempo ideal si Google no manda el de tránsito', async () => {
    const result = await readTravelTime({
      ...base,
      fetchImplementation: async () =>
        jsonResponse({ status: 'OK', rows: [{ elements: [{ status: 'OK', duration: { value: 600 } }] }] }),
    });
    expect(result).toEqual({ destinationLabel: 'Al centro', minutes: 10 });
  });

  it('manda departure_time para que el número no mienta en hora pico', async () => {
    let requestedUrl = '';
    await readTravelTime({
      ...base,
      fetchImplementation: async (input) => {
        requestedUrl = String(input);
        return jsonResponse({ status: 'OK', rows: [{ elements: [{ status: 'OK', duration: { value: 60 } }] }] });
      },
    });
    expect(requestedUrl).toContain('departure_time=now');
  });

  it('no inventa un número cuando la ruta no existe', async () => {
    const result = await readTravelTime({
      ...base,
      fetchImplementation: async () =>
        jsonResponse({ status: 'OK', rows: [{ elements: [{ status: 'ZERO_RESULTS' }] }] }),
    });
    expect(result).toBeUndefined();
  });

  it('un error HTTP no rompe la tarjeta', async () => {
    const result = await readTravelTime({
      ...base,
      fetchImplementation: async () => jsonResponse({}, 500),
    });
    expect(result).toBeUndefined();
  });
});

describe('createExpiringReader', () => {
  it('no vuelve a pedir mientras el cache está fresco', async () => {
    let callCount = 0;
    let clock = 0;
    const read = createExpiringReader({
      ttlMilliseconds: 1_000,
      now: () => clock,
      read: async () => { callCount += 1; return `v${callCount}`; },
    });

    expect(await read()).toBe('v1');
    clock = 999;
    expect(await read()).toBe('v1');
    expect(callCount).toBe(1);
    clock = 1_000;
    expect(await read()).toBe('v2');
    expect(callCount).toBe(2);
  });

  it('ante un fallo se queda con el último valor bueno', async () => {
    let clock = 0;
    let shouldFail = false;
    const read = createExpiringReader({
      ttlMilliseconds: 100,
      now: () => clock,
      read: async () => {
        if (shouldFail) { throw new Error('sin red'); }
        return 'bueno';
      },
    });

    expect(await read()).toBe('bueno');
    shouldFail = true;
    clock = 200;
    // Falló, pero la pantalla sigue mostrando el dato en vez de vaciarse.
    expect(await read()).toBe('bueno');
  });

  it('dos vueltas simultáneas disparan un solo pedido', async () => {
    let callCount = 0;
    const read = createExpiringReader({
      ttlMilliseconds: 1_000,
      now: () => 0,
      read: async () => {
        callCount += 1;
        await Bun.sleep(5);
        return 'v';
      },
    });
    await Promise.all([read(), read(), read()]);
    expect(callCount).toBe(1);
  });
});
