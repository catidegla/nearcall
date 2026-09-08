import test from 'node:test';
import assert from 'node:assert/strict';

import { route, rank, estimateCost, estimateTokens, needsVision, serves, resolveModel } from '../src/router.mjs';

const ollama = {
  name: 'ollama',
  local: true,
  baseUrl: 'http://localhost:11434/v1',
  models: { '*': 'qwen3:8b' },
  contextWindow: 32000,
  supportsTools: true,
};

const lmstudio = {
  name: 'lmstudio',
  local: true,
  baseUrl: 'http://localhost:1234/v1',
  models: '*',
  contextWindow: 8000,
  supportsTools: false,
  priority: 200,
};

const cloud = {
  name: 'openai',
  local: false,
  baseUrl: 'https://api.openai.com/v1',
  models: '*',
  contextWindow: 200000,
  supportsTools: true,
  supportsVision: true,
  pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
};

const backends = [ollama, lmstudio, cloud];
const ask = (content, extra = {}) => ({ model: 'gpt-4o', messages: [{ role: 'user', content }], ...extra });

test('a short prompt goes to the local backend', () => {
  const result = route(ask('hello'), backends);

  assert.equal(result.backend.name, 'ollama');
  // The requested name is translated to whatever the backend calls it.
  assert.equal(result.model, 'qwen3:8b');
});

test('local wins even when a cloud backend is faster', () => {
  const result = route(ask('hello'), backends, {
    health: { ollama: { healthy: true, latencyMs: 3000 }, openai: { healthy: true, latencyMs: 200 } },
  });

  // Paying to save two seconds defeats the point of installing this.
  assert.equal(result.backend.name, 'ollama');
});

test('a prompt too large for every local window falls through to cloud', () => {
  const huge = 'x'.repeat(4 * 40000); // about 40k tokens
  const result = route(ask(huge), backends);

  assert.equal(result.backend.name, 'openai');
  assert.ok(
    result.trace.some((t) => t.backend === 'ollama' && /32000 token window/.test(t.detail)),
    'the trace should say why the local backend was skipped',
  );
});

test('tool calls skip a backend that cannot do them', () => {
  const result = route(ask('hi', { tools: [{ type: 'function', function: { name: 'x' } }] }), [lmstudio, cloud]);

  assert.equal(result.backend.name, 'openai');
  assert.ok(result.trace.some((t) => t.backend === 'lmstudio' && /tool calling/.test(t.detail)));
});

test('images skip backends that do not declare vision', () => {
  const withImage = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] }],
  };

  const result = route(withImage, backends);

  // supportsVision is opt in: a backend that does not say so is assumed not to,
  // because silently dropping an image produces a confidently wrong answer.
  assert.equal(result.backend.name, 'openai');
});

test('an unhealthy local backend is skipped and the next local one is used', () => {
  const result = route(ask('hello'), backends, { health: { ollama: { healthy: false } } });

  assert.equal(result.backend.name, 'lmstudio');
  assert.ok(result.trace.some((t) => t.backend === 'ollama' && /health checks/.test(t.detail)));
});

test('when everything local is down it falls back to cloud', () => {
  const result = route(ask('hello'), backends, {
    health: { ollama: { healthy: false }, lmstudio: { healthy: false } },
  });

  assert.equal(result.backend.name, 'openai');
  assert.match(
    result.trace.find((t) => t.decision === 'chosen').detail,
    /no local backend/,
  );
});

test('a disabled backend is never chosen', () => {
  const result = route(ask('hello'), [{ ...ollama, enabled: false }, cloud]);

  assert.equal(result.backend.name, 'openai');
  assert.ok(result.trace.some((t) => t.backend === 'ollama' && /disabled/.test(t.detail)));
});

