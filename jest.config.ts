import type { Config } from 'jest';

// Unit tests for the NPRS domain (engine, margin, validation, indicators) and the
// archive client's parsing / retry behaviour. Tests run in Node: no browser, no DB.
const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: true,
        tsconfig: {
          module: 'node16',
          moduleResolution: 'node16',
          target: 'ES2020',
          rootDir: '.',
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
          types: ['jest', 'node'],
          paths: { '@/*': ['./src/*'] },
        },
      },
    ],
  },
};

export default config;
