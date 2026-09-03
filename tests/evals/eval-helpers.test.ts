import { describe, expect, test } from "bun:test";
import { buildEvalProcessEnv, shouldLoadDotEnv } from "./eval-helpers";

describe("eval helpers", () => {
  test("passes the selected eval model to fx through FIBER_MODEL", () => {
    const previous = process.env.FIBER_MODEL;
    process.env.FIBER_MODEL = "ambient/model";

    try {
      const env = buildEvalProcessEnv("/tmp/fx-eval-home-test", "selected/model");

      expect(env.FIBER_MODEL).toBe("selected/model");
      expect(env.HOME).toBe("/tmp/fx-eval-home-test");
      expect(env.NO_COLOR).toBe("1");
    } finally {
      if (previous === undefined) {
        delete process.env.FIBER_MODEL;
      } else {
        process.env.FIBER_MODEL = previous;
      }
    }
  });

  test("does not load repository dotenv files in a hermetic run", () => {
    expect(shouldLoadDotEnv({ FIBER_E2E_DISABLE_DOTENV: "1" })).toBe(false);
    expect(shouldLoadDotEnv({})).toBe(true);
  });
});
