import '@/platform/bun/shims';

import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ApolloState } from '@/agents/apollo';
import { createApolloHostActor } from '@/host/actor';
import { createBroadcastUploadRegistry } from '@/host/broadcast';
import { parseHostConfiguration } from '@/host/configuration';
import { createHostInitiativeEngine } from '@/host/initiative';
import { createHostMcpManager, startMcpConnectionSupervisor } from '@/host/mcp';
import { startDashboardSupervisor } from '@/dashboard/supervisor';
import { startIdleRotation } from '@/idle/supervisor';
import {
  TRAVEL_TIME_CACHE_MILLISECONDS,
  createExpiringReader,
  readLastNote,
  readPendingList,
  readPendingListDetail,
  readTravelTime,
} from '@/idle/sources';
import { startNotionListSync } from '@/notion/sync';
import { getCachedCurrentDeskWeather } from '@/weather/cache';
import { createHostRunEngine } from '@/host/runs';
import { createApolloHostServer } from '@/host/server';
import { createHostThreadEngine } from '@/host/threads';
import { buildApolloSessionManager, compactThreadMessageList } from '@/memory/session';
import { embedTextWithOpenRouter } from '@/memory/vector';
import { createFileBlobStore } from '@/platform/bun/blob';
import { createBunJobQueue } from '@/platform/bun/queue';
import { createBunScheduler } from '@/platform/bun/scheduler';
import { startRouterLearning } from '@/router/learn';
import { createSqliteApiCostSink, setApiCostSink } from '@/costs/ledger';
import { createBunSqliteExecutor, createBunSqliteSqlProvider } from '@/platform/bun/sql';
import { createSqliteVectorStore } from '@/platform/bun/vector';
import { executeApolloQueueJob } from '@/queues/consume';

const HOST_SCHEMA_DDL_LIST = [
  'CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS session_prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS pending_device_messages (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS list_items (id TEXT PRIMARY KEY, list_name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS pending_confirmations (id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, args_json TEXT NOT NULL, summary TEXT NOT NULL, expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mcp_tool_settings (namespaced_name TEXT PRIMARY KEY, server_id TEXT NOT NULL, tool_name TEXT NOT NULL, is_enabled INTEGER NOT NULL, safety TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS thread_meta (session_id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT, last_turn_at INTEGER NOT NULL)',
];

export type ApolloHost = {
  readonly port: number;
  stop(): void;
};

