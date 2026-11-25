/* Confere que public/dist e o SRI de public/index.html estão em dia com as
   fontes de public/. Sem isso, o index poderia apontar para um bundle antigo
   ou para um hash que não corresponde ao arquivo servido.

   node test/assets-build.test.mjs */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['scripts/build-assets.mjs', '--check'], {
  cwd: root,
  encoding: 'utf8'
});

assert.equal(result.status, 0,
  (result.stderr || result.stdout || 'build-assets --check falhou').trim());
assert.match(result.stdout, /public\/dist e SRI do index em dia/);
console.log('ok   public/dist e SRI do index em dia');
