import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
}

export default defineConfig([
  { ...shared, entry: { index: 'lib/types/index.js' } },
  { ...shared, entry: { host: 'lib/types/host.js' } },
])
