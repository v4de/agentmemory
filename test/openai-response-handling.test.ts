import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";

/**
 * Unit tests for OpenAIProvider response flag parsing and malformed JSON handling.
 * Validates: Requirements 2.5, 5.4
 */
describe("OpenAIProvider — response flag parsing and malformed JSON handling", () => {
  const ORIGINAL_KEY = process.env["OPENAI_API_KEY"];
  const ORIGINAL_BASE = process.env["OPENAI_BASE_URL"];
  const ORIGINAL_TIMEOUT = process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];

  beforeEach(() => {
    process.env["OPENAI_API_KEY"] = "test-key";
    process.env["OPENAI_BASE_URL"] = "https://myresource.openai.azure.com";
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "5000";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = ORIGINAL_KEY;
    if (ORIGINAL_BASE === undefined) delete process.env["OPENAI_BASE_URL"];
    else process.env["OPENAI_BASE_URL"] = ORIGINAL_BASE;
    if (ORIGINAL_TIMEOUT === undefined) delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
    else process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = ORIGINAL_TIMEOUT;
    vi.restoreAllMocks();
  });

  it("throws error when response_successful is false (200 status)", async () => {
    const body = {
      response_successful: false,
      model_router_response_received: true,
      choices: [{ message: { content: "hello" } }],
      model: "gpt-4.1-nano",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await expect(provider.compress("system", "user")).rejects.toThrow(
      /Model Router response failure.*200/,
    );
  });

  it("throws error when model_router_response_received is false (200 status)", async () => {
    const body = {
      response_successful: true,
      model_router_response_received: false,
      choices: [{ message: { content: "hello" } }],
      model: "gpt-4.1-nano",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await expect(provider.compress("system", "user")).rejects.toThrow(
      /Model Router response failure.*200/,
    );
  });

  it("succeeds when both flags are truthy and valid content is present", async () => {
    const body = {
      response_successful: true,
      model_router_response_received: true,
      choices: [{ message: { content: "compressed result" } }],
      model: "gpt-4.1-nano",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    const result = await provider.compress("system", "user");
    expect(result).toBe("compressed result");
  });

  it("throws error with raw text prefix for unparseable body (200 status)", async () => {
    const malformedBody = "this is not json at all {{{";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(malformedBody, { status: 200 }),
    );

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await expect(provider.compress("system", "user")).rejects.toThrow(
      /Malformed response.*200.*this is not json/,
    );
  });

  it("truncates error body to 200 characters when body is longer", async () => {
    const longBody = "x".repeat(500);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(longBody, { status: 200 }),
    );

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    try {
      await provider.compress("system", "user");
      expect.fail("Expected an error to be thrown");
    } catch (err: unknown) {
      const message = (err as Error).message;
      // The raw text in the error should be at most 200 chars
      // Error format: "Malformed response: 200 <body>"
      const bodyPart = message.replace(/^Malformed response: \d+ /, "");
      expect(bodyPart.length).toBeLessThanOrEqual(200);
      expect(bodyPart).toBe("x".repeat(200));
    }
  });
});
