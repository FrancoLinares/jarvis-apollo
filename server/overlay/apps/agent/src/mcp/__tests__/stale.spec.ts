import { describe, expect, it } from 'bun:test';

import { callWithStaleSessionRetry, isStaleMcpSessionFailure } from '@/mcp/stale';

const staleFailure = {
  ok: false,
  summary:
    'No pude usar list-events: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"}}',
};

function fakeManager() {
  const calls: string[] = [];
  return {
    calls,
    manager: {
      connectToServer: async (id: string) => void calls.push(`connect:${id}`),
      discoverIfConnected: async (id: string) => void calls.push(`discover:${id}`),
    },
  };
}

describe('stale MCP sessions', () => {
  it('recognizes the error the calendar server returns after a restart', () => {
    expect(isStaleMcpSessionFailure(staleFailure)).toBe(true);
    expect(
      isStaleMcpSessionFailure({
        ok: false,
        summary:
          'No pude usar list-events: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"Not Found: Unknown or expired session"}}',
      }),
    ).toBe(true);
    expect(isStaleMcpSessionFailure({ ok: false, summary: 'Calendar API: 403 forbidden' })).toBe(false);
    expect(isStaleMcpSessionFailure({ ok: true, summary: 'No valid session ID' })).toBe(false);
  });

  it('reconnects the server and retries once', async () => {
    const { calls, manager } = fakeManager();
    let attempt = 0;
    const result = await callWithStaleSessionRetry({
      serverId: 'cal',
      toolName: 'list-events',
      manager,
      call: async () => (++attempt === 1 ? staleFailure : { ok: true, summary: '{"events":[]}' }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['connect:cal', 'discover:cal']);
    expect(attempt).toBe(2);
  });

  it('does not retry other failures', async () => {
    const { calls, manager } = fakeManager();
    let attempt = 0;
    await callWithStaleSessionRetry({
      serverId: 'cal',
      toolName: 'x',
      manager,
      call: async () => {
        attempt += 1;
        return { ok: false, summary: 'quota exceeded' };
      },
    });
    expect(attempt).toBe(1);
    expect(calls).toEqual([]);
  });
});
