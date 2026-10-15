import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);

test('local environment files are excluded from source and Vercel deployments', () => {
  const gitignore = readFileSync(new URL('.gitignore', root), 'utf8');
  const vercelignore = readFileSync(new URL('.vercelignore', root), 'utf8');
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
  assert.match(vercelignore, /^\.env$/m);
  assert.match(vercelignore, /^\.env\.\*$/m);
  assert.match(vercelignore, /^\*\*\/\.env\.\*$/m);
});
