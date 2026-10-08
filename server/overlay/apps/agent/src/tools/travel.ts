import { z } from 'zod';

import type { ToolDefinition } from '@/tools/types';

// Tool deliberadamente FINA: solo toma el pedido. Todo el calculo de viaje vive
// en el servidor (travel/departure.ts + host/actor.ts), porque cada campo que
// se agregue aca se paga en el prompt de todos los turnos de esta intencion.
const departureAlertArgsSchema = z.object({
  lugar: z.string().min(1).max(120),
  horaLlegada: z.string().min(1).max(40),
  direccion: z.string().min(1).max(200).optional(),
});

export const departureAlertTool: ToolDefinition = {
  name: 'avisar_para_salir',
  safety: 'safe',
  description:
    'Avisa cuándo hay que salir para llegar a horario a un lugar, calculando el viaje con tráfico. Usar cuando el usuario dice que va a ir a algún lado a una hora.',
  parameters: {
    type: 'object',
    properties: {
      lugar: { type: 'string', description: 'Cómo nombrarlo al hablar, ej: el dentista' },
      horaLlegada: {
        type: 'string',
        description: 'Hora de llegada en ISO 8601 con zona, ej: 2026-09-27T18:00:00-03:00',
      },
      direccion: {
        type: 'string',
        description: 'Dirección o nombre buscable en el mapa. Si no se sabe, omitir.',
      },
    },
    required: ['lugar', 'horaLlegada'],
    additionalProperties: false,
  },
  async handler(args, context) {
    if (!context.effects) {
      return { ok: false, summary: 'Effects no disponibles' };
    }
    const parsedArgs = departureAlertArgsSchema.parse(args);

    const arrivalMilliseconds = Date.parse(parsedArgs.horaLlegada);
    if (!Number.isFinite(arrivalMilliseconds)) {
      return { ok: false, summary: 'No entendí la hora de llegada' };
    }
    // Una hora ya pasada casi siempre es que el modelo erro el dia. Preferimos
    // decirlo a programar un aviso para ayer.
    if (arrivalMilliseconds <= context.nowMilliseconds) {
      return { ok: false, summary: 'Esa hora ya pasó, decime bien cuándo tenés que llegar' };
    }

    return await context.effects.scheduleDepartureAlert({
      placeLabel: parsedArgs.lugar,
      destination: parsedArgs.direccion ?? parsedArgs.lugar,
      arrivalMilliseconds,
    });
  },
};
