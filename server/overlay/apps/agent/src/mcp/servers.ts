import { z } from 'zod';

import { buildNamespacedMcpToolName } from '@/mcp/naming';
import { findMcpToolSetting, type McpToolSettingRow } from '@/mcp/settings';
import type { DiscoveredMcpTool } from '@/mcp/adapter';
import type { ToolSafetyLevel } from '@/tools/types';

// The worker fetches this with the owner's credentials attached: a relative URL
// would resolve against the worker itself, and http would send them in clear.
// Destinos cuyo tráfico nunca sale del host donde corre el agente ni de su red
// privada. Para ellos http es aceptable: no hay red pública por la que espiar
// las credenciales. Cualquier otro destino sigue exigiendo https, que es de lo
// que protegía la regla original (el agente adjunta las credenciales del dueño).
//
// Los nombres de un solo componente entran a propósito: Apollo corre en Docker,
// y un MCP vecino se resuelve por nombre de servicio (ej. http://maps-mcp:8000),
// que nunca sale del bridge del host.
const LOOPBACK_HOSTNAME_SET = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isPrivateNetworkHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTNAME_SET.has(hostname)) {
    return true;
  }
  if (hostname.endsWith('.local') || !hostname.includes('.')) {
    return true;
  }
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match === null) {
    return false;
  }
  const [first, second] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

const mcpServerUrlSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine((candidateUrl) => {
    try {
      const parsedUrl = new URL(candidateUrl);
      if (parsedUrl.protocol === 'https:') {
        return true;
      }
      return parsedUrl.protocol === 'http:' && isPrivateNetworkHostname(parsedUrl.hostname);
    } catch {
      return false;
    }
  }, 'La URL del servidor MCP tiene que ser https, o http contra la red privada');

export const installMcpServerInputSchema = z.object({
  secret: z.string().min(1),
  name: z.string().min(1).max(64),
  url: mcpServerUrlSchema,
  authToken: z.string().min(1).max(4096).optional(),
});

export type InstallMcpServerInput = z.infer<typeof installMcpServerInputSchema>;

export const mcpSecretInputSchema = z.object({
  secret: z.string().min(1),
});

export const removeMcpServerInputSchema = z.object({
  secret: z.string().min(1),
  serverId: z.string().min(1),
});

export const retryMcpServerInputSchema = z.object({
  secret: z.string().min(1),
  serverId: z.string().min(1),
});

export const setMcpToolEnabledInputSchema = z.object({
  secret: z.string().min(1),
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  safety: z.enum(['safe', 'unsafe']).optional(),
});

export type SetMcpToolEnabledInput = z.infer<typeof setMcpToolEnabledInputSchema>;

export type McpServerToolSummary = {
  readonly namespacedName: string;
  readonly toolName: string;
  readonly description: string;
  readonly isEnabled: boolean;
  readonly safety: ToolSafetyLevel;
};

export type McpServerSummary = {
  readonly serverId: string;
  readonly name: string;
  readonly url: string;
  readonly state: string;
  readonly authUrl: string | null;
  readonly error: string | null;
  readonly toolList: readonly McpServerToolSummary[];
};

export const mcpServerRecordSchema = z.object({
  name: z.string(),
  server_url: z.string(),
  state: z.string(),
  auth_url: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

// The SDK's server registry survives hibernation, so a stored record may be
// null or miss any field; every record is re-validated with the schema before use.
export type McpServerRecordCandidate = Partial<
  z.input<typeof mcpServerRecordSchema>
> | null;

export type McpServerRecordCandidateMap = Record<string, McpServerRecordCandidate>;

export function buildMcpServerSummaryList(input: {
  readonly serverRecordMap: McpServerRecordCandidateMap;
  readonly discoveredToolList: readonly DiscoveredMcpTool[];
  readonly settingList: readonly McpToolSettingRow[];
  readonly defaultSafetyResolver: (discoveredTool: DiscoveredMcpTool) => ToolSafetyLevel;
}): readonly McpServerSummary[] {
  return Object.entries(input.serverRecordMap).flatMap(([serverId, rawRecord]) => {
    const parsedRecord = mcpServerRecordSchema.safeParse(rawRecord);
    if (!parsedRecord.success) {
      return [];
    }
    const toolList = input.discoveredToolList
      .filter((discoveredTool) => discoveredTool.serverId === serverId)
      .map((discoveredTool) => {
        const namespacedName = buildNamespacedMcpToolName(serverId, discoveredTool.name);
        const settingRow = findMcpToolSetting(
          input.settingList,
          serverId,
          discoveredTool.name,
        );
        return {
          namespacedName,
          toolName: discoveredTool.name,
          description: discoveredTool.description ?? '',
          isEnabled: settingRow?.isEnabled ?? false,
          safety: settingRow?.safety ?? input.defaultSafetyResolver(discoveredTool),
        };
      });
    return [
      {
        serverId,
        name: parsedRecord.data.name,
        url: parsedRecord.data.server_url,
        state: parsedRecord.data.state,
        authUrl: parsedRecord.data.auth_url ?? null,
        error: parsedRecord.data.error ?? null,
        toolList,
      },
    ];
  });
}
