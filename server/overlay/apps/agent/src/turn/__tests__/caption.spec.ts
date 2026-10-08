import { describe, expect, it } from 'bun:test';

import { mapToolNameToThinkingCaption, resolveThinkingHint } from '@/turn/caption';

describe('resolveThinkingHint', () => {
  it('mapea las herramientas propias a su cartel y color', () => {
    expect(resolveThinkingHint('weather_now')).toEqual({
      caption: 'Mirando el cielo…',
      accentColor: '#38BDF8',
    });
    expect(mapToolNameToThinkingCaption('web_search')).toBe('Buscando en internet…');
    expect(mapToolNameToThinkingCaption('start_research')).toBe('Investigando a fondo…');
    expect(mapToolNameToThinkingCaption('recall_memory')).toBe('Haciendo memoria…');
    expect(mapToolNameToThinkingCaption('translate')).toBe('Traduciendo…');
    expect(mapToolNameToThinkingCaption('dollar_rate')).toBe('Viendo cómo viene el dólar…');
    expect(mapToolNameToThinkingCaption('set_timer')).toBe('Poniendo el timer…');
  });

  it('agrupa por color cada familia de actividad', () => {
    // Todo lo que sea "ir a buscar afuera" comparte color, para que el anillo
    // sea legible de un vistazo sin leer el cartel.
    const buscar = resolveThinkingHint('web_search').accentColor;
    expect(resolveThinkingHint('start_research').accentColor).toBe(buscar);
    const organizar = resolveThinkingHint('set_reminder').accentColor;
    expect(resolveThinkingHint('add_to_list').accentColor).toBe(organizar);
    expect(resolveThinkingHint('set_timer').accentColor).toBe(organizar);
  });

  it('desenvuelve los nombres de herramientas MCP, que vienen con id y hash', () => {
    // El cliente MCP envuelve el nombre real: mcp_<servidor>_<nombre>_<hash>.
    // Sin desenvolverlo, todas caían en el cartel genérico.
    expect(resolveThinkingHint('mcp_7c6ade76_maps_distance_matrix_03a63731')).toEqual({
      caption: 'Calculando el viaje…',
      accentColor: '#22C55E',
    });
    expect(mapToolNameToThinkingCaption('mcp_7c6ade76_maps_search_places_53d6ba95')).toBe(
      'Ubicando el lugar…',
    );
    expect(mapToolNameToThinkingCaption('mcp_1c77fb38_query_docs_7d451458')).toBe(
      'Leyendo documentación…',
    );
  });

  it('cae en un cartel genérico cuando no reconoce la herramienta', () => {
    expect(resolveThinkingHint('weird_tool')).toEqual({
      caption: 'Manos a la obra…',
      accentColor: '#94A3B8',
    });
  });
});
