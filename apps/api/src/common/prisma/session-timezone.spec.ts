import { sessionTimezoneProblem } from './session-timezone';

describe('sessionTimezoneProblem', () => {
  it.each(['UTC', 'Etc/UTC', 'GMT'])('accepts %s', (timezone) => {
    expect(sessionTimezoneProblem({ timezone, winterOffsetSeconds: 0, summerOffsetSeconds: 0 })).toBeNull();
  });

  it('reports a zone with an offset, naming it', () => {
    const problem = sessionTimezoneProblem({
      timezone: 'Asia/Kolkata',
      winterOffsetSeconds: 19_800,
      summerOffsetSeconds: 19_800,
    });
    expect(problem).toContain('Asia/Kolkata');
    expect(problem).toContain('UTC');
  });

  it('reports a zone that is UTC+0 only part of the year', () => {
    expect(
      sessionTimezoneProblem({ timezone: 'Europe/London', winterOffsetSeconds: 0, summerOffsetSeconds: 3_600 }),
    ).not.toBeNull();
  });
});
