import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function assetUrl(relativePath) {
  return new URL(`./assets/${relativePath}`, import.meta.url);
}

export function assetPath(relativePath) {
  return fileURLToPath(assetUrl(relativePath));
}

export function packageRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function requireSsh2() {
  return require('ssh2');
}
