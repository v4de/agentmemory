# Implementation Plan: Model Router Integration

## Overview

This plan implements Azure AI Foundry Model Router integration across two codebases: minimal TypeScript changes in agentmemory (routing mode injection, response flag parsing, malformed JSON handling, and observability logging) and a new Terraform module in azure.foundry.terraform. The implementation proceeds infrastructure-first, then application code, then property-based tests to validate correctness properties.

## Tasks

- [x] 1. Create Terraform Model Router module
  - [x] 1.1 Create `modules/model-router/variables.tf` with `model_router_config` variable, `cognitive_account_id`, and `model_deployment_names` inputs including validation rules for capacity (1-10000), non-empty model_subset when enabled, and model_subset max 20 entries
    - Define `model_router_config` as object with fields: `enabled` (bool), `routing_mode` (string), `model_subset` (list(string)), `capacity` (number)
    - Add validation: capacity between 1 and 10000
    - Add validation: model_subset must have ≥1 entry when enabled (`!enabled || length(model_subset) >= 1`)
    - Add validation: model_subset must have ≤20 entries (`length(model_subset) <= 20`)
    - _Requirements: 1.1, 1.2, 1.7, 6.1, 6.4_

  - [x] 1.2 Create `modules/model-router/main.tf` with the `azurerm_cognitive_deployment` resource for Model Router (conditional on `enabled`), and a precondition validating model_subset entries exist in model_deployment_names
    - Resource: `azurerm_cognitive_deployment` with count based on `enabled`
    - Model format "OpenAI", name "model-router", version "2025-11-18"
    - SKU "GlobalStandard" with configurable capacity
    - Add precondition: each model_subset entry must exist in model_deployment_names
    - _Requirements: 1.1, 1.3, 6.5_

  - [x] 1.3 Create `modules/model-router/outputs.tf` with `model_router_endpoint` (URL format) and `model_router_deployment_name` outputs (null when disabled)
    - Output endpoint in format `https://<resource>.openai.azure.com`
    - Output deployment name from the created resource
    - Both outputs return null when model_router_config.enabled is false
    - _Requirements: 1.5, 6.2, 6.3_

- [x] 2. Integrate Model Router module into root Terraform configuration
  - [x] 2.1 Add `model_router_config` variable to root `variables.tf` with default (enabled=false, routing_mode="balanced", model_subset=[], capacity=50) and add region validation to the AI Services module location variable
    - Default disables Model Router so existing deployments are unaffected
    - Region validation: location must be in ["eastus2", "swedencentral"]
    - _Requirements: 1.3, 1.4, 1.6, 6.1, 6.2_

  - [x] 2.2 Add `module "model_router"` block to root `main.tf` passing cognitive_account_id, model_router_config, and model_deployment_names; add Model Router outputs to root `outputs.tf`
    - Wire module source to `./modules/model-router`
    - Pass `model_deployment_names` derived from `var.model_deployments`
    - Add root outputs: `model_router_endpoint`, `model_router_deployment_name`
    - _Requirements: 1.5, 6.3_

- [x] 3. Checkpoint - Validate Terraform configuration
  - Ensure `terraform validate` passes for the azure.foundry.terraform root module. Run `terraform plan` with model_router_config.enabled=false to confirm zero Model Router resources. Ask the user if questions arise.

