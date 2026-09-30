import { describe, expect, it } from "vitest";
import { errorText } from "../../src/lib/usage/errorText.js";

describe("errorText", () => {
  it("returns trimmed strings and empty for blanks", () => {
    expect(errorText("  boom  ")).toBe("boom");
    expect(errorText("")).toBe("");
    expect(errorText("   ")).toBe("");
    expect(errorText(null)).toBe("");
    expect(errorText(undefined)).toBe("");
  });

  it("unwraps the common provider error envelopes", () => {
    expect(errorText({ message: "context length exceeded" })).toBe("context length exceeded");
    expect(errorText({ error: { message: "rate limited" } })).toBe("rate limited");
    expect(errorText({ error: "quota exceeded" })).toBe("quota exceeded");
    expect(errorText({ detail: "bad param" })).toBe("bad param");
    expect(errorText({ reason: "unsupported" })).toBe("unsupported");
    expect(errorText({ msg: "legacy" })).toBe("legacy");
  });

  it("never leaks [object Object]", () => {
    const shapes = [
      { message: "nested" },
      { error: { message: "deep" } },
      { model: "deepseek-v4.1-flash" },
      { codes: [1, 2, 3] },
      new Error("socket hang up"),
      42,
      false,
    ];
    for (const shape of shapes) {
      expect(errorText(shape)).not.toContain("[object Object]");
    }
  });

  it("serialises a message-less payload rather than hiding it", () => {
    expect(errorText({ model: "deepseek-v4.1-flash" })).toBe('{"model":"deepseek-v4.1-flash"}');
  });

  it("returns an empty string for an empty object", () => {
    expect(errorText({})).toBe("");
  });

  it("survives self-referencing and circular objects", () => {
    const self = { message: "loop" };
    self.error = self;
    expect(errorText(self)).toBe("loop");

    const a = { detail: "" };
    const b = { error: a };
    a.reason = b;
    expect(() => errorText(a)).not.toThrow();
  });

  it("takes the first usable entry of an array-like error list", () => {
    expect(errorText([{ message: "first" }, { message: "second" }])).toBe("first");
    expect(errorText([])).toBe("");
  });

  it("unwraps nested envelopes several levels deep", () => {
    expect(errorText({ error: { detail: { message: "deep chain" } } })).toBe("deep chain");
  });
});
