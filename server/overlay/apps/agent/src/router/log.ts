import type { MemorySqlExecutor } from '@/memory/store';
import {
  isRouterIntentId,
  resolveIntentForUsedToolList,
  type RouterIntentId,
} from '@/router/intents';
import type { RouteTier } from '@/router/plan';

// Cada decisión del router queda anotada con lo que pasó después. Es la materia
// prima del aprendizaje: sin esto las probabilidades se usan y se tiran.
//
// La etiqueta de cada turno se deduce sola, sin pedirle nada al usuario:
// - qué herramientas terminó usando el modelo (si usó maps, era un viaje);
// - si pidió la herramienta de escape (el router le quitó algo que necesitaba);
// - si el turno siguiente es una queja SOBRE EL MISMO TEMA. La queja sola no
//   alcanza: en los turnos históricos "necesito que remuevas…" sacó 0,90 de
//   queja sin serlo.

export const ROUTER_DECISION_TABLE_STATEMENT =
  'CREATE TABLE IF NOT EXISTS router_decisions (' +
  'id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, text TEXT NOT NULL, ' +
  'mode TEXT NOT NULL, source TEXT NOT NULL, intent TEXT, intent_p REAL, ' +
  'probs_json TEXT, noise_p REAL, complaint_p REAL, tier TEXT NOT NULL, reason TEXT, ' +
  'exposed_json TEXT, used_json TEXT, escalated INTEGER NOT NULL DEFAULT 0, ' +
  'jev_ms INTEGER, llm_ms INTEGER, total_ms INTEGER, tool_schema_chars INTEGER, ' +
  'outcome TEXT, label TEXT, embedding TEXT, reasoning_p REAL, reasoning_policy INTEGER, ' +
  'reasoning_used INTEGER, reasoning_explored INTEGER, llm_calls INTEGER)';

// Columnas agregadas después de que la tabla ya existía en la Pi.
const ROUTER_DECISION_ADDED_COLUMN_LIST: readonly (readonly [string, string])[] = [
  ['reasoning_p', 'REAL'],
  ['reasoning_policy', 'INTEGER'],
  ['reasoning_used', 'INTEGER'],
  ['reasoning_explored', 'INTEGER'],
  ['llm_calls', 'INTEGER'],
];

export const ROUTER_STATE_TABLE_STATEMENT =
  'CREATE TABLE IF NOT EXISTS router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)';

export function ensureRouterTables(sqlExecutor: MemorySqlExecutor): void {
  sqlExecutor.execute(ROUTER_DECISION_TABLE_STATEMENT);
  sqlExecutor.execute(ROUTER_STATE_TABLE_STATEMENT);
  const existingColumnNameSet = new Set(
    sqlExecutor
      .execute<{ name: string }>('PRAGMA table_info(router_decisions)')
      .map((column) => column.name),
  );
  for (const [columnName, columnType] of ROUTER_DECISION_ADDED_COLUMN_LIST) {
    if (!existingColumnNameSet.has(columnName)) {
      sqlExecutor.execute(`ALTER TABLE router_decisions ADD COLUMN ${columnName} ${columnType}`);
    }
  }
  sqlExecutor.execute(
    'CREATE INDEX IF NOT EXISTS router_decisions_created_at ON router_decisions (created_at)',
  );
}

export type RouterDecisionSource = 'jev' | 'local' | 'timeout' | 'error' | 'off';