- [x] 4. Implement routing mode resolution and response handling in agentmemory
  - [x] 4.1 Add `resolveRoutingMode()` function to `src/providers/_openai-shared.ts` that validates `MODEL_ROUTER_ROUTING_MODE` env var (case-insensitive), logs a warning to stderr for invalid values, and returns undefined for non-Azure endpoints
    - Accept envValue (string|undefined) and isAzure (boolean) parameters
    - Normalize to lowercase, validate against ["cost", "balanced", "quality"]
    - Log warning to stderr for unrecognized values with the three valid options listed
    - Return undefined when envValue is unset, isAzure is false, or value is invalid
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 4.2 Modify `OpenAIProvider` in `src/providers/openai.ts` to resolve routing mode at construction and inject `model_router_mode` into the request body when the endpoint is Azure and routing mode is set
    - Call `resolveRoutingMode(process.env.MODEL_ROUTER_ROUTING_MODE, this.isAzure)` during construction
    - In the call method: conditionally add `model_router_mode` field to request body
    - _Requirements: 2.4, 3.1, 3.2, 3.3_

  - [x] 4.3 Implement response flag parsing in `OpenAIProvider.call()` — after receiving HTTP 200, parse JSON and check `response_successful` and `model_router_response_received` flags; if either is `false`, record circuit breaker failure and throw error with status + body truncated to 200 chars
    - After fetch returns 200: parse response body as JSON
    - Check `response_successful === false` or `model_router_response_received === false`
    - If either flag indicates failure: record circuit breaker failure, throw error with `"Model Router response failure: ${status} ${body.slice(0, 200)}"`
    - If flags indicate success (or are absent): record circuit breaker success, extract content
    - _Requirements: 2.5, 5.4_

  - [x] 4.4 Implement malformed JSON handling in `OpenAIProvider.call()` — if `response.json()` throws (malformed body), catch the parse error, record circuit breaker failure, and throw with raw text prefix truncated to 200 chars
    - Wrap `response.json()` in try/catch
    - On SyntaxError: read raw text with `response.text()`, record circuit breaker failure
    - Throw error: `"Malformed response: ${status} ${rawText.slice(0, 200)}"`
    - _Requirements: 2.5, 5.4_

  - [x] 4.5 Add observability logging — on successful 200 response (after flag checks pass), log the response's actual model name to stderr alongside the requested model name
    - Log format: `[agentmemory] LLM response: requested=${requestedModel} actual=${responseModel}`
    - Write to process.stderr
    - _Requirements: 5.1, 5.2_

  - [ ]* 4.6 Write unit tests for `resolveRoutingMode` in `test/openai-shared.test.ts`
    - Test valid values in various casings (COST, Balanced, QUALITY)
    - Test invalid value returns undefined and triggers stderr warning
    - Test undefined envValue returns undefined
    - Test non-Azure (isAzure=false) returns undefined regardless of envValue
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 4.7 Write unit tests for OpenAIProvider response flag parsing and malformed JSON handling
    - Test: 200 response with `response_successful: false` → throws error, records failure
    - Test: 200 response with `model_router_response_received: false` → throws error, records failure
    - Test: 200 response with valid JSON and both flags truthy → success path
    - Test: 200 response with unparseable body → throws error with raw text prefix, records failure
    - Test: error body longer than 200 chars is truncated
    - _Requirements: 2.5, 5.4_

  - [ ]* 4.8 Write unit tests for OpenAIProvider routing mode injection and observability logging
    - Test model_router_mode appears in body when Azure + routing mode set
    - Test model_router_mode absent when non-Azure or routing mode unset
    - Test stderr log includes requested and actual model names on success
    - _Requirements: 2.4, 3.1, 3.2, 5.1_

