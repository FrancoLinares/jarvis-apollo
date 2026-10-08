// Cliente mínimo de la API de Notion: solo lo que necesita la sincronización de
// listas (leer la base, crear fila, editar fila, archivar).
//
// Por qué REST y no el MCP: el MCP de Notion exige OAuth con callback HTTPS, y
// Apollo corre en la LAN por HTTP, así que el registro dinámico del cliente lo
// rechaza ("Redirect URI must use HTTPS"). Con un token de integración interna
// no hay OAuth y el token no vence.

const NOTION_API_BASE_URL = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2022-06-28';
const NOTION_QUERY_PAGE_SIZE = 100;

// Notion corta a ~3 pedidos por segundo. Los ciclos son chicos, pero un vaciado
// de lista puede disparar varias escrituras seguidas.
const NOTION_REQUEST_SPACING_MILLISECONDS = 350;

// Nombres de las propiedades de la base "Jarvis · Listas". Si se renombran en
// Notion hay que tocarlos acá; se centralizan para que sea un solo lugar.
export const NOTION_PROPERTY_ITEM = 'Ítem';
export const NOTION_PROPERTY_LIST = 'Lista';
export const NOTION_PROPERTY_DONE = 'Hecho';
export const NOTION_PROPERTY_ITEM_ID = 'ID Jarvis';
export const NOTION_PROPERTY_CREATED = 'Creado';

export type NotionRowRecord = {
  readonly pageId: string;
  readonly itemId: string | undefined;
  readonly listName: string;
  readonly content: string;
  readonly isDone: boolean;
};

type NotionRichTextFragment = { readonly plain_text?: string };
type NotionPropertyValue = {
  readonly title?: readonly NotionRichTextFragment[];
  readonly rich_text?: readonly NotionRichTextFragment[];
  readonly select?: { readonly name?: string } | null;
  readonly checkbox?: boolean;
};
type NotionPageResponse = {
  readonly id: string;
  readonly archived?: boolean;
  readonly in_trash?: boolean;
  readonly properties?: Record<string, NotionPropertyValue>;
};
type NotionQueryResponse = {
  readonly results?: readonly NotionPageResponse[];
  readonly next_cursor?: string | null;
  readonly has_more?: boolean;
};

function readPlainText(fragmentList: readonly NotionRichTextFragment[] | undefined): string {
  return (fragmentList ?? []).map((fragment) => fragment.plain_text ?? '').join('');
}

export function toNotionRowRecord(
  page: NotionPageResponse,
  defaultListName: string,
): NotionRowRecord {
  const properties = page.properties ?? {};
  const rawItemId = readPlainText(properties[NOTION_PROPERTY_ITEM_ID]?.rich_text).trim();
  return {
    pageId: page.id,
    itemId: rawItemId.length > 0 ? rawItemId : undefined,
    // Una fila recién escrita a mano puede no tener lista elegida: cae en la
    // lista por defecto, que es donde Jarvis anota cuando no se le aclara.
    listName: properties[NOTION_PROPERTY_LIST]?.select?.name ?? defaultListName,
    content: readPlainText(properties[NOTION_PROPERTY_ITEM]?.title).trim(),
    isDone: properties[NOTION_PROPERTY_DONE]?.checkbox === true,
  };
}

// `typeof fetch` incluye extras propios de Bun (`preconnect`) que un doble de
// test no tiene por qué implementar. Para inyectar alcanza con la llamada.
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type NotionListsClient = {
  readonly readRowList: () => Promise<readonly NotionRowRecord[]>;
  readonly createRow: (input: {
    readonly itemId: string;
    readonly listName: string;
    readonly content: string;
    readonly createdAtMilliseconds: number;
  }) => Promise<void>;
  readonly writeItemId: (pageId: string, itemId: string) => Promise<void>;
  readonly archiveRow: (pageId: string) => Promise<void>;
};

export function createNotionListsClient(input: {
  readonly token: string;
  readonly databaseId: string;
  readonly defaultListName: string;
  readonly fetchImplementation?: FetchLike;
}): NotionListsClient {
  const performFetch = input.fetchImplementation ?? fetch;
  // Las escrituras van en fila india y espaciadas: en paralelo Notion devuelve
  // 429 y habría que reintentar igual, con más código y peor latencia.
  let requestChain: Promise<unknown> = Promise.resolve();

  async function request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
  ): Promise<T> {
    const response = await performFetch(`${NOTION_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Notion-Version': NOTION_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Notion ${method} ${path} respondió ${response.status}: ${detail.slice(0, 300)}`,
      );
    }
    return (await response.json()) as T;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = requestChain.then(operation);
    requestChain = result
      .catch(() => undefined)
      .then(() => Bun.sleep(NOTION_REQUEST_SPACING_MILLISECONDS));
    return result;
  }

  return {
    async readRowList() {
      const rowList: NotionRowRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await enqueue(() =>
          request<NotionQueryResponse>(`/databases/${input.databaseId}/query`, 'POST', {
            page_size: NOTION_QUERY_PAGE_SIZE,
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
          }),
        );
        for (const result of page.results ?? []) {
          if (result.archived === true || result.in_trash === true) {
            continue;
          }
          const row = toNotionRowRecord(result, input.defaultListName);
          // Una fila sin texto es la que Notion crea al apretar "+": todavía no
          // dice nada, no hay nada que sincronizar.
          if (row.content.length > 0) {
            rowList.push(row);
          }
        }
        cursor = page.has_more === true ? (page.next_cursor ?? undefined) : undefined;
      } while (cursor !== undefined);
      // La reconciliación espera orden de creación ascendente, y la query de
      // Notion devuelve por defecto de más nueva a más vieja.
      return rowList.reverse();
    },

    async createRow(row) {
      await enqueue(() =>
        request('/pages', 'POST', {
          parent: { database_id: input.databaseId },
          properties: {
            [NOTION_PROPERTY_ITEM]: { title: [{ text: { content: row.content } }] },
            [NOTION_PROPERTY_LIST]: { select: { name: row.listName } },
            [NOTION_PROPERTY_ITEM_ID]: { rich_text: [{ text: { content: row.itemId } }] },
            [NOTION_PROPERTY_DONE]: { checkbox: false },
            [NOTION_PROPERTY_CREATED]: {
              date: { start: new Date(row.createdAtMilliseconds).toISOString() },
            },
          },
        }),
      );
    },

    async writeItemId(pageId, itemId) {
      await enqueue(() =>
        request(`/pages/${pageId}`, 'PATCH', {
          properties: {
            [NOTION_PROPERTY_ITEM_ID]: { rich_text: [{ text: { content: itemId } }] },
          },
        }),
      );
    },

    async archiveRow(pageId) {
      await enqueue(() => request(`/pages/${pageId}`, 'PATCH', { archived: true }));
    },
  };
}
