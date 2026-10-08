import { z } from 'zod';

import { buildApiCostEntry, openRouterUsageSchema, reportApiCost } from '@/costs/ledger';

const openRouterTranscriptionResponseSchema = z.object({
  text: z.string().optional(),
  usage: openRouterUsageSchema.nullable().optional(),
});

function encodeArrayBufferAsBase64(arrayBuffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(arrayBuffer);
  let binaryString = '';
  for (const byteValue of byteArray) {
    binaryString += String.fromCharCode(byteValue);
  }
  return btoa(binaryString);
}

export async function transcribeAudioWithOpenRouter(input: {
  readonly audioBuffer: ArrayBuffer;
  readonly openRouterApiKey: string;
  readonly modelId: string;
  readonly languageCode?: string;
  readonly audioFormat?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<string> {
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const response = await fetchImplementation(
    'https://openrouter.ai/api/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.openRouterApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.modelId,
        language: input.languageCode ?? 'es',
        input_audio: {
          data: encodeArrayBufferAsBase64(input.audioBuffer),
          format: input.audioFormat ?? 'wav',
        },
      }),
    },
  );

  if (!response.ok) {
    // The status alone says nothing actionable: the reason a transcription is
    // rejected (audio too long, unsupported format, bad model) only ever comes
    // back in the body.
    const failureDetail = await response.text().catch(() => '');
    const audioKilobytes = Math.round(input.audioBuffer.byteLength / 1024);
    throw new Error(
      `STT falló con status ${response.status} (${audioKilobytes} kB de audio): ${failureDetail.slice(0, 500)}`,
    );
  }

  const payload = openRouterTranscriptionResponseSchema.parse(await response.json());
  reportApiCost(buildApiCostEntry('stt', input.modelId, payload.usage ?? undefined));
  // Una transcripción vacía significa silencio, no un fallo. Lanzar acá hacía
  // que el turno terminara en "No pude procesar ese pedido" en la pantalla, algo
  // que pasa seguido con el modo conversación: el micrófono se reabre solo
  // después de cada respuesta y quedarse callado es lo normal. Devolver la
  // cadena vacía deja que quien llama decida — runDeskTurn ya tiene esa rama.
  return payload.text?.trim() ?? '';
}
