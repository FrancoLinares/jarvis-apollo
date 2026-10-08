import { describe, expect, it } from 'bun:test';

import { deviceToServerMessageSchema } from '@/protocol/schema';

describe('boot_report', () => {
  it('accepts what the firmware sends after a guardian restart or a crash', () => {
    expect(
      deviceToServerMessageSchema.parse({
        type: 'boot_report',
        resetReason: 'software',
        guardianReason: 'loop principal sin latido 91 s (estado 3)',
        firmwareVersion: '2.7.2',
      }).type,
    ).toBe('boot_report');
    expect(
      deviceToServerMessageSchema.parse({
        type: 'boot_report',
        resetReason: 'panic',
        crash: { task: 'main', pc: '0x42012345', backtrace: '0x42012345:0x3fc9 0x42001234:0x3fc8' },
      }).type,
    ).toBe('boot_report');
  });
});
