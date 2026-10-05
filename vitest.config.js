import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Ladybug's native addon reserves significant virtual address space per
    // Database instance; running test files in parallel worker processes has
    // been observed to crash a worker outright. Force single-process,
    // sequential execution to keep native DB access serialized across the
    // whole test run, not just within one file.
    fileParallelism: false,
    pool: "forks",
    isolate: false,
    // Never download or run the real embedding/re-ranking models in the
    // suite; tests that need models inject deterministic fakes.
    env: { BRAINDUMP_MODELS: "off" },
  },
});
