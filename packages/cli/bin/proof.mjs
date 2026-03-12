#!/usr/bin/env node

// Thin wrapper that runs the CLI via tsx for development,
// or the compiled JS in production.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = join(__dirname, '..', 'dist', 'index.js');

if (existsSync(distEntry)) {
  await import(distEntry);
} else {
  // Development: run TypeScript source directly via tsx
  const { register } = await import('node:module');
  try {
    // Node 20.6+ with --import tsx
    register('tsx/esm', import.meta.url);
  } catch {
    // Fallback: just try importing the TS source (works if tsx is in the loader chain)
  }
  await import(join(__dirname, '..', 'src', 'index.ts'));
}
