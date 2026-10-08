import { beforeEach, describe, expect, it } from 'bun:test';

import {
  isSpeechInFlight,
  markSpeechFinished,
  markSpeechStarted,
  resetSpeechGateForTesting,
} from '@/idle/speech-gate';

describe('semáforo de habla', () => {
  beforeEach(() => {
    resetSpeechGateForTesting();
  });

  it('arranca libre', () => {
    expect(isSpeechInFlight(1_000)).toBe(false);
  });

  it('frena la rotación mientras hay audio en vuelo', () => {
    markSpeechStarted(1_000);
    expect(isSpeechInFlight(1_500)).toBe(true);
    markSpeechFinished();
    expect(isSpeechInFlight(1_600)).toBe(false);
  });

  it('espera al último que habla, no al primero que termina', () => {
    markSpeechStarted(1_000);
    markSpeechStarted(1_100);
    markSpeechFinished();
    expect(isSpeechInFlight(1_200)).toBe(true);
    markSpeechFinished();
    expect(isSpeechInFlight(1_300)).toBe(false);
  });

  it('se suelta solo si el cierre nunca llega', () => {
    markSpeechStarted(1_000);
    expect(isSpeechInFlight(120_999)).toBe(true);
    expect(isSpeechInFlight(121_001)).toBe(false);
  });

  it('un cierre de más no deja el contador en negativo', () => {
    markSpeechFinished();
    markSpeechFinished();
    markSpeechStarted(1_000);
    expect(isSpeechInFlight(1_100)).toBe(true);
  });
});
