import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { OpenAIProvider } from "../src/providers/openai.js";

describe("Feature: model-router-integration, Property 10: Success response model logging", () => {
  /**
   * **Validates: Requirements 5.1**
   *
   * For any successful HTTP 200 response containing a `model` field in the
   * JSON body, the provider SHALL write a log line to stderr that includes
   * both the requested model name (from the request) and the actual model
   * name (from the response).
   */

  const ORIGINAL_BASE_URL = process.env["OPENAI_BASE_URL"];
  const ORIGINAL_ROUTING_MODE = process.env["MODEL_ROUTER_ROUTING_MODE"];
  const ORIGINAL_TIMEOUT = process.env["OPENAI_TIMEOUT_MS"];
  const ORIGINAL_LLM_TIMEOUT = process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];

  let stderrCalls: string[];

  beforeEach(() => {
    stderrCalls = [];
    process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
    delete process.env["MODEL_ROUTER_ROUTING_MODE"];
    delete process.env["OPENAI_TIMEOUT_MS"];
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
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

  // Generator: non-empty strings for model names (avoid control chars that break JSON)
  const modelNameArb = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => {
    // Must not contain characters that break JSON serialization or stderr output
    return !s.includes("\0") && s.trim().length > 0;
  });

  it("stderr log line includes both requested and actual model names", async () => {
    await fc.assert(
      fc.asyncProperty(modelNameArb, modelNameArb, async (requestedModel, responseModel) => {
        stderrCalls = [];
        vi.restoreAllMocks();

        // Mock stderr to capture log output
        vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
          stderrCalls.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
          return true;
        });

        // Mock fetch to return 200 with the generated response model name
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "test response" } }],
              model: responseModel,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        });

        process.env["OPENAI_BASE_URL"] = "https://api.openai.com";

        const provider = new OpenAIProvider("test-key", requestedModel, 4096);
        await provider.compress("system prompt", "user prompt");

        // Find the log line that contains both model names
        const logLine = stderrCalls.find(
          (line) => line.includes(requestedModel) && line.includes(responseModel),
        );
        expect(logLine).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });
});
