import type { ToolExecutionResult } from '@/tools/types';

// Sesión MCP vencida: el servidor se reinició y ya no conoce el id de sesión
// que Apollo tiene guardado. Pasó el 2026-09-28 al pasar el calendario a HTTP
// nativo (que sí tiene sesiones): cada llamada volvía "Bad Request: No valid
// session ID provided" y Jarvis decía que el calendario estaba caído. El
// supervisor no lo arreglaba porque el servidor seguía figurando como "ready".
//
// La salida es la obvia: ante ese error, reconectar ese servidor y reintentar
// una vez.
// Visto en la Pi, según cómo se cortó la sesión:
//   "Bad Request: No valid session ID provided"            (-32000)
//   "Not Found: Unknown or expired session"                (-32001)
const STALE_SESSION_PATTERN =
  /\b(no valid|unknown|expired|invalid)\b[^"]{0,20}\bsession\b|\bsession\b[^"]{0,12}\b(not found|expired|invalid)\b/i;

export function isStaleMcpSessionFailure(result: ToolExecutionResult): boolean {
  return !result.ok && STALE_SESSION_PATTERN.test(result.summary);
}

// Sin closeConnection: cerrar borra la conexión del registro del manager y el
// connectToServer siguiente ya no la encuentra (probado en la Pi). Es lo mismo
// que hace el supervisor: connectToServer sobre la conexión existente arma un
// transporte y una sesión nuevos.
export type McpReconnectSource = {
  readonly connectToServer: (serverId: string) => Promise<unknown>;
  readonly discoverIfConnected: (serverId: string) => Promise<unknown>;
};

export async function callWithStaleSessionRetry(input: {
  readonly serverId: string;
  readonly toolName: string;
  readonly manager: McpReconnectSource;
  readonly call: () => Promise<ToolExecutionResult>;
}): Promise<ToolExecutionResult> {
  const firstResult = await input.call();
  if (!isStaleMcpSessionFailure(firstResult)) {
    return firstResult;
  }
  console.log(
    JSON.stringify({
      level: 'warn',
      message: 'host_mcp_sesion_vencida_reconecto',
      serverId: input.serverId,
      tool: input.toolName,
    }),
  );
  try {
    await input.manager.connectToServer(input.serverId);
    await input.manager.discoverIfConnected(input.serverId);
  } catch {
    return firstResult;
  }
  return input.call();
}
