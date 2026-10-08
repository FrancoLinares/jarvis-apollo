// Respuesta en vivo: el texto del modelo se muestra en el cartel MIENTRAS se
// genera, en vez de dejar “Pensando…” congelado hasta que empieza a hablar.
// El LLM ya llegaba en streaming (se usaba para adelantar el TTS del primer
// segmento); acá se aprovecha el mismo flujo de deltas para la pantalla.

// El cartel es una franja de una línea (toast_label, 620px con la fuente de 30).
// No entra la respuesta entera, así que se muestra la COLA del texto, como un
// teleprompter: siempre se lee lo último que salió del modelo.
export const STREAMING_CAPTION_MAX_CHARACTER_COUNT = 42;

// El firmware repinta el cartel en cada ui_state. Medido contra el servidor
// real, este intervalo es lo que limita la fluidez: con 250ms el texto entraba
// a los saltos. A ~7 por segundo se lee como escritura corrida, y sigue siendo
// un repintado de una franja de 620x46 en una placa que ya dibuja la cara.
export const STREAMING_CAPTION_MINIMUM_INTERVAL_MILLISECONDS = 150;

// Turquesa: no es ninguna familia de herramienta, es “la respuesta se está
// escribiendo”. Se distingue del gris de sistema y del violeta de memoria.
export const STREAMING_CAPTION_ACCENT_COLOR = '#2DD4BF';

// Corte por palabra: al quedarse con la cola, el primer token casi siempre queda
// partido al medio. Se descarta si el corte está cerca del principio; si la
// palabra es larguísima se deja tal cual antes que vaciar el cartel.
const LEADING_WORD_TRIM_MAX_INDEX = 20;

export function buildStreamingCaption(streamedText: string): string {
  // El modelo cierra con [[escucho]] para pedir el micrófono. Es una marca de
  // protocolo, no algo para leer: se saca acá igual que en el texto hablado,
  // incluyendo el corchete a medio escribir del final del stream.
  const withoutListenMark = streamedText
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[\[?[^\]]*$/, ' ');
  const collapsed = withoutListenMark.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return '';
  }
  if (collapsed.length <= STREAMING_CAPTION_MAX_CHARACTER_COUNT) {
    return collapsed;
  }
  const tail = collapsed.slice(collapsed.length - STREAMING_CAPTION_MAX_CHARACTER_COUNT);
  const firstSpaceIndex = tail.indexOf(' ');
  const aligned =
    firstSpaceIndex >= 0 && firstSpaceIndex <= LEADING_WORD_TRIM_MAX_INDEX
      ? tail.slice(firstSpaceIndex + 1)
      : tail;
  return `…${aligned}`;
}

export type StreamingCaptionEmitter = {
  // Devuelve el cartel a mandar, o undefined si hay que saltear este delta
  // (llegó demasiado pronto, o el texto visible no cambió).
  readonly nextCaption: (
    streamedText: string,
    nowMilliseconds: number,
  ) => string | undefined;
};

export function createStreamingCaptionEmitter(input?: {
  readonly minimumIntervalMilliseconds?: number;
}): StreamingCaptionEmitter {
  const minimumIntervalMilliseconds =
    input?.minimumIntervalMilliseconds ?? STREAMING_CAPTION_MINIMUM_INTERVAL_MILLISECONDS;
  let lastEmittedAtMilliseconds: number | undefined;
  let lastEmittedCaption: string | undefined;

  return {
    nextCaption(streamedText, nowMilliseconds) {
      const caption = buildStreamingCaption(streamedText);
      if (caption.length === 0) {
        return undefined;
      }
      if (
        lastEmittedAtMilliseconds !== undefined &&
        nowMilliseconds - lastEmittedAtMilliseconds < minimumIntervalMilliseconds
      ) {
        return undefined;
      }
      if (caption === lastEmittedCaption) {
        return undefined;
      }
      lastEmittedAtMilliseconds = nowMilliseconds;
      lastEmittedCaption = caption;
      return caption;
    },
  };
}
