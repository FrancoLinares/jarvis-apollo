// Semáforo entre el turno que está mandando audio y la rotación de reposo.
//
// El estado de la máquina de UI vuelve a 'idle' apenas termina de armarse la
// respuesta, pero el audio sigue viajando a la placa varios segundos después.
// Sin este semáforo, la rotación pisaba el cartel de la frase que Jarvis estaba
// diciendo — se veía el clima encima de la respuesta, a menos de un segundo de
// que apareciera.
//
// Es un contador y no un booleano porque puede haber más de un dispositivo (o
// una notificación proactiva) hablando a la vez: recién cuando el último
// termina se libera la pantalla.

// Techo de seguridad: si el envío de audio se corta por una excepción, el
// contador nunca se decrementa y la rotación quedaría muda para siempre. Con el
// vencimiento el semáforo se suelta solo. Es bien holgado contra la respuesta
// más larga posible (varios segmentos de 280 caracteres) para no cortar una
// frase de verdad.
const SPEECH_GATE_MAXIMUM_HOLD_MILLISECONDS = 120_000;

let speechInFlightCount = 0;
let gateExpiresAtMilliseconds = 0;

export function markSpeechStarted(nowMilliseconds: number = Date.now()): void {
  speechInFlightCount += 1;
  gateExpiresAtMilliseconds = nowMilliseconds + SPEECH_GATE_MAXIMUM_HOLD_MILLISECONDS;
}

export function markSpeechFinished(): void {
  // Nunca por debajo de cero: un cierre que corra dos veces dejaría el contador
  // en negativo y haría falta el doble de aperturas para volver a frenar.
  speechInFlightCount = Math.max(0, speechInFlightCount - 1);
  if (speechInFlightCount === 0) {
    gateExpiresAtMilliseconds = 0;
  }
}

export function isSpeechInFlight(nowMilliseconds: number = Date.now()): boolean {
  return speechInFlightCount > 0 && nowMilliseconds < gateExpiresAtMilliseconds;
}

// Solo para los tests: deja el semáforo como recién arrancado.
export function resetSpeechGateForTesting(): void {
  speechInFlightCount = 0;
  gateExpiresAtMilliseconds = 0;
}
