import { listCodingRepositoriesTool, startCodingTaskTool } from '@/tools/coding';
import { deviceStatusTool, setBrightnessTool, setVolumeTool } from '@/tools/device';
import { dollarRateTool } from '@/tools/dollar';
import { sendEmailTool } from '@/tools/email';
import { setFocusTool, clearFocusTool } from '@/tools/focus';
import { recallConversationTool, resumeConversationTool } from '@/tools/history';
import { addToListTool, readListTool, removeFromListTool } from '@/tools/list';
import { setWeatherLocationTool } from '@/tools/location';
import { confirmMessageTool, draftMessageTool } from '@/tools/message';
import { speakerTool } from '@/tools/speaker';
import { recallMemoryTool, rememberFactTool } from '@/tools/memory';
import {
  cancelReminderTool,
  listRemindersTool,
  setRecurringReminderTool,
  setReminderTool,
} from '@/tools/reminder';
import { departureAlertTool } from '@/tools/travel';
import { buildToolDefinitionMap } from '@/tools/router';
import { startResearchTool } from '@/tools/research';
import { sandboxExecTool, sandboxRunCodeTool } from '@/tools/sandbox';
import { setTimerTool, startPomodoroTool } from '@/tools/timer';
import { translateTool } from '@/tools/translate';
import { webSearchTool } from '@/tools/web';
import type { ToolDefinition } from '@/tools/types';
import { weatherNowTool } from '@/tools/weather';
import { sendWhatsAppTool } from '@/tools/whatsapp';

export function listBuiltinToolDefinitionList(): readonly ToolDefinition[] {
  return [
    weatherNowTool,
    setWeatherLocationTool,
    rememberFactTool,
    setFocusTool,
    clearFocusTool,
    webSearchTool,
    startResearchTool,
    recallMemoryTool,
    recallConversationTool,
    resumeConversationTool,
    translateTool,
    setReminderTool,
    setRecurringReminderTool,
    departureAlertTool,
    listRemindersTool,
    cancelReminderTool,
    setTimerTool,
    startPomodoroTool,
    addToListTool,
    readListTool,
    removeFromListTool,
    dollarRateTool,
    setVolumeTool,
    setBrightnessTool,
    deviceStatusTool,
    speakerTool,
    sendEmailTool,
    sendWhatsAppTool,
    draftMessageTool,
    confirmMessageTool,
    sandboxRunCodeTool,
    sandboxExecTool,
    listCodingRepositoriesTool,
    startCodingTaskTool,
  ];
}

export function createBuiltinToolDefinitionMap(): Map<string, ToolDefinition> {
  return buildToolDefinitionMap(listBuiltinToolDefinitionList());
}
