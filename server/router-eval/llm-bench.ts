// Benchmark aislado: cuánto tarda el LLM con las 41 herramientas contra las que
// elige el router, con el mismo prompt, sin historial y alternando el orden.
// Corre dentro del contenedor (necesita la red de docker para los MCP):
//   docker cp llm-bench.ts docker-apollo-1:/app/eval-bench.ts
//   docker exec docker-apollo-1 sh -c 'cd /app && bun eval-bench.ts 3'
import { Database } from 'bun:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { buildNamespacedMcpToolName } from '@/mcp/naming';
import { buildCurrentTimePromptNote } from '@/persona/clock';
import { buildApolloSoulPrompt, buildInstalledToolPromptNote } from '@/persona/soul';
import { ROUTER_ESCAPE_TOOL_NAME, ROUTER_INTENT_LIST, type RouterIntentId } from '@/router/intents';
import { planRoute } from '@/router/plan';
import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import { condenseToolDescription, type LanguageModelToolDescriptor } from '@/turn/run';
import { buildOpenRouterSystemPrompt, chatWithOpenRouter } from '@/voice/llm';

const repetitionCount = Number(process.argv[2] ?? '3');
const database = new Database('/data/jarvis.sqlite', { readonly: true });
const serverList = database
  .query("SELECT id, name, server_url FROM cf_agents_mcp_servers WHERE name IN ('maps','notion','calendar')")
  .all() as { id: string; name: string; server_url: string }[];
const enabledNameSet = new Set(
  (database.query('SELECT namespaced_name FROM mcp_tool_settings WHERE is_enabled = 1').all() as {
    namespaced_name: string;
  }[]).map((row) => row.namespaced_name),
);

const mcpToolList: LanguageModelToolDescriptor[] = [];
for (const server of serverList) {
  let client = new Client({ name: 'bench', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.server_url)));
  } catch {
    client = new Client({ name: 'bench', version: '1' });
    await client.connect(new SSEClientTransport(new URL(server.server_url)));
  }
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const name = buildNamespacedMcpToolName(server.id, tool.name);
    if (!enabledNameSet.has(name)) continue;
    const description = condenseToolDescription(
      `[${server.name}] ${tool.description ?? ''}`.slice(0, 1024),
    );
    mcpToolList.push({ name, description, parameters: tool.inputSchema as never });
  }
  await client.close();
}
const builtinToolList: LanguageModelToolDescriptor[] = listBuiltinToolDefinitionList().map((tool) => ({
  name: tool.name,
  description: condenseToolDescription(tool.description),
  parameters: tool.parameters,
}));
const fullToolList = [...builtinToolList, ...mcpToolList];
console.log(`herramientas: ${fullToolList.length}, esquemas: ${JSON.stringify(fullToolList).length} caracteres`);

const escapeTool: LanguageModelToolDescriptor = {
  name: ROUTER_ESCAPE_TOOL_NAME,
  description:
    'Llamala SOLO si para cumplir el pedido necesitás una herramienta que no está en tu lista; después vas a tener todas. No la uses para la hora, la fecha ni para charlar: eso ya lo sabés.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

const systemPrompt =
  buildOpenRouterSystemPrompt({
    soulSystemPrompt: buildApolloSoulPrompt('default'),
    memoryContentList: [],
    isFocusActive: false,
  }) +
  buildInstalledToolPromptNote(mcpToolList.map((tool) => tool.name)) +
  buildCurrentTimePromptNote(Date.now());

const caseList: { text: string; intent: RouterIntentId }[] = [
  { text: '¿Qué hora es?', intent: 'hora' },
  { text: '¿Cuánto está el dólar blue?', intent: 'dolar' },
  { text: '¿Qué clima hace hoy?', intent: 'clima' },
  { text: '¿Qué tengo en la agenda hoy?', intent: 'agenda_leer' },
  { text: '¿Cuánto tardo en auto hasta el Obelisco?', intent: 'viaje' },
  { text: '¿Qué tengo en pendientes?', intent: 'pendientes' },
  { text: 'Contame un dato curioso corto.', intent: 'charla' },
];

function routedToolList(intent: RouterIntentId): LanguageModelToolDescriptor[] {
  const plan = planRoute({
    intentProbabilityMap: Object.fromEntries(
      ROUTER_INTENT_LIST.map((item) => [item.id, item.id === intent ? 1 : 0]),
    ) as Record<RouterIntentId, number>,
    noiseProbability: 0,
    availableToolNameList: fullToolList.map((tool) => tool.name),
    nowMilliseconds: Date.now(),
  });
  const selected = fullToolList.filter((tool) => plan.toolNameList?.includes(tool.name));
  return plan.escapeAllowed === false ? selected : [...selected, escapeTool];
}

const apiKey = process.env.OPENROUTER_API_KEY ?? '';
const modelId = process.env.OPENROUTER_MODEL ?? '';
type Sample = { case: string; condition: 'todas' | 'router'; ms: number; firstTokenMs: number | undefined; toolCalls: string[]; schemaChars: number };
const sampleList: Sample[] = [];
for (let repetition = 0; repetition < repetitionCount; repetition += 1) {
  for (const item of caseList) {
    // Se alterna el orden en cada repetición para que la deriva del proveedor
    // no favorezca a una condición.
    const conditionList: ('todas' | 'router')[] = repetition % 2 === 0 ? ['todas', 'router'] : ['router', 'todas'];
    for (const condition of conditionList) {
      const toolList = condition === 'todas' ? fullToolList : routedToolList(item.intent);
      const startedAt = Date.now();
      let firstTokenMs: number | undefined;
      const result = await chatWithOpenRouter({
        openRouterApiKey: apiKey,
        modelId,
        messageList: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: item.text },
        ],
        toolDefinitionList: toolList,
        onTextDelta: () => {
          firstTokenMs ??= Date.now() - startedAt;
        },
      });
      sampleList.push({
        case: item.intent,
        condition,
        ms: Date.now() - startedAt,
        firstTokenMs,
        toolCalls: result.toolCallList.map((call) => call.name),
        schemaChars: JSON.stringify(toolList).length,
      });
      const last = sampleList[sampleList.length - 1];
      console.log(JSON.stringify(last));
    }
  }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
console.log('\ncaso          todas(ms)  router(ms)  esquema todas/router');
for (const item of caseList) {
  const all = sampleList.filter((sample) => sample.case === item.intent && sample.condition === 'todas');
  const routed = sampleList.filter((sample) => sample.case === item.intent && sample.condition === 'router');
  console.log(
    `${item.intent.padEnd(13)} ${String(median(all.map((s) => s.ms))).padStart(9)}  ${String(median(routed.map((s) => s.ms))).padStart(10)}  ${all[0].schemaChars}/${routed[0].schemaChars}`,
  );
}
const allMs = sampleList.filter((s) => s.condition === 'todas').map((s) => s.ms);
const routedMs = sampleList.filter((s) => s.condition === 'router').map((s) => s.ms);
console.log(`MEDIANA GLOBAL todas=${median(allMs)} router=${median(routedMs)}  (n=${allMs.length} por condición)`);
console.log(`escapes pedidos con router: ${sampleList.filter((s) => s.condition === 'router' && s.toolCalls.includes(ROUTER_ESCAPE_TOOL_NAME)).length}`);