export async function startApolloHost(
  processEnvironment: Record<string, string | undefined>,
): Promise<ApolloHost> {
  const configuration = parseHostConfiguration(processEnvironment);
  await mkdir(configuration.dataDirectory, { recursive: true });
  const blobDirectory = join(configuration.dataDirectory, 'blobs');
  await mkdir(blobDirectory, { recursive: true });

  const database = new Database(
    join(configuration.dataDirectory, `${configuration.deviceName}.sqlite`),
  );
  database.run('PRAGMA journal_mode = WAL');
  for (const tableDdl of HOST_SCHEMA_DDL_LIST) {
    database.run(tableDdl);
  }

  const sqlExecutor = createBunSqliteExecutor(database);
  const sqlProvider = createBunSqliteSqlProvider(database);
  const mediaBlobStore = createFileBlobStore(blobDirectory);
  const vectorStore = createSqliteVectorStore(database);
  const { environment } = configuration;

  const sessionManager = buildApolloSessionManager({
    sqlProvider,
    getSpeechModeId: () => actor.getState().speechMode,
    skillBucket: {
      async list(options) {
        const listing = await mediaBlobStore.list({ prefix: options.prefix ?? '' });
        return {
          objects: listing.entryList.map((entry) => ({ key: entry.key })),
          truncated: listing.isTruncated,
          ...(listing.cursor === undefined ? {} : { cursor: listing.cursor }),
        };
      },
      async get(objectKey) {
        return mediaBlobStore.get(objectKey);
      },
    },
    compactMessageList: async (messageList) =>
      compactThreadMessageList(environment, messageList),
  });

  const runEngine = createHostRunEngine({
    database,
    environment,
    mediaBlobStore,
    notifyApollo: async (notification) => {
      await actor.notifyBackgroundResult(notification);
    },
  });

  const jobQueue = createBunJobQueue({
    database,
    executeJob: async (job) =>
      executeApolloQueueJob(job, {
        vectorStore,
        runLauncher: runEngine.runLauncher,
        embedText: (text) =>
          embedTextWithOpenRouter({
            openRouterApiKey: environment.OPENROUTER_API_KEY,
            modelId: environment.OPENROUTER_EMBEDDING_MODEL,
            text,
          }),
      }),
  });

  const scheduler = createBunScheduler({
    database,
    dispatch: async (schedule) => actor.dispatchSchedule(schedule),
  });

  const stateBroadcast = {
    notify: (state: ApolloState) => {
      void state;
    },
  };

  const actor = createApolloHostActor({
    deviceName: configuration.deviceName,
    environment,
    sqlExecutor,
    sessionManager,
    scheduler,
    mediaBlobStore,
    vectorStore,
    jobPublisher: jobQueue.publisher,
    onStateChanged: (state) => stateBroadcast.notify(state),
  });

  const mcpServersChanged = {
    notify: () => {},
  };
  const mcpManager = await createHostMcpManager({
    database,
    deviceName: configuration.deviceName,
    onServersChanged: () => mcpServersChanged.notify(),
  });

  startMcpConnectionSupervisor({
    hostMcpManager: mcpManager,
    onServersChanged: () => mcpServersChanged.notify(),
  });

  // TODOs híbridos: las listas siguen viviendo en el SQLite (es lo que usan las
  // herramientas de voz y el scheduler) y Notion queda como espejo editable a
  // mano, sincronizado en los dos sentidos. Sin NOTION_TOKEN no se arranca:
  // todo lo demás funciona igual, solo que sin espejo.
  const notionToken = process.env.NOTION_TOKEN?.trim();
  const notionDatabaseId = process.env.NOTION_LISTS_DATABASE_ID?.trim();
  if (notionToken !== undefined && notionToken.length > 0 &&
      notionDatabaseId !== undefined && notionDatabaseId.length > 0) {
    startNotionListSync({
      sqlExecutor,
      token: notionToken,
      databaseId: notionDatabaseId,
    });
    console.log(
      JSON.stringify({ level: 'info', message: 'notion_list_sync_enabled' }),
    );
  }

  // Costo real de cada llamada a OpenRouter, por componente (src/costs).
  setApiCostSink(createSqliteApiCostSink(sqlExecutor));

  // Router de intenciones: aprende una vez por día de cómo terminaron sus
  // decisiones (umbrales por intención y clasificador local). Ver src/router.
  if (process.env.ROUTER_MODE !== 'off') {
    startRouterLearning(sqlExecutor);
  }

  // Tiempo de viaje: solo si hay clave y destino configurados. El cache propio
  // evita pedirle el tránsito a Google cuatro veces por minuto, que es la
  // frecuencia a la que gira la rotación.
  const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  const travelDestination = process.env.IDLE_TRAVEL_DESTINATION?.trim();
  const travelOrigin = process.env.IDLE_TRAVEL_ORIGIN?.trim();
  const idleTravelTimeReader =
    googleMapsApiKey !== undefined && googleMapsApiKey.length > 0 &&
    travelDestination !== undefined && travelDestination.length > 0 &&
    travelOrigin !== undefined && travelOrigin.length > 0
      ? createExpiringReader({
          ttlMilliseconds: TRAVEL_TIME_CACHE_MILLISECONDS,
          read: async () =>
            readTravelTime({
              apiKey: googleMapsApiKey,
              originAddress: travelOrigin,
              destinationAddress: travelDestination,
              destinationLabel: process.env.IDLE_TRAVEL_LABEL?.trim() || 'Al centro',
            }),
        })
      : undefined;

  // Pantalla en reposo: en vez de solo la cara y el reloj, rota lo que hay para
  // saber de un vistazo. Cada fuente se lee en el momento y falla en silencio.
  startIdleRotation({
    getUiState: () => actor.getState().uiState,
    getDeviceConnectionCount: () => actor.getDeviceConnectionCount(),
    pushIdleCaption: (caption) => {
      actor.setState({ ...actor.getState(), caption });
      actor.pushUiStateToDevices();
    },
    readWeather: async () => {
      const location = await actor.resolveWeatherLocation();
      return getCachedCurrentDeskWeather({
        latitude: location.latitude,
        longitude: location.longitude,
        locationLabel: location.locationLabel,
      });
    },
    readNextReminder: async () => {
      const reminderRowList = await actor.listReminderRowList();
      // El más próximo que todavía no venció: mostrar uno pasado sería ruido.
      const nowMilliseconds = Date.now();
      const upcoming = reminderRowList
        .map((row) => ({
          text: row.message,
          dueAtMilliseconds: new Date(row.firesAtIso).getTime(),
        }))
        .filter((row) => Number.isFinite(row.dueAtMilliseconds))
        .filter((row) => row.dueAtMilliseconds > nowMilliseconds)
        .sort((left, right) => left.dueAtMilliseconds - right.dueAtMilliseconds);
      return upcoming[0];
    },
    readPendingList: async () => readPendingList(sqlExecutor),
    readLastNote: async () => readLastNote(sqlExecutor),
    readTravelTime: idleTravelTimeReader,
  });

  // Tablero para el firmware LVGL. Convive con la rotación de reposo: el
  // firmware viejo ignora el mensaje `dashboard` (la cadena de strcmp del
  // protocolo no tiene un else que falle) y el nuevo ignora los carteles.
  // Cuando la placa esté flasheada, la rotación se retira.
  startDashboardSupervisor({
    getDeviceConnectionCount: () => actor.getDeviceConnectionCount(),
    pushDashboard: (payload) => actor.broadcastToDevices(payload),
    readSources: async () => {
      const [weather, reminderRowList, pending, travel] = await Promise.all([
        (async () => {
          const location = await actor.resolveWeatherLocation();
          return getCachedCurrentDeskWeather({
            latitude: location.latitude,
            longitude: location.longitude,
            locationLabel: location.locationLabel,
          });
        })().catch(() => undefined),
        actor.listReminderRowList().catch(() => []),
        readPendingListDetail(sqlExecutor).catch(() => undefined),
        (idleTravelTimeReader?.() ?? Promise.resolve(undefined)).catch(() => undefined),
      ]);
      return {
        weather,
        reminderList: reminderRowList.map((row) => ({
          text: row.message,
          dueAtMilliseconds: new Date(row.firesAtIso).getTime(),
        })),
        pending,
        travel,
      };
    },
  });

  const activeThreadAccessor = actor.getActiveThreadSessionIdSetter();
  const threadEngine = createHostThreadEngine({
    deviceName: configuration.deviceName,
    environment,
    sqlExecutor,
    sessionManager,
    scheduler,
    vectorStore,
    jobPublisher: jobQueue.publisher,
    getActiveThreadSessionId: () => activeThreadAccessor.get(),
    setActiveThreadSessionId: (sessionId) => activeThreadAccessor.set(sessionId),
  });
  const initiativeEngine = createHostInitiativeEngine({
    deviceName: configuration.deviceName,
    environment,
    sqlExecutor,
    scheduler,
    mediaBlobStore,
    getFocusEndsAt: () => actor.getState().focusEndsAt,
    currentFocusState: () => actor.currentFocusState(),
    getDeviceConnectionList: () => actor.getDeviceConnectionList(),
    playEffect: (effectName) =>
      actor.broadcastToDevices({ type: 'play_effect', name: effectName }),
  });
  actor.attachEngines({ threadEngine, initiativeEngine, mcpManager });

  const server = createApolloHostServer({
    configuration,
    actor,
    mediaBlobStore,
    rpcDependencies: {
      actor,
      deviceName: configuration.deviceName,
      environment,
      sqlExecutor,
      scheduler,
      mediaBlobStore,
      vectorStore,
      jobPublisher: jobQueue.publisher,
      broadcastUploadRegistry: createBroadcastUploadRegistry(),
      mcpManager,
    },
  });
  stateBroadcast.notify = (state) => server.broadcastConsoleState(state);
  mcpServersChanged.notify = () => {
    server.broadcastConsoleMessage(
      JSON.stringify({
        type: 'cf_agent_mcp_servers',
        mcp: {
          servers: mcpManager.buildServerRecordMap(),
          tools: mcpManager.manager.listTools(),
          prompts: mcpManager.manager.listPrompts(),
          resources: mcpManager.manager.listResources(),
        },
      }),
    );
  };

  await actor.start();
  await scheduler.start();
  jobQueue.start();
  await runEngine.resumeIncompleteRuns();

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'apollo_host_started',
      port: server.port,
      deviceName: configuration.deviceName,
      dataDirectory: configuration.dataDirectory,
    }),
  );

  return {
    port: server.port,
    stop() {
      jobQueue.stop();
      scheduler.stop();
      server.stop();
      database.close();
    },
  };
}

if (import.meta.main) {
  void startApolloHost(process.env);
}
