import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { buildAuthHeaders, buildChatUrl, detectAzure } from "../src/providers/_openai-shared.js";
import { OpenAIProvider } from "../src/providers/openai.js";

// Generator for valid Azure-style subdomains (lowercase alphanumeric + hyphens)
const azureSubdomainArb = fc
  .array(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz0123456789-".split(""))), {
    minLength: 1,
    maxLength: 20,
  })
  .map((chars) => chars.join(""));

describe("Feature: model-router-integration, Property 1: Azure detection produces correct auth headers", () => {
  /**
   * **Validates: Requirements 2.1**
   *
   * For any URL whose hostname ends with `.openai.azure.com`, buildAuthHeaders
   * returns an `api-key` header. For any URL whose hostname does NOT end with
   * `.openai.azure.com`, it returns an `Authorization: Bearer` header.
   */

  it("Azure hosts produce api-key header", () => {
    fc.assert(
      fc.property(
        azureSubdomainArb,
        fc.string({ minLength: 1, maxLength: 50 }),
        (subdomain, apiKey) => {
          const baseUrl = `https://${subdomain}.openai.azure.com`;
          const isAzure = detectAzure(baseUrl);

          expect(isAzure).toBe(true);

          const headers = buildAuthHeaders(apiKey, isAzure);
          expect(headers["api-key"]).toBe(apiKey);
          expect(headers["Content-Type"]).toBe("application/json");
          expect(headers["Authorization"]).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("non-Azure hosts produce Authorization: Bearer header", () => {
    fc.assert(
      fc.property(
        fc.domain().filter((d) => !d.endsWith(".openai.azure.com")),
        fc.string({ minLength: 1, maxLength: 50 }),
        (hostname, apiKey) => {
          const baseUrl = `https://${hostname}`;
          const isAzure = detectAzure(baseUrl);

          expect(isAzure).toBe(false);

          const headers = buildAuthHeaders(apiKey, isAzure);
          expect(headers["Authorization"]).toBe(`Bearer ${apiKey}`);
          expect(headers["Content-Type"]).toBe("application/json");
          expect(headers["api-key"]).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("detectAzure correctly classifies hostnames ending with .openai.azure.com", () => {
    fc.assert(
      fc.property(azureSubdomainArb, (subdomain) => {
        const azureUrl = `https://${subdomain}.openai.azure.com`;
        expect(detectAzure(azureUrl)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("detectAzure correctly rejects hostnames NOT ending with .openai.azure.com", () => {
    fc.assert(
      fc.property(
        fc.domain().filter((d) => !d.endsWith(".openai.azure.com")),
        (hostname) => {
          const url = `https://${hostname}`;
          expect(detectAzure(url)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: model-router-integration, Property 3: Model name passthrough in request body", () => {
  const ORIGINAL_BASE_URL = process.env["OPENAI_BASE_URL"];
  const ORIGINAL_ROUTING_MODE = process.env["MODEL_ROUTER_ROUTING_MODE"];
  const ORIGINAL_TIMEOUT = process.env["OPENAI_TIMEOUT_MS"];
  const ORIGINAL_LLM_TIMEOUT = process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];

  let capturedBody: Record<string, unknown> | null = null;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capturedBody = null;
    process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
    delete process.env["MODEL_ROUTER_ROUTING_MODE"];
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

  function mockFetchCapturingBody(): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "response content" } }],
            model: "gpt-4o-mini",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
  }

  /**
   * **Validates: Requirements 2.3**
   *
   * For any non-empty model name string, the constructed request body
   * SHALL contain a `model` field whose value is exactly that string.
   */
  it("request body model field equals the input model name exactly", async () => {
    const nonEmptyStringArb = fc.string({ minLength: 1 });

    await fc.assert(
      fc.asyncProperty(nonEmptyStringArb, async (modelName) => {
        capturedBody = null;
        vi.restoreAllMocks();
        process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
        delete process.env["MODEL_ROUTER_ROUTING_MODE"];
        stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        mockFetchCapturingBody();

        const provider = new OpenAIProvider("test-key", modelName, 4096);
        await provider.compress("system prompt", "user prompt");

        expect(capturedBody).not.toBeNull();
        expect(capturedBody!.model).toBe(modelName);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: model-router-integration, Property 2: Azure v1 URL construction", () => {
  /**
   * **Validates: Requirements 2.2**
   *
   * For any Azure base URL (hostname ending in `.openai.azure.com`) that does
   * NOT contain a `/openai/deployments/` path segment, buildChatUrl SHALL
   * produce a URL with the path `/openai/v1/chat/completions` and no
   * `api-version` query parameter.
   */
  it("produces /openai/v1/chat/completions with no api-version for Azure v1 URLs", () => {
    // Generator: random Azure hostnames (ending with .openai.azure.com)
    // without /openai/deployments/ in the path.
    const azureResourceName = fc
      .stringMatching(/^[a-z][a-z0-9]{1,20}$/)
      .filter((s) => s.length >= 2);

    // Optional path segments that do NOT contain "openai/deployments/"
    const safePath = fc.constantFrom(
      "",
      "/",
      "/openai",
      "/openai/",
      "/openai/v1",
      "/openai/v1/",
    );

    const azureBaseUrlArb = fc
      .tuple(azureResourceName, safePath)
      .map(([resource, path]) => `https://${resource}.openai.azure.com${path}`)
      .filter((url) => !url.includes("/openai/deployments/"));

    // The api-version param is passed but should be ignored on v1 paths
    const apiVersionArb = fc.constantFrom(
      "2024-08-01-preview",
      "2025-01-01",
      "any-version",
    );

    fc.assert(
      fc.property(azureBaseUrlArb, apiVersionArb, (baseUrl, apiVersion) => {
        const result = buildChatUrl(baseUrl, true, apiVersion);
        const parsed = new URL(result);

        // Path must be /openai/v1/chat/completions
        expect(parsed.pathname).toBe("/openai/v1/chat/completions");

        // No api-version query parameter
        expect(parsed.searchParams.has("api-version")).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: model-router-integration, Property 4: Routing mode conditional injection", () => {
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

  function mockFetchCapturingBody(): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "response content" } }],
            model: "model-router",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
  }

  // Generator: valid routing modes with random casing
  const validModeArb = fc
    .constantFrom("cost", "balanced", "quality")
    .chain((mode) =>
      fc.func(fc.boolean()).map((randomize) =>
        mode
          .split("")
          .map((ch, i) => (randomize(i) ? ch.toUpperCase() : ch.toLowerCase()))
          .join(""),
      ),
    );

  // Generator: Azure resource name for subdomain
  const azureResourceArb = fc
    .stringMatching(/^[a-z][a-z0-9]{1,15}$/)
    .filter((s) => s.length >= 2);

  // Generator: non-Azure domains
  const nonAzureDomainArb = fc.constantFrom(
    "https://api.openai.com",
    "https://api.deepseek.com/v1",
    "https://openrouter.ai/api/v1",
    "https://localhost:8080",
    "https://my-proxy.example.com",
  );

  /**
   * **Validates: Requirements 2.4, 3.1, 3.2, 3.3**
   *
   * For any Azure endpoint with a valid routing mode set (one of "cost",
   * "balanced", "quality" in any casing), the request body SHALL include a
   * `model_router_mode` field with the lowercased value. For any non-Azure
   * endpoint OR when routing mode is unset, the request body SHALL NOT
   * contain a `model_router_mode` field.
   */
  it("Azure + valid mode → model_router_mode present (lowercased)", async () => {
    await fc.assert(
      fc.asyncProperty(azureResourceArb, validModeArb, async (resource, mode) => {
        capturedBody = null;
        vi.restoreAllMocks();
        stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        mockFetchCapturingBody();

        const baseUrl = `https://${resource}.openai.azure.com`;
        process.env["OPENAI_BASE_URL"] = baseUrl;
        process.env["MODEL_ROUTER_ROUTING_MODE"] = mode;

        const provider = new OpenAIProvider("test-key", "model-router", 4096, baseUrl);
        await provider.compress("system prompt", "user prompt");

        expect(capturedBody).not.toBeNull();
        expect(capturedBody!.model_router_mode).toBe(mode.toLowerCase());
      }),
      { numRuns: 100 },
    );
  });

  it("non-Azure endpoint → model_router_mode absent", async () => {
    await fc.assert(
      fc.asyncProperty(nonAzureDomainArb, validModeArb, async (baseUrl, mode) => {
        capturedBody = null;
        vi.restoreAllMocks();
        stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        mockFetchCapturingBody();

        process.env["OPENAI_BASE_URL"] = baseUrl;
        process.env["MODEL_ROUTER_ROUTING_MODE"] = mode;

        const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 4096, baseUrl);
        await provider.compress("system prompt", "user prompt");

        expect(capturedBody).not.toBeNull();
        expect(capturedBody!.model_router_mode).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it("routing mode unset → model_router_mode absent (even for Azure)", async () => {
    await fc.assert(
      fc.asyncProperty(azureResourceArb, async (resource) => {
        capturedBody = null;
        vi.restoreAllMocks();
        stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        mockFetchCapturingBody();

        const baseUrl = `https://${resource}.openai.azure.com`;
        process.env["OPENAI_BASE_URL"] = baseUrl;
        delete process.env["MODEL_ROUTER_ROUTING_MODE"];

        const provider = new OpenAIProvider("test-key", "model-router", 4096, baseUrl);
        await provider.compress("system prompt", "user prompt");

        expect(capturedBody).not.toBeNull();
        expect(capturedBody!.model_router_mode).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
