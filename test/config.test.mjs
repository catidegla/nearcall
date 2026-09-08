import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultConfig, validate, load, apiKeyFor, cloudBackendsFromEnv } from '../src/config.mjs';

test('the defaults work with no config file and no keys', () => {
  const config = defaultConfig({});

  assert.equal(config.port, 8787);
  assert.equal(config.host, '127.0.0.1');
  assert.ok(config.backends.length >= 3, 'the three local servers people run are configured');
  assert.ok(config.backends.every((b) => b.local), 'no cloud backend without a key');
  assert.deepEqual(validate(config), []);
});

test('a cloud backend appears only when its key is in the environment', () => {
  assert.deepEqual(cloudBackendsFromEnv({}), []);

  const withKey = cloudBackendsFromEnv({ OPENAI_API_KEY: 'sk-test' });
  assert.equal(withKey.length, 1);
  assert.equal(withKey[0].name, 'openai');
  assert.ok(withKey[0].pricing, 'a remote backend without pricing would report a saving of zero');
});

test('the key is read at call time, never stored in config', () => {
  const backend = { apiKeyEnv: 'MY_KEY' };

  assert.equal(apiKeyFor(backend, {}), null);
  assert.equal(apiKeyFor(backend, { MY_KEY: 'secret' }), 'secret');
});

test('validation names the mistake', () => {
  const problems = validate({
    backends: [
      { name: 'a' },
      { name: 'a', baseUrl: 'http://x' },
      { name: 'b', baseUrl: 'not a url' },
      { name: 'c', baseUrl: 'http://x', local: false },
      { name: 'd', baseUrl: 'http://x', typo: 1 },
    ],
  });

  const joined = problems.join('\n');
  assert.match(joined, /a has no baseUrl/);
  assert.match(joined, /duplicate backend name "a"/);
  assert.match(joined, /not a URL/);
  assert.match(joined, /neither apiKey nor apiKeyEnv/);
  assert.match(joined, /no pricing/);
  assert.match(joined, /unknown option "typo"/);
});

test('an unknown top level option is caught rather than ignored', () => {
  const problems = validate({ ...defaultConfig({}), prefrLocal: true });
  assert.ok(problems.some((p) => /unknown option "prefrLocal"/.test(p)), 'a typo should not fail silently');
});

test('a config file overrides the defaults and replaces backends outright', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nearcall-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, 'custom.json');
  await writeFile(
    file,
    JSON.stringify({
      port: 9999,
      backends: [{ name: 'only', local: true, baseUrl: 'http://127.0.0.1:1/v1', models: '*' }],
    }),
  );

  const { config, from } = await load(file, {});

  assert.equal(config.port, 9999);
  assert.equal(config.from, undefined);
  assert.equal(from, file);
  // Replaced, not merged, so a config file is a complete statement of intent
  // rather than something layered on top of defaults you cannot see.
  assert.deepEqual(config.backends.map((b) => b.name), ['only']);
});

test('a named config file that does not exist is an error', async () => {
  await assert.rejects(() => load('definitely-not-here.json', {}), /not found/);
});

test('a named config file with bad JSON says so', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nearcall-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, 'broken.json');
  await writeFile(file, '{ not json');

  await assert.rejects(() => load(file, {}), /not valid JSON/);
});

test('an invalid config is rejected with every problem at once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nearcall-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = join(dir, 'bad.json');
  await writeFile(file, JSON.stringify({ backends: [{ name: 'x' }] }));

  // All of them, not just the first, so fixing a config is one pass.
  await assert.rejects(() => load(file, {}), /Configuration problems/);
});
