import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    server: 'src/server.ts',
    migrate: 'src/migrate.ts',
    'import-alpha': 'src/import-alpha.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ['@kabanda/contracts', '@kabanda/domain'],
})