export type RouterDecisionEntry = {
  readonly id: string;
  readonly createdAtMilliseconds: number;
  readonly text: string;
  readonly mode: string;
  readonly source: RouterDecisionSource;
  readonly intentId: RouterIntentId | undefined;
  readonly intentProbability: number | undefined;
  readonly intentProbabilityMap: Readonly<Record<string, number>> | undefined;
  readonly noiseProbability: number | undefined;
  readonly complaintProbability: number | undefined;
  readonly tier: RouteTier;
  readonly reason: string;
  readonly exposedToolNameList: readonly string[] | undefined;
  readonly usedToolNameList: readonly string[];
  readonly escalated: boolean;
  readonly jevMilliseconds: number | undefined;
  readonly llmMilliseconds: number | undefined;
  readonly totalMilliseconds: number | undefined;
  readonly toolSchemaChars: number | undefined;
  readonly embedding: readonly number[] | undefined;
  readonly reasoning: RouterReasoningDecision | undefined;
  readonly llmCallCount: number | undefined;
};

// Qué se decidió sobre el razonamiento del modelo en el turno:
// - probability: lo que dijo Jev ("¿hace falta razonar?").
// - policy: lo que manda la política (umbral sobre esa probabilidad).
// - enabled: lo que se aplicó. Distinto de policy cuando el turno cayó en la
//   exploración del A/B: así se puede comparar qué pasa al contradecir a Jev.
export type RouterReasoningDecision = {
  readonly probability: number | undefined;
  readonly policy: boolean;
  readonly enabled: boolean;
  readonly explored: boolean;
};

// text-embedding-3 es "matryoshka": las primeras dimensiones ya son un
// embedding válido si se renormaliza. 256 de 1536 alcanzan para separar 16
// intenciones y ocupan 1,4 KB por turno en vez de 30 KB en JSON.
export const STORED_EMBEDDING_DIMENSION_COUNT = 256;

export function truncateEmbedding(values: readonly number[]): Float32Array {
  const truncated = Float32Array.from(values.slice(0, STORED_EMBEDDING_DIMENSION_COUNT));
  let squaredNorm = 0;
  for (const value of truncated) {
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm) || 1;
  for (let index = 0; index < truncated.length; index += 1) {
    truncated[index] /= norm;
  }
  return truncated;
}

export function encodeEmbedding(values: readonly number[]): string {
  const truncated = truncateEmbedding(values);
  return Buffer.from(truncated.buffer, truncated.byteOffset, truncated.byteLength).toString(
    'base64',
  );
}

export function decodeEmbedding(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, 'base64');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export function insertRouterDecision(
  sqlExecutor: MemorySqlExecutor,
  entry: RouterDecisionEntry,
): void {
  sqlExecutor.execute(
    'INSERT INTO router_decisions (id, created_at, text, mode, source, intent, intent_p, probs_json, ' +
      'noise_p, complaint_p, tier, reason, exposed_json, used_json, escalated, jev_ms, llm_ms, ' +
      'total_ms, tool_schema_chars, embedding, reasoning_p, reasoning_policy, reasoning_used, ' +
      'reasoning_explored, llm_calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    entry.id,
    entry.createdAtMilliseconds,
    entry.text,
    entry.mode,
    entry.source,
    entry.intentId ?? null,
    entry.intentProbability ?? null,
    entry.intentProbabilityMap === undefined ? null : JSON.stringify(entry.intentProbabilityMap),
    entry.noiseProbability ?? null,
    entry.complaintProbability ?? null,
    entry.tier,
    entry.reason,
    entry.exposedToolNameList === undefined ? null : JSON.stringify(entry.exposedToolNameList),
    JSON.stringify(entry.usedToolNameList),
    entry.escalated,
    entry.jevMilliseconds ?? null,
    entry.llmMilliseconds ?? null,
    entry.totalMilliseconds ?? null,
    entry.toolSchemaChars ?? null,
    entry.embedding === undefined ? null : encodeEmbedding(entry.embedding),
    entry.reasoning?.probability ?? null,
    entry.reasoning === undefined ? null : entry.reasoning.policy,
    entry.reasoning === undefined ? null : entry.reasoning.enabled,
    entry.reasoning === undefined ? null : entry.reasoning.explored,
    entry.llmCallCount ?? null,
  );
}

