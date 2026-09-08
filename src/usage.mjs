/**
 * Usage and savings accounting.
 *
 * The pitch for a local-first router is that you stop paying per token, and a
 * pitch is worth more when it comes with a number. Every request served
 * locally records what the same request would have cost on the cheapest
 * configured cloud backend.
 *
 * That comparison is deliberately conservative. Charging the saving against
 * the most expensive backend you happen to have configured would inflate the
 * figure, and a savings counter nobody believes is worse than none.
 */

import { estimateCost } from './router.mjs';

export class UsageLedger {
  constructor() {
    this.reset();
  }

  reset() {
    this.startedAt = new Date().toISOString();
    this.requests = 0;
    this.byBackend = {};
    this.spent = 0;
    this.saved = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
  }

  /**
   * @param {object} entry
   * @param {object} entry.backend      the backend that served it
   * @param {number} entry.promptTokens
   * @param {number} entry.completionTokens
   * @param {Array}  entry.allBackends  used to price the counterfactual
   * @param {number} entry.latencyMs
   */
  record({ backend, promptTokens = 0, completionTokens = 0, allBackends = [], latencyMs = 0 }) {
    this.requests += 1;
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;

    const cost = estimateCost(backend, promptTokens, completionTokens);
    this.spent += cost;

    const stats = (this.byBackend[backend.name] ??= {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      totalLatencyMs: 0,
      local: Boolean(backend.local),
    });

    stats.requests += 1;
    stats.promptTokens += promptTokens;
    stats.completionTokens += completionTokens;
    stats.cost += cost;
    stats.totalLatencyMs += latencyMs;

    if (backend.local) {
      // Priced against the cheapest cloud alternative rather than the most
      // expensive, so the number is a floor and not marketing.
      const cloudCosts = allBackends
        .filter((b) => !b.local && b.pricing)
        .map((b) => estimateCost(b, promptTokens, completionTokens));

      if (cloudCosts.length) this.saved += Math.min(...cloudCosts);
    }
  }

  summary() {
    const backends = Object.entries(this.byBackend).map(([name, s]) => ({
      name,
      local: s.local,
      requests: s.requests,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      cost: Number(s.cost.toFixed(6)),
      averageLatencyMs: s.requests ? Math.round(s.totalLatencyMs / s.requests) : 0,
    }));

    const localRequests = backends.filter((b) => b.local).reduce((n, b) => n + b.requests, 0);

    return {
      startedAt: this.startedAt,
      requests: this.requests,
      localRequests,
      remoteRequests: this.requests - localRequests,
      localShare: this.requests ? Number((localRequests / this.requests).toFixed(3)) : 0,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      spent: Number(this.spent.toFixed(6)),
      saved: Number(this.saved.toFixed(6)),
      backends,
    };
  }
}

/**
 * Pull usage out of a provider response. Field names differ, and a missing
 * count is estimated rather than dropped, because a zero would quietly
 * understate both spend and savings.
 */
export function usageFrom(body, fallbackPromptTokens = 0) {
  const usage = body?.usage ?? {};

  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? fallbackPromptTokens;
  const completion =
    usage.completion_tokens ??
    usage.output_tokens ??
    estimateCompletionTokens(body);

  return { promptTokens: prompt, completionTokens: completion };
}

function estimateCompletionTokens(body) {
  const text = body?.choices?.map((c) => c.message?.content ?? c.delta?.content ?? '').join('') ?? '';
  return Math.ceil(text.length / 4);
}
