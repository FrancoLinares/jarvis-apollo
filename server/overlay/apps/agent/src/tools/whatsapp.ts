import { z } from 'zod';

import type { ToolDefinition } from '@/tools/types';
import { getWhatsAppNotifier } from '@/whatsapp/client';

const sendWhatsAppArgsSchema = z.object({
  texto: z.string().min(1).max(3000),
});

// Le escribe al dueño, al chat de WhatsApp consigo mismo. No manda a terceros:
// un mensaje a otra persona en nombre del dueño necesitaría confirmación y un
// contacto, y no se pidió.
export const sendWhatsAppTool: ToolDefinition = {
  name: 'send_whatsapp',
  safety: 'safe',
  description:
    'Le manda un mensaje de WhatsApp AL PROPIO USUARIO (a su chat consigo mismo). Usar cuando pide "mandame/pasame por WhatsApp" algo: una lista, una dirección, un resumen, un recordatorio para el celular. Para escribirle a otra persona, usá mandar_mensaje.',
  parameters: {
    type: 'object',
    properties: {
      texto: {
        type: 'string',
        description: 'El texto completo a mandar, listo para leer en el celular. Puede tener saltos de línea.',
      },
    },
    required: ['texto'],
    additionalProperties: false,
  },
  async handler(args) {
    const parsedArgs = sendWhatsAppArgsSchema.parse(args);
    const result = await getWhatsAppNotifier().send(parsedArgs.texto);
    return result.ok
      ? { ok: true, summary: 'Mensaje de WhatsApp enviado' }
      : { ok: false, summary: `No pude mandar el WhatsApp: ${result.reason}` };
  },
};
