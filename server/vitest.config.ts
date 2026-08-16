import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "test/live/**"],
    testTimeout: 15000,
  },
});
