import { describe, expect, it } from "vitest";

import { canonicalJson, sha256, sha256Json } from "../../src/core/digest.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(
      canonicalJson({
        z: 1,
        a: { y: true, b: null },
      }),
    ).toBe('{"a":{"b":null,"y":true},"z":1}');
  });

  it("retains array order", () => {
    expect(canonicalJson(["second", "first"])).toBe('["second","first"]');
  });
});

describe("sha256", () => {
  it("produces the same digest for equivalent objects", () => {
    expect(sha256({ a: 1, b: 2 })).toBe(sha256({ b: 2, a: 1 }));
  });

  it("hashes arbitrary JSON-compatible objects canonically", () => {
    expect(sha256Json({ a: 1, b: 2 })).toBe(sha256Json({ b: 2, a: 1 }));
  });
});
