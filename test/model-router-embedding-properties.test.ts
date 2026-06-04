import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { withDimensionGuard } from "../src/providers/embedding/index.js";
import type { EmbeddingProvider } from "../src/types.js";

describe("Feature: model-router-integration, Property 7: Embedding dimension guard", () => {
  /**
   * **Validates: Requirements 4.5**
   *
   * For any embedding vector whose length differs from the provider's configured
   * `dimensions` value, the `withDimensionGuard` wrapper SHALL throw an error
   * containing the expected and actual dimension counts.
   */

  const EXPECTED_DIMENSIONS = 1536;

  // Generator: random positive integers that are NOT 1536
  const wrongDimensionArb = fc
    .nat({ max: 5000 })
    .filter((n) => n !== EXPECTED_DIMENSIONS && n > 0);

  function fakeProvider(
    dimensions: number,
    returnLength: number,
  ): EmbeddingProvider {
    return {
      name: "fake-embedding",
      dimensions,
      embed: async () => new Float32Array(returnLength),
      embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array(returnLength)),
    };
  }

  it("embed() throws error with expected and actual dimensions for wrong-size vectors", async () => {
    await fc.assert(
      fc.asyncProperty(wrongDimensionArb, async (actualDim) => {
        const provider = fakeProvider(EXPECTED_DIMENSIONS, actualDim);
        const guarded = withDimensionGuard(provider);

        const error = await guarded.embed("test input").catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        const msg = (error as Error).message;
        expect(msg).toContain(String(EXPECTED_DIMENSIONS));
        expect(msg).toContain(String(actualDim));
      }),
      { numRuns: 100 },
    );
  });

  it("embedBatch() throws error with expected and actual dimensions for wrong-size vectors", async () => {
    await fc.assert(
      fc.asyncProperty(wrongDimensionArb, async (actualDim) => {
        const provider = fakeProvider(EXPECTED_DIMENSIONS, actualDim);
        const guarded = withDimensionGuard(provider);

        const error = await guarded
          .embedBatch(["test input"])
          .catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        const msg = (error as Error).message;
        expect(msg).toContain(String(EXPECTED_DIMENSIONS));
        expect(msg).toContain(String(actualDim));
      }),
      { numRuns: 100 },
    );
  });

  it("embedImage() throws error with expected and actual dimensions for wrong-size vectors", async () => {
    await fc.assert(
      fc.asyncProperty(wrongDimensionArb, async (actualDim) => {
        const providerBase: EmbeddingProvider = {
          name: "fake-image-embedding",
          dimensions: EXPECTED_DIMENSIONS,
          embed: async () => new Float32Array(EXPECTED_DIMENSIONS),
          embedBatch: async (texts: string[]) =>
            texts.map(() => new Float32Array(EXPECTED_DIMENSIONS)),
          embedImage: async () => new Float32Array(actualDim),
        };
        const guarded = withDimensionGuard(providerBase);

        expect(guarded.embedImage).toBeDefined();
        const error = await guarded
          .embedImage!("/tmp/test.png")
          .catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        const msg = (error as Error).message;
        expect(msg).toContain(String(EXPECTED_DIMENSIONS));
        expect(msg).toContain(String(actualDim));
      }),
      { numRuns: 100 },
    );
  });

  it("correctly sized vectors pass through without error", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(EXPECTED_DIMENSIONS),
        async (dim) => {
          const provider = fakeProvider(dim, dim);
          const guarded = withDimensionGuard(provider);

          const result = await guarded.embed("test input");
          expect(result.length).toBe(EXPECTED_DIMENSIONS);
        },
      ),
      { numRuns: 10 },
    );
  });
});
