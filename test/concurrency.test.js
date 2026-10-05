import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initTool, addEntityTool, __enqueueForTesting } from "../src/tools.js";

let dbDir;

afterEach(() => {
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("__enqueueForTesting (the withDb serialization primitive)", () => {
  it("runs same-project calls strictly one at a time, in order", async () => {
    const order = [];
    const project = "queue-test-project";

    const slow = (label, ms) =>
      __enqueueForTesting(project, async () => {
        order.push(`${label}-start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${label}-end`);
      });

    // If these ran concurrently, "b-start" would appear before "a-end".
    await Promise.all([slow("a", 30), slow("b", 5)]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("continues processing later calls even if an earlier one rejects", async () => {
    const project = "queue-test-project-2";

    await expect(
      __enqueueForTesting(project, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const result = await __enqueueForTesting(project, async () => "still works");
    expect(result).toBe("still works");
  });
});

describe("concurrent writes to the same project", () => {
  it("serializes overlapping addEntityTool calls without corrupting the db", async () => {
    const project = `concurrency-test-${Date.now()}`;
    dbDir = path.join(os.homedir(), ".agents", "braindump", project);

    await initTool({ project });

    // Fire many concurrent writes at the same project's db. Without
    // serialization this used to crash the Ladybug native module mid-write
    // and permanently corrupt the db file (every later open would SIGSEGV).
    const calls = Array.from({ length: 20 }, (_, i) =>
      addEntityTool({
        project,
        name: `entity${i}`,
        file: "a.js",
        kind: "function",
        description: `entity number ${i}`,
      })
    );

    const results = await Promise.all(calls);
    expect(results).toHaveLength(20);
    expect(new Set(results.map((r) => r.id)).size).toBe(20);
  });
});
