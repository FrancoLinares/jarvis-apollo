// Núcleo puro de la sincronización SQLite ↔ Notion.
//
// El SQLite de la Pi manda para lo que se dicta por voz; Notion manda para lo
// que se escribe a mano. Como Apollo no tiene herramienta de "editar ítem" (solo
// agregar y sacar), el texto de un ítem nunca cambia del lado de la Pi: si los
// dos textos difieren es porque lo editaron en Notion, y por eso Notion gana.
//
// Todo se resuelve con una reconciliación completa en cada vuelta, sin cola ni
// registro de cambios: es idempotente, tolera que se pierda un ciclo y se
// arregla sola después de un corte de red.

export type JarvisListItem = {
  readonly id: string;
  readonly listName: string;
  readonly content: string;
};

export type NotionListPage = {
  readonly pageId: string;
  // Vacío cuando la fila la escribió una persona en Notion y todavía no se
  // vinculó con ningún ítem del SQLite.
  readonly itemId: string | undefined;
  readonly listName: string;
  readonly content: string;
  readonly isDone: boolean;
};

export type NotionSyncPlan = {
  // Ítems dictados a Jarvis que todavía no tienen fila en Notion.
  readonly createInNotionList: readonly JarvisListItem[];
  // Fila e ítem que son claramente el mismo: alcanza con escribirle el ID.
  readonly linkList: readonly { readonly pageId: string; readonly itemId: string }[];
  // Filas escritas a mano en Notion que hay que dar de alta en el SQLite.
  readonly adoptList: readonly {
    readonly pageId: string;
    readonly listName: string;
    readonly content: string;
  }[];
  // Ítems que dejaron de existir en el SQLite, o filas ya tildadas: se archivan.
  readonly archivePageIdList: readonly string[];
  // Tildadas como hechas: se borran de la lista de Jarvis.
  readonly removeItemIdList: readonly string[];
  // Editadas en Notion: el SQLite se pone al día.
  readonly updateJarvisList: readonly {
    readonly itemId: string;
    readonly listName: string;
    readonly content: string;
  }[];
};

// Para emparejar un ítem dictado con una fila escrita a mano hay que ignorar
// mayúsculas, espacios de más y el punto final que a veces agrega el modelo.
function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?¡¿]+$/g, '')
    .trim();
}

function buildMatchKey(listName: string, content: string): string {
  return `${normalizeForMatching(listName)} ${normalizeForMatching(content)}`;
}

/**
 * `notionPageList` tiene que venir ordenada por fecha de creación ascendente:
 * si dos filas comparten el mismo ID (porque alguien duplicó una en Notion), la
 * primera se considera la original y la copia se trata como un ítem nuevo.
 */
export function planNotionSync(input: {
  readonly jarvisItemList: readonly JarvisListItem[];
  readonly notionPageList: readonly NotionListPage[];
}): NotionSyncPlan {
  const jarvisItemById = new Map(input.jarvisItemList.map((item) => [item.id, item]));

  const canonicalPageByItemId = new Map<string, NotionListPage>();
  const unlinkedPageList: NotionListPage[] = [];
  const archivePageIdList: string[] = [];
  const removeItemIdList: string[] = [];
  const updateJarvisList: NotionSyncPlan['updateJarvisList'][number][] = [];

  for (const page of input.notionPageList) {
    const itemId = page.itemId?.trim();
    const isCanonical =
      itemId !== undefined && itemId.length > 0 && !canonicalPageByItemId.has(itemId);

    if (page.isDone) {
      // Tildada: sale de la lista de Jarvis y la fila se archiva, así no vuelve
      // a entrar en la próxima vuelta como "ítem que ya no existe".
      archivePageIdList.push(page.pageId);
      if (isCanonical && jarvisItemById.has(itemId)) {
        removeItemIdList.push(itemId);
      }
      continue;
    }

    if (!isCanonical) {
      // Sin ID, o duplicada de una fila que ya vimos: en los dos casos es algo
      // que todavía no vive en el SQLite.
      unlinkedPageList.push(page);
      continue;
    }

    canonicalPageByItemId.set(itemId, page);
    const jarvisItem = jarvisItemById.get(itemId);
    if (jarvisItem === undefined) {
      // El ítem se borró por voz: la fila deja de tener sentido.
      archivePageIdList.push(page.pageId);
      continue;
    }
    if (jarvisItem.content !== page.content || jarvisItem.listName !== page.listName) {
      updateJarvisList.push({
        itemId,
        listName: page.listName,
        content: page.content,
      });
    }
  }

  // Lo que quedó suelto de los dos lados se intenta emparejar antes de crear
  // nada: si no, dictar "pan" y escribir "pan" en Notion dejaría dos ítems. Es
  // además la red de seguridad de un adopt cuyo write-back del ID falló.
  //
  // Los que se están por borrar quedan afuera: su fila ya se archivó por estar
  // tildada, así que sin esto contarían como "ítem sin fila" y se volverían a
  // crear en Notion — tildar Hecho lo resucitaría en vez de completarlo.
  const removeItemIdSet = new Set(removeItemIdList);
  const unmatchedJarvisItemList = input.jarvisItemList.filter(
    (item) => !canonicalPageByItemId.has(item.id) && !removeItemIdSet.has(item.id),
  );
  const jarvisItemListByMatchKey = new Map<string, JarvisListItem[]>();
  for (const item of unmatchedJarvisItemList) {
    const key = buildMatchKey(item.listName, item.content);
    const bucket = jarvisItemListByMatchKey.get(key);
    if (bucket === undefined) {
      jarvisItemListByMatchKey.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }

  const linkList: NotionSyncPlan['linkList'][number][] = [];
  const adoptList: NotionSyncPlan['adoptList'][number][] = [];
  const linkedItemIdSet = new Set<string>();

  for (const page of unlinkedPageList) {
    const bucket = jarvisItemListByMatchKey.get(buildMatchKey(page.listName, page.content));
    const match = bucket?.shift();
    if (match === undefined) {
      adoptList.push({
        pageId: page.pageId,
        listName: page.listName,
        content: page.content,
      });
      continue;
    }
    linkList.push({ pageId: page.pageId, itemId: match.id });
    linkedItemIdSet.add(match.id);
  }

  const createInNotionList = unmatchedJarvisItemList.filter(
    (item) => !linkedItemIdSet.has(item.id),
  );

  return {
    createInNotionList,
    linkList,
    adoptList,
    archivePageIdList,
    removeItemIdList,
    updateJarvisList,
  };
}

export function isEmptyNotionSyncPlan(plan: NotionSyncPlan): boolean {
  return (
    plan.createInNotionList.length === 0 &&
    plan.linkList.length === 0 &&
    plan.adoptList.length === 0 &&
    plan.archivePageIdList.length === 0 &&
    plan.removeItemIdList.length === 0 &&
    plan.updateJarvisList.length === 0
  );
}
