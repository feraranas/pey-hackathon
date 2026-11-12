import { describe, expect, it } from "vitest";
import { runStory } from "../src/story-demo.js";

describe("one-command story demo", () => {
  it("replays Rafa, Ana and Luis against the local sandbox and every check passes", async () => {
    const lines: string[] = [];
    const checks = await runStory((l) => void lines.push(l));
    expect(checks).toBeGreaterThanOrEqual(15);
    const text = lines.join("\n");
    expect(text).toContain("Confirmado por pey: $2,800.00");
    expect(text).toContain("SIMULACIÓN LOCAL");
    expect(text).not.toMatch(/PEY_API_KEY|whsec_|sandbox-[0-9a-f]{16}/);
  }, 30_000);
});
