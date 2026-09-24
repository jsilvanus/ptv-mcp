import type { OpeningTime, ServiceHour, Weekday } from './domain.js';

export const WEEKDAYS: Weekday[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/**
 * An hour's opening times with day ranges written out. On anything but an
 * OverMidnight hour, `dayFrom`–`dayTo` is shorthand for the same times on
 * each day of the range (Monday–Friday 09:00–15:00); PTV stores one entry
 * per day and would otherwise read `dayTo` as the end day of one long span.
 */
export function expandOpeningTimes(hour: ServiceHour): OpeningTime[] {
  const times = hour.openingTimes ?? [];
  if (hour.type === 'OverMidnight') return times;
  return times.flatMap((time) => {
    if (!time.dayTo || time.dayTo === time.dayFrom) {
      return [{ dayFrom: time.dayFrom, from: time.from, to: time.to }];
    }
    const start = WEEKDAYS.indexOf(time.dayFrom);
    const end = WEEKDAYS.indexOf(time.dayTo);
    const days =
      end >= start
        ? WEEKDAYS.slice(start, end + 1)
        : [...WEEKDAYS.slice(start), ...WEEKDAYS.slice(0, end + 1)];
    return days.map((day) => ({ dayFrom: day, from: time.from, to: time.to }));
  });
}

/**
 * A comparable form of service hours: ranges written out, times sorted, and
 * the defaults PTV fills in on read (validForNow without dates, false flags)
 * dropped, so the same hours read back from PTV equal what was proposed.
 */
export function canonicalServiceHours(hours: ServiceHour[] | undefined): unknown[] {
  return (hours ?? []).map((hour) => {
    const times = expandOpeningTimes(hour)
      .map((time) => ({ ...time }))
      .sort(
        (a, b) =>
          WEEKDAYS.indexOf(a.dayFrom) - WEEKDAYS.indexOf(b.dayFrom) || a.from.localeCompare(b.from),
      );
    return {
      type: hour.type,
      ...(hour.validFrom ? { validFrom: hour.validFrom } : {}),
      ...(hour.validTo ? { validTo: hour.validTo } : {}),
      ...(hour.isClosed ? { isClosed: true } : {}),
      ...(hour.isAlwaysOpen ? { isAlwaysOpen: true } : {}),
      ...(hour.isReservation ? { isReservation: true } : {}),
      ...(hour.additionalInformation ? { additionalInformation: hour.additionalInformation } : {}),
      openingTimes: times,
    };
  });
}
