import { z } from 'zod';

import {
  isSpeakerRoute,
  readSpeakerHealth,
  resolveSpeakerConfiguration,
  resolveSpeakerRoute,
  setSpeakerRoute,
  setSpeakerVoiceVolume,
  type SpeakerRoute,
} from '@/speaker/output';
import type { ToolDefinition } from '@/tools/types';

const ROUTE_DESCRIPTION: Record<SpeakerRoute, string> = {
  apagado: 'todo suena en la placa',
  avisos: 'los avisos suenan en el parlante y la conversación en la placa',
  todo: 'todo suena en el parlante',
};

const speakerArgsSchema = z.object({
  modo: z.string().optional(),
  volumen: z.number().int().min(0).max(100).optional(),
});

export const speakerTool: ToolDefinition = {
  name: 'parlante',
  safety: 'safe',
  description:
    'Parlante externo conectado a la Raspberry Pi (el que también pasa Spotify). modo: "avisos" (avisos y recordatorios por el parlante, la charla en la placa; es el normal), "todo" (modo parlante: también las respuestas), "apagado" (todo en la placa). volumen: volumen de la voz de Jarvis en el parlante, 0 a 100. Sin argumentos, dice cómo está. La música se elige desde la app de Spotify (dispositivo "Jarvis"); esta herramienta no pone música.',
  parameters: {
    type: 'object',
    properties: {
      modo: { type: 'string', enum: ['avisos', 'todo', 'apagado'] },
      volumen: { type: 'number', minimum: 0, maximum: 100 },
    },
    additionalProperties: false,
  },
  async handler(args) {
    if (resolveSpeakerConfiguration() === undefined) {
      return { ok: false, summary: 'No hay parlante externo configurado.' };
    }
    const parsedArgs = speakerArgsSchema.parse(args);
    const changeList: string[] = [];
    if (parsedArgs.modo !== undefined) {
      if (!isSpeakerRoute(parsedArgs.modo)) {
        return { ok: false, summary: `Modo desconocido: ${parsedArgs.modo}` };
      }
      setSpeakerRoute(parsedArgs.modo);
      changeList.push(`Parlante en modo ${parsedArgs.modo}: ${ROUTE_DESCRIPTION[parsedArgs.modo]}.`);
    }
    if (parsedArgs.volumen !== undefined) {
      const volumeChanged = await setSpeakerVoiceVolume(parsedArgs.volumen);
      if (!volumeChanged) {
        return { ok: false, summary: 'El parlante no responde: no pude cambiar el volumen.' };
      }
      changeList.push(`Voz del parlante al ${parsedArgs.volumen}%.`);
    }
    if (changeList.length > 0) {
      return { ok: true, summary: changeList.join(' ') };
    }
    const route = resolveSpeakerRoute();
    const health = await readSpeakerHealth();
    if (health === undefined) {
      return {
        ok: true,
        summary: `Modo ${route}, pero el parlante no responde: los avisos van a la placa.`,
      };
    }
    const music = health.musicActive === true ? ' Está sonando música.' : '';
    return {
      ok: true,
      summary: `Modo ${route}: ${ROUTE_DESCRIPTION[route]}. Voz al ${String(health.voiceLevel)}%.${music}`,
      data: { route, ...health },
    };
  },
};
