import { describe, expect, it } from 'bun:test';

import {
  isEmptyNotionSyncPlan,
  planNotionSync,
  type JarvisListItem,
  type NotionListPage,
} from '@/notion/reconcile';

function buildJarvisItem(overrides: Partial<JarvisListItem> = {}): JarvisListItem {
  return { id: 'item-1', listName: 'super', content: 'pan', ...overrides };
}

function buildNotionPage(overrides: Partial<NotionListPage> = {}): NotionListPage {
  return {
    pageId: 'page-1',
    itemId: 'item-1',
    listName: 'super',
    content: 'pan',
    isDone: false,
    ...overrides,
  };
}

describe('planNotionSync', () => {
  it('no propone nada cuando los dos lados ya coinciden', () => {
    const plan = planNotionSync({
      jarvisItemList: [buildJarvisItem()],
      notionPageList: [buildNotionPage()],
    });
    expect(isEmptyNotionSyncPlan(plan)).toBe(true);
  });

  it('sube a Notion lo que se dictó por voz', () => {
    const plan = planNotionSync({
      jarvisItemList: [buildJarvisItem({ id: 'item-9', content: 'leche' })],
      notionPageList: [],
    });
    expect(plan.createInNotionList).toEqual([
      { id: 'item-9', listName: 'super', content: 'leche' },
    ]);
  });

  it('da de alta en Jarvis lo que se escribió a mano en Notion', () => {
    const plan = planNotionSync({
      jarvisItemList: [],
      notionPageList: [
        buildNotionPage({ pageId: 'page-7', itemId: undefined, content: 'yerba' }),
      ],
    });
    expect(plan.adoptList).toEqual([
      { pageId: 'page-7', listName: 'super', content: 'yerba' },
    ]);
    expect(plan.createInNotionList).toEqual([]);
  });

  it('trata el ID en blanco igual que el ausente', () => {
    const plan = planNotionSync({
      jarvisItemList: [],
      notionPageList: [buildNotionPage({ itemId: '   ' })],
    });
    expect(plan.adoptList).toHaveLength(1);
  });

  it('vincula en vez de duplicar cuando lo mismo se dictó y se escribió', () => {
    const plan = planNotionSync({
      jarvisItemList: [buildJarvisItem({ id: 'item-3', content: 'Pan lactal.' })],
      notionPageList: [
        buildNotionPage({ pageId: 'page-3', itemId: undefined, content: 'pan  lactal' }),
      ],
    });
    expect(plan.linkList).toEqual([{ pageId: 'page-3', itemId: 'item-3' }]);
    expect(plan.adoptList).toEqual([]);
    expect(plan.createInNotionList).toEqual([]);
  });

  it('no vincula entre listas distintas', () => {
    const plan = planNotionSync({
      jarvisItemList: [buildJarvisItem({ id: 'item-3', listName: 'super' })],
      notionPageList: [
        buildNotionPage({ pageId: 'page-3', itemId: undefined, listName: 'tareas' }),
      ],
    });
    expect(plan.linkList).toEqual([]);
    expect(plan.adoptList).toHaveLength(1);
    expect(plan.createInNotionList).toHaveLength(1);
  });

  it('tildar Hecho lo saca de Jarvis y archiva la fila', () => {
    const plan = planNotionSync({
      jarvisItemList: [buildJarvisItem({ id: 'item-4' })],
      notionPageList: [buildNotionPage({ pageId: 'page-4', itemId: 'item-4', isDone: true })],
    });
    expect(plan.removeItemIdList).toEqual(['item-4']);
    expect(plan.archivePageIdList).toEqual(['page-4']);
    // Y no vuelve a subirlo: un ítem que se está borrando no es un "ítem sin
    // fila", o tildar Hecho lo resucitaría en la misma vuelta.
    expect(plan.createInNotionList).toEqual([]);
    expect(plan.linkList).toEqual([]);
  });

  it('archiva una fila tildada que nunca llegó a existir en Jarvis', () => {
    const plan = planNotionSync({
      jarvisItemList: [],
      notionPageList: [buildNotionPage({ itemId: undefined, isDone: true })],
    });
    expect(plan.archivePageIdList).toEqual(['page-1']);
    expect(plan.removeItemIdList).toEqual([]);
    expect(plan.adoptList).toEqual([]);
  });

  it('archiva la fila de un ítem que se borró por voz', () => {
    const plan = planNotionSync({
      jarvisItemList: [],
      notionPageList: [buildNotionPage({ pageId: 'page-5', itemId: 'item-borrado' })],
    });
    expect(plan.archivePageIdList).toEqual(['page-5']);
    expect(plan.adoptList).toEqual([]);
  });

  it('trae a Jarvis el texto editado en Notion', () => {
    const plan = planNotionSync({
      jarvisItemList: [buildJarvisItem({ id: 'item-6', content: 'pan' })],
      notionPageList: [
        buildNotionPage({ itemId: 'item-6', content: 'pan integral', listName: 'compras' }),
      ],
    });
    expect(plan.updateJarvisList).toEqual([
      { itemId: 'item-6', listName: 'compras', content: 'pan integral' },
    ]);
  });

  it('una fila duplicada a mano en Notion se convierte en un ítem nuevo', () => {
    const plan = planNotionSync({
      jarvisItemList: [buildJarvisItem({ id: 'item-7', content: 'pagar luz' })],
      notionPageList: [
        buildNotionPage({ pageId: 'page-a', itemId: 'item-7', content: 'pagar luz' }),
        buildNotionPage({ pageId: 'page-b', itemId: 'item-7', content: 'pagar gas' }),
      ],
    });
    // La primera queda como la original; la copia entra como alta nueva.
    expect(plan.adoptList).toEqual([
      { pageId: 'page-b', listName: 'super', content: 'pagar gas' },
    ]);
    expect(plan.archivePageIdList).toEqual([]);
    expect(plan.updateJarvisList).toEqual([]);
  });

  it('con dos ítems iguales sueltos empareja uno solo y sube el otro', () => {
    const plan = planNotionSync({
      jarvisItemList: [
        buildJarvisItem({ id: 'item-a', content: 'pan' }),
        buildJarvisItem({ id: 'item-b', content: 'pan' }),
      ],
      notionPageList: [buildNotionPage({ pageId: 'page-x', itemId: undefined, content: 'pan' })],
    });
    expect(plan.linkList).toEqual([{ pageId: 'page-x', itemId: 'item-a' }]);
    expect(plan.createInNotionList).toEqual([
      { id: 'item-b', listName: 'super', content: 'pan' },
    ]);
  });

  it('converge: aplicar el plan y volver a planificar no propone nada', () => {
    const jarvisItemList = [
      buildJarvisItem({ id: 'item-1', content: 'pan' }),
      buildJarvisItem({ id: 'item-2', listName: 'tareas', content: 'llamar al plomero' }),
    ];
    const firstPlan = planNotionSync({ jarvisItemList, notionPageList: [] });
    // Se simula el efecto: cada create deja una fila con su ID ya escrito.
    const notionPageList = firstPlan.createInNotionList.map((item, index) => ({
      pageId: `page-${index}`,
      itemId: item.id,
      listName: item.listName,
      content: item.content,
      isDone: false,
    }));
    const secondPlan = planNotionSync({ jarvisItemList, notionPageList });
    expect(isEmptyNotionSyncPlan(secondPlan)).toBe(true);
  });
});
