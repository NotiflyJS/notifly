/**
 * AWS "Exponential Backoff and Jitter" — Full Jitter variant:
 *
 *   delay = random(0, min(cap, base * 2^attempt))
 *
 * https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
 *
 * Full Jitter (rather than "equal jitter" or plain exponential) is what keeps a
 * fleet of reconnecting clients from re-stampeding a server in lockstep waves:
 * the whole `[0, ceiling]` window is used, so retries spread out evenly instead
 * of clustering at the top of each backoff step.
 *
 * `attempt` is 0-based — attempt 0 is the first retry after a failure.
 * `base * 2 ** attempt` overflows to `Infinity` for absurd attempt counts;
 * `Math.min` with the cap handles that without a special case.
 */
export function fullJitterDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** What a closed socket should do next. */
export type ReconnectPlan =
  /** Intentional close — stay down. */
  | 'none'
  /** Come back now, jittered over the base window only (no exponential ramp). */
  | 'immediate-jitter'
  /** Transient failure — exponential backoff with full jitter. */
  | 'backoff';

/**
 * Decides what a close means, from the only two facts a standard WebSocket
 * client actually has: whether the connection ever opened, and the close code.
 *
 * ⚠️ The `wasOpen === false` branch is a hard limitation of the WebSocket
 * platform API, not an oversight. Per the WHATWG spec, a *failed handshake*
 * gives the client no access to the HTTP response — a `401`, `403` or `429`
 * from the server's upgrade handler is delivered to JavaScript as the exact
 * same bare `close` event (code `1006`, `wasClean: false`) as an unreachable
 * host or a dropped network. Browsers deliberately withhold the status code
 * to avoid leaking cross-origin response details, and Node's native
 * `WebSocket` behaves the same way. There is therefore no spec-compliant way
 * to treat `401`/`403` as terminal and `429` as retryable here: the client
 * cannot tell them apart from each other, or from a flaky Wi-Fi connection.
 * Backing off (rather than giving up) is the honest, safe default — giving up
 * on what was really a network blip would strand a legitimate user offline.
 * Applications that need auth-aware behavior should detect an invalid session
 * over HTTP (where the status code is visible) and call `close()` themselves.
 *
 * Once a connection *has* opened, a close carries a real WebSocket close
 * frame, and the code is meaningful — so that branch implements the precise
 * policy.
 */
export function planReconnect(wasOpen: boolean, code: number): ReconnectPlan {
  if (!wasOpen) {
    return 'backoff';
  }

  // 1000 Normal Closure, and 1005 "No Status Received" — what a bare
  // `ws.close()` on the server produces, i.e. `netifly.disconnect(userId)`
  // (verified against a real @netiflyjs/core server). Both mean somebody
  // deliberately ended this connection; reconnecting would fight them.
  if (code === 1000 || code === 1005) {
    return 'none';
  }

  // 1012 Service Restart — what @netiflyjs/core's graceful `close()` sends
  // (NOT-19). The server is coming back, so there's no reason to ramp; the
  // only thing to avoid is every client in the fleet reconnecting on the same
  // millisecond, which a single jitter over the base window handles.
  if (code === 1012) {
    return 'immediate-jitter';
  }

  // Everything else — 1001, 1006 mid-connection, 1011, 1013, app codes — is
  // treated as a transient fault.
  return 'backoff';
}
