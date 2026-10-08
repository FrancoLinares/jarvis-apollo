import { buildCurrentTimePromptNote } from '@/persona/clock';
import { buildApolloSoulPrompt } from '@/persona/soul';
import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import { condenseToolDescription } from '@/turn/run';
import { buildOpenRouterSystemPrompt } from '@/voice/llm';
const tools = listBuiltinToolDefinitionList().filter((t) => ['set_reminder', 'list_reminders', 'cancel_reminder', 'set_timer', 'recall_conversation'].includes(t.name))
  .map((t) => ({ type: 'function', function: { name: t.name, description: condenseToolDescription(t.description), parameters: t.parameters } }));
const system = buildOpenRouterSystemPrompt({ soulSystemPrompt: buildApolloSoulPrompt('default'), memoryContentList: [], isFocusActive: false }) + buildCurrentTimePromptNote(Date.now());
const cases = [
  'El 7 de octubre se me renueva el dominio, avisame una semana antes a las 10 de la mañana.',
  'Necesito que me avises todos los días laborales a las 11:30 que prepare la daily.',
  'Tengo que tomar un antibiótico cada ocho horas por tres días, empezando ahora. Avisame cada toma.',
  'Recordame pasado mañana a las 9 de la noche llamar al plomero.',
];
for (const model of ['deepseek/deepseek-v4-flash-0731', 'deepseek/deepseek-v4.1-flash']) {
  console.log('=== ' + model);
  for (const text of cases) {
    const t0 = Date.now();
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: text }], tools }) });
    const j = await r.json() as any;
    const calls = (j.choices?.[0]?.message?.tool_calls ?? []).map((c: any) => `${c.function.name}(${c.function.arguments})`);
    console.log(`[${Date.now() - t0}ms] ${text.slice(0, 50)}\n   → ${calls.length ? calls.join('\n     ') : 'TEXTO: ' + j.choices?.[0]?.message?.content}`);
  }
}
