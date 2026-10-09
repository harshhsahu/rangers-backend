/**
 * Cron expressions are built here, in our own code, from structured fields —
 * never accepted as a string an LLM wrote. Models get the parts that look
 * harmless wrong: day-of-week 0 vs 7, a list where a step was meant, and the
 * day-of-month / day-of-week fields being OR'd rather than AND'd. Those produce
 * a job that fires on the wrong days and nobody notices for a week.
 *
 * Raw expressions are still accepted for the advanced case, but they go through
 * `validateCronExpression` first and are held to the same 5-field shape.
 */

const FIELD_RANGES = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

export const FREQUENCIES = ["hourly", "daily", "weekdays", "weekly", "monthly"];

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "17:00" / "5:00" / "17" -> { hour, minute }. Throws on anything else. */
export function parseTimeOfDay(time, fallback = "09:00") {
  const raw = String(time || fallback).trim();
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(raw);
  if (!match) throw new Error(`Invalid time "${raw}" — use 24-hour HH:MM, e.g. 17:00`);
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time "${raw}" — hour must be 0-23 and minute 0-59`);
  return { hour, minute };
}

/**
 * Structured schedule -> 5-field cron. Reading the frequency plus its one
 * relevant field: daily at 17:00 becomes `0 17 * * *`; weekdays at 09:30
 * becomes `30 9 * * 1-5`; weekly on weekday 1 at 09:00 becomes `0 9 * * 1`;
 * monthly on day 1 at 08:00 becomes `0 8 1 * *`; hourly at minute 15 becomes
 * `15 * * * *`.
 */
export function buildCronExpression(input = {}) {
  const frequency = String(input.frequency || "").toLowerCase();

  if (frequency === "hourly") {
    const minute = Number(input.minute ?? 0);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error("minute must be between 0 and 59 for an hourly schedule");
    }
    return `${minute} * * * *`;
  }

  const { hour, minute } = parseTimeOfDay(input.time);

  if (frequency === "daily") return `${minute} ${hour} * * *`;
  if (frequency === "weekdays") return `${minute} ${hour} * * 1-5`;

  if (frequency === "weekly") {
    const weekday = Number(input.weekday ?? 1);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error("weekday must be 0 (Sunday) through 6 (Saturday)");
    }
    return `${minute} ${hour} * * ${weekday}`;
  }

  if (frequency === "monthly") {
    const day = Number(input.day_of_month ?? 1);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      // 29-31 silently skips short months, which reads as a broken schedule.
      throw new Error("day_of_month must be between 1 and 28 so every month fires");
    }
    return `${minute} ${hour} ${day} * *`;
  }

  throw new Error(`Unknown frequency "${input.frequency}" — use one of ${FREQUENCIES.join(", ")}`);
}

/** Throws unless `expression` is a 5-field cron whose every field is in range. */
export function validateCronExpression(expression) {
  const fields = String(expression || "")
    .trim()
    .split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("A cron expression needs exactly 5 fields: minute hour day-of-month month day-of-week");
  }

  fields.forEach((field, index) => {
    const { name, min, max } = FIELD_RANGES[index];
    for (const part of field.split(",")) {
      const [range, step] = part.split("/");
      if (step !== undefined && !/^\d+$/.test(step)) {
        throw new Error(`Invalid step in the ${name} field: "${part}"`);
      }
      if (range === "*") continue;
      const bounds = range.split("-");
      if (bounds.length > 2) throw new Error(`Invalid range in the ${name} field: "${part}"`);
      for (const bound of bounds) {
        if (!/^\d+$/.test(bound)) throw new Error(`Invalid ${name} value: "${part}"`);
        const value = Number(bound);
        if (value < min || value > max) {
          throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
        }
      }
    }
  });

  return String(expression).trim().split(/\s+/).join(" ");
}

/** Expands one cron field into the set of values it matches. */
function fieldValues(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let from = min;
    let to = max;
    if (range !== "*") {
      const bounds = range.split("-").map(Number);
      from = bounds[0];
      to = bounds.length > 1 ? bounds[1] : bounds[0];
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/**
 * The wall-clock parts of `date` as read in `timeZone`. Intl is the only thing
 * in the platform that knows a zone's DST history, so the whole calculation is
 * done in wall-clock terms and converted back at the end.
 */
function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: weekdays[get("weekday")] ?? 0,
  };
}

/** The UTC instant at which `timeZone`'s clock reads the given wall time. */
function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes: the first offset can be the pre-transition one on a DST boundary.
  let stamp = guess;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = zonedParts(new Date(stamp), timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    const drift = guess - seenAsUtc;
    if (drift === 0) break;
    stamp += drift;
  }
  return new Date(stamp);
}

/**
 * The next `count` fire times of `expression` in `timeZone`, as Date objects.
 *
 * Walks day by day in the zone's own calendar rather than minute by minute, so
 * a "1st of the month" schedule costs the same as an hourly one. Day-of-month
 * and day-of-week follow cron's rule: when both are restricted, either match
 * fires the job.
 */
export function nextCronRuns(expression, timeZone = "UTC", count = 3, from = new Date()) {
  const fields = validateCronExpression(expression).split(" ");
  const minutes = fieldValues(fields[0], 0, 59);
  const hours = fieldValues(fields[1], 0, 23);
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";
  const days = fieldValues(fields[2], 1, 31);
  const months = fieldValues(fields[3], 1, 12);
  // Cron treats 7 and 0 as Sunday.
  const weekdays = new Set([...fieldValues(fields[4], 0, 7)].map((value) => value % 7));

  const sortedHours = [...hours].sort((a, b) => a - b);
  const sortedMinutes = [...minutes].sort((a, b) => a - b);

  const runs = [];
  const start = zonedParts(from, timeZone);
  let cursor = { year: start.year, month: start.month, day: start.day };

  for (let dayOffset = 0; dayOffset < 400 && runs.length < count; dayOffset += 1) {
    if (dayOffset > 0) {
      const next = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day + 1));
      cursor = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    }

    if (!months.has(cursor.month)) continue;
    const weekday = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day)).getUTCDay();
    const dayMatches =
      domRestricted && dowRestricted
        ? days.has(cursor.day) || weekdays.has(weekday)
        : (!domRestricted || days.has(cursor.day)) && (!dowRestricted || weekdays.has(weekday));
    if (!dayMatches) continue;

    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const at = zonedTimeToUtc({ ...cursor, hour, minute }, timeZone);
        if (at.getTime() <= from.getTime()) continue;
        runs.push(at);
        if (runs.length >= count) return runs;
      }
    }
  }

  return runs;
}

/** Plain-language summary, so a confirmation can be read back to the user. */
export function describeCron(expression, timeZone = "UTC") {
  const fields = String(expression || "")
    .trim()
    .split(/\s+/);
  if (fields.length !== 5) return expression;
  const [minute, hour, dom, month, dow] = fields;
  const at = /^\d+$/.test(hour) && /^\d+$/.test(minute) ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : null;
  const zone = timeZone ? ` ${timeZone}` : "";

  if (at && dom === "*" && month === "*" && dow === "*") return `every day at ${at}${zone}`;
  if (at && dom === "*" && month === "*" && dow === "1-5") return `every weekday at ${at}${zone}`;
  if (at && dom === "*" && month === "*" && /^\d$/.test(dow)) {
    return `every ${WEEKDAY_NAMES[Number(dow) % 7]} at ${at}${zone}`;
  }
  if (at && /^\d+$/.test(dom) && month === "*" && dow === "*") {
    return `on day ${dom} of every month at ${at}${zone}`;
  }
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `every hour at minute ${minute}`;
  }
  return `cron ${expression}${zone}`;
}
