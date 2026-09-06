import { beforeAll, describe, expect, it } from 'vitest';

let schedulerForm: typeof import('@/components/scheduler/TaskFormModal');

beforeAll(async () => {
  process.env.TZ = 'America/Sao_Paulo';
  schedulerForm = await import('@/components/scheduler/TaskFormModal');
});

describe('TaskFormModal cron timezone conversion', () => {
  it('stores a local 08:00 schedule as an equivalent UTC cron expression', () => {
    expect(schedulerForm.buildUtcCronFromLocalState('08:00', [1, 2, 3, 4, 5])).toBe('0 11 * * 1,2,3,4,5');
  });

  it('renders stored UTC cron expressions back as local time for editing', () => {
    expect(schedulerForm.parseCronToState('0 11 * * 1,2,3,4,5')).toEqual({
      time: '08:00',
      days: [1, 2, 3, 4, 5],
    });
  });

  it('shifts day-of-week when local evening crosses into the next UTC day', () => {
    expect(schedulerForm.buildUtcCronFromLocalState('23:00', [1])).toBe('0 2 * * 2');
    expect(schedulerForm.parseCronToState('0 2 * * 2')).toEqual({
      time: '23:00',
      days: [1],
    });
  });
});
