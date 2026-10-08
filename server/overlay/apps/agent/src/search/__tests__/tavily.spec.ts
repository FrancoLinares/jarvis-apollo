import { describe, expect, it } from 'bun:test';

import { searchWebSourcesWithTavily } from '@/search/tavily';

type CapturedFetchCall = {
  readonly url: string;
  readonly init: RequestInit;
};

type TavilySearchResultFixture = {
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly raw_content: string | null;
};

type TavilySearchResponseFixture = {
  readonly results?: readonly TavilySearchResultFixture[];
};

function createCapturingFetchMock(
  responseBody: TavilySearchResponseFixture,
  status = 200,
) {
  const callList: CapturedFetchCall[] = [];
  const fetchHandler = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    callList.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(responseBody), { status });
  };
  const fetchImplementation: typeof fetch = Object.assign(fetchHandler, {
    preconnect: () => {},
  });
  return { fetchImplementation, callList };
}

describe('searchWebSourcesWithTavily', () => {
  it('por defecto pide solo extractos y mapea los resultados a fuentes', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock({
      results: [
        {
          url: 'https://example.com/nota',
          title: 'La nota',
          content: 'resumen corto',
          raw_content: 'texto completo de la página',
        },
        {
          url: 'https://example.com/sin-raw',
          title: 'Sin raw',
          content: 'solo el snippet',
          raw_content: null,
        },
      ],
    });

    const sourceList = await searchWebSourcesWithTavily({
      tavilyApiKey: 'tvly-key',
      query: 'capital de Francia',
      fetchImplementation,
    });

    expect(callList[0].url).toBe('https://api.tavily.com/search');
    expect(callList[0].init.headers).toMatchObject({
      Authorization: 'Bearer tvly-key',
    });
    const capturedRequestBody: unknown = JSON.parse(String(callList[0].init.body));
    expect(capturedRequestBody).toEqual({
      query: 'capital de Francia',
      max_results: 3,
      include_raw_content: false,
    });
    expect(sourceList).toEqual([
      {
        // Sin texto completo se usa el extracto, aunque la respuesta traiga
        // raw_content: es lo que mantiene el prompt chico en una respuesta hablada.
        url: 'https://example.com/nota',
        title: 'La nota',
        text: 'resumen corto',
      },
      {
        url: 'https://example.com/sin-raw',
        title: 'Sin raw',
        text: 'solo el snippet',
      },
    ]);
  });

  it('con includeFullPageText trae el texto completo de la página', async () => {
    const { fetchImplementation, callList } = createCapturingFetchMock({
      results: [
        {
          url: 'https://example.com/nota',
          title: 'La nota',
          content: 'resumen corto',
          raw_content: 'texto completo de la página',
        },
      ],
    });

    const sourceList = await searchWebSourcesWithTavily({
      tavilyApiKey: 'tvly-key',
      query: 'investigación profunda',
      includeFullPageText: true,
      fetchImplementation,
    });

    const capturedRequestBody: unknown = JSON.parse(String(callList[0].init.body));
    expect(capturedRequestBody).toMatchObject({ include_raw_content: true });
    expect(sourceList[0].text).toBe('texto completo de la página');
  });

  it('drops results with relative redirect urls instead of failing the batch', async () => {
    const { fetchImplementation } = createCapturingFetchMock({
      results: [
        {
          url: '/goto?url=CAESYAHuR6pN0iq',
          title: 'Redirect raro',
          content: 'snippet',
          raw_content: null,
        },
        {
          url: 'https://example.com/ok',
          title: 'Válida',
          content: 'snippet útil',
          raw_content: null,
        },
      ],
    });

    const sourceList = await searchWebSourcesWithTavily({
      tavilyApiKey: 'tvly-key',
      query: 'algo',
      fetchImplementation,
    });

    expect(sourceList).toEqual([
      { url: 'https://example.com/ok', title: 'Válida', text: 'snippet útil' },
    ]);
  });

  it('recorta el extracto para que el prompt no se dispare', async () => {
    const { fetchImplementation } = createCapturingFetchMock({
      results: [
        {
          url: 'https://example.com/larga',
          title: 'Página larga',
          content: 'x'.repeat(20000),
          raw_content: 'y'.repeat(20000),
        },
      ],
    });

    const sourceList = await searchWebSourcesWithTavily({
      tavilyApiKey: 'tvly-key',
      query: 'algo',
      fetchImplementation,
    });

    expect(sourceList[0].text.length).toBe(1500);
  });

  it('throws on a non-ok response', async () => {
    const { fetchImplementation } = createCapturingFetchMock({}, 401);
    await expect(
      searchWebSourcesWithTavily({
        tavilyApiKey: 'tvly-bad',
        query: 'algo',
        fetchImplementation,
      }),
    ).rejects.toThrow('Búsqueda web falló con status 401');
  });
});
