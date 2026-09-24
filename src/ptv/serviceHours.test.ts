import { describe, expect, it } from 'vitest';
import { canonicalServiceHours, expandOpeningTimes } from './serviceHours.js';

describe('expandOpeningTimes', () => {
  it('writes out weekday ranges, including ones that wrap past Sunday', () => {
    expect(
      expandOpeningTimes({
        type: 'DaysOfTheWeek',
        openingTimes: [{ dayFrom: 'Saturday', dayTo: 'Monday', from: '10:00', to: '12:00' }],
      }).map((t) => t.dayFrom),
    ).toEqual(['Saturday', 'Sunday', 'Monday']);
  });

  it('keeps dayTo on over-midnight hours', () => {
    const times = [
      { dayFrom: 'Friday' as const, dayTo: 'Saturday' as const, from: '22:00', to: '02:00' },
    ];
    expect(expandOpeningTimes({ type: 'OverMidnight', openingTimes: times })).toEqual(times);
  });
});

describe('canonicalServiceHours', () => {
  it('equates a proposed range with the per-day hours PTV returns', () => {
    const proposed = canonicalServiceHours([
      {
        type: 'DaysOfTheWeek',
        openingTimes: [{ dayFrom: 'Monday', dayTo: 'Tuesday', from: '09:00', to: '15:00' }],
      },
    ]);
    const readBack = canonicalServiceHours([
      {
        type: 'DaysOfTheWeek',
        validForNow: true,
        isClosed: false,
        openingTimes: [
          { dayFrom: 'Tuesday', from: '09:00', to: '15:00' },
          { dayFrom: 'Monday', from: '09:00', to: '15:00' },
        ],
      },
    ]);
    expect(readBack).toEqual(proposed);
  });
});
