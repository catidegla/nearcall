#!/usr/bin/env node
/**
 * nearcall
 *
 * A local-first router with an OpenAI-compatible surface. Point any OpenAI SDK
 * at it and requests reach a paid API only when nothing local can serve them.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { load, apiKeyFor } from '../src/config.mjs';
import { createNearcallServer } from '../src/server.mjs';
import { HealthMonitor } from '../src/health.mjs';
import { route, estimateCost } from '../src/router.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const has = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: (s) => paint('1', s),
  dim: (s) => paint('2', s),
  green: (s) => paint('32', s),
  yellow: (s) => paint('33', s),
  red: (s) => paint('31', s),
  cyan: (s) => paint('36', s),
};

function usage() {
  console.log(`
${c.bold('nearcall')} ${pkg.version}
Route model calls to whatever you have running locally, and pay only when you must.

  ${c.bold('serve')}                 start the OpenAI-compatible server
  ${c.bold('route')} <prompt>        show where a request would go, and why, without sending it
  ${c.bold('doctor')}                probe every configured backend
  ${c.bold('models')}                list models across healthy backends
  ${c.bold('config')}                print the resolved configuration

Options
  --config <file>       config file (default: nearcall.config.json if present)
  --port <n>            override the listen port
  --model <name>        model to route as, for the route command
  --tools               pretend the request carries tool definitions
  --image               pretend the request carries an image
  --json                machine readable output

Examples
  nearcall serve
  nearcall route "summarise this paragraph"
  nearcall route "$(cat long-file.txt)" --model gpt-4o
  OPENAI_API_KEY=sk-... nearcall serve
`);
}

async function resolveConfig() {
  const { config, from } = await load(value('config'), process.env);
  if (value('port')) config.port = Number(value('port'));
  return { config, from };
}

async function cmdServe() {
  const { config, from } = await resolveConfig();
  const server = createNearcallServer(config);

  server.nearcall.monitor.start(config.healthIntervalMs);

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));

  const local = config.backends.filter((b) => b.local && b.enabled !== false);
  const remote = config.backends.filter((b) => !b.local && b.enabled !== false);

  console.log('');
  console.log(`  ${c.bold('nearcall')} listening on ${c.cyan(`http://${config.host}:${config.port}/v1`)}`);
  console.log('');
  console.log(`  ${c.dim('local  ')} ${local.map((b) => b.name).join(', ') || c.dim('none configured')}`);
  console.log(
    `  ${c.dim('remote ')} ${
      remote.length
        ? remote.map((b) => (apiKeyFor(b) ? b.name : c.yellow(`${b.name} (no key)`))).join(', ')
        : c.dim('none, so nothing can leave this machine')
    }`,
  );
  console.log(`  ${c.dim('config ')} ${from ?? c.dim('defaults')}`);
  console.log('');
  console.log(c.dim('  Point any OpenAI client at the URL above. GET /stats for what you have saved.'));
  console.log('');

  const shutdown = () => {
    server.nearcall.monitor.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdRoute() {
  const prompt = argv.slice(1).find((a) => !a.startsWith('--')) ?? '';
  if (!prompt) {
    console.error('Give a prompt to route, for example: nearcall route "hello"');
    process.exit(2);
  }

  const { config } = await resolveConfig();

  const monitor = new HealthMonitor(config.backends);

  // Twice, because a backend is only marked down after two consecutive
  // failures. That debounce exists so a model reload does not divert a live
  // session to a paid API, but a one shot diagnostic that stops after one
  // probe would report a dead backend as usable, which is worse than useless
  // in a command whose whole job is to tell you where a request would go.
  await monitor.checkAll();
  await monitor.checkAll();

  const request = {
    model: value('model', 'gpt-4o'),
    messages: [{ role: 'user', content: prompt }],
    ...(has('tools') ? { tools: [{ type: 'function', function: { name: 'example' } }] } : {}),
  };

  if (has('image')) {
    request.messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] }];
  }

  const decision = route(request, config.backends, {
    health: monitor.snapshot(),
    maxCostPerRequest: config.maxCostPerRequest,
    preferLocal: config.preferLocal !== false,
  });

  if (has('json')) {
    console.log(JSON.stringify({ decision: decision.backend?.name ?? null, ...decision }, null, 2));
    process.exit(decision.backend ? 0 : 1);
  }

  console.log('');
  console.log(`  ${c.dim('request')}  ${decision.ctx.tokens} tokens, model ${decision.ctx.model}` +
    (decision.ctx.tools ? ', tools' : '') + (decision.ctx.vision ? ', image' : ''));
  console.log('');

  for (const entry of decision.trace) {
    const mark =
      entry.decision === 'chosen' ? c.green('->') : entry.decision === 'skipped' ? c.dim(' x') : c.dim('  ');
    const name = entry.decision === 'chosen' ? c.bold(entry.backend) : entry.backend;
    console.log(`  ${mark} ${name.padEnd(tty ? 22 : 12)} ${c.dim(entry.detail)}`);
  }

  console.log('');

  if (!decision.backend) {
    console.log(`  ${c.red(decision.error)}`);
    process.exit(1);
  }

  if (decision.backend.local) {
    const wouldCost = config.backends
      .filter((b) => !b.local && b.pricing)
      .map((b) => estimateCost(b, decision.ctx.tokens, decision.ctx.tokens));

    if (wouldCost.length) {
      console.log(`  ${c.green('local')}, saving about $${Math.min(...wouldCost).toFixed(4)} on this request`);
    } else {
      console.log(`  ${c.green('local')}, and no cloud backend is configured so nothing can leave this machine`);
    }
  } else {
    const cost = estimateCost(decision.backend, decision.ctx.tokens, decision.ctx.tokens);
    console.log(`  ${c.yellow('remote')}, about $${cost.toFixed(4)} for this request`);
  }
  console.log('');
}

async function cmdDoctor() {
  const { config, from } = await resolveConfig();
  const monitor = new HealthMonitor(config.backends);

  // See the note in cmdRoute: one probe is never enough to mark a backend down.
  await monitor.checkAll();
  const state = await monitor.checkAll();

  if (has('json')) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  console.log('');
  console.log(`  ${c.dim('config')} ${from ?? 'defaults'}`);
  console.log('');

  let anyLocal = false;

  for (const backend of config.backends) {
    const entry = state[backend.name];
    const up = entry.healthy === true;
    if (up && backend.local) anyLocal = true;

    const status = up ? c.green('up  ') : entry.healthy === false ? c.red('down') : c.dim('????');
    const timing = entry.latencyMs !== null ? c.dim(`${entry.latencyMs}ms`) : '';
    const note = up ? '' : c.dim(entry.error ?? '');

    console.log(`  ${status} ${backend.name.padEnd(12)} ${c.dim(backend.baseUrl.padEnd(34))} ${timing} ${note}`);

    if (!backend.local && !apiKeyFor(backend)) {
      console.log(`       ${c.yellow(`no ${backend.apiKeyEnv ?? 'api key'} in the environment`)}`);
    }
  }

  console.log('');

  if (!anyLocal) {
    console.log(`  ${c.yellow('No local backend is answering.')}`);
    console.log(c.dim('  Start one, for example "ollama serve", or every request will go to a paid API.'));
    console.log('');
    process.exitCode = 1;
  }
}

async function cmdModels() {
  const { config } = await resolveConfig();
  const server = createNearcallServer(config);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
  const body = await response.json();
  server.close();

  if (has('json')) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log('');
  if (!body.data.length) {
    console.log(`  ${c.yellow('No models found. Is anything running?')}`);
    console.log('');
    process.exitCode = 1;
    return;
  }

  for (const model of body.data) {
    const where = model['x-nearcall-local'] ? c.green('local ') : c.yellow('remote');
    console.log(`  ${where} ${String(model.id).padEnd(40)} ${c.dim(model.owned_by)}`);
  }
  console.log('');
}

async function cmdConfig() {
  const { config, from } = await resolveConfig();
  console.log(JSON.stringify({ loadedFrom: from, ...config }, null, 2));
}

const commands = { serve: cmdServe, route: cmdRoute, doctor: cmdDoctor, models: cmdModels, config: cmdConfig };

// Version is checked first. A bare "--version" leaves command null, so the
// usage branch would otherwise swallow it.
if (has('version')) {
  console.log(pkg.version);
} else if (!command || has('help') || command === 'help') {
  usage();
} else if (commands[command]) {
  try {
    await commands[command]();
  } catch (error) {
    console.error(`nearcall: ${error.message}`);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(1);
}
