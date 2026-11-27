const HOUR = 3600;
const DAY = 24 * HOUR;

export const PERIODS_HELP =
  'сегодня, вчера, позавчера, неделя, месяц, 6ч (часов), 3д (дней), 25.11, 20.11-25.11';

// Разница между временем в часовом поясе tz и UTC (в секундах) для момента ts
function tzOffset(ts, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(new Date(ts * 1000))
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000;
  return asUtc - ts;
}

// Unix-время начала суток (00:00) по часовому поясу tz
function startOfDay(year, month, day, tz) {
  const guess = Date.UTC(year, month - 1, day) / 1000;
  return guess - tzOffset(guess - tzOffset(guess, tz), tz);
}

function localDate(ts, tz) {
  const shifted = new Date((ts + tzOffset(ts, tz)) * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function parseDate(str, currentYear) {
  const [d, m, y] = str.split('.').map(Number);
  let year = y || currentYear;
  if (year < 100) year += 2000;
  const check = new Date(Date.UTC(year, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return { year, month: m, day: d };
}

/**
 * Разбирает период из команды.
 * Возвращает { from, to, title } (unix-время в секундах) или null.
 */
export function parsePeriod(arg, now, tz) {
  const a = arg.trim().toLowerCase();
  const today = localDate(now, tz);
  const todayStart = startOfDay(today.year, today.month, today.day, tz);
  const dayStartAgo = (n) => {
    const d = localDate(todayStart - n * DAY + 12 * HOUR, tz);
    return startOfDay(d.year, d.month, d.day, tz);
  };

  if (a === '' || a === 'сегодня') return { from: todayStart, to: now, title: 'сегодня' };
  if (a === 'вчера') return { from: dayStartAgo(1), to: todayStart, title: 'вчера' };
  if (a === 'позавчера') return { from: dayStartAgo(2), to: dayStartAgo(1), title: 'позавчера' };
  if (['неделя', 'неделю', 'week'].includes(a)) return { from: now - 7 * DAY, to: now, title: 'последние 7 дней' };
  if (['месяц', 'month'].includes(a)) return { from: now - 30 * DAY, to: now, title: 'последние 30 дней' };

  let m = a.match(/^(\d+)\s*(ч|час|часа|часов|h)$/);
  if (m) return { from: now - Number(m[1]) * HOUR, to: now, title: `последние ${m[1]} ч.` };

  m = a.match(/^(\d+)\s*(д|дн|день|дня|дней|d)$/);
  if (m) {
    const n = Math.max(1, Number(m[1]));
    return { from: dayStartAgo(n - 1), to: now, title: `последние ${n} дн. (включая сегодня)` };
  }

  const dateRe = '(\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2,4})?)';
  m = a.match(new RegExp(`^${dateRe}\\s*[-–—]\\s*${dateRe}$`));
  if (m) {
    const d1 = parseDate(m[1], today.year);
    const d2 = parseDate(m[2], today.year);
    if (!d1 || !d2) return null;
    const from = startOfDay(d1.year, d1.month, d1.day, tz);
    const endDay = localDate(startOfDay(d2.year, d2.month, d2.day, tz) + DAY + 12 * HOUR, tz);
    const to = Math.min(startOfDay(endDay.year, endDay.month, endDay.day, tz), now);
    return { from, to, title: `${m[1]} – ${m[2]}` };
  }

  m = a.match(new RegExp(`^${dateRe}$`));
  if (m) {
    const d = parseDate(m[1], today.year);
    if (!d) return null;
    const from = startOfDay(d.year, d.month, d.day, tz);
    const next = localDate(from + DAY + 12 * HOUR, tz);
    const to = Math.min(startOfDay(next.year, next.month, next.day, tz), now);
    return { from, to, title: m[1] };
  }

  return null;
}

export function formatTime(ts, tz) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts * 1000));
}
