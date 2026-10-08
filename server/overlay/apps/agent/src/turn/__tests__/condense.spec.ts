import { describe, expect, it } from 'bun:test';
import { TOOL_DESCRIPTION_MAX_CHARACTER_COUNT, condenseToolDescription } from '@/turn/run';

describe('condenseToolDescription', () => {
  it('deja pasar una descripción que ya es corta', () => {
    expect(condenseToolDescription('Lee una lista por nombre'))
      .toBe('Lee una lista por nombre');
  });

  it('se queda con la primera oración, que es el resumen útil', () => {
    // Tiene que superar el umbral para que valga la pena recortar: una
    // descripción corta se devuelve entera, y está bien que así sea.
    const largo = 'Crea un evento en el calendario. ' +
      'Acepta parámetros opcionales de recurrencia, invitados, recordatorios, ' +
      'zona horaria, visibilidad, transparencia, colores y archivos adjuntos. ' +
      'Ver la documentación del proveedor para el formato exacto de cada uno, ' +
      'incluyendo las reglas de repetición en formato RRULE y los husos horarios.';
    expect(condenseToolDescription(largo)).toBe('Crea un evento en el calendario.');
  });

  it('corta por palabra cuando no hay una oración corta', () => {
    const sinPuntos = 'palabra '.repeat(60);
    const result = condenseToolDescription(sinPuntos);
    expect(result.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX_CHARACTER_COUNT + 1);
    expect(result.endsWith('…')).toBe(true);
  });

  it('normaliza saltos de línea y espacios de más', () => {
    expect(condenseToolDescription('Hace\n\n  algo   útil')).toBe('Hace algo útil');
  });

  it('no rompe con una descripción vacía', () => {
    expect(condenseToolDescription('')).toBe('');
  });
});