export type StoredRouterDecision = {
  readonly id: string;
  readonly createdAtMilliseconds: number;
  readonly text: string;
  readonly mode: string;
  readonly source: string;
  readonly intentId: RouterIntentId | undefined;
  readonly intentProbability: number | undefined;
  readonly intentProbabilityMap: Readonly<Record<string, number>> | undefined;
  readonly noiseProbability: number | undefined;
  readonly complaintProbability: number | undefined;
  readonly tier: RouteTier;
  readonly exposedToolNameList: readonly string[] | undefined;
  readonly usedToolNameList: readonly string[];
  readonly escalated: boolean;
  readonly outcome: string | undefined;
  readonly label: RouterIntentId | undefined;
  readonly embedding: string | undefined;
  readonly reasoningPolicy: boolean | undefined;
  readonly reasoningUsed: boolean | undefined;
  readonly reasoningExplored: boolean | undefined;
  readonly llmMilliseconds: number | undefined;
  readonly llmCallCount: number | undefined;
  readonly totalMilliseconds: number | undefined;
};

type RouterDecisionRow = {
  id: string;
  created_at: number;
  text: string;
  mode: string;
  source: string;
  intent: string | null;
  intent_p: number | null;
  probs_json: string | null;
  noise_p: number | null;
  complaint_p: number | null;
  tier: string;
  exposed_json: string | null;
  used_json: string | null;
  escalated: number;
  outcome: string | null;
  label: string | null;
  embedding: string | null;
  reasoning_policy: number | null;
  reasoning_used: number | null;
  reasoning_explored: number | null;
  llm_ms: number | null;
  llm_calls: number | null;
  total_ms: number | null;
};

function readOptionalFlag(value: number | null): boolean | undefined {
  return value === null ? undefined : value === 1;
}

function parseRouterDecisionRow(row: RouterDecisionRow): StoredRouterDecision {
  return {
    id: row.id,
    createdAtMilliseconds: row.created_at,
    text: row.text,
    mode: row.mode,
    source: row.source,
    intentId: row.intent !== null && isRouterIntentId(row.intent) ? row.intent : undefined,
    intentProbability: row.intent_p ?? undefined,
    intentProbabilityMap:
      row.probs_json === null ? undefined : (JSON.parse(row.probs_json) as Record<string, number>),
    noiseProbability: row.noise_p ?? undefined,
    complaintProbability: row.complaint_p ?? undefined,
    tier: row.tier as RouteTier,
    exposedToolNameList:
      row.exposed_json === null ? undefined : (JSON.parse(row.exposed_json) as string[]),
    usedToolNameList: row.used_json === null ? [] : (JSON.parse(row.used_json) as string[]),
    escalated: row.escalated === 1,
    outcome: row.outcome ?? undefined,
    label: row.label !== null && isRouterIntentId(row.label) ? row.label : undefined,
    embedding: row.embedding ?? undefined,
    reasoningPolicy: readOptionalFlag(row.reasoning_policy),
    reasoningUsed: readOptionalFlag(row.reasoning_used),
    reasoningExplored: readOptionalFlag(row.reasoning_explored),
    llmMilliseconds: row.llm_ms ?? undefined,
    llmCallCount: row.llm_calls ?? undefined,
    totalMilliseconds: row.total_ms ?? undefined,
  };
}

const SELECT_DECISION_COLUMNS =
  'SELECT id, created_at, text, mode, source, intent, intent_p, probs_json, noise_p, complaint_p, ' +
  'tier, exposed_json, used_json, escalated, outcome, label, embedding, reasoning_policy, ' +
  'reasoning_used, reasoning_explored, llm_ms, llm_calls, total_ms FROM router_decisions';

export function readLatestRouterDecision(
  sqlExecutor: MemorySqlExecutor,
): StoredRouterDecision | undefined {
  const [row] = sqlExecutor.execute<RouterDecisionRow>(
    `${SELECT_DECISION_COLUMNS} ORDER BY created_at DESC LIMIT 1`,
  );
  return row === undefined ? undefined : parseRouterDecisionRow(row);
}

