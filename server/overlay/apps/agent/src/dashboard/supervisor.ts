import {
  buildDashboardPayload,
  type DashboardPayload,
  type DashboardSourceData,
} from '@/dashboard/payload';

// Mantiene el tablero de la placa al día.
//
// La rotación de reposo empujaba un cartel cada 15s porque solo se veía uno por
// vez. Acá se manda el tablero entero, y por eso el ritmo es otro: cada 30s
// alcanza, y solo si algo cambió. Las etiquetas de tiempo ("en 40 minutos") se
// recalculan en cada vuelta, así que la cuenta regresiva se ve viva sin que el
// firmware tenga que hacer aritmética de fechas.

// 10s y no 30: cuando la placa se reconecta (o se reflashea, que pasa seguido)
// llega con la pantalla vacia y espera este intervalo para recibir el tablero.
// Treinta segundos mirando tarjetas en blanco se leen como "esta roto".
const DASHBOARD_REFRESH_INTERVAL_MILLISECONDS = 10_000;

export type DashboardSupervisorDependencies = {
  readonly getDeviceConnectionCount: () => number;
  readonly pushDashboard: (payload: DashboardPayload) => void;
  readonly readSources: () => Promise<Omit<DashboardSourceData, 'nowMilliseconds'>>;
  readonly intervalMilliseconds?: number;
  readonly now?: () => number;
};

export function startDashboardSupervisor(
  dependencies: DashboardSupervisorDependencies,
): () => void {
  const now = dependencies.now ?? (() => Date.now());
  let lastPushedPayload: DashboardPayload | undefined;
  let lastConnectionCount = 0;
  let tickInFlight = false;

  async function tick(): Promise<void> {
    // Las fuentes salen a la red: una vuelta lenta no debe pisar la siguiente.
    if (tickInFlight) {
      return;
    }
    const connectionCount = dependencies.getDeviceConnectionCount();
    // Una placa que ACABA de conectarse tiene la pantalla sin datos: hay que
    // mandarle el tablero completo aunque el contenido no haya cambiado. Con
    // mirar solo el caso "no queda nadie" no alcanzaba, porque con dos clientes
    // el contador nunca llegaba a cero y el nuevo se quedaba sin nada.
    if (connectionCount > lastConnectionCount) {
      lastPushedPayload = undefined;
    }
    lastConnectionCount = connectionCount;

    // Sin nadie mirando no tiene sentido leer clima ni tránsito.
    if (connectionCount === 0) {
      lastPushedPayload = undefined;
      return;
    }
    tickInFlight = true;
    try {
      const sourceData = await dependencies.readSources();
      const payload = buildDashboardPayload({
        ...sourceData,
        nowMilliseconds: now(),
      });
      // Se manda SIEMPRE, aunque no haya cambiado nada.
      //
      // Antes solo se empujaba ante un cambio, y eso creaba un bug de
      // corrección disfrazado de optimización: si la placa se reiniciaba y
      // mientras tanto ningún dato cambiaba, se quedaba con las tarjetas vacías
      // PARA SIEMPRE. Detectar la reconexión por el contador de conexiones no
      // alcanzaba (una conexión colgada mantiene el número arriba).
      //
      // El costo de mandar siempre es unos cientos de bytes cada 10s por un
      // WebSocket que ya está abierto. Nada, comparado con una pantalla vacía.
      lastPushedPayload = payload;
      dependencies.pushDashboard(payload);
    } catch (error) {
      // Una fuente caída no puede tumbar el tablero: se reintenta en la próxima
      // vuelta y mientras tanto la placa conserva lo último que le llegó.
      console.log(
        JSON.stringify({
          level: 'warn',
          message: 'dashboard_refresh_failed',
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      tickInFlight = false;
    }
  }

  const timer = setInterval(
    () => void tick(),
    dependencies.intervalMilliseconds ?? DASHBOARD_REFRESH_INTERVAL_MILLISECONDS,
  );
  void tick();
  return () => clearInterval(timer);
}
