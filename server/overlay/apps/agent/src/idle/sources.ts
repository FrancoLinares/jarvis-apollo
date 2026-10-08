import { listListItemRecords } from '@/lists/store';
import type { MemorySqlExecutor } from '@/memory/store';
import type { IdleNote, IdlePendingList, IdleTravelTime } from '@/idle/rotator';

// De dónde salen los datos de la pantalla de reposo.
//
// Las fuentes locales (SQLite) se leen en cada vuelta porque cuestan nada. Las
// que salen a la red van con cache: la rotación gira cada 15s y pedirle el
// tránsito a Google cuatro veces por minuto sería gastar cuota para mostrar el
// mismo número.

export const TRAVEL_TIME_CACHE_MILLISECONDS = 10 * 60_000;

// `typeof fetch` incluye extras propios de Bun (`preconnect`) que un doble de
// test no tiene por qué implementar. Para inyectar alcanza con la llamada.
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Cache con vencimiento para las fuentes de red. Si la lectura falla se
 * devuelve lo último que anduvo en vez de vaciar la tarjeta: un corte de red de
 * un minuto no tiene por qué borrar el dato de la pantalla.
 */
export function createExpiringReader<T>(input: {
  readonly read: () => Promise<T | undefined>;
  readonly ttlMilliseconds: number;
  readonly now?: () => number;
}): () => Promise<T | undefined> {
  const now = input.now ?? (() => Date.now());
  let cachedValue: T | undefined;
  let cachedAtMilliseconds = Number.NEGATIVE_INFINITY;
  let readInFlight: Promise<void> | undefined;

  return async () => {
    if (now() - cachedAtMilliseconds < input.ttlMilliseconds) {
      return cachedValue;
    }
    // Dos vueltas de la rotación no deben disparar dos pedidos a la vez.
    if (readInFlight !== undefined) {
      await readInFlight;
      return cachedValue;
    }
    readInFlight = (async () => {
      try {
        const value = await input.read();
        if (value !== undefined) {
          cachedValue = value;
        }
        cachedAtMilliseconds = now();
      } catch {
        // Se reintenta en la próxima vuelta; mientras tanto queda el anterior.
        cachedAtMilliseconds = now();
      } finally {
        readInFlight = undefined;
      }
    })();
    await readInFlight;
    return cachedValue;
  };
}

/** La lista con más pendientes: mostrar las cinco no entra en una franja. */
export async function readPendingList(
  sqlExecutor: MemorySqlExecutor,
): Promise<IdlePendingList | undefined> {
  const itemRecordList = await listListItemRecords(sqlExecutor);
  if (itemRecordList.length === 0) {
    return undefined;
  }
  const countByListName = new Map<string, number>();
  for (const item of itemRecordList) {
    countByListName.set(item.listName, (countByListName.get(item.listName) ?? 0) + 1);
  }
  let fullest: IdlePendingList | undefined;
  for (const [listName, count] of countByListName) {
    if (fullest === undefined || count > fullest.count) {
      fullest = { listName, count };
    }
  }
  return fullest;
}

/**
 * Igual que readPendingList pero con los textos: el tablero de LVGL muestra los
 * ítems, no solo cuántos hay. Devuelve la lista más cargada, en orden de
 * anotación, y el total real aunque se muestren solo los primeros.
 */
export async function readPendingListDetail(
  sqlExecutor: MemorySqlExecutor,
): Promise<
  | { readonly listName: string; readonly count: number; readonly itemList: readonly string[] }
  | undefined
> {
  const itemRecordList = await listListItemRecords(sqlExecutor);
  if (itemRecordList.length === 0) {
    return undefined;
  }
  const itemListByName = new Map<string, string[]>();
  for (const item of itemRecordList) {
    const bucket = itemListByName.get(item.listName);
    if (bucket === undefined) {
      itemListByName.set(item.listName, [item.content]);
    } else {
      bucket.push(item.content);
    }
  }
  let fullestName: string | undefined;
  let fullestItemList: string[] = [];
  for (const [listName, contentList] of itemListByName) {
    if (contentList.length > fullestItemList.length) {
      fullestName = listName;
      fullestItemList = contentList;
    }
  }
  return fullestName === undefined
    ? undefined
    : { listName: fullestName, count: fullestItemList.length, itemList: fullestItemList };
}

type MemoryContentRow = { content: string };

/** Lo último que se guardó, para que no quede enterrado en la base. */
export async function readLastNote(
  sqlExecutor: MemorySqlExecutor,
): Promise<IdleNote | undefined> {
  const rowList = sqlExecutor.execute<MemoryContentRow>(
    'SELECT content FROM memories ORDER BY created_at DESC LIMIT 1',
  );
  const content = rowList[0]?.content?.trim();
  return content === undefined || content.length === 0 ? undefined : { content };
}

type DistanceMatrixResponse = {
  readonly status?: string;
  readonly rows?: readonly {
    readonly elements?: readonly {
      readonly status?: string;
      readonly duration_in_traffic?: { readonly value?: number };
      readonly duration?: { readonly value?: number };
    }[];
  }[];
};

/**
 * Tiempo de viaje por la Distance Matrix de Google, no por el MCP de Maps: el
 * MCP devuelve el resultado aplanado a texto (`summarizeMcpCallToolResult`) y
 * sacar los minutos de ahí con una expresión regular es frágil para algo que
 * corre solo en segundo plano. Acá viene el número en JSON.
 */
export async function readTravelTime(input: {
  readonly apiKey: string;
  readonly originAddress: string;
  readonly destinationAddress: string;
  readonly destinationLabel: string;
  readonly fetchImplementation?: FetchLike;
}): Promise<IdleTravelTime | undefined> {
  const performFetch = input.fetchImplementation ?? fetch;
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
  url.searchParams.set('origins', input.originAddress);
  url.searchParams.set('destinations', input.destinationAddress);
  url.searchParams.set('mode', 'driving');
  // Sin esto devuelve el tiempo ideal sin tránsito, que a las 18 h miente feo.
  url.searchParams.set('departure_time', 'now');
  url.searchParams.set('language', 'es');
  url.searchParams.set('key', input.apiKey);

  const response = await performFetch(url.toString());
  if (!response.ok) {
    return undefined;
  }
  const payload = (await response.json()) as DistanceMatrixResponse;
  if (payload.status !== 'OK') {
    return undefined;
  }
  const element = payload.rows?.[0]?.elements?.[0];
  if (element === undefined || element.status !== 'OK') {
    return undefined;
  }
  const durationSeconds =
    element.duration_in_traffic?.value ?? element.duration?.value;
  if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  return {
    destinationLabel: input.destinationLabel,
    minutes: durationSeconds / 60,
  };
}