export function readRouterDecisionList(
  sqlExecutor: MemorySqlExecutor,
  sinceMilliseconds: number,
): readonly StoredRouterDecision[] {
  return sqlExecutor
    .execute<RouterDecisionRow>(
      `${SELECT_DECISION_COLUMNS} WHERE created_at >= ? ORDER BY created_at ASC`,
      sinceMilliseconds,
    )
    .map(parseRouterDecisionRow);
}

// Una queja o una repetición del mismo pedido tiene que llegar pronto para
// referirse al turno anterior.
export const OUTCOME_WINDOW_MILLISECONDS = 3 * 60 * 1000;
export const COMPLAINT_LABEL_THRESHOLD = 0.85;

export type RouterOutcome = 'ok' | 'queja' | 'repetido' | 'escalado';

// Qué pasó con el turno ANTERIOR, visto desde el turno nuevo.
export function judgePreviousOutcome(
  previous: StoredRouterDecision,
  next: {
    readonly createdAtMilliseconds: number;
    readonly intentId: RouterIntentId | undefined;
    readonly complaintProbability: number | undefined;
  },
): RouterOutcome {
  if (previous.escalated) {
    return 'escalado';
  }
  if (next.createdAtMilliseconds - previous.createdAtMilliseconds > OUTCOME_WINDOW_MILLISECONDS) {
    return 'ok';
  }
  const previousTopic = resolveIntentForUsedToolList(
    previous.usedToolNameList,
    previous.intentId,
  ) ?? previous.intentId;
  const sameTopic =
    next.intentId !== undefined &&
    previousTopic !== undefined &&
    next.intentId === previousTopic &&
    previousTopic !== 'charla' &&
    previousTopic !== 'seguimiento';
  if (sameTopic && (next.complaintProbability ?? 0) >= COMPLAINT_LABEL_THRESHOLD) {
    return 'queja';
  }
  // Pedir lo mismo enseguida, sin quejarse, también dice que no salió.
  if (
    sameTopic &&
    previous.usedToolNameList.length === 0 &&
    previous.tier !== 'full' &&
    previous.mode === 'on'
  ) {
    return 'repetido';
  }
  return 'ok';
}

// La etiqueta plateada: la intención que el turno realmente tenía.
// - Si el modelo usó herramientas, ellas lo dicen.
// - Si no usó ninguna, no escaló y salió bien, la predicha era correcta.
// - Si escaló o hubo queja sin herramientas, no se sabe: queda sin etiqueta.
export function deriveRouterLabel(
  decision: StoredRouterDecision,
  outcome: RouterOutcome,
): RouterIntentId | undefined {
  const fromTools = resolveIntentForUsedToolList(decision.usedToolNameList, decision.intentId);
  if (fromTools !== undefined) {
    return fromTools;
  }
  if (outcome === 'ok' && !decision.escalated) {
    return decision.intentId;
  }
  return undefined;
}

export function writeRouterOutcome(
  sqlExecutor: MemorySqlExecutor,
  decisionId: string,
  outcome: RouterOutcome,
  label: RouterIntentId | undefined,
): void {
  sqlExecutor.execute(
    'UPDATE router_decisions SET outcome = ?, label = ? WHERE id = ?',
    outcome,
    label ?? null,
    decisionId,
  );
}

export function readRouterState(
  sqlExecutor: MemorySqlExecutor,
  key: string,
): string | undefined {
  const [row] = sqlExecutor.execute<{ value: string }>(
    'SELECT value FROM router_state WHERE key = ?',
    key,
  );
  return row?.value;
}

export function writeRouterState(
  sqlExecutor: MemorySqlExecutor,
  key: string,
  value: string,
  nowMilliseconds: number,
): void {
  sqlExecutor.execute(
    'INSERT INTO router_state (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    key,
    value,
    nowMilliseconds,
  );
}
