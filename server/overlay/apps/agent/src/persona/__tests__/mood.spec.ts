import { describe, expect, it } from 'bun:test';

import { extractMoodMark } from '@/persona/mood';

describe('extractMoodMark', () => {
  it('strips the mark and returns the mood', () => {
    expect(extractMoodMark('¡Ganó Racing 2 a 0! [[cara:festejo]]')).toEqual({
      text: '¡Ganó Racing 2 a 0!',
      mood: 'festejo',
    });
  });

  it('ignores unknown moods but still hides the mark', () => {
    expect(extractMoodMark('Listo. [[cara:enojado]]')).toEqual({ text: 'Listo.', mood: undefined });
  });

  it('leaves text without a mark untouched', () => {
    expect(extractMoodMark('Son las tres.')).toEqual({ text: 'Son las tres.', mood: undefined });
  });

  it('keeps the last valid mark', () => {
    expect(extractMoodMark('[[cara:triste]] No pude. [[cara:pensativo]]').mood).toBe('pensativo');
  });
});
