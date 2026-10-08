import { describe, expect, it } from 'bun:test';

import {
  shouldRelayOfflineReminder,
  shouldWatchReminderSeen,
  wasReminderSeen,
} from '@/reminders/whatsapp-relay';

describe('WhatsApp relay of reminders', () => {
  it('relays to WhatsApp only when no board is connected', () => {
    expect(shouldRelayOfflineReminder({ whatsAppConfigured: true, connectedDeviceCount: 0 })).toBe(true);
    expect(shouldRelayOfflineReminder({ whatsAppConfigured: true, connectedDeviceCount: 1 })).toBe(false);
    expect(shouldRelayOfflineReminder({ whatsAppConfigured: false, connectedDeviceCount: 0 })).toBe(false);
  });

  it('watches for a dismissal only with firmware that reports it', () => {
    const base = { whatsAppConfigured: true, connectedDeviceCount: 1 } as const;
    expect(shouldWatchReminderSeen({ ...base, deviceReportsReminderSeen: true })).toBe(true);
    expect(shouldWatchReminderSeen({ ...base, deviceReportsReminderSeen: false })).toBe(false);
  });

  it('counts any activity after the reminder as seen', () => {
    expect(wasReminderSeen({ deliveredAtMilliseconds: 1000, lastUserActivityAtMilliseconds: undefined })).toBe(false);
    expect(wasReminderSeen({ deliveredAtMilliseconds: 1000, lastUserActivityAtMilliseconds: 999 })).toBe(false);
    expect(wasReminderSeen({ deliveredAtMilliseconds: 1000, lastUserActivityAtMilliseconds: 1500 })).toBe(true);
  });
});
