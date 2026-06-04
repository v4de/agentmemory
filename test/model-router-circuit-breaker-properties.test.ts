import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { CircuitBreaker } from "../src/providers/circuit-breaker.js";

describe("Feature: model-router-integration, Property 8: Circuit breaker state transitions", () => {
  /**
   * **Validates: Requirements 2.6**
   *
   * For any sequence of N consecutive failures (N ≥ 3) occurring within a
   * 60-second window, the circuit breaker SHALL transition to the "open" state
   * and reject subsequent calls. After 30 seconds in the "open" state, it SHALL
   * transition to "half-open" and allow one trial call.
   */

  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  let currentTime: number;

  beforeEach(() => {
    currentTime = 1000000;
    dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("≥3 failures within 60s window transitions to open state", () => {
    fc.assert(
      fc.property(
        // Generate failure count ≥ 3
        fc.integer({ min: 3, max: 20 }),
        // Generate timestamps within 60s window (offsets from start, all < 60000ms)
        fc.integer({ min: 0, max: 59999 }),
        (failureCount, maxSpreadMs) => {
          vi.restoreAllMocks();
          currentTime = 1000000;
          dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

          const breaker = new CircuitBreaker();

          // Generate evenly-spaced timestamps within the window
          const timeStep = failureCount > 1 ? Math.floor(maxSpreadMs / (failureCount - 1)) : 0;

          for (let i = 0; i < failureCount; i++) {
            currentTime = 1000000 + i * timeStep;
            breaker.recordFailure();
          }

          // After ≥3 failures within 60s, circuit should be open
          const state = breaker.getState();
          expect(state.state).toBe("open");

          // Subsequent calls should be rejected (isAllowed = false)
          expect(breaker.isAllowed).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("fewer than 3 failures within 60s keeps circuit closed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 }),
        (failureCount) => {
          vi.restoreAllMocks();
          currentTime = 1000000;
          dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

          const breaker = new CircuitBreaker();

          for (let i = 0; i < failureCount; i++) {
            currentTime = 1000000 + i * 1000;
            breaker.recordFailure();
          }

          const state = breaker.getState();
          expect(state.state).toBe("closed");
          expect(breaker.isAllowed).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("failures spread beyond 60s window do not open circuit (counter resets)", () => {
    fc.assert(
      fc.property(
        // Generate gap that exceeds 60s from the LAST failure (since window check is against lastFailureAt)
        fc.integer({ min: 60001, max: 120000 }),
        (gapFromLastMs) => {
          vi.restoreAllMocks();
          currentTime = 1000000;
          dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

          const breaker = new CircuitBreaker();

          // Record 2 failures close together
          breaker.recordFailure();
          currentTime = 1000000 + 1000;
          breaker.recordFailure();

          const lastFailureTime = currentTime;

          // Jump beyond 60s from the LAST failure so the window resets
          currentTime = lastFailureTime + gapFromLastMs;

          // Record 1 more failure — window has reset, so counter starts at 1
          breaker.recordFailure();

          const state = breaker.getState();
          // Should still be closed since the window reset means only 1 recent failure
          expect(state.state).toBe("closed");
          expect(breaker.isAllowed).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("after 30s in open state, transitions to half-open and allows one trial", () => {
    fc.assert(
      fc.property(
        // Recovery time: ≥30s past the open event
        fc.integer({ min: 30000, max: 120000 }),
        (recoveryElapsedMs) => {
          vi.restoreAllMocks();
          currentTime = 1000000;
          dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

          const breaker = new CircuitBreaker();

          // Force open: 3 failures in quick succession
          breaker.recordFailure();
          currentTime = 1000000 + 100;
          breaker.recordFailure();
          currentTime = 1000000 + 200;
          breaker.recordFailure();

          expect(breaker.getState().state).toBe("open");
          const openedAt = currentTime;

          // Advance past recovery timeout
          currentTime = openedAt + recoveryElapsedMs;

          // isAllowed should now transition to half-open and allow trial
          expect(breaker.isAllowed).toBe(true);
          expect(breaker.getState().state).toBe("half-open");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("before 30s in open state, calls are still rejected", () => {
    fc.assert(
      fc.property(
        // Time elapsed < 30s
        fc.integer({ min: 0, max: 29999 }),
        (elapsedMs) => {
          vi.restoreAllMocks();
          currentTime = 1000000;
          dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

          const breaker = new CircuitBreaker();

          // Force open
          breaker.recordFailure();
          currentTime = 1000000 + 100;
          breaker.recordFailure();
          currentTime = 1000000 + 200;
          breaker.recordFailure();

          expect(breaker.getState().state).toBe("open");
          const openedAt = currentTime;

          // Advance but not past 30s
          currentTime = openedAt + elapsedMs;

          expect(breaker.isAllowed).toBe(false);
          expect(breaker.getState().state).toBe("open");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("success in half-open state closes the circuit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 30000, max: 120000 }),
        (recoveryElapsedMs) => {
          vi.restoreAllMocks();
          currentTime = 1000000;
          dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

          const breaker = new CircuitBreaker();

          // Force open
          breaker.recordFailure();
          currentTime = 1000000 + 100;
          breaker.recordFailure();
          currentTime = 1000000 + 200;
          breaker.recordFailure();

          const openedAt = currentTime;

          // Advance past recovery timeout to enter half-open
          currentTime = openedAt + recoveryElapsedMs;
          expect(breaker.isAllowed).toBe(true);
          expect(breaker.getState().state).toBe("half-open");

          // Record success → circuit should close
          breaker.recordSuccess();

          expect(breaker.getState().state).toBe("closed");
          expect(breaker.getState().failures).toBe(0);
          expect(breaker.isAllowed).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("failure in half-open state re-opens the circuit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 30000, max: 120000 }),
        (recoveryElapsedMs) => {
          vi.restoreAllMocks();
          currentTime = 1000000;
          dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

          const breaker = new CircuitBreaker();

          // Force open
          breaker.recordFailure();
          currentTime = 1000000 + 100;
          breaker.recordFailure();
          currentTime = 1000000 + 200;
          breaker.recordFailure();

          const openedAt = currentTime;

          // Advance past recovery timeout to enter half-open
          currentTime = openedAt + recoveryElapsedMs;
          expect(breaker.isAllowed).toBe(true);
          expect(breaker.getState().state).toBe("half-open");

          // Record failure → circuit should re-open
          breaker.recordFailure();

          expect(breaker.getState().state).toBe("open");
          expect(breaker.isAllowed).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("random sequences of success/failure produce valid state transitions", () => {
    // Action type: success, failure, or time-advance
    const actionArb = fc.oneof(
      fc.constant({ type: "success" as const }),
      fc.constant({ type: "failure" as const }),
      fc.integer({ min: 1, max: 90000 }).map((ms) => ({ type: "advance" as const, ms })),
    );

    const actionSequenceArb = fc.array(actionArb, { minLength: 5, maxLength: 50 });

    fc.assert(
      fc.property(actionSequenceArb, (actions) => {
        vi.restoreAllMocks();
        currentTime = 1000000;
        dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

        const breaker = new CircuitBreaker();

        for (const action of actions) {
          if (action.type === "advance") {
            currentTime += action.ms;
          } else if (action.type === "success") {
            if (breaker.isAllowed) {
              breaker.recordSuccess();
            }
          } else {
            if (breaker.isAllowed) {
              breaker.recordFailure();
            }
          }

          // Invariant: state is always one of the three valid states
          const state = breaker.getState();
          expect(["closed", "open", "half-open"]).toContain(state.state);

          // Invariant: failures count is non-negative
          expect(state.failures).toBeGreaterThanOrEqual(0);

          // Invariant: if state is closed, isAllowed is true
          if (state.state === "closed") {
            expect(breaker.isAllowed).toBe(true);
          }

          // Invariant: if state is open and not enough time has passed, isAllowed is false
          if (state.state === "open" && state.openedAt !== null) {
            if (currentTime - state.openedAt < 30000) {
              expect(breaker.isAllowed).toBe(false);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