- [x] 5. Checkpoint - Verify agentmemory builds and existing tests pass
  - Run `npm run build` and `npm test` in the agentmemory workspace. Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Property-based tests for TypeScript components
  - [ ]* 6.1 Write property test for Azure detection auth headers (Property 1)
    - **Property 1: Azure detection produces correct auth headers**
    - Generator: random hostnames ending/not-ending with `.openai.azure.com`
    - Assert: Azure hosts → `api-key` header; non-Azure → `Authorization: Bearer` header
    - **Validates: Requirements 2.1**

  - [ ]* 6.2 Write property test for Azure v1 URL construction (Property 2)
    - **Property 2: Azure v1 URL construction**
    - Generator: random Azure base URLs without `/openai/deployments/` path segment
    - Assert: produced URL has path `/openai/v1/chat/completions`
    - **Validates: Requirements 2.2**

  - [ ]* 6.3 Write property test for model name passthrough (Property 3)
    - **Property 3: Model name passthrough in request body**
    - Generator: random non-empty strings as model names
    - Assert: request body `model` field equals the input string exactly
    - **Validates: Requirements 2.3**

  - [ ]* 6.4 Write property test for routing mode conditional injection (Property 4)
    - **Property 4: Routing mode conditional injection**
    - Generator: random valid modes × (Azure/non-Azure URLs), random casings
    - Assert: Azure + valid mode → `model_router_mode` present (lowercased); non-Azure or unset → field absent
    - **Validates: Requirements 2.4, 3.1, 3.2, 3.3**

  - [ ]* 6.5 Write property test for invalid routing mode fallback (Property 5)
    - **Property 5: Invalid routing mode fallback**
    - Generator: random strings excluding "cost", "balanced", "quality" (case-insensitive)
    - Assert: `resolveRoutingMode` returns undefined for all invalid inputs
    - **Validates: Requirements 3.4**

  - [ ]* 6.6 Write property test for embedding path isolation (Property 6)
    - **Property 6: Embedding path isolation from Model Router**
    - Generator: random (OPENAI_EMBEDDING_BASE_URL, OPENAI_BASE_URL) pairs where they differ
    - Assert: embedding provider resolves from OPENAI_EMBEDDING_BASE_URL, never OPENAI_BASE_URL
    - **Validates: Requirements 4.1, 4.3, 4.4**

  - [ ]* 6.7 Write property test for embedding dimension guard (Property 7)
    - **Property 7: Embedding dimension guard**
    - Generator: random Float32Arrays with lengths ≠ configured dimensions (1536)
    - Assert: dimension guard throws error containing expected and actual dimension counts
    - **Validates: Requirements 4.5**

  - [ ]* 6.8 Write property test for circuit breaker state transitions (Property 8)
    - **Property 8: Circuit breaker state transitions**
    - Generator: random sequences of success/failure calls with timestamps within/outside 60s window
    - Assert: ≥3 failures in 60s → open state; 30s recovery → half-open allows trial
    - **Validates: Requirements 2.6**

  - [ ]* 6.9 Write property test for error response body truncation (Property 9)
    - **Property 9: Error response handling with body truncation**
    - Generator: random non-2xx status codes × random strings of varying length (0–1000 chars); also generate 200 responses with `response_successful: false` and varying body lengths
    - Assert: error message contains status code AND body truncated to ≤200 characters; malformed JSON responses also produce truncated error messages
    - **Validates: Requirements 2.5, 5.4**

  - [ ]* 6.10 Write property test for success response model logging (Property 10)
    - **Property 10: Success response model logging**
    - Generator: random (requested model name, response model name) string pairs
    - Assert: stderr log line includes both the requested and actual model names
    - **Validates: Requirements 5.1**

- [x] 7. Final checkpoint - Full validation
  - Ensure all tests pass (`npm test` in agentmemory, `terraform validate` in azure.foundry.terraform). Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The Terraform module is built first because it's independent and can be validated with `terraform validate`
- agentmemory changes are minimal: one new function + modifications to the existing OpenAIProvider class
- Existing circuit breaker tests already cover the state machine; Property 8 adds randomized coverage
- Key design additions reflected in tasks 4.3/4.4: response flag parsing (`response_successful`, `model_router_response_received`) and malformed JSON catch-and-rethrow
- Terraform validation in task 1.1 now includes `model_subset <= 20` max entries constraint

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "4.2", "4.6"] },
    { "id": 2, "tasks": ["2.1", "4.3", "4.4", "6.1", "6.2", "6.3", "6.5"] },
    { "id": 3, "tasks": ["2.2", "4.5", "4.7", "6.4", "6.6", "6.7"] },
    { "id": 4, "tasks": ["4.8", "6.8", "6.9", "6.10"] }
  ]
}
```
