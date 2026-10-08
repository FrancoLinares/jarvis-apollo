import { describe, expect, it } from 'bun:test';

import { REMINDER_MAX_DEFER_COUNT, shouldDeferReminder } from '@/reminders/defer';

describe('shouldDeferReminder', () => {
  it('waits while a turn is being heard, thought about, or spoken', () => {
    for (const uiState of ['listening', 'thinking', 'speaking']) {
      expect(shouldDeferReminder({ uiState, isSpeechInFlight: false, deferCount: 0 })).toBe(true);
    }
    expect(shouldDeferReminder({ uiState: 'idle', isSpeechInFlight: true, deferCount: 0 })).toBe(true);
  });

  it('delivers right away when nothing is going on', () => {
    expect(shouldDeferReminder({ uiState: 'idle', isSpeechInFlight: false, deferCount: 0 })).toBe(false);
    expect(shouldDeferReminder({ uiState: 'dashboard', isSpeechInFlight: false, deferCount: 3 })).toBe(false);
  });

  it('gives up waiting after the cap so a stuck state never swallows a reminder', () => {
    expect(
      shouldDeferReminder({ uiState: 'thinking', isSpeechInFlight: true, deferCount: REMINDER_MAX_DEFER_COUNT }),
    ).toBe(false);
  });
});
