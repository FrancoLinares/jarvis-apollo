// Recordatorios que se repiten ("todos los días a las 19:30", "de lunes a
// viernes a las 11:30").
//
// Antes no existían: set_reminder es de una sola vez, y el modelo respondía
// "listo, todos los días" programando solo el primero (pasó con un recordatorio diario el
// 2026-09-28). El scheduler del host ya sabe correr crones, así que un
// recurrente es un cron que dispara el mismo deliverReminder de siempre.
//
// El cron corre en UTC (el contenedor está en UTC) y la hora la dice el usuario en
// Buenos Aires. Argentina no tiene horario de verano, pero el desfase igual se
// calcula en el momento, por si algún día vuelve.

export const WEEKDAY_NAME_LIST = [
  'domingo',
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
] as const;

export type WeekdayName = (typeof WEEKDAY_NAME_LIST)[number];

export function parseLocalTime(text: string): { readonly hour: number; readonly minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return { hour, minute };
}

// offsetMinutes = hora local − UTC (Buenos Aires: −180).
export function buildUtcCronFromLocal(input: {
  readonly hour: number;
  readonly minute: number;
  readonly weekdayList: readonly WeekdayName[];
  readonly offsetMinutes: number;
}): string {
  const localMinutes = input.hour * 60 + input.minute;
  let utcMinutes = localMinutes - input.offsetMinutes;
  let dayShift = 0;
  while (utcMinutes >= 24 * 60) {
    utcMinutes -= 24 * 60;
    dayShift += 1;
  }
  while (utcMinutes < 0) {
    utcMinutes += 24 * 60;
    dayShift -= 1;
  }
  const utcDayList = [
    ...new Set(
      input.weekdayList.map(
        (weekday) => (((WEEKDAY_NAME_LIST.indexOf(weekday) + dayShift) % 7) + 7) % 7,
      ),
    ),
  ].sort((left, right) => left - right);
  const dayField = utcDayList.length === 7 ? '*' : utcDayList.join(',');
  return `${utcMinutes % 60} ${Math.floor(utcMinutes / 60)} * * ${dayField}`;
}

const WORKDAY_NAME_LIST: readonly WeekdayName[] = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'];

export function describeRecurrence(
  weekdayList: readonly WeekdayName[],
  hour: number,
  minute: number,
): string {
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const unique = [...new Set(weekdayList)];
  if (unique.length === 7) {
    return `todos los días a las ${time}`;
  }
  if (unique.length === 5 && WORKDAY_NAME_LIST.every((day) => unique.includes(day))) {
    return `de lunes a viernes a las ${time}`;
  }
  const ordered = WEEKDAY_NAME_LIST.filter((day) => unique.includes(day)).map((day) =>
    day.replace('miercoles', 'miércoles').replace('sabado', 'sábado'),
  );
  return `los ${ordered.join(', ')} a las ${time}`;
}

// Mensual ("todos los 5 de cada mes"): el alquiler, las expensas. Si al pasar
// a UTC la hora cae al día siguiente, el día del mes se corre uno; por eso los
// días 29 a 31 solo se aceptan si no hay corrimiento (no existen en todos los
// meses igual, y cron los saltearía).
export function buildUtcMonthlyCronFromLocal(input: {
  readonly hour: number;
  readonly minute: number;
  readonly monthDay: number;
  readonly offsetMinutes: number;
}): string | undefined {
  let utcMinutes = input.hour * 60 + input.minute - input.offsetMinutes;
  let dayShift = 0;
  while (utcMinutes >= 24 * 60) {
    utcMinutes -= 24 * 60;
    dayShift += 1;
  }
  while (utcMinutes < 0) {
    utcMinutes += 24 * 60;
    dayShift -= 1;
  }
  const utcDay = input.monthDay + dayShift;
  if (utcDay < 1 || utcDay > 28 || input.monthDay > 28) {
    return undefined;
  }
  return `${utcMinutes % 60} ${Math.floor(utcMinutes / 60)} ${utcDay} * *`;
}

export function describeMonthlyRecurrence(monthDay: number, hour: number, minute: number): string {
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return `todos los ${monthDay} de cada mes a las ${time}`;
}

// Un mismo recurrente dos veces suena dos veces. Pasó el 2026-09-30: el modelo,
// releyendo la conversación, volvió a crear un aviso diario y quedó
// triplicado. Mismo cron y mensaje igual (o uno que empieza como el otro,
// "…sacá la basura" contra "…sacá la basura, hoy pasa el camión")
// cuenta como el mismo aviso.
export function normalizeReminderMessage(message: string): string {
  return message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSameRecurringReminder(
  existing: { readonly cron: string; readonly message: string },
  candidate: { readonly cron: string; readonly message: string },
): boolean {
  if (existing.cron !== candidate.cron) {
    return false;
  }
  const left = normalizeReminderMessage(existing.message);
  const right = normalizeReminderMessage(candidate.message);
  return left.startsWith(right) || right.startsWith(left);
}
