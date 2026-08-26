import { describe, expect, it } from 'vitest';

import { planRemindersFor } from '@/lib/reminders';
import type { Race } from '@/lib/races';

/** A race with just the fields planRemindersFor reads. */
const race = (over: Partial<Race> = {}): Race =>
  ({
    id: 'test-race',
    name: 'Medio Maratón Montemorelos',
    date: '2026-09-20',
    time: '07:00',
    city: 'Montemorelos',
    state: 'Nuevo León',
    venue: 'Plaza Principal',
    status: null,
    ...over,
  }) as Race;

/** Wall-clock reading of an instant in a zone, via the real IANA database. */
function readBack(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(instant)
    .replace(', ', ' ');
}

// "Now" well before the race, so nothing is filtered for being in the past.
const NOW = new Date('2026-09-01T12:00:00Z');
const TODAY = '2026-09-01';

describe('planRemindersFor', () => {
  it('plans two reminders: 3 days before, and the evening before', () => {
    const plans = planRemindersFor(race(), TODAY, NOW, 'es');
    expect(plans).toHaveLength(2);
    expect(readBack(plans[0].at, 'America/Mexico_City')).toBe('2026-09-17 09:00');
    expect(readBack(plans[1].at, 'America/Mexico_City')).toBe('2026-09-19 18:00');
  });

  // The whole reason instantInZone exists: reminders fire at 9am where the
  // RACE is, not where the phone happens to be.
  it('resolves times in the race’s own zone, not the device’s', () => {
    const cancun = planRemindersFor(
      race({ state: 'Quintana Roo', city: 'Cancún' }),
      TODAY,
      NOW,
      'es',
    );
    expect(readBack(cancun[0].at, 'America/Cancun')).toBe('2026-09-17 09:00');

    const tijuana = planRemindersFor(
      race({ state: 'Baja California', city: 'Tijuana' }),
      TODAY,
      NOW,
      'es',
    );
    expect(readBack(tijuana[0].at, 'America/Tijuana')).toBe('2026-09-17 09:00');

    // Same wall-clock time, different instants — proving the zone is applied.
    expect(cancun[0].at.getTime()).not.toBe(tijuana[0].at.getTime());
  });

  it('crosses a month boundary when subtracting days', () => {
    const plans = planRemindersFor(race({ date: '2026-10-02' }), TODAY, NOW, 'es');
    expect(readBack(plans[0].at, 'America/Mexico_City')).toBe('2026-09-29 09:00');
    expect(readBack(plans[1].at, 'America/Mexico_City')).toBe('2026-10-01 18:00');
  });

  it('drops reminders whose moment has already passed', () => {
    // Race is two days out, so the 3-days-before reminder is in the past and
    // must not be scheduled — only the evening-before survives.
    const now = new Date('2026-09-18T12:00:00Z');
    const plans = planRemindersFor(race(), '2026-09-18', now, 'es');
    expect(plans).toHaveLength(1);
    expect(readBack(plans[0].at, 'America/Mexico_City')).toBe('2026-09-19 18:00');
  });

  it('plans nothing for an undated, past, or canceled race', () => {
    expect(planRemindersFor(race({ date: null }), TODAY, NOW, 'es')).toEqual([]);
    expect(planRemindersFor(race({ date: '2026-08-01' }), TODAY, NOW, 'es')).toEqual([]);
    expect(planRemindersFor(race({ status: 'canceled' }), TODAY, NOW, 'es')).toEqual([]);
  });

  it('localizes the content, since the OS fires a fixed string', () => {
    const es = planRemindersFor(race(), TODAY, NOW, 'es');
    const en = planRemindersFor(race(), TODAY, NOW, 'en');
    expect(es[0].title).toContain('Faltan 3 días');
    expect(en[0].title).toContain('3 days to go');
    expect(es[1].title).toContain('Mañana');
    expect(en[1].title).toContain('Tomorrow');
  });

  it('includes the start time only when the race actually has one', () => {
    const withTime = planRemindersFor(race(), TODAY, NOW, 'es');
    expect(withTime[1].body).toContain('07:00');
    // 107 of 195 races have no time; it must be omitted, never invented.
    const without = planRemindersFor(race({ time: null }), TODAY, NOW, 'es');
    expect(without[1].body).not.toMatch(/\d{2}:\d{2}/);
    expect(without[1].body).toContain('Montemorelos');
  });

  it('tags every reminder with its race id, for cancellation', () => {
    for (const plan of planRemindersFor(race(), TODAY, NOW, 'es')) {
      expect(plan.raceId).toBe('test-race');
    }
  });
});
