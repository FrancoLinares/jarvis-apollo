import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

import { createFakeApolloEnvironment } from '@/configuration/testing';
import { FIRMWARE_MANIFEST_OBJECT_KEY } from '@/ota/manifest';
import { handleOtaRequest } from '@/ota/routes';
import { createFileBlobStore } from '@/platform/bun/blob';

const environment = { ...createFakeApolloEnvironment(), DEVICE_SHARED_SECRET: 'secreto' } as Env;

function request(path: string) {
  const url = new URL(`http://pi:8799${path}?token=secreto`);
  return { request: new Request(url, { method: 'POST' }), url };
}

describe('/ota/apply', () => {
  it('reboots the device only when a firmware is published', async () => {
    const blobStore = createFileBlobStore(mkdtempSync(join(tmpdir(), 'ota-')));
    let rebootCount = 0;
    const reboot = async () => {
      rebootCount += 1;
      return { ok: true, summary: 'reiniciando' };
    };

    const empty = request('/ota/apply');
    const emptyResponse = await handleOtaRequest(empty.request, empty.url, environment, blobStore, reboot);
    expect(emptyResponse.status).toBe(409);
    expect(rebootCount).toBe(0);

    await blobStore.put(
      FIRMWARE_MANIFEST_OBJECT_KEY,
      JSON.stringify({ version: '2.7.3', key: 'firmware/2.7.3.bin' }),
    );
    const published = request('/ota/apply');
    const response = await handleOtaRequest(published.request, published.url, environment, blobStore, reboot);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, summary: 'reiniciando', version: '2.7.3' });
    expect(rebootCount).toBe(1);
  });

  it('rejects a wrong token', async () => {
    const blobStore = createFileBlobStore(mkdtempSync(join(tmpdir(), 'ota-')));
    const url = new URL('http://pi:8799/ota/apply?token=otro');
    const response = await handleOtaRequest(new Request(url, { method: 'POST' }), url, environment, blobStore);
    expect(response.status).toBe(401);
  });
});
