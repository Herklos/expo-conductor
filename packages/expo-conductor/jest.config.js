/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // The ts-jest preset supplies the .ts(x) transform; it runs transpile-only
  // because `isolatedModules: true` lives in tsconfig.json (keeps tests fast and
  // decoupled from strict unused-var rules — type correctness is enforced by
  // `pnpm typecheck`). The flag moved out of here per ts-jest's deprecation notice.
  clearMocks: true,
};
