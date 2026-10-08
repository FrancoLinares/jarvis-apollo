// ¿Qué parte de la ronda del LLM es el modelo y cuál la configuración? Mide,
// con el prompt real de Jarvis y las herramientas que manda el router, el
// tiempo al primer token, el total, los tokens de razonamiento y si eligió la
// herramienta correcta. Corre dentro del contenedor:
//   docker cp model-bench.ts docker-apollo-1:/app/model-bench.ts
//   docker exec docker-apollo-1 sh -c 'cd /app && bun model-bench.ts 3'
import { buildCurrentTimePromptNote } from '@/persona/clock';
import { buildApolloSoulPrompt } from '@/persona/soul';
import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import { condenseToolDescription } from '@/turn/run';
import { buildOpenRouterSystemPrompt } from '@/voice/llm';

const repetitionCount = Number(process.argv[2] ?? '3');
const apiKey = process.env.OPENROUTER_API_KEY ?? '';

type Config = { label: string; model: string; extra?: Record<string, unknown> };
const configList: Config[] = [
  { label: 'actual (v4-flash-0731, por defecto)', model: 'deepseek/deepseek-v4-flash-0731' },
  { label: 'v4-flash-0731 sin razonar', model: 'deepseek/deepseek-v4-flash-0731', extra: { reasoning: { enabled: false } } },
  { label: 'v4.1-flash sin razonar', model: 'deepseek/deepseek-v4.1-flash', extra: { reasoning: { enabled: false } } },
  { label: 'gemini-2.5-flash-lite', model: 'google/gemini-2.5-flash-lite', extra: { reasoning: { enabled: false } } },
  { label: 'gemini-3.1-flash-lite', model: 'google/gemini-3.1-flash-lite', extra: { reasoning: { enabled: false } } },
  { label: 'gpt-4.1-nano', model: 'openai/gpt-4.1-nano' },
  { label: 'qwen3.7-flash sin razonar', model: 'qwen/qwen3.7-flash', extra: { reasoning: { enabled: false } } },
  { label: 'mistral-small-3.2', model: 'mistralai/mistral-small-3.2-24b-instruct' },
  { label: 'gpt-oss-20b (razonar bajo)', model: 'openai/gpt-oss-20b', extra: { reasoning: { effort: 'low' } } },
];

const toolByName = new Map(
  listBuiltinToolDefinitionList().map((tool) => [
    tool.name,
    {
      type: 'function',
      function: {
        name: tool.name,
        description: condenseToolDescription(tool.description),
        parameters: tool.parameters,
      },
    },
  ]),
);
const pick = (...names: string[]) => names.map((name) => toolByName.get(name)).filter(Boolean);

const systemPrompt =
  buildOpenRouterSystemPrompt({
    soulSystemPrompt: buildApolloSoulPrompt('default'),
    memoryContentList: [],
    isFocusActive: false,
  }) + buildCurrentTimePromptNote(Date.now());

// Las herramientas son las que el router le pasa hoy a cada intención.
const caseList = [
  { id: 'hora', text: '¿Qué hora es?', tools: [], expected: undefined },
  { id: 'clima', text: '¿Qué clima hace hoy?', tools: pick('weather_now', 'set_weather_location', 'recall_conversation'), expected: 'weather_now' },
  {
    id: 'recordatorio',
    text: 'Recordame en diez minutos sacar la ropa del lavarropas',
    tools: pick('set_reminder', 'list_reminders', 'cancel_reminder', 'set_timer', 'recall_conversation'),
    expected: 'set_reminder',
  },
];

type Sample = { config: string; case: string; ok: boolean; ttftMs?: number; totalMs: number; reasoningTokens?: number; completionTokens?: number; tool?: string; text: string; error?: string };

async function runOnce(config: Config, item: (typeof caseList)[number]): Promise<Sample> {
  const startedAt = Date.now();
  const body: Record<string, unknown> = {
    model: config.model,
    usage: { include: true },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: item.text },
    ],
    ...(item.tools.length > 0 ? { tools: item.tools } : {}),
    ...(config.extra ?? {}),
  };
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || response.body === null) {
    return { config: config.label, case: item.id, ok: false, totalMs: Date.now() - startedAt, text: '', error: `${response.status} ${(await response.text()).slice(0, 120)}` };
  }
  const payload = (await response.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }; choices?: { message?: { content?: string; tool_calls?: { function?: { name?: string } }[] } }[] };
  console.log(JSON.stringify({ usageProbe: config.label, case: item.id, promptTokens: payload.usage?.prompt_tokens, cached: payload.usage?.prompt_tokens_details?.cached_tokens, completionTokens: payload.usage?.completion_tokens, reasoning: payload.usage?.completion_tokens_details?.reasoning_tokens, cost: payload.usage?.cost, promptChars: JSON.stringify(body).length }));
  const ttftMs = undefined; const text = payload.choices?.[0]?.message?.content ?? ''; const tool = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.name;
  const usage = { completion_tokens: payload.usage?.completion_tokens, completion_tokens_details: payload.usage?.completion_tokens_details };
  return {
    config: config.label,
    case: item.id,
    ok: item.expected === undefined ? tool === undefined && text.length > 0 : tool === item.expected,
    ttftMs,
    totalMs: Date.now() - startedAt,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    completionTokens: usage?.completion_tokens,
    tool,
    text: text.slice(0, 80),
  };
}

const sampleList: Sample[] = [];
for (let repetition = 0; repetition < repetitionCount; repetition += 1) {
  for (const config of repetition % 2 === 0 ? configList : [...configList].reverse()) {
    for (const item of caseList) {
      try {
        const sample = await runOnce(config, item);
        sampleList.push(sample);
        console.log(JSON.stringify(sample));
      } catch (error) {
        sampleList.push({ config: config.label, case: item.id, ok: false, totalMs: 60_000, text: '', error: String(error) });
      }
    }
  }
}

const median = (values: number[]) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length === 0 ? NaN : sorted[Math.floor(sorted.length / 2)];
};
console.log('\nconfig                              total(med)  1er token(med)  razonamiento(med)  aciertos  errores');
for (const config of configList) {
  const own = sampleList.filter((sample) => sample.config === config.label);
  const good = own.filter((sample) => sample.error === undefined);
  console.log(
    `${config.label.padEnd(36)}${String(median(good.map((s) => s.totalMs))).padStart(10)}${String(median(good.map((s) => s.ttftMs ?? NaN))).padStart(16)}${String(median(good.map((s) => s.reasoningTokens ?? 0))).padStart(19)}${`${own.filter((s) => s.ok).length}/${own.length}`.padStart(10)}${String(own.length - good.length).padStart(9)}`,
  );
}
console.log('\nrespuestas a "¿Qué hora es?":');
for (const config of configList) {
  const sample = sampleList.find((s) => s.config === config.label && s.case === 'hora' && s.error === undefined);
  console.log(`  ${config.label.padEnd(36)} ${sample?.text ?? '(error)'}`);
}
for (const sample of sampleList.filter((s) => s.error)) console.log('ERROR', sample.config, sample.error);
