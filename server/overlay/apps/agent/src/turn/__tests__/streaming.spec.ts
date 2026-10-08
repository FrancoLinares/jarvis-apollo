import { describe, expect, it } from 'bun:test';

import {
  STREAMING_CAPTION_MAX_CHARACTER_COUNT,
  buildStreamingCaption,
  createStreamingCaptionEmitter,
} from '@/turn/streaming';

describe('buildStreamingCaption', () => {
  it('muestra el texto completo mientras entra en el cartel', () => {
    expect(buildStreamingCaption('Hola Marcos')).toBe('Hola Marcos');
  });

  it('devuelve vacío si todavía no salió nada legible', () => {
    expect(buildStreamingCaption('')).toBe('');
    expect(buildStreamingCaption('   \n ')).toBe('');
  });

  it('normaliza los saltos de línea que manda el modelo', () => {
    expect(buildStreamingCaption('Hola\n\n  Marcos  ')).toBe('Hola Marcos');
  });

  it('al pasarse muestra la cola, no el principio', () => {
    const longText =
      'El clima en Chacarita está despejado con veintidós grados y viento suave del este';
    const caption = buildStreamingCaption(longText);
    expect(caption.startsWith('…')).toBe(true);
    expect(caption.endsWith('del este')).toBe(true);
  });

  it('no corta palabras al principio de la cola', () => {
    const longText = 'a'.repeat(30) + ' pregunta respuesta conclusion definitiva final';
    const caption = buildStreamingCaption(longText);
    // Lo que sigue al “…” tiene que ser una palabra entera del texto original.
    const visible = caption.replace('…', '');
    expect(longText.includes(` ${visible}`)).toBe(true);
  });

  it('deja pasar una palabra larguísima antes que vaciar el cartel', () => {
    const caption = buildStreamingCaption('x'.repeat(200));
    expect(caption).toBe(`…${'x'.repeat(STREAMING_CAPTION_MAX_CHARACTER_COUNT)}`);
  });

  it('esconde la marca [[escucho]], entera o a medio escribir', () => {
    expect(buildStreamingCaption('Contame más [[escucho]]')).toBe('Contame más');
    expect(buildStreamingCaption('Contame más [[escu')).toBe('Contame más');
    expect(buildStreamingCaption('Contame más [')).toBe('Contame más');
  });
});

describe('createStreamingCaptionEmitter', () => {
  it('manda el primer delta al toque', () => {
    const emitter = createStreamingCaptionEmitter({ minimumIntervalMilliseconds: 250 });
    expect(emitter.nextCaption('Ho', 1_000)).toBe('Ho');
  });

  it('saltea los deltas que llegan antes del intervalo', () => {
    const emitter = createStreamingCaptionEmitter({ minimumIntervalMilliseconds: 250 });
    expect(emitter.nextCaption('Ho', 1_000)).toBe('Ho');
    expect(emitter.nextCaption('Hola', 1_100)).toBeUndefined();
    expect(emitter.nextCaption('Hola Fra', 1_249)).toBeUndefined();
    expect(emitter.nextCaption('Hola Marcos', 1_250)).toBe('Hola Marcos');
  });

  it('no repite el mismo cartel cuando el delta no cambia lo visible', () => {
    const emitter = createStreamingCaptionEmitter({ minimumIntervalMilliseconds: 250 });
    expect(emitter.nextCaption('Hola', 1_000)).toBe('Hola');
    // Solo llegó espacio en blanco: el texto legible sigue siendo el mismo.
    expect(emitter.nextCaption('Hola  \n', 2_000)).toBeUndefined();
    expect(emitter.nextCaption('Hola Marcos', 3_000)).toBe('Hola Marcos');
  });

  it('no arranca a emitir mientras el modelo solo escribió la marca', () => {
    const emitter = createStreamingCaptionEmitter({ minimumIntervalMilliseconds: 250 });
    expect(emitter.nextCaption('[[esc', 1_000)).toBeUndefined();
    expect(emitter.nextCaption('[[escucho]] Dale', 2_000)).toBe('Dale');
  });
});
