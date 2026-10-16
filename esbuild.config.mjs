import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: ['node18'],
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: '#!/usr/bin/env node',
  },
})
