import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createSilentPcm,
  playPcmOnSpeaker,
  resetSpeakerRouteCacheForTests,
  resolveSpeakerConfiguration,
  resolveSpeakerRoute,
  setSpeakerRoute,
  shouldRouteToSpeaker,
} from '@/speaker/output';

const ENV_KEYS = ['SPEAKER_URL', 'SPEAKER_TOKEN', 'SPEAKER_ROUTE', 'APOLLO_DATA_DIRECTORY'] as const;
let savedEnv: Record<string, string | undefined> = {};
let dataDirectory = '';

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  dataDirectory = mkdtempSync(join(tmpdir(), 'speaker-'));
  process.env.APOLLO_DATA_DIRECTORY = dataDirectory;
  process.env.SPEAKER_URL = 'http://host.docker.internal:8790/';
  process.env.SPEAKER_TOKEN = 'token-de-prueba-123456';
  delete process.env.SPEAKER_ROUTE;
  resetSpeakerRouteCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  rmSync(dataDirectory, { recursive: true, force: true });
  resetSpeakerRouteCacheForTests();
});

describe('shouldRouteToSpeaker', () => {
  it('en modo avisos manda los avisos y deja la conversación en la placa', () => {
    expect(shouldRouteToSpeaker('aviso', 'avisos', true)).toBe(true);
    expect(shouldRouteToSpeaker('respuesta', 'avisos', true)).toBe(false);
  });

  it('en modo todo manda las dos cosas', () => {
    expect(shouldRouteToSpeaker('aviso', 'todo', true)).toBe(true);
    expect(shouldRouteToSpeaker('respuesta', 'todo', true)).toBe(true);
  });

  it('apagado o sin configurar, nada va al parlante', () => {
    expect(shouldRouteToSpeaker('aviso', 'apagado', true)).toBe(false);
    expect(shouldRouteToSpeaker('aviso', 'todo', false)).toBe(false);
  });
});

describe('configuración y modo', () => {
  it('sin URL o sin token no hay parlante', () => {
    delete process.env.SPEAKER_TOKEN;
    expect(resolveSpeakerConfiguration()).toBeUndefined();
  });

  it('saca la barra final de la URL', () => {
    expect(resolveSpeakerConfiguration()?.baseUrl).toBe('http://host.docker.internal:8790');
  });

  it('arranca en avisos y respeta SPEAKER_ROUTE', () => {
    expect(resolveSpeakerRoute()).toBe('avisos');
    resetSpeakerRouteCacheForTests();
    process.env.SPEAKER_ROUTE = 'todo';
    expect(resolveSpeakerRoute()).toBe('todo');
  });

  it('el modo elegido por voz sobrevive a un reinicio', () => {
    setSpeakerRoute('todo');
    resetSpeakerRouteCacheForTests();
    expect(resolveSpeakerRoute()).toBe('todo');
  });

  it('un archivo de estado roto cae al default en vez de romper', () => {
    writeFileSync(join(dataDirectory, 'speaker.json'), '{no es json');
    expect(resolveSpeakerRoute()).toBe('avisos');
  });
});

describe('playPcmOnSpeaker', () => {
  it('manda el PCM con el formato y el token', async () => {
    const requestList: { url: string; init: RequestInit | undefined }[] = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      requestList.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, seconds: 1 }), { status: 200 });
    }) as typeof fetch;

    const accepted = await playPcmOnSpeaker(new ArrayBuffer(48000), {
      sampleRateHz: 24000,
      channelCount: 1,
      fetchImplementation: fetchStub,
    });

    expect(accepted).toBe(true);
    expect(requestList).toHaveLength(1);
    expect(requestList[0].url).toBe('http://host.docker.internal:8790/play?rate=24000&channels=1');
    expect(new Headers(requestList[0].init?.headers).get('X-Speaker-Token')).toBe('token-de-prueba-123456');
    expect((requestList[0].init?.body as ArrayBuffer).byteLength).toBe(48000);
  });

  it('si el parlante falla, devuelve false para que suene en la placa', async () => {
    const failingFetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const throwingFetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    expect(
      await playPcmOnSpeaker(new ArrayBuffer(10), { sampleRateHz: 24000, channelCount: 1, fetchImplementation: failingFetch }),
    ).toBe(false);
    expect(
      await playPcmOnSpeaker(new ArrayBuffer(10), { sampleRateHz: 24000, channelCount: 1, fetchImplementation: throwingFetch }),
    ).toBe(false);
  });

  it('sin configuración ni siquiera llama', async () => {
    delete process.env.SPEAKER_URL;
    let called = false;
    const fetchStub = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;

    expect(
      await playPcmOnSpeaker(new ArrayBuffer(10), { sampleRateHz: 24000, channelCount: 1, fetchImplementation: fetchStub }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe('createSilentPcm', () => {
  it('tiene el mismo largo y es todo ceros', () => {
    const silence = new Uint8Array(createSilentPcm(4800));
    expect(silence.byteLength).toBe(4800);
    expect(silence.every((byte) => byte === 0)).toBe(true);
  });
});