test('a per-request budget rules out an expensive cloud backend', () => {
  const huge = 'x'.repeat(4 * 40000);
  const result = route(ask(huge), backends, { maxCostPerRequest: 0.01 });

  // 40k tokens at $2.50 per million is $0.10, over the one cent budget, and no
  // local backend has a window big enough.
  assert.equal(result.backend, null);
  assert.match(result.error, /No backend can serve/);
});

test('an explicit override wins over every rule, including health', () => {
  const result = route(ask('hello'), backends, {
    forceBackend: 'openai',
    health: { openai: { healthy: false } },
  });

  assert.equal(result.backend.name, 'openai');
  assert.equal(result.forced, true);
});

test('forcing a backend that does not exist is an error, not a silent fallback', () => {
  const result = route(ask('hello'), backends, { forceBackend: 'nope' });

  assert.equal(result.backend, null);
  assert.match(result.error, /No backend named "nope"/);
});

test('every decision is explainable', () => {
  const result = route(ask('hello'), backends);

  // A router that cannot say why it sent your request somewhere, and billed
  // you for it, is worse than no router.
  assert.ok(result.trace.length >= backends.length);
  for (const entry of result.trace) {
    assert.ok(entry.backend, 'trace entry names a backend');
    assert.ok(entry.decision, 'trace entry has a decision');
    assert.ok(entry.detail && entry.detail.length > 3, 'trace entry explains itself');
  }
});

test('fallbacks are ordered, not just present', () => {
  const result = route(ask('hello'), backends);

  assert.equal(result.backend.name, 'ollama');
  assert.deepEqual(result.fallbacks.map((b) => b.name), ['lmstudio', 'openai']);
});

test('local backends cost nothing', () => {
  assert.equal(estimateCost(ollama, 1_000_000, 1_000_000), 0);
});

test('cloud cost is computed from per million rates', () => {
  // 1M in at $2.50 plus 1M out at $10.
  assert.equal(estimateCost(cloud, 1_000_000, 1_000_000).toFixed(2), '12.50');
});

test('token estimates count structured content, not just strings', () => {
  const plain = estimateTokens([{ role: 'user', content: 'a'.repeat(400) }]);
  const structured = estimateTokens([{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(400) }] }]);

  assert.equal(plain, 100);
  assert.equal(structured, 100);
});

test('vision detection understands both content shapes', () => {
  assert.equal(needsVision([{ content: [{ type: 'image_url', image_url: {} }] }]), true);
  assert.equal(needsVision([{ content: [{ type: 'text', text: 'hi' }] }]), false);
  assert.equal(needsVision([{ content: 'hi' }]), false);
});

test('model matching handles lists, maps and wildcards', () => {
  assert.equal(serves({ models: ['a', 'b'] }, 'a'), true);
  assert.equal(serves({ models: ['a', 'b'] }, 'c'), false);
  assert.equal(serves({ models: '*' }, 'anything'), true);
  assert.equal(serves({ models: { 'gpt-4o': 'qwen3' } }, 'gpt-4o'), true);
  assert.equal(serves({ models: { 'gpt-4o': 'qwen3' } }, 'claude'), false);

  assert.equal(resolveModel({ models: { 'gpt-4o': 'qwen3' } }, 'gpt-4o'), 'qwen3');
  assert.equal(resolveModel({ models: { '*': 'qwen3' } }, 'anything'), 'qwen3');
  assert.equal(resolveModel({ models: '*' }, 'passthrough'), 'passthrough');
});

test('priority breaks ties between two local backends', () => {
  const ranked = rank([lmstudio, ollama], { tokens: 10 }, {});
  assert.deepEqual(ranked.map((b) => b.name), ['ollama', 'lmstudio']);
});

test('latency breaks ties when cost and priority match', () => {
  const a = { name: 'a', local: true, priority: 1 };
  const b = { name: 'b', local: true, priority: 1 };

  const ranked = rank([a, b], { tokens: 10 }, { health: { a: { latencyMs: 900 }, b: { latencyMs: 100 } } });
  assert.deepEqual(ranked.map((x) => x.name), ['b', 'a']);
});
