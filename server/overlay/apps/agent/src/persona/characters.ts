// Personajes por turno: Jev elige, en la misma llamada del router, si a esta
// frase le queda mejor un tono especial. Lo que contaron todos los que lo
// probaron: un personaje fijo cansa a los dos días; como condimento ocasional
// divierte. Por eso "normal" es lo que sale casi siempre y el resto necesita
// que Jev esté bastante seguro.
//
// No reemplaza el modo de habla del swipe (persona/catalog): se suma encima, y
// solo por un turno.

export type CharacterId = 'normal' | 'sarcastico' | 'relator' | 'mayordomo';

export type Character = {
  readonly id: CharacterId;
  // Lo que lee Jev para decidir.
  readonly criteria: string;
  // Lo que lee el LLM. Vacío = sin nota.
  readonly promptNote: string;
};

export const CHARACTER_LIST: readonly Character[] = [
  {
    id: 'normal',
    criteria:
      'Casi todos los pedidos: datos (hora, clima, dólar), agenda, recordatorios, listas, preguntas serias, ' +
      'cuando el usuario está apurado, molesto, preocupado o se queja, o cuando no hay ningún motivo claro para otro tono.',
    promptNote: '',
  },
  {
    id: 'sarcastico',
    criteria:
      'El usuario bromea, provoca, se burla del asistente, hace una pregunta obvia o absurda, ' +
      'o cuenta algo que pide una ironía cariñosa (se olvidó algo de nuevo, se quedó dormido).',
    promptNote:
      'Personaje de este turno: sarcástico. Contestá con una ironía seca y cariñosa, una sola, ' +
      'sin ser hiriente y sin dejar de dar el dato o hacer lo pedido.',
  },
  {
    id: 'relator',
    criteria:
      'Fútbol, pádel u otro deporte, un resultado, un gol, un partido, o el usuario celebra un logro ' +
      '(cerró una buena operación, terminó algo difícil, ganó algo).',
    promptNote:
      'Personaje de este turno: relator de fútbol rioplatense. Contestá con la emoción de un relato ' +
      'de radio, exclamaciones y ritmo, pero igual de corto y con el dato correcto.',
  },
  {
    id: 'mayordomo',
    criteria:
      'Una orden formal o un trámite de la casa o del día (organizar la agenda, preparar algo, ' +
      'recordar un compromiso, saludar al llegar o al irse, dar las buenas noches).',
    promptNote:
      'Personaje de este turno: mayordomo inglés flemático, a lo Jarvis de Iron Man, pero en rioplatense: ' +
      'formal, impecable, con un toque de humor británico. Llamalo "señor" una vez como mucho.',
  },
];

export const CHARACTER_INSTRUCTIONS =
  '¿Con qué tono le conviene contestar al asistente esta frase? Elegí normal salvo que otro encaje claramente.';

// Por debajo de esto gana normal: un personaje equivocado molesta más que
// ninguno.
export const CHARACTER_MINIMUM_PROBABILITY = 0.6;

export function isCharacterId(value: string): value is CharacterId {
  return CHARACTER_LIST.some((character) => character.id === value);
}

export function resolveCharacterMode(value: string | undefined): 'on' | 'off' {
  return value === 'off' ? 'off' : 'on';
}

export function chooseCharacter(input: {
  readonly probabilityMap: Readonly<Partial<Record<CharacterId, number>>> | undefined;
  readonly complaintProbability?: number;
}): CharacterId {
  if (input.probabilityMap === undefined) {
    return 'normal';
  }
  // Una queja nunca se contesta con chistes.
  if ((input.complaintProbability ?? 0) >= 0.5) {
    return 'normal';
  }
  let best: CharacterId = 'normal';
  let bestProbability = 0;
  for (const character of CHARACTER_LIST) {
    if (character.id === 'normal') {
      continue;
    }
    const probability = input.probabilityMap[character.id] ?? 0;
    if (probability > bestProbability) {
      best = character.id;
      bestProbability = probability;
    }
  }
  return bestProbability >= CHARACTER_MINIMUM_PROBABILITY ? best : 'normal';
}

export function buildCharacterPromptNote(characterId: CharacterId | undefined): string {
  const character = CHARACTER_LIST.find((candidate) => candidate.id === characterId);
  if (character === undefined || character.promptNote.length === 0) {
    return '';
  }
  return `\n${character.promptNote}`;
}
