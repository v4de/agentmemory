import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";

/**
 * Unit tests for OpenAIProvider routing mode injection and observability logging.
 *
 * Validates: Requirements 2.4, 3.1, 3.2, 5.1
 */

describe("OpenAIProvider — routing mode injection", () => {
  const ORIGINAL_BASE_URL = process.env["OPENAI_BASE_URL"];
  const ORIGINAL_ROUTING_MODE = process.env["MODEL_ROUTER_ROUTING_MODE"];
  const ORIGINAL_TIMEOUT = process.env["OPENAI_TIMEOUT_MS"];
  const ORIGINAL_LLM_TIMEOUT = process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];

  let capturedBody: Record<string, unknown> | null = null;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedBody = null;
    delete process.env["OPENAI_TIMEOUT_MS"];
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

  function mockFetchCapturingBody(responseModel = "gpt-4.1-nano"): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "response content" } }],
            model: responseModel,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
  }

  it("includes model_router_mode in request body when Azure endpoint + routing mode set", async () => {
    process.env["OPENAI_BASE_URL"] = "https://myresource.openai.azure.com";
    process.env["MODEL_ROUTER_ROUTING_MODE"] = "balanced";
    mockFetchCapturingBody();

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await provider.compress("system prompt", "user prompt");

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.model_router_mode).toBe("balanced");
  });

  it("includes model_router_mode lowercased for COST (uppercase)", async () => {
    process.env["OPENAI_BASE_URL"] = "https://myresource.openai.azure.com";
    process.env["MODEL_ROUTER_ROUTING_MODE"] = "COST";
    mockFetchCapturingBody();

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await provider.compress("system prompt", "user prompt");

    expect(capturedBody!.model_router_mode).toBe("cost");
  });

  it("includes model_router_mode lowercased for Quality (mixed case)", async () => {
    process.env["OPENAI_BASE_URL"] = "https://myresource.openai.azure.com";
    process.env["MODEL_ROUTER_ROUTING_MODE"] = "Quality";
    mockFetchCapturingBody();

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await provider.compress("system prompt", "user prompt");

    expect(capturedBody!.model_router_mode).toBe("quality");
  });

  it("omits model_router_mode when endpoint is non-Azure (api.openai.com)", async () => {
    process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
    process.env["MODEL_ROUTER_ROUTING_MODE"] = "balanced";
    mockFetchCapturingBody();

    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 4096);
    await provider.compress("system prompt", "user prompt");

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!).not.toHaveProperty("model_router_mode");
  });

  it("omits model_router_mode when routing mode env var is not set", async () => {
    process.env["OPENAI_BASE_URL"] = "https://myresource.openai.azure.com";
    delete process.env["MODEL_ROUTER_ROUTING_MODE"];
    mockFetchCapturingBody();

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await provider.compress("system prompt", "user prompt");

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!).not.toHaveProperty("model_router_mode");
  });

  it("omits model_router_mode when endpoint is non-Azure (DeepSeek)", async () => {
    process.env["OPENAI_BASE_URL"] = "https://api.deepseek.com/v1";
    process.env["MODEL_ROUTER_ROUTING_MODE"] = "quality";
    mockFetchCapturingBody();

    const provider = new OpenAIProvider("test-key", "deepseek-chat", 4096);
    await provider.compress("system prompt", "user prompt");

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!).not.toHaveProperty("model_router_mode");
  });

  it("omits model_router_mode when routing mode is invalid (even on Azure)", async () => {
    process.env["OPENAI_BASE_URL"] = "https://myresource.openai.azure.com";
    process.env["MODEL_ROUTER_ROUTING_MODE"] = "fastest";
    mockFetchCapturingBody();

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await provider.compress("system prompt", "user prompt");

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!).not.toHaveProperty("model_router_mode");
  });
});

describe("OpenAIProvider — observability logging", () => {
  const ORIGINAL_BASE_URL = process.env["OPENAI_BASE_URL"];
  const ORIGINAL_ROUTING_MODE = process.env["MODEL_ROUTER_ROUTING_MODE"];
  const ORIGINAL_TIMEOUT = process.env["OPENAI_TIMEOUT_MS"];
  const ORIGINAL_LLM_TIMEOUT = process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];

  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env["OPENAI_TIMEOUT_MS"];
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
    delete process.env["MODEL_ROUTER_ROUTING_MODE"];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

  function mockFetchWithModel(responseModel: string): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            model: responseModel,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );
  }

  it("logs requested and actual model names to stderr on success", async () => {
    process.env["OPENAI_BASE_URL"] = "https://myresource.openai.azure.com";
    mockFetchWithModel("gpt-4.1-nano");

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await provider.compress("system", "user");

    expect(stderrSpy).toHaveBeenCalled();
    const logLine = stderrSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[agentmemory] LLM response:"),
    );
    expect(logLine).toBeDefined();
    const msg = logLine![0] as string;
    expect(msg).toContain("requested=model-router");
    expect(msg).toContain("actual=gpt-4.1-nano");
  });

  it("logs different actual model name when Model Router routes to another model", async () => {
    process.env["OPENAI_BASE_URL"] = "https://myresource.openai.azure.com";
    mockFetchWithModel("gpt-4o");

    const provider = new OpenAIProvider("test-key", "model-router", 4096);
    await provider.summarize("system", "user");

    const logLine = stderrSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[agentmemory] LLM response:"),
    );
    expect(logLine).toBeDefined();
    const msg = logLine![0] as string;
    expect(msg).toContain("requested=model-router");
    expect(msg).toContain("actual=gpt-4o");
  });

  it("logs on non-Azure endpoints as well when model field is present", async () => {
    process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
    mockFetchWithModel("gpt-4o-mini");

    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 4096);
    await provider.compress("system", "user");

    const logLine = stderrSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[agentmemory] LLM response:"),
    );
    expect(logLine).toBeDefined();
    const msg = logLine![0] as string;
    expect(msg).toContain("requested=gpt-4o-mini");
    expect(msg).toContain("actual=gpt-4o-mini");
  });

  it("does not log model line when response has no model field", async () => {
    process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );

    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 4096);
    await provider.compress("system", "user");

    const logLine = stderrSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[agentmemory] LLM response:"),
    );
    expect(logLine).toBeUndefined();
  });
});
