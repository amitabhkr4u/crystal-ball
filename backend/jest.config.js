/** @type {import("jest").Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  // ts-jest type-checks every .ts test and source file (the backend has no JavaScript left).
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }]
  },
  clearMocks: true,
  collectCoverageFrom: [
    "src/services/aiDecision.service.ts",
    "src/workers/**/*.ts",
    "src/sockets/**/*.ts",
    "src/auth/**/*.ts",
    "src/config/**/*.ts",
    "src/middleware/**/*.ts",
    "src/security/**/*.ts",
    "src/queues/**/*.ts",
    "src/prompts/**/*.ts",
    "src/utils/**/*.ts"
  ],
  coverageThreshold: { global: { branches: 35, functions: 45, lines: 35, statements: 35 } }
};
