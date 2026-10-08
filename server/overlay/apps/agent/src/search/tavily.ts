import { z } from 'zod';

export type TavilyWebSource = {
  readonly url: string;
  readonly title: string;
  readonly text: string;
};

// url is a plain string on purpose: the live API sometimes returns relative
// redirect urls ("/goto?url=..."), and a strict .url() would fail the whole
// batch — those rows get filtered out below instead.
const tavilySearchResponseSchema = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string(),
      content: z.string(),
      raw_content: z.string().nullable().optional(),
    }),
  ),
});

// Tavily replaced the Cloudflare Web Search binding (account_disabled on the
// free plan). Una sola request devuelve las fuentes listas para sintetizar, sin
// tener que ir a buscar cada URL después.
export async function searchWebSourcesWithTavily(input: {
  readonly tavilyApiKey: string;
  readonly query: string;
  readonly maxResults?: number;
  /**
   * Trae el texto completo de cada página además del extracto. Cuesta caro y
   * por defecto va apagado: medido, `include_raw_content` devolvía 54.439
   * caracteres contra 4.722 sin él — 11 veces más contexto para el LLM en una
   * respuesta hablada de dos oraciones. Encenderlo solo para investigación
   * profunda, donde el texto completo sí se aprovecha.
   */
  readonly includeFullPageText?: boolean;
  readonly fetchImplementation?: typeof fetch;
}): Promise<readonly TavilyWebSource[]> {
  const includeFullPageText = input.includeFullPageText ?? false;
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const response = await fetchImplementation('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.tavilyApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: input.query,
      // 3 fuentes alcanzan para una respuesta hablada de dos oraciones y la
      // búsqueda tarda menos; medido, el web_search era el mayor costo del turno.
      max_results: input.maxResults ?? 3,
      include_raw_content: includeFullPageText,
    }),
  });

  if (!response.ok) {
    throw new Error(`Búsqueda web falló con status ${response.status}`);
  }

  const payload = tavilySearchResponseSchema.parse(await response.json());
  return payload.results
    .filter((result) => result.url.startsWith('http'))
    .map((result) => ({
      url: result.url,
      title: result.title,
      // raw_content es el texto completo de la página; content es el extracto
      // relevante. Sin texto completo el recorte es mucho más chico: 5 extractos
      // entran holgados en el prompt, mientras que 5 páginas enteras a 8000
      // caracteres sumaban hasta 40.000.
      text: includeFullPageText
        ? (result.raw_content ?? result.content).slice(0, 8000)
        : result.content.slice(0, 1500),
    }));
}
