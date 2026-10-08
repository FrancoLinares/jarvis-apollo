// La cara de Einstein reacciona al TONO de la respuesta, no solo al estado
// (escuchando, pensando, hablando). Como en xiaozhi, el que sabe el tono es el
// LLM: cierra la respuesta con una marca [[cara:...]] que no se lee en voz
// alta, igual que [[escucho]]. Va al FINAL para no frenar el TTS adelantado del
// primer segmento.
//
// Cada ánimo es un modo del sprite que antes no se usaba:
//   festejo   → Jumping (salta con los brazos arriba)
//   triste    → Failed (se agarra la cabeza)
//   apurado   → Running
//   pensativo → Review (mano en el mentón)

export type DeskMood = 'festejo' | 'triste' | 'apurado' | 'pensativo';

const DESK_MOOD_LIST: readonly DeskMood[] = ['festejo', 'triste', 'apurado', 'pensativo'];

const MOOD_MARK_PATTERN = /\s*\[\[cara:\s*([a-záéíóúñ]+)\s*\]\]\s*/gi;

export const MOOD_PROMPT_NOTE =
  '\nCara: si tu respuesta tiene un tono claro, terminala con UNA marca para que tu cara en la pantalla reaccione: ' +
  '[[cara:festejo]] (buena noticia, logro, gol, algo que salió bien), [[cara:triste]] (no pudiste, falló algo, mala noticia), ' +
  '[[cara:apurado]] (hay que salir ya, algo urgente) o [[cara:pensativo]] (duda, algo para pensar). ' +
  'Si el tono es neutro, no pongas ninguna. La marca no se lee en voz alta.';

export function isDeskMood(value: string): value is DeskMood {
  return (DESK_MOOD_LIST as readonly string[]).includes(value);
}

// Saca todas las marcas del texto y devuelve la última válida.
export function extractMoodMark(text: string): { readonly text: string; readonly mood: DeskMood | undefined } {
  let mood: DeskMood | undefined;
  const cleaned = text.replace(MOOD_MARK_PATTERN, (_match, rawMood: string) => {
    const candidate = rawMood.toLowerCase();
    if (isDeskMood(candidate)) {
      mood = candidate;
    }
    return ' ';
  });
  return { text: cleaned.trim(), mood };
}
