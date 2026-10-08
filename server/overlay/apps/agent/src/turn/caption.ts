// Lo que la pantalla muestra mientras Jarvis trabaja. Cada herramienta tiene su
// propio cartel y su color de anillo, así de un vistazo se sabe QUÉ está
// haciendo — no solo que está pensando.

export type ThinkingHint = {
  readonly caption: string;
  /** Color del anillo de acento mientras corre la herramienta. */
  readonly accentColor: string;
};

// Paleta por familia de actividad. Los colores son saturados a propósito: en una
// pantalla de 4,3" a un metro de distancia, los pasteles no se distinguen.
const ACCENT_SEARCH = '#3B82F6'; // azul: traer algo de afuera
const ACCENT_PLACE = '#22C55E'; // verde: mapas y lugares
const ACCENT_WEATHER = '#38BDF8'; // celeste: clima
const ACCENT_MEMORY = '#A855F7'; // violeta: memoria
const ACCENT_ORGANIZE = '#F97316'; // naranja: listas, recordatorios, timers
const ACCENT_LANGUAGE = '#EC4899'; // rosa: traducción
const ACCENT_MONEY = '#EAB308'; // dorado: plata
const ACCENT_SYSTEM = '#94A3B8'; // gris: cosas del dispositivo

const toolNameToThinkingHintMap = new Map<string, ThinkingHint>([
  ['weather_now', { caption: 'Mirando el cielo…', accentColor: ACCENT_WEATHER }],
  ['set_weather_location', { caption: 'Anotando dónde vivís…', accentColor: ACCENT_WEATHER }],
  ['web_search', { caption: 'Buscando en internet…', accentColor: ACCENT_SEARCH }],
  ['start_research', { caption: 'Investigando a fondo…', accentColor: ACCENT_SEARCH }],
  ['recall_memory', { caption: 'Haciendo memoria…', accentColor: ACCENT_MEMORY }],
  ['remember_fact', { caption: 'Guardándome esto…', accentColor: ACCENT_MEMORY }],
  ['recall_conversation', { caption: 'Repasando lo que hablamos…', accentColor: ACCENT_MEMORY }],
  ['translate', { caption: 'Traduciendo…', accentColor: ACCENT_LANGUAGE }],
  ['set_reminder', { caption: 'Agendando…', accentColor: ACCENT_ORGANIZE }],
  ['list_reminders', { caption: 'Revisando la agenda…', accentColor: ACCENT_ORGANIZE }],
  ['cancel_reminder', { caption: 'Borrando de la agenda…', accentColor: ACCENT_ORGANIZE }],
  ['set_timer', { caption: 'Poniendo el timer…', accentColor: ACCENT_ORGANIZE }],
  ['start_pomodoro', { caption: 'Arrancando pomodoro…', accentColor: ACCENT_ORGANIZE }],
  ['add_to_list', { caption: 'Sumando a la lista…', accentColor: ACCENT_ORGANIZE }],
  ['read_list', { caption: 'Leyendo la lista…', accentColor: ACCENT_ORGANIZE }],
  ['remove_from_list', { caption: 'Sacando de la lista…', accentColor: ACCENT_ORGANIZE }],
  ['dollar_rate', { caption: 'Viendo cómo viene el dólar…', accentColor: ACCENT_MONEY }],
  ['send_email', { caption: 'Mandando el mail…', accentColor: ACCENT_SYSTEM }],
  ['set_focus', { caption: 'Modo concentración…', accentColor: ACCENT_SYSTEM }],
  ['clear_focus', { caption: 'Saliendo de concentración…', accentColor: ACCENT_SYSTEM }],
  ['sandbox_run_code', { caption: 'Corriendo código…', accentColor: ACCENT_SYSTEM }],
  ['sandbox_exec', { caption: 'Corriendo código…', accentColor: ACCENT_SYSTEM }],
]);

// Las herramientas MCP llegan con el nombre envuelto: el cliente le antepone el
// id del servidor y le agrega un hash para evitar colisiones, quedando algo como
// `mcp_7c6ade76_maps_distance_matrix_03a63731`. Sin desenvolverlo, TODAS caían
// en el cartel genérico "Trabajando…".
const MCP_TOOL_NAME_PATTERN = /^mcp_[0-9a-f]+_(.+?)_[0-9a-f]{6,}$/;

function unwrapMcpToolName(toolName: string): string {
  return MCP_TOOL_NAME_PATTERN.exec(toolName)?.[1] ?? toolName;
}

// Coincidencias por fragmento para lo que llega por MCP: los nombres varían
// entre servidores, pero la palabra que importa suele estar adentro.
const mcpKeywordHintList: readonly (readonly [RegExp, ThinkingHint])[] = [
  [/distance|matrix|route|direction/i, { caption: 'Calculando el viaje…', accentColor: ACCENT_PLACE }],
  [/place|search_places|geocode/i, { caption: 'Ubicando el lugar…', accentColor: ACCENT_PLACE }],
  [/elevation/i, { caption: 'Midiendo la altura…', accentColor: ACCENT_PLACE }],
  [/maps/i, { caption: 'Mirando el mapa…', accentColor: ACCENT_PLACE }],
  [/calendar|event/i, { caption: 'Revisando el calendario…', accentColor: ACCENT_ORGANIZE }],
  [/wiki|docs|library|documentation/i, { caption: 'Leyendo documentación…', accentColor: ACCENT_SEARCH }],
  [/search|query|ask/i, { caption: 'Averiguando…', accentColor: ACCENT_SEARCH }],
  [/note|keep|task/i, { caption: 'Mirando tus notas…', accentColor: ACCENT_ORGANIZE }],
];

const DEFAULT_THINKING_HINT: ThinkingHint = {
  caption: 'Manos a la obra…',
  accentColor: ACCENT_SYSTEM,
};

export function resolveThinkingHint(toolName: string): ThinkingHint {
  const exactHint = toolNameToThinkingHintMap.get(toolName);
  if (exactHint !== undefined) {
    return exactHint;
  }
  const unwrappedName = unwrapMcpToolName(toolName);
  const unwrappedHint = toolNameToThinkingHintMap.get(unwrappedName);
  if (unwrappedHint !== undefined) {
    return unwrappedHint;
  }
  for (const [pattern, hint] of mcpKeywordHintList) {
    if (pattern.test(unwrappedName)) {
      return hint;
    }
  }
  return DEFAULT_THINKING_HINT;
}

// Se conserva la firma anterior: hay llamadores que solo quieren el texto.
export function mapToolNameToThinkingCaption(toolName: string): string {
  return resolveThinkingHint(toolName).caption;
}
