// Fase 1 offline: reproduce los turnos históricos contra Jev con el código real
// del router y mide si las herramientas que el LLM terminó usando habrían
// estado disponibles. Uso:
//   JEV_API_KEY=... bun eval/replay.ts turns.json mcp_enabled.json [salida.json]
import { readFileSync, writeFileSync } from 'node:fs';

import { listBuiltinToolDefinitionList } from '@/tools/catalog';
import { askJev, type JevVerdict } from '@/router/jev';
import { planRoute, type PreviousRouteSummary } from '@/router/plan';
import { ROUTER_INTENT_LIST } from '@/router/intents';

type HistoricalTurn = { text: string; at: string; tools: string[]; reply: string };

// Herramientas que hoy ya no están habilitadas (o que el router saca a propósito):
// que el LLM las haya usado en el pasado no cuenta como fallo de cobertura.
const RETIRED_TOOL_PATTERN = /_(get_current_time|list_calendars|ask_question)_[0-9a-f]{8}$/;

const [turnsPath, mcpPath, outPath = 'replay_results.json'] = process.argv.slice(2);
const turnList: HistoricalTurn[] = JSON.parse(readFileSync(turnsPath, 'utf8')).turns;
const mcpToolNameList: string[] = JSON.parse(readFileSync(mcpPath, 'utf8')).filter(
  (name: string) => !RETIRED_TOOL_PATTERN.test(name),
);
const availableToolNameList = [
  ...listBuiltinToolDefinitionList().map((tool) => tool.name),
  ...mcpToolNameList,
];
const apiKey = process.env.JEV_API_KEY ?? '';

const resultList: unknown[] = [];
let previousRoute: PreviousRouteSummary | undefined;
const counters = { turns: 0, ignore: 0, fast: 0, narrow: 0, full: 0, withTools: 0, covered: 0, errors: 0 };
const exposedCountList: number[] = [];
const latencyList: number[] = [];
const missList: string[] = [];

for (let index = 0; index < turnList.length; index += 1) {
  const turn = turnList[index];
  if (turn.text.trim().length === 0) continue;
  const previous = index > 0 ? turnList[index - 1] : undefined;
  const nowMilliseconds = new Date(turn.at).getTime();
  let verdict: JevVerdict;
  const startedAt = Date.now();
  try {
    verdict = await askJev({
      userText: turn.text,
      context: { previousUserText: previous?.text, previousAssistantText: previous?.reply },
      apiKey,
      timeoutMilliseconds: 8000,
    });
  } catch (error) {
    counters.errors += 1;
    console.error('jev error', String(error));
    continue;
  }
  latencyList.push(Date.now() - startedAt);
  const plan = planRoute({
    intentProbabilityMap: verdict.intentProbabilityMap,
    noiseProbability: verdict.noiseProbability,
    availableToolNameList,
    previousRoute,
    nowMilliseconds,
  });
  counters.turns += 1;
  counters[plan.tier] += 1;
  const usedToolList = turn.tools.filter((name) => !RETIRED_TOOL_PATTERN.test(name));
  const exposed = plan.toolNameList;
  exposedCountList.push(exposed === undefined ? availableToolNameList.length : exposed.length);
  let covered: boolean | undefined;
  if (usedToolList.length > 0) {
    counters.withTools += 1;
    // Notion para pendientes fue un incidente (editaba Notion en vez de la
    // lista interna): que el router no lo ofrezca es lo buscado.
    const intendedExclusion = (name: string) =>
      plan.intentId === 'pendientes' && name.includes('_API_');
    covered =
      exposed === undefined ||
      usedToolList.every(
        (name) =>
          exposed.includes(name) || name === plan.preExecuteToolName || intendedExclusion(name),
      );
    if (covered) counters.covered += 1;
    else missList.push(`${plan.intentId}(${plan.intentProbability.toFixed(2)}) ${plan.tier} usó=${usedToolList.join(',')} :: ${turn.text.slice(0, 80)}`);
  }
  resultList.push({ text: turn.text, used: usedToolList, plan, noise: verdict.noiseProbability, complaint: verdict.complaintProbability, covered });
  previousRoute = { createdAtMilliseconds: nowMilliseconds, exposedToolNameList: exposed, usedToolNameList: usedToolList };
}

writeFileSync(outPath, JSON.stringify(resultList, null, 1));
const sorted = [...latencyList].sort((a, b) => a - b);
const average = exposedCountList.reduce((sum, value) => sum + value, 0) / Math.max(1, exposedCountList.length);
console.log(JSON.stringify(counters));
console.log(`cobertura: ${counters.covered}/${counters.withTools} turnos con herramientas`);
console.log(`herramientas expuestas en promedio: ${average.toFixed(1)} de ${availableToolNameList.length}`);
console.log(`latencia Jev ms: p50=${sorted[Math.floor(sorted.length / 2)]} p90=${sorted[Math.floor(sorted.length * 0.9)]}`);
console.log(`intenciones: ${ROUTER_INTENT_LIST.length}`);
console.log('fallos de cobertura:');
for (const miss of missList) console.log('  ' + miss);
