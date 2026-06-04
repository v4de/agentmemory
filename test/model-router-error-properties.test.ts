import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { OpenAIProvider } from "../src/providers/openai.js";

describe("Feature: model-router-integration, Property 9: Error response handling with body truncation", () => {
  /**
   * **Validates: Requirements 2.5, 5.4**
   *
   * For any HTTP response with a non-2xx status code and a response body of
   * arbitrary length, the thrown error message SHALL contain the numeric status
   * code AND the response body truncated to at most 200 characters.
   * Additionally, for any response where the body is not valid JSON
   * (malformed/unparseable), the provider SHALL throw an error containing
   * "Malformed response" and the body prefix (≤200 chars).
   */

  const ORIGINAL_BASE_URL = process.env["OPENAI_BASE_URL"];
  const ORIGINAL_ROUTING_MODE = process.env["MODEL_ROUTER_ROUTING_MODE"];
  const ORIGINAL_TIMEOUT = process.env["OPENAI_TIMEOUT_MS"];
  const ORIGINAL_LLM_TIMEOUT = process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];

  beforeEach(() => {
    process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
    delete process.env["MODEL_ROUTER_ROUTING_MODE"];
    delete process.env["OPENAI_TIMEOUT_MS"];
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    if (ORIGINAL_BASE_URL === undefined) delete process.env["OPENAI_BASE_URL"];
    else process.env["OPENAI_BASE_URL"] = ORIGINAL_BASE_URL;
    if (ORIGINAL_ROUTING_MODE === undefined) delete process.env["MODEL_ROUTER_ROUTING_MODE"];
    else process.env["MODEL_ROUTER_ROUTING_MODE"] = ORIGINAL_ROUTING_MODE;
    if (ORIGINAL_TIMEOUT === undefined) delete process.env["OPENAI_TIMEOUT_MS"];
    else process.env["OPENAI_TIMEOUT_MS"] = ORIGINAL_TIMEOUT;
    if (ORIGINAL_LLM_TIMEOUT === undefined) delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
    else process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = ORIGINAL_LLM_TIMEOUT;
    vi.restoreAllMocks();
  });

  // Generator: non-2xx HTTP status codes (400-599)
  const nonOkStatusArb = fc.integer({ min: 400, max: 599 });

  // Generator: random body strings of varying lengths (0-1000 chars)
  const bodyStringArb = fc.string({ minLength: 0, maxLength: 1000 });

  it("non-2xx responses: error contains status code and body text", async () => {
    await fc.assert(
      fc.asyncProperty(nonOkStatusArb, bodyStringArb, async (status, body) => {
        vi.restoreAllMocks();
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          return new Response(body, {
            status,
            headers: { "content-type": "text/plain" },
          });
        });

        process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
        delete process.env["MODEL_ROUTER_ROUTING_MODE"];

        const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 4096);

        const error = await provider
          .compress("system prompt", "user prompt")
          .catch((e: Error) => e);

        expect(error).toBeInstanceOf(Error);
        const msg = (error as Error).message;

        // Error message contains the numeric status code
        expect(msg).toContain(String(status));

        // Error message contains the body text
        // The error format is: "OpenAI API error (STATUS): BODY_TEXT"
        expect(msg).toContain(body);
      }),
      { numRuns: 100 },
    );
  });

  it("200 with malformed JSON: error contains 'Malformed response' and body truncated to ≤200 chars", async () => {
    // Generator: non-JSON strings of varying lengths that won't parse as JSON
    const malformedBodyArb = fc
      .string({ minLength: 1, maxLength: 1000 })
      .filter((s) => {
        try {
          JSON.parse(s);
          return false;
        } catch {
          return true;
        }
      });

    await fc.assert(
      fc.asyncProperty(malformedBodyArb, async (body) => {
        vi.restoreAllMocks();
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          return new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        });

        process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
        delete process.env["MODEL_ROUTER_ROUTING_MODE"];

        const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 4096);

        const error = await provider
          .compress("system prompt", "user prompt")
          .catch((e: Error) => e);

        expect(error).toBeInstanceOf(Error);
        const msg = (error as Error).message;

        // Error message contains "Malformed response"
        expect(msg).toContain("Malformed response");

        // Error message contains the status code 200
        expect(msg).toContain("200");

        // The error format is: "Malformed response: 200 BODY_SLICE"
        // The body is truncated via rawText.slice(0, 200)
        const expectedBodySlice = body.slice(0, 200);
        expect(msg).toContain(expectedBodySlice);

        // If body is longer than 200 chars, the full body should NOT be in the message
        if (body.length > 200) {
          expect(msg).not.toContain(body);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("200 with response_successful: false — error contains status and body truncated to ≤200 chars", async () => {
    // Generator: random body content embedded in a JSON response with response_successful: false
    const extraContentArb = fc.string({ minLength: 0, maxLength: 800 });

    await fc.assert(
      fc.asyncProperty(extraContentArb, async (extraContent) => {
        vi.restoreAllMocks();
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        const responseBody = JSON.stringify({
          response_successful: false,
          model: "gpt-4o-mini",
          choices: [{ message: { content: extraContent } }],
          error_detail: extraContent,
        });

        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          return new Response(responseBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        });

        process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
        delete process.env["MODEL_ROUTER_ROUTING_MODE"];

        const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 4096);

        const error = await provider
          .compress("system prompt", "user prompt")
          .catch((e: Error) => e);

        expect(error).toBeInstanceOf(Error);
        const msg = (error as Error).message;

        // Contains the status code
        expect(msg).toContain("200");

        // Contains "Model Router response failure"
        expect(msg).toContain("Model Router response failure");

        // The body portion after the prefix is ≤200 chars
        // Format: "Model Router response failure: 200 RAW_BODY_PREFIX"
        const bodyPortion = msg.replace(
          /^Model Router response failure:\s*200\s*/,
          "",
        );
        expect(bodyPortion.length).toBeLessThanOrEqual(200);
      }),
      { numRuns: 100 },
    );
  });
});
