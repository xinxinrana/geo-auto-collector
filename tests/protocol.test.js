import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, validateCommand, documentation, help } from '../shared/protocol.js';
import { spawnSync } from 'node:child_process';

test('every documented command example is accepted by the real validator', () => {
  for (const action of Object.keys(ACTIONS)) assert.equal(validateCommand(documentation(action).request.body).action, action);
  assert(Buffer.byteLength(JSON.stringify(help('0.6.3'))) < 4096);
});
test('normalization, unknown fields, explicit save revision and typed booleans', () => {
  assert.deepEqual(validateCommand({ action: 'run', platform: 'perplexity', keyword: ' hello ' }), validateCommand({ action: 'run', keyword: 'hello', platform: 'perplexity', focus: true, timeoutMs: 180000 }));
  for (const body of [{ action: 'toString' }, { action: '__proto__' }, { action: 'run', platform: 'chatgpt', keyword: 'x' }, { action: 'collect', platform: 'perplexity', focus: 'false' }, { action: 'stop', unknown: 1 }, { action: 'fix', platform: 'perplexity', field: 'answer', selector: 'main', testOnly: false }]) assert.throws(() => validateCommand(body), e => e.code === 'invalid_action' || e.code === 'invalid_argument');
  assert.throws(() => documentation('__proto__'), e => e.status === 404);
});
test('CLI help and docs work offline without credentials or ws import', () => {
  for (const args of [['help'], ['docs', 'run'], ['docs', 'connection']]) {
    const result = spawnSync(process.execPath, ['geo', ...args], { env: { ...process.env, GEO_BRIDGE_HOME: '/private/tmp/geo-nonexistent-help-test' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
});
