/**
 * Backend availability.
 *
 * Local model servers get started and stopped constantly, so a router that
 * assumes a backend is up until a request fails will hang every first request
 * after you close LM Studio. Health is probed in the background and the result
 * feeds routing directly.
 *
 * A backend is not marked down on a single failure. One refused connection
 * during a model reload should not divert a session to a paid API.
 */

import { apiKeyFor } from './config.mjs';

const FAILURES_BEFORE_DOWN = 2;

export class HealthMonitor {
  constructor(backends, { timeoutMs = 3000, env = process.env, fetchImpl = fetch } = {}) {
    this.backends = backends;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.fetch = fetchImpl;
    this.state = {};
    this.timer = null;

    for (const backend of backends) {
      // Unknown rather than healthy. Routing treats unknown as usable, so the
      // first request is not blocked waiting for a probe, but a backend that
      // has never answered will be demoted as soon as one completes.
      this.state[backend.name] = { healthy: null, latencyMs: null, failures: 0, checkedAt: null, error: null };
    }
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async checkOne(backend) {
    const entry = this.state[backend.name];
    const url = backend.baseUrl.replace(/\/$/, '') + (backend.healthPath ?? '/models');

    const headers = { accept: 'application/json' };
    const key = apiKeyFor(backend, this.env);
    if (key) headers.authorization = `Bearer ${key}`;

    const started = Date.now();

    try {
      const response = await this.fetch(url, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // Any answer at all means something is listening and speaking HTTP. A
      // 401 from a cloud provider still proves reachability, and the request
      // itself will report the auth problem more usefully than a health probe.
      if (response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }

      entry.healthy = true;
      entry.failures = 0;
      entry.latencyMs = Date.now() - started;
      entry.error = null;
    } catch (error) {
      entry.failures += 1;
      entry.error = error.message;

      // One refused connection during a model reload should not divert the
      // session to a paid API.
      if (entry.failures >= FAILURES_BEFORE_DOWN) {
        entry.healthy = false;
        entry.latencyMs = null;
      }
    }

    entry.checkedAt = new Date().toISOString();
    return entry;
  }

  async checkAll() {
    await Promise.all(this.backends.map((b) => this.checkOne(b)));
    return this.snapshot();
  }

  start(intervalMs = 30000) {
    this.stop();
    this.checkAll().catch(() => {});
    this.timer = setInterval(() => {
      this.checkAll().catch(() => {});
    }, intervalMs);
    // Do not hold the process open just to run health probes.
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Called when a real request fails, so a backend that passes a shallow
   * health probe but cannot actually serve a completion still gets demoted.
   */
  recordFailure(name, error) {
    const entry = this.state[name];
    if (!entry) return;

    entry.failures += 1;
    entry.error = String(error?.message ?? error);
    if (entry.failures >= FAILURES_BEFORE_DOWN) entry.healthy = false;
  }

  recordSuccess(name, latencyMs) {
    const entry = this.state[name];
    if (!entry) return;

    entry.healthy = true;
    entry.failures = 0;
    entry.latencyMs = latencyMs;
    entry.error = null;
  }
}
