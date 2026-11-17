import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reportOnFailure: true,
      include: ["src/lib/demoApi.ts", "src/lib/validate.ts", "src/lib/stats.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
