/**
 * End to end against real HTTP.
 *
 * The mock backends are actual servers rather than a stubbed fetch, because
 * the parts most likely to break are the ones a stub hides: streaming, header
 * propagation, and falling back after an upstream returns 500.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createNearcallServer } from '../src/server.mjs';

/** A minimal OpenAI-compatible backend whose behaviour each test dictates. */
async function mockBackend({ name = 'mock', status = 200, fail = false, delayMs = 0, models = ['local-model'] } = {}) {
  const calls = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model' })) }));
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ path: url.pathname, body, headers: req.headers });

    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));

    if (fail) {
      res.destroy();
      return;
    }

    if (body.stream) {
      res.writeHead(status, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${name}`,
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `hello from ${name}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
    );
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    name,
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function startRouter(backends, overrides = {}) {
  const config = {
    port: 0,
    host: '127.0.0.1',
    preferLocal: true,
    maxCostPerRequest: null,
    requestTimeoutMs: 5000,
    backends,
    ...overrides,
  };

  const server = createNearcallServer(config, { logger: { error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    server,
    chat: (body, headers = {}) =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], ...body }),
      }),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('a request is served locally and says so in the headers', async (t) => {
  const local = await mockBackend({ name: 'ollama' });
  const router = await startRouter([
    { name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*', contextWindow: 32000 },
  ]);
  t.after(async () => { await router.close(); await local.close(); });

  const response = await router.chat({});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-nearcall-backend'), 'ollama');
  assert.equal(response.headers.get('x-nearcall-local'), 'true');
  assert.match(body.choices[0].message.content, /hello from ollama/);
});

test('a dead local backend falls back to cloud and the client never sees the failure', async (t) => {
  const local = await mockBackend({ name: 'ollama', fail: true });
  const cloud = await mockBackend({ name: 'openai' });

  const router = await startRouter([
    { name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*', contextWindow: 32000 },
    {
      name: 'openai',
      local: false,
      baseUrl: cloud.baseUrl,
      apiKey: 'test',
      models: '*',
      contextWindow: 128000,
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    },
  ]);
  t.after(async () => { await router.close(); await local.close(); await cloud.close(); });

  const response = await router.chat({});

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-nearcall-backend'), 'openai');
  assert.equal(local.calls.length, 1, 'the local backend was tried first');
});

test('a 500 from the chosen backend retries the next one', async (t) => {
  const broken = await mockBackend({ name: 'broken', status: 500 });
  const good = await mockBackend({ name: 'good' });

  const router = await startRouter([
    { name: 'broken', local: true, baseUrl: broken.baseUrl, models: '*', priority: 1 },
    { name: 'good', local: true, baseUrl: good.baseUrl, models: '*', priority: 2 },
  ]);
  t.after(async () => { await router.close(); await broken.close(); await good.close(); });

  const response = await router.chat({});

  assert.equal(response.headers.get('x-nearcall-backend'), 'good');
});

test('a 400 is returned rather than retried against a paid backend', async (t) => {
  const local = await mockBackend({ name: 'ollama', status: 400 });
  const cloud = await mockBackend({ name: 'openai' });

  const router = await startRouter([
    { name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*' },
    {
      name: 'openai', local: false, baseUrl: cloud.baseUrl, apiKey: 'k', models: '*',
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    },
  ]);
  t.after(async () => { await router.close(); await local.close(); await cloud.close(); });

  const response = await router.chat({});

  // A malformed request is the client's bug. Sending it on to a paid backend
  // would turn that bug into a bill.
  assert.equal(response.status, 400);
  assert.equal(cloud.calls.length, 0, 'the paid backend was never called');
});

test('the model name is translated per backend', async (t) => {
  const local = await mockBackend({ name: 'ollama' });
  const router = await startRouter([
    { name: 'ollama', local: true, baseUrl: local.baseUrl, models: { 'gpt-4o': 'qwen3:8b' }, contextWindow: 32000 },
  ]);
  t.after(async () => { await router.close(); await local.close(); });

  await router.chat({ model: 'gpt-4o' });

  assert.equal(local.calls[0].body.model, 'qwen3:8b');
});

test('streaming passes through and keeps the routing headers', async (t) => {
  const local = await mockBackend({ name: 'ollama' });
  const router = await startRouter([
    { name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*', contextWindow: 32000 },
  ]);
  t.after(async () => { await router.close(); await local.close(); });

  const response = await router.chat({ stream: true });
  const text = await response.text();

  assert.equal(response.headers.get('x-nearcall-backend'), 'ollama');
  assert.match(response.headers.get('content-type'), /event-stream/);
  assert.match(text, /"content":"hel"/);
  assert.match(text, /\[DONE\]/);
});

test('the backend can be forced with a header', async (t) => {
  const local = await mockBackend({ name: 'ollama' });
  const cloud = await mockBackend({ name: 'openai' });

  const router = await startRouter([
    { name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*' },
    {
      name: 'openai', local: false, baseUrl: cloud.baseUrl, apiKey: 'k', models: '*',
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    },
  ]);
  t.after(async () => { await router.close(); await local.close(); await cloud.close(); });

  const response = await router.chat({}, { 'x-nearcall-backend': 'openai' });

  assert.equal(response.headers.get('x-nearcall-backend'), 'openai');
  assert.equal(local.calls.length, 0);
});

test('stats report what was saved by staying local', async (t) => {
  const local = await mockBackend({ name: 'ollama' });
  const router = await startRouter([
    { name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*', contextWindow: 32000 },
    {
      name: 'openai', local: false, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', models: '*',
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    },
  ]);
  t.after(async () => { await router.close(); await local.close(); });

  await router.chat({});

  const stats = await (await fetch(`${router.base}/stats`)).json();

  assert.equal(stats.requests, 1);
  assert.equal(stats.localRequests, 1);
  assert.equal(stats.spent, 0);
  // 11 prompt at $2.50/M plus 7 completion at $10/M.
  assert.ok(stats.saved > 0, 'a local request should record a saving');
  assert.equal(stats.localShare, 1);
});

test('when no backend can serve the request the error explains why', async (t) => {
  const local = await mockBackend({ name: 'ollama' });
  const router = await startRouter([
    { name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*', contextWindow: 100 },
  ]);
  t.after(async () => { await router.close(); await local.close(); });

  const response = await router.chat({ messages: [{ role: 'user', content: 'x'.repeat(40000) }] });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.match(body.error.message, /No backend can serve/);
  assert.ok(Array.isArray(body.error.trace), 'the error carries the routing trace');
  assert.ok(body.error.trace.some((t) => /token window/.test(t.detail)));
});

test('models are aggregated across backends and tagged by location', async (t) => {
  const local = await mockBackend({ name: 'ollama', models: ['qwen3:8b'] });
  const cloud = await mockBackend({ name: 'openai', models: ['gpt-4o'] });

  const router = await startRouter([
    { name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*' },
    {
      name: 'openai', local: false, baseUrl: cloud.baseUrl, apiKey: 'k', models: '*',
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    },
  ]);
  t.after(async () => { await router.close(); await local.close(); await cloud.close(); });

  const body = await (await fetch(`${router.base}/v1/models`)).json();
  const byId = Object.fromEntries(body.data.map((m) => [m.id, m]));

  assert.equal(byId['qwen3:8b']['x-nearcall-local'], true);
  assert.equal(byId['gpt-4o']['x-nearcall-local'], false);
});

test('a malformed body is rejected without touching a backend', async (t) => {
  const local = await mockBackend({ name: 'ollama' });
  const router = await startRouter([{ name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*' }]);
  t.after(async () => { await router.close(); await local.close(); });

  const response = await fetch(`${router.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });

  assert.equal(response.status, 400);
  assert.equal(local.calls.length, 0);
});

test('an unknown route answers in the OpenAI error shape', async (t) => {
  const local = await mockBackend({ name: 'ollama' });
  const router = await startRouter([{ name: 'ollama', local: true, baseUrl: local.baseUrl, models: '*' }]);
  t.after(async () => { await router.close(); await local.close(); });

  const response = await fetch(`${router.base}/v1/nope`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.ok(body.error.message, 'clients parse error.message, so it has to be there');
});
