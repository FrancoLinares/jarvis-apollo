import { describe, expect, it } from 'bun:test';

import {
  isLikelySilenceTranscript,
  normalizeTranscriptForComparison,
} from '@/voice/silence';

describe('normalizeTranscriptForComparison', () => {
  it('saca tildes, puntuación y mayúsculas', () => {
    expect(normalizeTranscriptForComparison('¡Gracias!')).toBe('gracias');
    expect(normalizeTranscriptForComparison('  Gracias por ver el VÍDEO.  ')).toBe(
      'gracias por ver el video',
    );
  });
});

describe('isLikelySilenceTranscript', () => {
  it('descarta las alucinaciones típicas de Whisper ante silencio', () => {
    for (const frase of [
      'Gracias.',
      '¡Gracias!',
      'Gracias por ver el video',
      'Muchas gracias',
      'Subtítulos realizados por la comunidad de Amara.org',
      'Thanks for watching!',
      'Thank you.',
    ]) {
      expect(isLikelySilenceTranscript(frase)).toBe(true);
    }
  });

  it('descarta restos de ruido demasiado cortos', () => {
    expect(isLikelySilenceTranscript('')).toBe(true);
    expect(isLikelySilenceTranscript('   ')).toBe(true);
    expect(isLikelySilenceTranscript('...')).toBe(true);
    expect(isLikelySilenceTranscript('ah')).toBe(true);
  });


  it('descarta los bucles de repetición que Whisper produce ante silencio', () => {
    // Transcripciones REALES capturadas del dispositivo: el modelo entra en
    // bucle y repite la muletilla. El filtro anterior solo miraba la frase
    // exacta y las dejaba pasar, gastando una llamada al LLM por cada una.
    for (const frase of [
      '¡Ah!  Gracias.  Gracias.  Gracias.  Gracias.  Gracias.',
      '¡Ahh!  Gracias.  Gracias.  Gracias.  Gracias.',
      '¡Ah!  Gracias.',
      'Gracias. Gracias. Gracias.',
    ]) {
      expect(isLikelySilenceTranscript(frase)).toBe(true);
    }
  });

  it('no confunde una orden que repite una palabra dos veces', () => {
    // Dos repeticiones pueden ser habla real ("sí, sí, dale"); el umbral es tres.
    expect(isLikelySilenceTranscript('Poné poné el timer de cinco minutos')).toBe(false);
  });

  it('deja pasar una orden de verdad', () => {
    for (const frase of [
      '¿Qué hora es?',
      'Cuánto tardo hasta el Obelisco',
      'Poné un timer de cinco minutos',
      // Contiene "gracias" pero es una frase real, no la muletilla suelta.
      'Gracias, ahora decime el clima',
    ]) {
      expect(isLikelySilenceTranscript(frase)).toBe(false);
    }
  });
});

describe('respuestas cortas legítimas', () => {
  // Regresión: el filtro de alucinaciones se comía "sí" y "no", y cuando Jarvis
  // preguntaba algo la conversación se cortaba sin explicación.
  it('no descarta un sí ni un no', () => {
    expect(isLikelySilenceTranscript('sí')).toBe(false);
    expect(isLikelySilenceTranscript('si')).toBe(false);
    expect(isLikelySilenceTranscript('no')).toBe(false);
    expect(isLikelySilenceTranscript('No.')).toBe(false);
  });

  it('tampoco un ok o un dale', () => {
    expect(isLikelySilenceTranscript('ok')).toBe(false);
    expect(isLikelySilenceTranscript('dale')).toBe(false);
    expect(isLikelySilenceTranscript('ya')).toBe(false);
  });

  it('pero sigue descartando las alucinaciones de siempre', () => {
    expect(isLikelySilenceTranscript('gracias por ver el video')).toBe(true);
    expect(isLikelySilenceTranscript('gracias gracias gracias')).toBe(true);
    expect(isLikelySilenceTranscript('')).toBe(true);
  });
});

describe('frases largas de verdad (regresión)', () => {
  it('no descarta una pregunta normal por repetir una preposición', () => {
    // Capturada del dispositivo con apollo_stt_resultado: "en" aparece tres
    // veces y el filtro la tiraba entera, sin decir nada y sin dejar rastro.
    expect(
      isLikelySilenceTranscript(
        'Me dice que tengo un partido hoy en la agenda. ¿Esto está en el calendar o en tu memoria interna?',
      ),
    ).toBe(false);
  });

  it('tampoco otras frases que repiten palabras funcionales', () => {
    for (const frase of [
      'Acordate de que mañana tengo que ir a lo de mi vieja y de ahí a la oficina',
      'Poné en la lista la leche, el pan y la yerba, y después contame qué hay en la agenda',
    ]) {
      expect(isLikelySilenceTranscript(frase)).toBe(false);
    }
  });

  it('pero sigue descartando el bucle de frase repetida', () => {
    expect(
      isLikelySilenceTranscript(
        'Gracias por ver el video. Gracias por ver el video. Gracias por ver el video.',
      ),
    ).toBe(true);
  });
});

describe('repeticiones dentro de habla real (regresión)', () => {
  it('no descarta un "bla bla bla" usado para abreviar', () => {
    // Capturada con apollo_stt_resultado: el pedido se descartó entero y Jarvis
    // ni lo proceso. Tres palabras iguales seguidas dentro de una frase de doce
    // son habla humana, no un bucle del modelo.
    expect(
      isLikelySilenceTranscript(
        '¿puedes remover el pendiente, mejorar la UI, bla bla bla?  en los',
      ),
    ).toBe(false);
  });

  it('tampoco un énfasis repetido en medio de una orden', () => {
    expect(
      isLikelySilenceTranscript('no no no, cancelá ese recordatorio y poné uno nuevo'),
    ).toBe(false);
    expect(
      isLikelySilenceTranscript('dale dale dale, agregá la leche a la lista del súper'),
    ).toBe(false);
  });

  it('pero un bucle que ocupa toda la frase se sigue descartando', () => {
    expect(isLikelySilenceTranscript('Gracias. Gracias. Gracias.')).toBe(true);
    expect(isLikelySilenceTranscript('¡Ah! Gracias. Gracias. Gracias. Gracias.')).toBe(true);
  });
});

describe('barrera de palabras distintas', () => {
  it('seis palabras distintas nunca se descartan', () => {
    // La regla de fondo: los falsos positivos matan el turno en silencio y los
    // falsos negativos solo cuestan una llamada. Ante la duda, pasa.
    for (const frase of [
      'sacá de la lista el ítem de mejorar la interfaz',
      'che, anotá que tengo que llamar al del service mañana temprano',
      'no no no no, mejor cancelalo y agendame otra cosa distinta',
    ]) {
      expect(isLikelySilenceTranscript(frase)).toBe(false);
    }
  });

  it('las alucinaciones conocidas siguen filtrándose igual', () => {
    for (const frase of [
      'Subtítulos realizados por la comunidad de Amara.org',
      'Gracias por ver el video',
      'Gracias. Gracias. Gracias.',
      '¡Ah! Gracias.',
    ]) {
      expect(isLikelySilenceTranscript(frase)).toBe(true);
    }
  });
});
