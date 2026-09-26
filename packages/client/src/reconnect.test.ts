import { fullJitterDelay, planReconnect } from './reconnect';

describe('fullJitterDelay', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockRandom(value: number): void {
    jest.spyOn(Math, 'random').mockReturnValue(value);
  }

  it('is random(0, base * 2^attempt) while under the cap', () => {
    mockRandom(1);
    expect(fullJitterDelay(0, 500, 30_000)).toBe(500);
    expect(fullJitterDelay(1, 500, 30_000)).toBe(1000);
    expect(fullJitterDelay(2, 500, 30_000)).toBe(2000);
    expect(fullJitterDelay(3, 500, 30_000)).toBe(4000);
    expect(fullJitterDelay(4, 500, 30_000)).toBe(8000);
  });

  it('scales the jittered delay by the random draw', () => {
    mockRandom(0.5);
    expect(fullJitterDelay(0, 500, 30_000)).toBe(250);
    expect(fullJitterDelay(3, 500, 30_000)).toBe(2000);

    mockRandom(0.25);
    expect(fullJitterDelay(2, 1000, 30_000)).toBe(1000);
  });

  it('returns 0 when the random draw is 0 (full jitter allows an immediate retry)', () => {
    mockRandom(0);
    expect(fullJitterDelay(0, 500, 30_000)).toBe(0);
    expect(fullJitterDelay(10, 500, 30_000)).toBe(0);
  });

  it('clamps the exponential ceiling to the configured cap', () => {
    mockRandom(1);
    // 500 * 2^6 = 32_000 > cap
    expect(fullJitterDelay(6, 500, 30_000)).toBe(30_000);
    expect(fullJitterDelay(20, 500, 30_000)).toBe(30_000);
    // Even an attempt count large enough to overflow to Infinity stays capped.
    expect(fullJitterDelay(2000, 500, 30_000)).toBe(30_000);

    mockRandom(0.5);
    expect(fullJitterDelay(20, 500, 30_000)).toBe(15_000);
  });

  it('never exceeds min(cap, base * 2^attempt) for any random draw', () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      for (let i = 0; i < 50; i += 1) {
        const delay = fullJitterDelay(attempt, 500, 30_000);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(Math.min(30_000, 500 * 2 ** attempt));
      }
    }
  });
});

describe('planReconnect', () => {
  describe('on a connection that never opened (failed handshake)', () => {
    // Per the WHATWG WebSocket spec a failed handshake is indistinguishable
    // from a network failure — a 401/403/429 upgrade rejection surfaces as a
    // bare 1006 with no status, exactly like an unreachable host — so every
    // never-opened failure has to take the same conservative path.
    it.each([1006, 1000, 1005, 1012, 1011, 1015, 4000])(
      'backs off exponentially regardless of the reported code (%i)',
      (code) => {
        expect(planReconnect(false, code)).toBe('backoff');
      }
    );
  });

  describe('on a connection that was open (a real close frame)', () => {
    it('does not reconnect after a normal closure (1000)', () => {
      expect(planReconnect(true, 1000)).toBe('none');
    });

    it('does not reconnect after a clean close with no status (1005)', () => {
      // This is what `netifly.disconnect(userId)` produces client-side: the
      // server calls ws.close() with no code, so the close frame carries no
      // status and the client reports 1005 / wasClean: true (verified against
      // a real @netiflyjs/core server in client.test.ts).
      expect(planReconnect(true, 1005)).toBe('none');
    });

    it('reconnects immediately (single jitter, no ramp) after a service restart (1012)', () => {
      expect(planReconnect(true, 1012)).toBe('immediate-jitter');
    });

    it.each([1001, 1006, 1009, 1011, 1013, 4000])(
      'treats every other close code as transient and backs off (%i)',
      (code) => {
        expect(planReconnect(true, code)).toBe('backoff');
      }
    );
  });
});
