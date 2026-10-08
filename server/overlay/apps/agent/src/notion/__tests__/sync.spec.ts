import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createBunSqliteExecutor } from '@/platform/bun/sql';
import { addListItemRecord, listListItemRecords } from '@/lists/store';
import type { NotionListsClient, NotionRowRecord } from '@/notion/client';
import { runNotionListSyncOnce } from '@/notion/sync';

function createListsSqlExecutor() {
  const database = new Database(':memory:');
  database.run(
    'CREATE TABLE list_items (id TEXT PRIMARY KEY, list_name TEXT, content TEXT, created_at INTEGER)',
  );
  return createBunSqliteExecutor(database);
}

type RecordedCall =
  | { readonly kind: 'create'; readonly itemId: string; readonly content: string }
  | { readonly kind: 'writeItemId'; readonly pageId: string; readonly itemId: string }
  | { readonly kind: 'archive'; readonly pageId: string };

function createFakeNotionClient(rowList: readonly NotionRowRecord[]): {
  readonly client: NotionListsClient;
  readonly callList: readonly RecordedCall[];
} {
  const callList: RecordedCall[] = [];
  return {
    callList,
    client: {
      readRowList: async () => rowList,
      createRow: async (row) => {
        callList.push({ kind: 'create', itemId: row.itemId, content: row.content });
      },
      writeItemId: async (pageId, itemId) => {
        callList.push({ kind: 'writeItemId', pageId, itemId });
      },
      archiveRow: async (pageId) => {
        callList.push({ kind: 'archive', pageId });
      },
    },
  };
}

describe('runNotionListSyncOnce', () => {
  it('sube a Notion un ítem dictado, con su id como clave', async () => {
    const sqlExecutor = createListsSqlExecutor();
    await addListItemRecord(sqlExecutor, { listName: 'super', content: 'pan' }, 1_000, () => 'i1');
    const { client, callList } = createFakeNotionClient([]);

    const outcome = await runNotionListSyncOnce({ sqlExecutor, client });

    expect(outcome.createdInNotionCount).toBe(1);
    expect(callList).toEqual([{ kind: 'create', itemId: 'i1', content: 'pan' }]);
  });

  it('da de alta en el SQLite una fila escrita a mano y le devuelve el id', async () => {
    const sqlExecutor = createListsSqlExecutor();
    const { client, callList } = createFakeNotionClient([
      { pageId: 'p1', itemId: undefined, listName: 'tareas', content: 'llamar al gasista', isDone: false },
    ]);

    const outcome = await runNotionListSyncOnce({
      sqlExecutor,
      client,
      nowMilliseconds: 5_000,
      createIdentifier: () => 'nuevo-1',
    });

    expect(outcome.adoptedIntoJarvisCount).toBe(1);
    expect(callList).toEqual([{ kind: 'writeItemId', pageId: 'p1', itemId: 'nuevo-1' }]);
    const itemList = await listListItemRecords(sqlExecutor);
    expect(itemList).toEqual([
      { id: 'nuevo-1', listName: 'tareas', content: 'llamar al gasista', createdAt: 5_000 },
    ]);
  });

  it('tildar Hecho en Notion borra el ítem del SQLite y archiva la fila', async () => {
    const sqlExecutor = createListsSqlExecutor();
    await addListItemRecord(sqlExecutor, { listName: 'super', content: 'pan' }, 1_000, () => 'i1');
    const { client, callList } = createFakeNotionClient([
      { pageId: 'p1', itemId: 'i1', listName: 'super', content: 'pan', isDone: true },
    ]);

    const outcome = await runNotionListSyncOnce({ sqlExecutor, client });

    expect(outcome.removedFromJarvisCount).toBe(1);
    expect(await listListItemRecords(sqlExecutor)).toEqual([]);
    expect(callList).toEqual([{ kind: 'archive', pageId: 'p1' }]);
  });

  it('editar el texto en Notion actualiza el SQLite', async () => {
    const sqlExecutor = createListsSqlExecutor();
    await addListItemRecord(sqlExecutor, { listName: 'super', content: 'pan' }, 1_000, () => 'i1');
    const { client } = createFakeNotionClient([
      { pageId: 'p1', itemId: 'i1', listName: 'compras', content: 'pan integral', isDone: false },
    ]);

    const outcome = await runNotionListSyncOnce({ sqlExecutor, client });

    expect(outcome.updatedInJarvisCount).toBe(1);
    expect(await listListItemRecords(sqlExecutor)).toEqual([
      { id: 'i1', listName: 'compras', content: 'pan integral', createdAt: 1_000 },
    ]);
  });

  it('borrar por voz archiva la fila en Notion', async () => {
    const sqlExecutor = createListsSqlExecutor();
    const { client, callList } = createFakeNotionClient([
      { pageId: 'p1', itemId: 'fantasma', listName: 'super', content: 'pan', isDone: false },
    ]);

    const outcome = await runNotionListSyncOnce({ sqlExecutor, client });

    expect(outcome.archivedCount).toBe(1);
    expect(callList).toEqual([{ kind: 'archive', pageId: 'p1' }]);
  });

  it('no toca nada cuando los dos lados coinciden', async () => {
    const sqlExecutor = createListsSqlExecutor();
    await addListItemRecord(sqlExecutor, { listName: 'super', content: 'pan' }, 1_000, () => 'i1');
    const { client, callList } = createFakeNotionClient([
      { pageId: 'p1', itemId: 'i1', listName: 'super', content: 'pan', isDone: false },
    ]);

    await runNotionListSyncOnce({ sqlExecutor, client });

    expect(callList).toEqual([]);
  });

  it('si el write-back del id falla, la vuelta siguiente empareja en vez de duplicar', async () => {
    const sqlExecutor = createListsSqlExecutor();
    const notionRow: NotionRowRecord = {
      pageId: 'p1',
      itemId: undefined,
      listName: 'super',
      content: 'yerba',
      isDone: false,
    };
    const failingClient: NotionListsClient = {
      readRowList: async () => [notionRow],
      createRow: async () => undefined,
      writeItemId: async () => {
        throw new Error('Notion 503');
      },
      archiveRow: async () => undefined,
    };

    await expect(
      runNotionListSyncOnce({
        sqlExecutor,
        client: failingClient,
        createIdentifier: () => 'nuevo-1',
      }),
    ).rejects.toThrow('Notion 503');
    // El alta local ya quedó hecha; la fila de Notion sigue sin id.
    expect(await listListItemRecords(sqlExecutor)).toHaveLength(1);

    const { client, callList } = createFakeNotionClient([notionRow]);
    const outcome = await runNotionListSyncOnce({ sqlExecutor, client });

    expect(outcome.adoptedIntoJarvisCount).toBe(0);
    expect(outcome.linkedCount).toBe(1);
    expect(callList).toEqual([{ kind: 'writeItemId', pageId: 'p1', itemId: 'nuevo-1' }]);
    expect(await listListItemRecords(sqlExecutor)).toHaveLength(1);
  });
});
