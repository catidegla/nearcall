/**
 * An OpenAI-compatible HTTP surface in front of whatever you have running.
 *
 * Point any OpenAI SDK at it and requests go to a local model when one can
 * serve them, and to a paid API only when none can.
 *
 * The subtle part is failure handling. A backend that passes a health probe
 * can still fail a completion, so a failed request retries down the ranked
 * fallback list. That retry is only possible before any bytes have been sent
 * to the client, which is why streaming responses are held until the upstream
 * status is known.
 */

import { createServer } from 'node:http';

import { route } from './router.mjs';
import { apiKeyFor } from './config.mjs';
import { HealthMonitor } from './health.mjs';
import { UsageLedger, usageFrom } from './usage.mjs';

const JSON_HEADERS = { 'content-type': 'application/json' };

function send(res, status, body, extraHeaders = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  res.end(payload);
}

/** The error shape OpenAI clients already know how to read. */
function sendError(res, status, message, type = 'nearcall_error', extra = {}) {
  send(res, status, { error: { message, type, ...extra } });
}

async function readJson(req, limitBytes = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }

  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createNearcallServer(config, { env = process.env, fetchImpl = fetch, logger = console } = {}) {
  const monitor = new HealthMonitor(config.backends, { env, fetchImpl });
  const ledger = new UsageLedger();

  async function callBackend(backend, path, body, { stream = false, signal }) {
    const url = backend.baseUrl.replace(/\/$/, '') + path;
    const headers = { 'content-type': 'application/json', ...(backend.headers ?? {}) };

    const key = apiKeyFor(backend, env);
    if (key) headers.authorization = `Bearer ${key}`;

    const started = Date.now();

    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    return { response, latencyMs: Date.now() - started, stream };
  }

  /**
   * Try the chosen backend, then its ranked fallbacks.
   *
   * Only transport failures and 5xx responses trigger a fallback. A 400 means
   * the request itself is wrong and sending it to a second, paid backend would
   * turn a client bug into a bill.
   */
  async function attempt(decision, path, body, { signal }) {
    const chain = [decision.backend, ...(decision.fallbacks ?? [])];
    const attempts = [];

    for (const backend of chain) {
      const upstreamBody = { ...body, model: decision.forced ? body.model : resolveFor(backend, body.model) };

      try {
        const { response, latencyMs } = await callBackend(backend, path, upstreamBody, { signal });

        if (response.status >= 500) {
          monitor.recordFailure(backend.name, new Error(`HTTP ${response.status}`));
          attempts.push({ backend: backend.name, status: response.status });
          continue;
        }

        monitor.recordSuccess(backend.name, latencyMs);
        return { backend, response, latencyMs, attempts };
      } catch (error) {
        monitor.recordFailure(backend.name, error);
        attempts.push({ backend: backend.name, error: String(error.message ?? error) });
      }
    }

    return { backend: null, attempts };
  }

  function resolveFor(backend, requested) {
    if (backend.models && typeof backend.models === 'object' && !Array.isArray(backend.models)) {
      return backend.models[requested] ?? backend.models['*'] ?? requested;
    }
    return requested;
  }

  async function handleCompletion(req, res, path) {
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return sendError(res, 400, error.message, 'invalid_request_error');
    }

    if (!Array.isArray(body.messages) && path === '/v1/chat/completions') {
      return sendError(res, 400, 'messages must be an array', 'invalid_request_error');
    }

    const decision = route(body, config.backends, {
      health: monitor.snapshot(),
      maxCostPerRequest: config.maxCostPerRequest,
      preferLocal: config.preferLocal !== false,
      forceBackend: req.headers['x-nearcall-backend'] ?? null,
    });

    if (!decision.backend) {
      return sendError(res, 503, decision.error, 'no_backend_available', { trace: decision.trace });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? 120000);
    req.on('close', () => controller.abort());

    try {
      const result = await attempt(decision, path, body, { signal: controller.signal });

      if (!result.backend) {
        return sendError(res, 502, 'Every backend failed', 'upstream_error', { attempts: result.attempts });
      }

      const routeHeaders = {
        'x-nearcall-backend': result.backend.name,
        'x-nearcall-local': String(Boolean(result.backend.local)),
      };

      if (body.stream) {
        // The status is known before anything is written, so a retry was still
        // possible up to this point. From here the client owns the stream.
        res.writeHead(result.response.status, {
          'content-type': result.response.headers.get('content-type') ?? 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...routeHeaders,
        });

        for await (const chunk of result.response.body) res.write(chunk);
        res.end();

        // Streaming responses carry usage only when the caller asked for it,
        // so the prompt side is estimated rather than reported as zero.
        ledger.record({
          backend: result.backend,
          promptTokens: decision.ctx.tokens,
          allBackends: config.backends,
          latencyMs: result.latencyMs,
        });
        return;
      }

      const payload = await result.response.json();

      if (result.response.ok) {
        const { promptTokens, completionTokens } = usageFrom(payload, decision.ctx.tokens);
        ledger.record({
          backend: result.backend,
          promptTokens,
          completionTokens,
          allBackends: config.backends,
          latencyMs: result.latencyMs,
        });
      }

      return send(res, result.response.status, payload, routeHeaders);
    } catch (error) {
      if (controller.signal.aborted) {
        return sendError(res, 504, 'Upstream timed out', 'timeout_error');
      }
      logger.error?.('nearcall: request failed', error);
      return sendError(res, 500, String(error.message ?? error));
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Aggregate models across healthy backends, tagged with where they live. */
  async function handleModels(res) {
    const health = monitor.snapshot();
    const data = [];

    await Promise.all(
      config.backends.map(async (backend) => {
        if (backend.enabled === false) return;
        if (health[backend.name]?.healthy === false) return;

        try {
          const url = backend.baseUrl.replace(/\/$/, '') + '/models';
          const headers = {};
          const key = apiKeyFor(backend, env);
          if (key) headers.authorization = `Bearer ${key}`;

          const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5000) });
          if (!response.ok) return;

          const body = await response.json();
          for (const model of body.data ?? []) {
            data.push({
              ...model,
              owned_by: backend.name,
              'x-nearcall-local': Boolean(backend.local),
            });
          }
        } catch {
          // A backend that cannot list models is not an error for this
          // endpoint; it just contributes nothing.
        }
      }),
    );

    send(res, 200, { object: 'list', data });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-nearcall-backend',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok', backends: monitor.snapshot() });
      }

      if (req.method === 'GET' && url.pathname === '/stats') {
        return send(res, 200, ledger.summary());
      }

      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        return handleModels(res);
      }

      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/embeddings')) {
        return handleCompletion(req, res, url.pathname);
      }

      sendError(res, 404, `No route for ${req.method} ${url.pathname}`, 'not_found');
    } catch (error) {
      logger.error?.('nearcall: unhandled', error);
      sendError(res, 500, String(error.message ?? error));
    }
  });

  server.nearcall = { monitor, ledger, config };
  return server;
}
