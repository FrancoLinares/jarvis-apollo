// Whisper alucina cuando le dan silencio o ruido.
//
// El modelo se entrenó con subtítulos de YouTube, así que ante audio sin habla
// devuelve las muletillas más frecuentes de ese corpus: "Gracias", "Gracias por
// ver el video", "Subtítulos realizados por la comunidad de Amara.org". Con el
// modo conversación el micrófono se reabre después de cada respuesta, así que
// esto pasa seguido: el usuario deja de hablar, Whisper inventa un "Gracias" y
// Jarvis contesta "de nada, avisame si necesitás algo" — una llamada al LLM y
// una síntesis de voz por un turno que nunca existió.
//
// Filtrar acá es más barato y más predecible que pedirle al prompt que ignore
// los saludos: el modelo no puede distinguir un "gracias" real de uno alucinado,
// pero nosotros sabemos que el de verdad casi nunca viene solo.

/** Frases que Whisper devuelve ante silencio, ya normalizadas. */
const HALLUCINATED_SILENCE_PHRASE_SET = new Set([
  'gracias',
  'gracias por ver el video',
  'gracias por ver el vídeo',
  'gracias por su atencion',
  'muchas gracias',
  'subtitulos realizados por la comunidad de amara org',
  'subtitulos por la comunidad de amara org',
  'subtitulado por la comunidad de amara org',
  'mas informacion www alimmenta com',
  'suscribete al canal',
  'suscribete',
  'thanks for watching',
  'thank you',
  'thank you very much',
  'you',
  'bye',
  // 'okay', 'ok' y 'si' SALIERON de esta lista: son las respuestas mas comunes
  // cuando Jarvis pregunta algo, y descartarlas cortaba la conversacion. El
  // riesgo de una alucinacion suelta es menor que el de comerse un "si".
  'ah',
  'eh',
  'mm',
  'hm',
]);

// Palabras que aparecen en las alucinaciones pero nunca solas en una orden. Si
// una transcripción está hecha ÚNICAMENTE de estas, no se dijo nada.
const FILLER_WORD_SET = new Set([
  'gracias', 'muchas', 'por', 'ver', 'el', 'la', 'de', 'su', 'atencion',
  'video', 'canal', 'suscribete', 'subtitulos', 'subtitulado', 'realizados',
  'comunidad', 'amara', 'org', 'mas', 'informacion', 'www', 'com',
  'ah', 'ahh', 'eh', 'ehh', 'mm', 'mmm', 'hm', 'hmm', 'oh', 'uh', 'um',
  'thanks', 'thank', 'you', 'for', 'watching', 'bye', 'goodbye', 'okay', 'ok',
]);

// Whisper entra en bucle ante el silencio y repite la misma palabra. Una orden
// real nunca repite una sola palabra tantas veces.
const REPETITION_LOOP_MINIMUM_COUNT = 3;

// Seis palabras distintas ya son una oracion; ninguna muletilla alucinada llega
// a esa variedad. "gracias por ver el video" repetido tiene cinco.
const MEANINGFUL_DISTINCT_WORD_COUNT = 6;

// La racha repetida tiene que ser al menos la mitad de la frase para contar
// como bucle. "Gracias. Gracias. Gracias." es 3 de 3; el "bla bla bla" de una
// pregunta de doce palabras es 3 de 12.
const REPETITION_LOOP_DOMINANCE_RATIO = 0.5;

// Un bucle de frase solo se juzga con suficiente texto: en algo de 4 palabras
// repetir una es normal ("sí, sí, dale, dale").
const LEXICAL_DIVERSITY_MINIMUM_WORD_COUNT = 8;
// La mitad o menos de palabras distintas = el modelo se trabó.
const LEXICAL_DIVERSITY_LOOP_RATIO = 0.5;

// Una transcripción real de una orden de voz casi nunca baja de esto. Los restos
// de ruido ("ah", "eh", un punto suelto) sí.
const MINIMUM_MEANINGFUL_CHARACTER_COUNT = 3;

// Respuestas cortas que SÍ son una respuesta.
//
// El filtro de alucinaciones descartaba todo lo de menos de 3 caracteres, y en
// una conversación real eso incluye "sí", "no" y "ok" — justo las respuestas
// más comunes cuando Jarvis pregunta algo. El turno moría en silencio y la
// conversación se cortaba sin explicación.
//
// Van con y sin tilde porque Whisper alterna, y en minúscula porque la
// comparación se hace sobre el texto normalizado.
const MEANINGFUL_SHORT_REPLY_SET = new Set([
  'si', 'sí', 'no', 'ok', 'oka', 'ya', 'va', 'dale',
  'nop', 'yep', 'sip', 'ajá', 'aja', 'mmm',
]);

