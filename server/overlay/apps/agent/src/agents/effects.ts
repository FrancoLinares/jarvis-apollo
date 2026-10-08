import type { Session } from 'agents/experimental/memory/session';

import {
  addListItemRecord,
  listListItemRecords,
  removeListItemRecords,
} from '@/lists/store';
import { rememberFactInSession } from '@/memory/session';
import { addMemoryRecord, type MemorySqlExecutor } from '@/memory/store';
import { notifyJarvisListsChanged } from '@/notion/sync';
import type { JobPublisher } from '@/platform/jobs';
import {
  enqueueBackgroundJob,
  enqueueCodingJob,
  enqueueMemoryIndexJob,
} from '@/queues/consume';
import type { DeskToolEffects } from '@/tools/types';

export function createDeskToolEffects(input: {
  readonly sqlExecutor: MemorySqlExecutor;
  readonly jobPublisher: JobPublisher;
  readonly deviceId: string;
  readonly session: Session;
  readonly applyFocusMinutes: (minutes: number) => Promise<void>;
  readonly clearFocus: () => Promise<void>;
  readonly scheduleReminder: (input: {
    delaySeconds: number;
    message: string;
  }) => Promise<void>;
  readonly scheduleDepartureAlert: DeskToolEffects['scheduleDepartureAlert'];
  readonly scheduleRecurringReminder?: DeskToolEffects['scheduleRecurringReminder'];
  readonly broadcastTimerProgress: DeskToolEffects['broadcastTimerProgress'];
  readonly listReminders: DeskToolEffects['listReminders'];
  readonly cancelReminders: DeskToolEffects['cancelReminders'];
  readonly resolveWeatherLocation: DeskToolEffects['resolveWeatherLocation'];
  readonly persistWeatherLocation: DeskToolEffects['persistWeatherLocation'];
  readonly searchThreadHistory: DeskToolEffects['searchThreadHistory'];
  readonly resumeConversationThread: DeskToolEffects['resumeConversationThread'];
  readonly callDeviceTool: DeskToolEffects['callDeviceTool'];
  readonly callInstalledMcpTool: DeskToolEffects['callInstalledMcpTool'];
}): DeskToolEffects {
  return {
    persistMemory: async (content) => {
      const memoryRecord = await addMemoryRecord(input.sqlExecutor, content);
      await rememberFactInSession(input.session, content);
      await enqueueMemoryIndexJob(input.jobPublisher, {
        memoryId: memoryRecord.id,
        content,
        deviceId: input.deviceId,
      });
      return { memoryId: memoryRecord.id, content };
    },
    applyFocusMinutes: input.applyFocusMinutes,
    clearFocus: input.clearFocus,
    enqueueResearch: async (prompt) => {
      await enqueueBackgroundJob(input.jobPublisher, {
        prompt,
        deviceId: input.deviceId,
      });
    },
    enqueueCodingTask: async ({ repository, task }) => {
      await enqueueCodingJob(input.jobPublisher, {
        repository,
        task,
        deviceId: input.deviceId,
      });
    },
    scheduleReminder: input.scheduleReminder,
    scheduleDepartureAlert: input.scheduleDepartureAlert,
    scheduleRecurringReminder: input.scheduleRecurringReminder,
    broadcastTimerProgress: input.broadcastTimerProgress,
    listReminders: input.listReminders,
    cancelReminders: input.cancelReminders,
    resolveWeatherLocation: input.resolveWeatherLocation,
    persistWeatherLocation: input.persistWeatherLocation,
    searchThreadHistory: input.searchThreadHistory,
    resumeConversationThread: input.resumeConversationThread,
    callDeviceTool: input.callDeviceTool,
    callInstalledMcpTool: input.callInstalledMcpTool,
    // Cada cambio en las listas avisa al espejo de Notion. El aviso es un
    // empujón con retardo, no una escritura: junta los borrados de un mismo
    // turno en una sola reconciliación, y no hace nada si el sync está apagado.
    addListItem: async (item) => {
      const record = await addListItemRecord(input.sqlExecutor, item);
      notifyJarvisListsChanged();
      return record;
    },
    listListItems: async (listName) => listListItemRecords(input.sqlExecutor, listName),
    removeListItems: async (removal) => {
      const removalOutcome = await removeListItemRecords(input.sqlExecutor, removal);
      if (removalOutcome.removedCount > 0) {
        notifyJarvisListsChanged();
      }
      return removalOutcome;
    },
  };
}
