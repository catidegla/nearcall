/**
 * Decides which backend serves a request.
 *
 * Pure: no network, no clock, no filesystem. Everything it needs arrives as
 * arguments, which is what makes the routing table testable without standing
 * up four model servers.
 *
 * The design goal is that a routing decision is always explainable. A router
 * that silently sends your request somewhere unexpected, and bills you for it,
 * is worse than no router, so every decision carries the reasons that produced
 * it and `nearcall route` prints them.
 */

/** Roughly four characters per token. Good enough to pick a route. */
export function estimateTokens(messages = []) {
  const text = messages
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((part) => (typeof part.text === 'string' ? part.text : '')).join(' ');
      }
      return '';
    })
    .join(' ');

  return Math.ceil(text.length / 4);
}

/** Requests carrying images need a backend that can actually see them. */
export function needsVision(messages = []) {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((part) => part.type === 'image_url' || part.type === 'image'),
  );
}

export function needsTools(body = {}) {
  return Boolean((body.tools && body.tools.length) || body.functions?.length);
}

/**
 * Reasons a candidate was ruled out, in the order they are checked. Ordering
 * matters only for the explanation, not the outcome.
 */
const REJECTIONS = {
  unhealthy: (b) => `${b.name} is not answering health checks`,
  disabled: (b) => `${b.name} is disabled in config`,
  noModel: (b, ctx) => `${b.name} does not serve ${ctx.model}`,
  contextTooSmall: (b, ctx) =>
    `${b.name} has a ${b.contextWindow} token window and this request needs about ${ctx.tokens}`,
  noTools: (b) => `${b.name} does not support tool calling`,
  noVision: (b) => `${b.name} does not support images`,
  overBudget: (b, ctx) => `${b.name} would cost more than the ${ctx.maxCostPerRequest} budget`,
};

/**
 * @param {object} request  { model, messages, tools, stream }
 * @param {Array}  backends configured backends, in preference order
 * @param {object} options  { health, maxCostPerRequest, forceBackend, preferLocal }
 */
export function route(request, backends, options = {}) {
  const {
    health = {},
    maxCostPerRequest = null,
    forceBackend = null,
    preferLocal = true,
  } = options;

  const ctx = {
    model: request.model ?? 'default',
    tokens: estimateTokens(request.messages),
    tools: needsTools(request),
    vision: needsVision(request.messages),
    maxCostPerRequest,
  };

  const trace = [];

  // An explicit override skips every rule, including health, because the
  // caller asking for a specific backend usually knows something we do not.
  if (forceBackend) {
    const forced = backends.find((b) => b.name === forceBackend);
    if (!forced) {
      return { backend: null, ctx, trace, error: `No backend named "${forceBackend}"` };
    }
    trace.push({ backend: forced.name, decision: 'forced', detail: 'requested explicitly' });
    return { backend: forced, model: resolveModel(forced, ctx.model), ctx, trace, forced: true };
  }

  const eligible = [];

  for (const backend of backends) {
    const reason = rejectionFor(backend, ctx, health);
    if (reason) {
      trace.push({ backend: backend.name, decision: 'skipped', detail: reason });
      continue;
    }
    eligible.push(backend);
    trace.push({ backend: backend.name, decision: 'eligible', detail: describe(backend, ctx) });
  }

  if (eligible.length === 0) {
    return { backend: null, ctx, trace, error: 'No backend can serve this request' };
  }

  const ranked = rank(eligible, ctx, { preferLocal, health });
  const chosen = ranked[0];

  trace.push({
    backend: chosen.name,
    decision: 'chosen',
    detail: chosen.local
      ? 'nearest healthy local backend'
      : eligible.some((b) => b.local)
        ? 'preferred over an eligible local backend by cost or capability'
        : 'no local backend could serve this request',
  });

  return {
    backend: chosen,
    model: resolveModel(chosen, ctx.model),
    ctx,
    trace,
    fallbacks: ranked.slice(1),
  };
}

function rejectionFor(backend, ctx, health) {
  if (backend.enabled === false) return REJECTIONS.disabled(backend, ctx);

  const state = health[backend.name];
  if (state && state.healthy === false) return REJECTIONS.unhealthy(backend, ctx);

  if (!serves(backend, ctx.model)) return REJECTIONS.noModel(backend, ctx);

  if (backend.contextWindow && ctx.tokens > backend.contextWindow) {
    return REJECTIONS.contextTooSmall(backend, ctx);
  }

  if (ctx.tools && backend.supportsTools === false) return REJECTIONS.noTools(backend, ctx);
  if (ctx.vision && backend.supportsVision !== true) return REJECTIONS.noVision(backend, ctx);

  if (ctx.maxCostPerRequest !== null && !backend.local) {
    const estimate = estimateCost(backend, ctx.tokens);
    if (estimate > ctx.maxCostPerRequest) return REJECTIONS.overBudget(backend, ctx);
  }

  return null;
}

/** A backend serves a model if it lists it, aliases it, or claims everything. */
export function serves(backend, model) {
  if (backend.models === '*' || backend.models === undefined) return true;
  if (Array.isArray(backend.models)) {
    return backend.models.includes(model) || backend.models.includes('*');
  }
  if (typeof backend.models === 'object') {
    return model in backend.models || '*' in backend.models;
  }
  return false;
}

/** Translate the requested model into whatever this backend calls it. */
export function resolveModel(backend, model) {
  if (backend.models && typeof backend.models === 'object' && !Array.isArray(backend.models)) {
    return backend.models[model] ?? backend.models['*'] ?? model;
  }
  return model;
}

function describe(backend, ctx) {
  const parts = [backend.local ? 'local' : 'remote'];
  if (!backend.local) parts.push(`${estimateCost(backend, ctx.tokens).toFixed(4)} estimated`);
  if (backend.contextWindow) parts.push(`${backend.contextWindow} token window`);
  return parts.join(', ');
}

/**
 * Local first, then cheapest, then fastest observed.
 *
 * Latency is a tiebreaker rather than the primary key on purpose. A local
 * model that takes two seconds still beats a cloud model that takes one and
 * charges for it, which is the entire reason someone installs this.
 */
export function rank(backends, ctx, { preferLocal = true, health = {} } = {}) {
  return [...backends].sort((a, b) => {
    if (preferLocal && a.local !== b.local) return a.local ? -1 : 1;

    const byPriority = (a.priority ?? 100) - (b.priority ?? 100);
    if (byPriority !== 0) return byPriority;

    const costDelta = estimateCost(a, ctx.tokens) - estimateCost(b, ctx.tokens);
    if (Math.abs(costDelta) > 1e-9) return costDelta;

    const latencyA = health[a.name]?.latencyMs ?? Number.MAX_SAFE_INTEGER;
    const latencyB = health[b.name]?.latencyMs ?? Number.MAX_SAFE_INTEGER;
    return latencyA - latencyB;
  });
}

/** Dollars, from the backend's own per-million-token prices. Local is free. */
export function estimateCost(backend, promptTokens, completionTokens = 0) {
  if (backend.local) return 0;

  const inputRate = backend.pricing?.inputPerMillion ?? 0;
  const outputRate = backend.pricing?.outputPerMillion ?? 0;

  return (promptTokens / 1e6) * inputRate + (completionTokens / 1e6) * outputRate;
}
