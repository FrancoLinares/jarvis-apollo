import {
  addListItemRecord,
  listListItemRecords,
  removeListItemRecordById,
} from '@/lists/store';
import type { MemorySqlExecutor } from '@/memory/store';
import { createNotionListsClient, type NotionListsClient } from '@/notion/client';
import { isEmptyNotionSyncPlan, planNotionSync } from '@/notion/reconcile';

// Sistema híbrido de TODOs: las listas siguen viviendo en el SQLite de la Pi
// (que es lo que usan las herramientas de voz y el scheduler), y Notion es un
// espejo con el que se puede trabajar a mano. Cada vuelta reconcilia los dos
// lados enteros; la lógica de qué hacer está en reconcile.ts, testeada aparte.

const NOTION_SYNC_INTERVAL_MILLISECONDS = 60_000;
// Tras dictar un ítem la vuelta periódica tardaría hasta un minuto en subirlo.
// Este empujón lo sube casi en el acto, y el retardo junta las escrituras de un
// mismo turno (vaciar una lista son N borrados) en una sola reconciliación.
const NOTION_SYNC_NUDGE_DELAY_MILLISECONDS = 2_000;

const DEFAULT_LIST_NAME = 'super';

export type NotionSyncOutcome = {
  readonly createdInNotionCount: number;
  readonly linkedCount: number;
  readonly adoptedIntoJarvisCount: number;
  readonly archivedCount: number;
  readonly removedFromJarvisCount: number;
  readonly updatedInJarvisCount: number;
};

const EMPTY_OUTCOME: NotionSyncOutcome = {
  createdInNotionCount: 0,
  linkedCount: 0,
  adoptedIntoJarvisCount: 0,
  archivedCount: 0,
  removedFromJarvisCount: 0,
  updatedInJarvisCount: 0,
};

export async function runNotionListSyncOnce(input: {
  readonly sqlExecutor: MemorySqlExecutor;
  readonly client: NotionListsClient;
  readonly nowMilliseconds?: number;
  readonly createIdentifier?: () => string;
}): Promise<NotionSyncOutcome> {
  const createIdentifier = input.createIdentifier ?? (() => crypto.randomUUID());
  const nowMilliseconds = input.nowMilliseconds ?? Date.now();

  const [jarvisItemRecordList, notionPageList] = await Promise.all([
    listListItemRecords(input.sqlExecutor),
    input.client.readRowList(),
  ]);
  const plan = planNotionSync({
    jarvisItemList: jarvisItemRecordList.map((record) => ({
      id: record.id,
      listName: record.listName,
      content: record.content,
    })),
    notionPageList,
  });
  if (isEmptyNotionSyncPlan(plan)) {
    return EMPTY_OUTCOME;
  }

  // Orden deliberado: primero lo que solo toca el SQLite (barato y local),
  // después lo que sale a la red. Si Notion se cae a mitad de camino, el estado
  // local queda consistente y la próxima vuelta reintenta lo que faltó.
  for (const itemId of plan.removeItemIdList) {
    await removeListItemRecordById(input.sqlExecutor, itemId);
  }
  for (const update of plan.updateJarvisList) {
    input.sqlExecutor.execute(
      'UPDATE list_items SET content = ?, list_name = ? WHERE id = ?',
      update.content,
      update.listName,
      update.itemId,
    );
  }

  for (const adoption of plan.adoptList) {
    // El alta local va primero: si el write-back del ID falla, la próxima vuelta
    // encuentra la fila sin ID y el ítem sin fila, y los empareja por texto en
    // vez de duplicar.
    const record = await addListItemRecord(
      input.sqlExecutor,
      { listName: adoption.listName, content: adoption.content },
      nowMilliseconds,
      createIdentifier,
    );
    await input.client.writeItemId(adoption.pageId, record.id);
  }

  for (const link of plan.linkList) {
    await input.client.writeItemId(link.pageId, link.itemId);
  }
  for (const item of plan.createInNotionList) {
    const record = jarvisItemRecordList.find((candidate) => candidate.id === item.id);
    await input.client.createRow({
      itemId: item.id,
      listName: item.listName,
      content: item.content,
      createdAtMilliseconds: record?.createdAt ?? nowMilliseconds,
    });
  }
  for (const pageId of plan.archivePageIdList) {
    await input.client.archiveRow(pageId);
  }

  return {
    createdInNotionCount: plan.createInNotionList.length,
    linkedCount: plan.linkList.length,
    adoptedIntoJarvisCount: plan.adoptList.length,
    archivedCount: plan.archivePageIdList.length,
    removedFromJarvisCount: plan.removeItemIdList.length,
    updatedInJarvisCount: plan.updateJarvisList.length,
  };
}

// Puente para que las herramientas de lista avisen sin conocer al supervisor:
// effects.ts llama a esto después de tocar el SQLite y, si el sync está
// apagado (sin token), no pasa nada.
let requestImmediateSync: (() => void) | undefined;

export function notifyJarvisListsChanged(): void {
  requestImmediateSync?.();
}

export function startNotionListSync(dependencies: {
  readonly sqlExecutor: MemorySqlExecutor;
  readonly token: string;
  readonly databaseId: string;
  readonly intervalMilliseconds?: number;
  readonly nudgeDelayMilliseconds?: number;
}): () => void {
  const client = createNotionListsClient({
    token: dependencies.token,
    databaseId: dependencies.databaseId,
    defaultListName: DEFAULT_LIST_NAME,
  });
  let tickInFlight = false;
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined;

  async function tick(): Promise<void> {
    // Una vuelta lenta (Notion con latencia) no debe pisar a la siguiente: dos
    // reconciliaciones simultáneas se duplicarían el trabajo.
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      const outcome = await runNotionListSyncOnce({
        sqlExecutor: dependencies.sqlExecutor,
        client,
      });
      // Solo se loguean las vueltas que hicieron algo: una por minuto sin
      // cambios llenaría el log de ruido.
      if (Object.values(outcome).some((count) => count > 0)) {
        console.log(
          JSON.stringify({ level: 'info', message: 'notion_list_sync', detail: outcome }),
        );
      }
    } catch (error) {
      // Notion caído o token vencido no puede tumbar al asistente: se anota y
      // se reintenta en la próxima vuelta.
      console.log(
        JSON.stringify({
          level: 'warn',
          message: 'notion_list_sync_failed',
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      tickInFlight = false;
    }
  }

  requestImmediateSync = () => {
    if (nudgeTimer !== undefined) {
      return;
    }
    nudgeTimer = setTimeout(() => {
      nudgeTimer = undefined;
      void tick();
    }, dependencies.nudgeDelayMilliseconds ?? NOTION_SYNC_NUDGE_DELAY_MILLISECONDS);
  };

  const timer = setInterval(
    () => void tick(),
    dependencies.intervalMilliseconds ?? NOTION_SYNC_INTERVAL_MILLISECONDS,
  );
  // Primera pasada al arrancar: sube lo que se haya anotado con el sync apagado.
  void tick();

  return () => {
    clearInterval(timer);
    if (nudgeTimer !== undefined) {
      clearTimeout(nudgeTimer);
    }
    requestImmediateSync = undefined;
  };
}
