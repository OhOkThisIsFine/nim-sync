import { describe, it, expect } from "vitest";
import { hashModels } from "../lib/crypto-utils.js";

describe("hashModels", () => {
  const modelA = { id: "model-a", name: "Model A" };
  const modelB = { id: "model-b", name: "Model B" };

  it("produces consistent hash for identical model lists", () => {
    const h1 = hashModels([modelA, modelB]);
    const h2 = hashModels([modelA, modelB]);
    expect(h1).toBe(h2);
  });

  it("produces same hash for different ordering (sorted by id)", () => {
    const h1 = hashModels([modelA, modelB]);
    const h2 = hashModels([modelB, modelA]);
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different model lists", () => {
    const h1 = hashModels([modelA]);
    const h2 = hashModels([modelB]);
    expect(h1).not.toBe(h2);
  });

  it("outputs a 64-character hex string", () => {
    const hash = hashModels([modelA]);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
