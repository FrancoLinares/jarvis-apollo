import { isSpeechInFlight } from '@/idle/speech-gate';
import {
  buildIdleCaptionList,
  selectIdleCaption,
  type IdleCalendarEvent,
  type IdleNote,
  type IdlePendingList,
  type IdleReminder,
  type IdleTravelTime,
  type IdleWeatherSnapshot,
} from '@/idle/rotator';

// Rota información en la pantalla mientras Jarvis no hace nada. El armado de
// texto vive en rotator.ts (puro y testeado); acá solo está el cuándo y el
// de dónde.
//
// Reglas que evitan que moleste:
//  - Solo cuando el estado es 'idle' y hay algún dispositivo conectado.
//  - Los datos se releen en cada vuelta: un recordatorio que se cumplió tiene
//    que desaparecer del ciclo.
//  - Si una fuente falla, se saltea; una pantalla con menos datos es mejor que
//    un ciclo que se corta entero.

const IDLE_ROTATION_INTERVAL_MILLISECONDS = 15_000;

export type IdleRotationDependencies = {
  readonly getUiState: () => string;
  readonly getDeviceConnectionCount: () => number;
  readonly pushIdleCaption: (caption: string) => void;
  readonly readWeather: () => Promise<IdleWeatherSnapshot | undefined>;
  readonly readNextReminder: () => Promise<IdleReminder | undefined>;
  readonly readNextCalendarEvent?: () => Promise<IdleCalendarEvent | undefined>;
  readonly readTravelTime?: () => Promise<IdleTravelTime | undefined>;
  readonly readPendingList?: () => Promise<IdlePendingList | undefined>;
  readonly readLastNote?: () => Promise<IdleNote | undefined>;
  readonly intervalMilliseconds?: number;
};

async function readOrSkip<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

export function startIdleRotation(dependencies: IdleRotationDependencies): () => void {
  let rotationIndex = 0;
  let tickInFlight = false;

  async function tick(): Promise<void> {
    // Las fuentes salen a la red: un ciclo lento no debe pisar al siguiente.
    if (tickInFlight) {
      return;
    }
    // El estado vuelve a 'idle' apenas se arma la respuesta, pero el audio sigue
    // viajando: sin este chequeo la rotación tapaba la frase que Jarvis estaba
    // diciendo, menos de un segundo después de que apareciera en el cartel.
    if (
      dependencies.getUiState() !== 'idle' ||
      dependencies.getDeviceConnectionCount() === 0 ||
      isSpeechInFlight()
    ) {
      return;
    }
    tickInFlight = true;
    try {
      // Una fuente sin cablear (undefined) se resuelve a undefined y el rotador
      // no le hace lugar en el ciclo: así se van conectando de a una.
      const [weather, nextReminder, nextCalendarEvent, travelTime, pendingList, lastNote] =
        await Promise.all([
          readOrSkip(dependencies.readWeather),
          readOrSkip(dependencies.readNextReminder),
          readOrSkip(dependencies.readNextCalendarEvent ?? (async () => undefined)),
          readOrSkip(dependencies.readTravelTime ?? (async () => undefined)),
          readOrSkip(dependencies.readPendingList ?? (async () => undefined)),
          readOrSkip(dependencies.readLastNote ?? (async () => undefined)),
        ]);
      const captionList = buildIdleCaptionList({
        weather,
        nextReminder,
        nextCalendarEvent,
        travelTime,
        pendingList,
        lastNote,
        nowMilliseconds: Date.now(),
      });
      const caption = selectIdleCaption(captionList, rotationIndex);
      // Se revalida el estado: entre el await y acá el usuario pudo empezar a
      // hablar, y pisarle el cartel sería confuso.
      if (
        caption !== undefined &&
        dependencies.getUiState() === 'idle' &&
        !isSpeechInFlight()
      ) {
        dependencies.pushIdleCaption(caption);
        rotationIndex += 1;
      }
    } finally {
      tickInFlight = false;
    }
  }

  const timer = setInterval(
    () => void tick(),
    dependencies.intervalMilliseconds ?? IDLE_ROTATION_INTERVAL_MILLISECONDS,
  );
  return () => clearInterval(timer);
}