/** Sin tildes, sin puntuación, en minúsculas: así se comparan las frases. */
export function normalizeTranscriptForComparison(transcript: string): string {
  return transcript
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ¿Esta transcripción es ruido en vez de una orden? Devuelve true para el
 * silencio alucinado y para los restos demasiado cortos para significar algo.
 */
export function isLikelySilenceTranscript(transcript: string): boolean {
  const normalized = normalizeTranscriptForComparison(transcript);
  if (normalized.length === 0) {
    return true;
  }
  // Antes que TODO descarte: una respuesta corta legítima es una respuesta.
  if (MEANINGFUL_SHORT_REPLY_SET.has(normalized)) {
    return false;
  }
  if (HALLUCINATED_SILENCE_PHRASE_SET.has(normalized)) {
    return true;
  }
  if (normalized.length < MINIMUM_MEANINGFUL_CHARACTER_COUNT) {
    return true;
  }

  const wordList = normalized.split(' ').filter((word) => word.length > 0);

  // Barrera estructural, antes de cualquier heuristica: las alucinaciones de
  // Whisper ante silencio tienen vocabulario pobre (repiten una muletilla o una
  // frase corta). Si hay bastantes palabras DISTINTAS, hubo habla real y no se
  // descarta, pase lo que pase mas abajo.
  //
  // Existe porque los descartes son asimetricos: un falso positivo mata el turno
  // en silencio y el usuario se queda sin respuesta, mientras que un falso
  // negativo cuesta una llamada al LLM. Ante la duda, dejar pasar.
  // Ya se comio dos frases reales: una por repetir "en" tres veces y otra por un
  // "bla bla bla". Las frases hechas conocidas se filtran antes, por igualdad
  // exacta, asi que esta barrera no las toca.
  if (new Set(wordList).size >= MEANINGFUL_DISTINCT_WORD_COUNT) {
    return false;
  }

  // Bucle de repetición: "gracias gracias gracias gracias". Nadie dicta una
  // orden repitiendo la misma palabra; Whisper sí lo hace ante el silencio.
  //
  // Se mira la repetición CONSECUTIVA, no el total de apariciones. Contar el
  // total tiraba frases normales: en "...un partido hoy en la agenda, ¿esto
  // está en el calendar o en tu memoria interna?" la palabra "en" aparece tres
  // veces y la oración entera se descartaba en silencio. En castellano "en",
  // "de", "que" y "la" llegan a tres en cualquier frase larga.
  let longestConsecutiveRun = 1;
  let currentRun = 1;
  for (let index = 1; index < wordList.length; index++) {
    currentRun = wordList[index] === wordList[index - 1] ? currentRun + 1 : 1;
    longestConsecutiveRun = Math.max(longestConsecutiveRun, currentRun);
  }
  // No alcanza con que la racha exista: tiene que DOMINAR la frase. Un bucle de
  // Whisper es toda la transcripcion ("Gracias. Gracias. Gracias."), no una
  // repeticion metida adentro de una oracion real. Sin esta condicion se
  // descartaba "¿puedes remover el pendiente, mejorar la UI, bla bla bla?",
  // donde el "bla bla bla" es habla humana normal para abreviar.
  if (
    longestConsecutiveRun >= REPETITION_LOOP_MINIMUM_COUNT &&
    longestConsecutiveRun / wordList.length >= REPETITION_LOOP_DOMINANCE_RATIO
  ) {
    return true;
  }

  // El otro bucle de Whisper repite una FRASE, no una palabra suelta:
  // "gracias por ver el video" tres veces seguidas. Ahí las palabras no quedan
  // pegadas, pero el vocabulario se desploma: mucho texto y muy pocas palabras
  // distintas. Una frase humana larga casi no repite nada.
  const distinctWordCount = new Set(wordList).size;
  if (
    wordList.length >= LEXICAL_DIVERSITY_MINIMUM_WORD_COUNT &&
    distinctWordCount / wordList.length <= LEXICAL_DIVERSITY_LOOP_RATIO
  ) {
    return true;
  }

  // Todo el texto es relleno: "¡Ah! Gracias." o "Gracias por ver el video".
  // Basta que UNA palabra no lo sea para tratarlo como una orden real, así un
  // "gracias, ahora decime la hora" pasa sin problema.
  return wordList.every((word) => FILLER_WORD_SET.has(word));
}
