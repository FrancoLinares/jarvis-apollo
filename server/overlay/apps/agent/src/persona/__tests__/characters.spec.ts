import { describe, expect, it } from 'bun:test';

import { buildCharacterPromptNote, chooseCharacter } from '@/persona/characters';
import { parseJevResponse } from '@/router/jev';

describe('chooseCharacter', () => {
  it('stays normal without a verdict', () => {
    expect(chooseCharacter({ probabilityMap: undefined })).toBe('normal');
  });

  it('picks a character only when Jev is fairly sure', () => {
    expect(chooseCharacter({ probabilityMap: { normal: 0.2, relator: 0.75 } })).toBe('relator');
    expect(chooseCharacter({ probabilityMap: { normal: 0.45, relator: 0.55 } })).toBe('normal');
  });

  it('never jokes back at a complaint', () => {
    expect(
      chooseCharacter({ probabilityMap: { sarcastico: 0.9 }, complaintProbability: 0.8 }),
    ).toBe('normal');
  });

  it('adds no prompt note for normal', () => {
    expect(buildCharacterPromptNote('normal')).toBe('');
    expect(buildCharacterPromptNote(undefined)).toBe('');
    expect(buildCharacterPromptNote('mayordomo')).toContain('mayordomo');
  });
});

describe('Jev character answer', () => {
  const baseAnswers = {
    intent: { probabilities: { charla: 1 } },
    es_ruido: { noul: 0 },
    es_queja: { noul: 0 },
  };

  it('reads the personaje probabilities and drops unknown labels', () => {
    const verdict = parseJevResponse({
      model: 'm',
      answers: { ...baseAnswers, personaje: { probabilities: { relator: 0.8, pirata: 0.2 } } },
    });
    expect(verdict.characterProbabilityMap).toEqual({ relator: 0.8 });
  });

  it('tolerates a Jev that did not answer it', () => {
    expect(parseJevResponse({ model: 'm', answers: baseAnswers }).characterProbabilityMap).toBeUndefined();
  });
});
