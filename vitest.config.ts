import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // One Postgres serves the whole run. Each test file works in a database of its own.
    globalSetup: ["./test/postgres.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
