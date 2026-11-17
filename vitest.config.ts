import { defineConfig } from 'vitest/config';

// Pruebas unitarias: sin base de datos. Vite 8 (Oxc) emite los metadatos de decoradores que Nest
// necesita (respeta emitDecoratorMetadata del tsconfig); no hace falta SWC.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
});
