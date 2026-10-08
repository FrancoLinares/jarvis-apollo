// Cuentas con zonas horarias sin sumar una dependencia.
//
// El contenedor corre en UTC y los avisos se piensan en hora local. Un cron fijo
// en UTC erraría por una hora durante medio año en cualquier zona con horario de
// verano, así que los avisos se calculan con el desfase real de la zona en esa
// fecha.
//
// OJO: `toLocaleString` pelado NO sirve acá. Al ICU del contenedor le falta el
// marcador AM/PM del locale es-AR y "18:45" sale "06:45". Siempre opciones
// explícitas y hour12: false.

// Desfase real de una zona horaria en un instante dado, en milisegundos.
//
// Se formatea el instante EN esa zona y se reinterpreta como si fuera UTC: la
// diferencia contra el instante original es el desfase. Es la forma de leer la
// base de zonas horarias sin sumar una dependencia.
export function resolveTimeZoneOffsetMilliseconds(
  timeZone: string,
  atMilliseconds: number,
): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const partList = formatter.formatToParts(new Date(atMilliseconds));
  const readPart = (type: string): number =>
    Number(partList.find((part) => part.type === type)?.value ?? '0');
  // hourCycle h23 puede devolver 24 por medianoche segun la plataforma.
  const hour = readPart('hour') % 24;
  const asIfUtcMilliseconds = Date.UTC(
    readPart('year'),
    readPart('month') - 1,
    readPart('day'),
    hour,
    readPart('minute'),
    readPart('second'),
  );
  return asIfUtcMilliseconds - atMilliseconds;
}

export type CalendarDate = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  // 0 = domingo, 6 = sabado, como Date.getUTCDay.
  readonly weekday: number;
};

export function resolveCalendarDateInTimeZone(
  timeZone: string,
  atMilliseconds: number,
): CalendarDate {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const partList = formatter.formatToParts(new Date(atMilliseconds));
  const readPart = (type: string): string =>
    partList.find((part) => part.type === type)?.value ?? '';
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    readPart('weekday'),
  );
  return {
    year: Number(readPart('year')),
    month: Number(readPart('month')),
    day: Number(readPart('day')),
    weekday: weekdayIndex,
  };
}

// Instante UTC de una hora de pared en una zona horaria.
//
// Se resuelve en dos pasos porque el desfase depende del instante que estamos
// buscando: se estima tratando la hora de pared como si fuera UTC, se mide el
// desfase ahi, y se corrige. La segunda pasada importa en los dias en que
// cambia la hora, donde la primera estimacion cae del lado equivocado del
// salto.
export function resolveWallClockInstantMilliseconds(input: {
  readonly timeZone: string;
  readonly date: CalendarDate;
  readonly hour: number;
  readonly minute: number;
}): number {
  const asIfUtcMilliseconds = Date.UTC(
    input.date.year,
    input.date.month - 1,
    input.date.day,
    input.hour,
    input.minute,
  );
  const firstGuess =
    asIfUtcMilliseconds -
    resolveTimeZoneOffsetMilliseconds(input.timeZone, asIfUtcMilliseconds);
  return (
    asIfUtcMilliseconds - resolveTimeZoneOffsetMilliseconds(input.timeZone, firstGuess)
  );
}
