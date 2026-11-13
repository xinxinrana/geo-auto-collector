import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(readFileSync('manifest.json'));
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path]) assert(existsSync(file), `Missing ${file}`);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
for (const dir of ['bridge', 'cli', 'shared', 'extension', 'scripts', 'tests']) {
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', join(dir, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
}
const html = readFileSync('extension/panel.html', 'utf8');
for (const [, file] of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) assert(existsSync(join('extension', file)));
assert(!/<script\b[^>]*>\s*[^<\s]/.test(html), 'No inline JS in extension pages');
console.log(`Manifest ${manifest.version}, source syntax and extension entry points: OK`);
