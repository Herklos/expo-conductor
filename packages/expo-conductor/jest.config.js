/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Transpile-only: keeps tests fast and decoupled from strict unused-var
        // rules. Type correctness is enforced separately by `pnpm typecheck`.
        isolatedModules: true,
      },
    ],
  },
  clearMocks: true,
};
