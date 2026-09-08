/**
 * Configuration, with defaults that work before you write any.
 *
 * The default backends are the three local servers people actually run, on
 * their documented ports, plus whichever cloud providers have a key in the
 * environment. Someone who has Ollama running should get a useful router from
 * `nearcall serve` with no config file at all, because a tool that demands a
 * config file before it does anything gets closed.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const CONFIG_FILENAMES = ['nearcall.config.json', '.nearcallrc', '.nearcallrc.json'];

/**
 * Published prices per million tokens, used to estimate what a request would
 * have cost had it gone to the cloud. Approximate by nature: they change, and
 * this is for showing a saving rather than for reconciling an invoice.
 */
export const DEFAULT_PRICING = {
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'claude-sonnet-4': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4 },
  default: { inputPerMillion: 2.5, outputPerMillion: 10 },
};

/** The local servers people run, on the ports their own docs use. */
export const LOCAL_BACKENDS = [
  {
    name: 'ollama',
    local: true,
    baseUrl: 'http://127.0.0.1:11434/v1',
    healthPath: '/models',
    models: '*',
    contextWindow: 32000,
    supportsTools: true,
    priority: 10,
  },
  {
    name: 'lmstudio',
    local: true,
    baseUrl: 'http://127.0.0.1:1234/v1',
    healthPath: '/models',
    models: '*',
    contextWindow: 8000,
    supportsTools: false,
    priority: 20,
  },
  {
    name: 'llamacpp',
    local: true,
    baseUrl: 'http://127.0.0.1:8080/v1',
    healthPath: '/models',
    models: '*',
    contextWindow: 8000,
    supportsTools: false,
    priority: 30,
  },
];

/** Cloud backends are only added when a key is actually present. */
export function cloudBackendsFromEnv(env = process.env) {
  const backends = [];

  if (env.OPENAI_API_KEY) {
    backends.push({
      name: 'openai',
      local: false,
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      models: '*',
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: true,
      pricing: DEFAULT_PRICING['gpt-4o'],
      priority: 100,
    });
  }

  if (env.ANTHROPIC_API_KEY) {
    backends.push({
      name: 'anthropic',
      local: false,
      baseUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      models: '*',
      contextWindow: 200000,
      supportsTools: true,
      supportsVision: true,
      pricing: DEFAULT_PRICING['claude-sonnet-4'],
      priority: 110,
    });
  }

  if (env.OPENROUTER_API_KEY) {
    backends.push({
      name: 'openrouter',
      local: false,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      models: '*',
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: true,
      pricing: DEFAULT_PRICING.default,
      priority: 120,
    });
  }

  return backends;
}

export function defaultConfig(env = process.env) {
  return {
    port: Number(env.NEARCALL_PORT ?? 8787),
    host: env.NEARCALL_HOST ?? '127.0.0.1',
    preferLocal: true,
    maxCostPerRequest: null,
    healthIntervalMs: 30000,
    requestTimeoutMs: 120000,
    backends: [...LOCAL_BACKENDS, ...cloudBackendsFromEnv(env)],
  };
}

const KNOWN_KEYS = new Set([
  'port', 'host', 'preferLocal', 'maxCostPerRequest', 'healthIntervalMs',
  'requestTimeoutMs', 'backends', '$schema',
]);

const KNOWN_BACKEND_KEYS = new Set([
  'name', 'local', 'baseUrl', 'healthPath', 'apiKey', 'apiKeyEnv', 'models',
  'contextWindow', 'supportsTools', 'supportsVision', 'pricing', 'priority',
  'enabled', 'headers',
]);

/**
 * Validation that names the mistake rather than throwing a type error three
 * frames later.
 */
export function validate(config) {
  const problems = [];

  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`unknown option "${key}"`);
  }

  if (!Array.isArray(config.backends) || config.backends.length === 0) {
    problems.push('backends must be a non-empty array');
    return problems;
  }

  const seen = new Set();

  for (const backend of config.backends) {
    const label = backend.name ?? '(unnamed)';

    if (!backend.name) problems.push('a backend has no name');
    if (seen.has(backend.name)) problems.push(`duplicate backend name "${backend.name}"`);
    seen.add(backend.name);

    if (!backend.baseUrl) {
      problems.push(`${label} has no baseUrl`);
    } else {
      try {
        new URL(backend.baseUrl);
      } catch {
        problems.push(`${label} baseUrl "${backend.baseUrl}" is not a URL`);
      }
    }

    if (backend.local === false && !backend.apiKey && !backend.apiKeyEnv) {
      problems.push(`${label} is remote but has neither apiKey nor apiKeyEnv`);
    }

    // A remote backend with no pricing silently reports a saving of zero,
    // which makes the whole cost report a lie.
    if (backend.local === false && !backend.pricing) {
      problems.push(`${label} is remote but has no pricing, so cost reporting would be wrong`);
    }

    for (const key of Object.keys(backend)) {
      if (!KNOWN_BACKEND_KEYS.has(key)) problems.push(`${label} has unknown option "${key}"`);
    }
  }

  return problems;
}

/** Merge a file over the defaults. Backends replace rather than merge. */
export async function load(path = null, env = process.env) {
  const base = defaultConfig(env);

  const candidates = path ? [path] : CONFIG_FILENAMES;
  let loaded = null;
  let from = null;

  for (const candidate of candidates) {
    try {
      const raw = await readFile(resolve(candidate), 'utf8');
      loaded = JSON.parse(raw);
      from = resolve(candidate);
      break;
    } catch (error) {
      // An explicitly requested file that does not parse is an error. A
      // default filename that is simply absent is not.
      if (path && error instanceof SyntaxError) {
        throw new Error(`${candidate} is not valid JSON: ${error.message}`);
      }
      if (path && error.code !== 'ENOENT') throw error;
    }
  }

  if (path && loaded === null) {
    throw new Error(`Config file not found: ${path}`);
  }

  const config = { ...base, ...(loaded ?? {}) };
  if (loaded?.backends) config.backends = loaded.backends;

  const problems = validate(config);
  if (problems.length) {
    throw new Error(`Configuration problems:\n  ${problems.join('\n  ')}`);
  }

  return { config, from };
}

/** Resolve a backend's key at call time so it is never held in the config. */
export function apiKeyFor(backend, env = process.env) {
  if (backend.apiKey) return backend.apiKey;
  if (backend.apiKeyEnv) return env[backend.apiKeyEnv] ?? null;
  return null;
}
