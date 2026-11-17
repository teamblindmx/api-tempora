import { defineConfig } from 'vitest/config';

// Pruebas contra PostgreSQL real. global-setup crea una base temporal, la migra y la borra al final.
export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
