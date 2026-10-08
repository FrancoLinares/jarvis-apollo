import { describe, expect, it } from 'bun:test';

import { buildApolloSoulPrompt, buildInstalledToolPromptNote } from '@/persona/soul';

describe('apollo soul prompt', () => {
  it('always includes Jarvis identity and shared tools base', () => {
    const soulPrompt = buildApolloSoulPrompt('default');
    expect(soulPrompt).toContain('Sos Jarvis');
    expect(soulPrompt).toContain('remember_fact');
    expect(soulPrompt).toContain('weather_now');
    expect(soulPrompt).toContain('set_weather_location');
    expect(soulPrompt).toContain('list_reminders');
    expect(soulPrompt).toContain('cancel_reminder');
    expect(soulPrompt).not.toContain('gmail');
  });

  it('includes nerd technical register', () => {
    expect(buildApolloSoulPrompt('nerd')).toContain('Modo nerd');
    expect(buildApolloSoulPrompt('nerd')).toContain('técnico');
  });

  it('includes playful slang guidance', () => {
    const soulPrompt = buildApolloSoulPrompt('playful');
    expect(soulPrompt).toContain('Modo playful');
    expect(soulPrompt).toContain('boludo');
    expect(soulPrompt).toContain('nunca humilles');
  });

  it('includes warm closeness guidance', () => {
    expect(buildApolloSoulPrompt('warm')).toContain('Modo warm');
  });
});

describe('installed tool prompt note', () => {
  it('says nothing when the owner has connected no tools', () => {
    expect(buildInstalledToolPromptNote([])).toBe('');
  });

  it('names every connected tool so the model can find it', () => {
    const promptNote = buildInstalledToolPromptNote([
      'mcp_github_list_issues',
      'mcp_linear_list_teams',
    ]);
    expect(promptNote).toContain('mcp_github_list_issues');
    expect(promptNote).toContain('mcp_linear_list_teams');
  });
});

describe('guía de listas cuando Notion está conectado', () => {
  it('manda las listas a remove_from_list y no a Notion', () => {
    // Regresión real: le pidieron sacar un ítem de pendientes y se fue por el
    // MCP de Notion a tildar "Hecho" con update-page-markdown, que edita el
    // contenido y no las propiedades. Notion respondió 400 y Jarvis contestó
    // que no podía, teniendo remove_from_list disponible.
    const note = buildInstalledToolPromptNote(['notion', 'maps']);
    expect(note).toContain('remove_from_list');
    expect(note).toContain('ESPEJO');
    expect(note).toMatch(/NUNCA agregues, saques ni tildes/);
  });

  it('no dice nada de listas si Notion no está conectado', () => {
    const note = buildInstalledToolPromptNote(['maps']);
    expect(note).not.toContain('ESPEJO');
  });
});
