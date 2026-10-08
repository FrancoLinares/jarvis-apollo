import { readFileSync } from 'node:fs';
import { askJev } from '@/router/jev';
const turns: { text: string }[] = JSON.parse(readFileSync(process.argv[2], 'utf8')).turns;
const out: { p: number; text: string; ms: number }[] = [];
for (const t of turns) {
  if (!t.text.trim()) continue;
  const s = Date.now();
  const v = await askJev({ userText: t.text, context: {}, apiKey: process.env.JEV_API_KEY ?? '', timeoutMilliseconds: 8000 });
  out.push({ p: v.reasoningProbability ?? -1, text: t.text.slice(0, 90), ms: Date.now() - s });
}
out.sort((a, b) => b.p - a.p);
const ms = out.map((o) => o.ms).sort((a, b) => a - b);
console.log(`n=${out.length} latencia p50=${ms[Math.floor(ms.length / 2)]}ms  p>=0.5: ${out.filter((o) => o.p >= 0.5).length}`);
console.log('--- más alto'); for (const o of out.slice(0, 14)) console.log(o.p.toFixed(2), o.text);
console.log('--- alrededor de 0.5'); for (const o of out.filter((o) => o.p > 0.35 && o.p < 0.65).slice(0, 8)) console.log(o.p.toFixed(2), o.text);
console.log('--- más bajo'); for (const o of out.slice(-8)) console.log(o.p.toFixed(2), o.text);
