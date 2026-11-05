import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchInstalled } from './mac-install.mjs';

try {
  const args = process.argv.length > 2 ? process.argv.slice(2) : ['setup'];
  process.exitCode = await launchInstalled(path.dirname(fileURLToPath(import.meta.url)), args);
} catch (error) {
  process.stderr.write('EmDash Vercel setup: ' + error.message + '\n');
  process.exitCode = 1;
}
