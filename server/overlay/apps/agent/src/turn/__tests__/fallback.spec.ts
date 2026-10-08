import { describe, expect, it } from 'bun:test';
import { buildToolFallbackSpeech } from '@/turn/run';

describe('buildToolFallbackSpeech', () => {
  it('usa los resúmenes de las herramientas propias, que son legibles', () => {
    expect(buildToolFallbackSpeech(['Anotado en la lista super: pan']))
      .toBe('Anotado en la lista super: pan');
  });

  it('nunca lee un JSON en voz alta', () => {
    const raw = '{"currentTime":"2026-09-07T11:31:42.277-03:00","timezone":"America/Argentina/Buenos_Aires"}';
    expect(buildToolFallbackSpeech([raw])).not.toContain('currentTime');
  });

  it('descarta un array crudo', () => {
    expect(buildToolFallbackSpeech(['[{"id":"abc"}]'])).not.toContain('abc');
  });

  it('descarta JSON aplanado que no arranca con llave', () => {
    expect(buildToolFallbackSpeech(['resultado "summary":"x" "id":"y"'])).not.toContain('summary');
  });

  it('se queda con lo legible y descarta lo demás', () => {
    expect(buildToolFallbackSpeech(['{"a":1}', 'Anotado: pan']))
      .toBe('Anotado: pan');
  });

  it('sin nada legible dice algo humano', () => {
    const result = buildToolFallbackSpeech(['{"a":1}']);
    expect(result.length).toBeGreaterThan(10);
    expect(result).not.toContain('{');
  });

  it('una lista vacía tampoco deja a Jarvis mudo', () => {
    expect(buildToolFallbackSpeech([]).length).toBeGreaterThan(10);
  });
});
