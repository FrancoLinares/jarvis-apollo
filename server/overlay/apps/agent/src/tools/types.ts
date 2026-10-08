import { z } from 'zod';

import type { ListItemRecord } from '@/lists/store';
import type { VectorStore } from '@/platform/vector';
import type { ScheduledReminderRow } from '@/reminders/logic';

export type ToolSafetyLevel = 'safe' | 'unsafe';

export type JsonSerializableValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonSerializableValue[]
  | { readonly [propertyName: string]: JsonSerializableValue };

export type ToolArgumentRecord = {
  readonly [argumentName: string]: JsonSerializableValue;
};

export const jsonSerializableValueSchema: z.ZodType<JsonSerializableValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSerializableValueSchema),
    z.record(jsonSerializableValueSchema),
  ]),
);

export type ToolExecutionResult = {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
  // Lo que el usuario tiene que escuchar TAL CUAL: reemplaza la redacción del
  // modelo. Para frases donde una palabra mal elegida engaña: el 2026-10-07 el
  // borrador de un mensaje a un contacto se dijo "Listo, dice: … ¿Lo mando?" y el usuario
  // entendió que ya se había enviado.
  readonly spokenText?: string;
};

export type PendingToolConfirmation = {
  readonly id: string;
  readonly toolName: string;
  readonly args: JsonSerializableValue | undefined;
  readonly summary: string;
  readonly expiresAt: number;
};

export type DeskToolEffects = {
  readonly persistMemory: (
    content: string,
  ) => Promise<{ readonly memoryId: string; readonly content: string }>;
  readonly applyFocusMinutes: (minutes: number) => Promise<void>;
  readonly clearFocus: () => Promise<void>;
  readonly enqueueResearch: (prompt: string) => Promise<void>;
  readonly enqueueCodingTask: (input: {
    readonly repository: string;
    readonly task: string;
  }) => Promise<void>;
  readonly scheduleReminder: (input: {
    readonly delaySeconds: number;
    readonly message: string;
  }) => Promise<void>;
  // Recordatorio que se repite con un cron (UTC). Opcional: solo lo tiene el
  // host de Bun.
  readonly scheduleRecurringReminder?: (input: {
    readonly cron: string;
    readonly message: string;
    readonly recurrence: string;
  }) => Promise<{ readonly nextFireMilliseconds: number; readonly alreadyExisted?: boolean }>;
  // Toma el pedido de "avisame cuando tengo que salir". Devuelve el resultado
  // ya redactado porque el calculo (viaje con trafico, hora de salida) lo hace
  // el actor: la tool no sabe nada de mapas.
  readonly scheduleDepartureAlert: (input: {
    readonly placeLabel: string;
    readonly destination: string;
    readonly arrivalMilliseconds: number;
  }) => Promise<{ readonly ok: boolean; readonly summary: string }>;
  readonly broadcastTimerProgress: (input: {
    readonly durationSeconds: number;
  }) => Promise<void>;
  readonly listReminders: () => Promise<readonly ScheduledReminderRow[]>;
  readonly cancelReminders: (input: {
    readonly message?: string;
    readonly cancelAll: boolean;
  }) => Promise<{
    readonly cancelledCount: number;
    readonly cancelledMessageList: readonly string[];
  }>;
  readonly resolveWeatherLocation: () => Promise<{
    readonly latitude: number;
    readonly longitude: number;
    readonly locationLabel: string;
    readonly timezone: string;
  }>;
  readonly persistWeatherLocation: (location: {
    readonly locationLabel: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly timezone: string;
  }) => Promise<void>;
  readonly addListItem: (input: {
    readonly listName: string;
    readonly content: string;
  }) => Promise<ListItemRecord>;
  readonly listListItems: (listName?: string) => Promise<readonly ListItemRecord[]>;
  readonly removeListItems: (input: {
    readonly listName: string;
    readonly contentQuery?: string;
    readonly clearAll: boolean;
  }) => Promise<{
    readonly removedCount: number;
    readonly removedContentList: readonly string[];
  }>;
  readonly searchThreadHistory: (input: {
    readonly query: string;
    readonly limit: number;
  }) => Promise<
    readonly {
      readonly id: string;
      readonly role: string;
      readonly content: string;
    }[]
  >;
  readonly resumeConversationThread: (input: { readonly query: string }) => Promise<
    | {
        readonly title: string;
        readonly summary: string | null;
      }
    | undefined
  >;
  readonly callDeviceTool: (input: {
    readonly deviceToolName: string;
    readonly argumentRecord: ToolArgumentRecord;
  }) => Promise<ToolExecutionResult>;
  readonly callInstalledMcpTool: (input: {
    readonly serverId: string;
    readonly toolName: string;
    readonly argumentRecord: ToolArgumentRecord;
  }) => Promise<ToolExecutionResult>;
};

export type ToolExecutionContext = {
  readonly environment: Env;
  readonly nowMilliseconds: number;
  readonly deviceId?: string;
  readonly vectorStore?: VectorStore;
  readonly effects?: DeskToolEffects;
  // Lo que dijo el usuario en ESTE turno. Lo usan las herramientas que no
  // pueden confiar en el modelo para saber si el usuario aceptó algo
  // (confirmar_mensaje).
  readonly userTranscript?: string;
};

export type ToolHandler = (
  args: JsonSerializableValue | undefined,
  context: ToolExecutionContext,
) => Promise<ToolExecutionResult>;

export type ToolDefinition = {
  readonly name: string;
  readonly safety: ToolSafetyLevel;
  readonly description: string;
  readonly parameters: ToolArgumentRecord;
  readonly handler: ToolHandler;
  readonly buildConfirmSummary?: (args: JsonSerializableValue | undefined) => string;
};

export const CONFIRM_TIMEOUT_MILLISECONDS = 30_000;
