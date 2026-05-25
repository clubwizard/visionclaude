import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file gets its own process so module-level caches in
    // crypto.ts / db.ts don't bleed across suites.
    isolate: true,
    pool: "forks",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
