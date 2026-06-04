# Requirements Document

## Introduction

This feature integrates Azure AI Foundry's Model Router into agentmemory's LLM provider system. Model Router is a trained language model that analyzes prompts in real-time and routes them to the optimal underlying LLM based on configurable routing modes (Balanced, Cost, Quality). It exposes an OpenAI-compatible `/v1/chat/completions` endpoint, provides built-in automatic failover across models, and supports prompt caching.

The integration points agentmemory at the Model Router endpoint for LLM calls (compress/summarize), gaining intelligent routing and built-in failover. Since `FALLBACK_PROVIDERS` is simply not set in the Model Router deployment, the existing fallback chain code is never activated — no application changes are needed to disable it. Embeddings remain on a fixed model deployment (dimension consistency requires a single, stable embedding model). The Terraform infrastructure adds a Model Router deployment resource to the existing Azure AI Foundry project.

## Glossary

- **Model_Router**: An Azure AI Foundry deployment that analyzes incoming prompts and routes them to the optimal underlying LLM based on cost, quality, and availability. Exposes an OpenAI-compatible chat completions endpoint.
- **Routing_Mode**: A Model Router configuration that controls the optimization strategy. Values: "balanced" (default, balances cost and quality), "cost" (minimizes cost), "quality" (maximizes output quality).
- **LLM_Provider**: The agentmemory subsystem responsible for compress and summarize operations. Implemented as classes conforming to the `MemoryProvider` interface.
- **OpenAI_Provider**: The existing agentmemory provider class that uses raw fetch against OpenAI-compatible endpoints. Already supports Azure OpenAI via auto-detection of `.openai.azure.com` hosts.
- **Embedding_Provider**: The agentmemory subsystem responsible for vector embeddings. Uses a fixed model (text-embedding-3-small) and is explicitly out of scope for Model Router.
- **Terraform_Module**: A reusable Terraform configuration unit in the `azure.foundry.terraform` repository that provisions Azure resources.
- **Model_Subset**: The set of underlying LLMs that Model Router is allowed to route to. Configured at deployment time.
- **Circuit_Breaker**: The existing `ResilientProvider` wrapper that stops calling a failing provider after repeated errors.

## Requirements

### Requirement 1: Terraform Model Router Deployment

**User Story:** As a platform engineer, I want to deploy Model Router as a Terraform resource in the Azure AI Foundry project, so that agentmemory has a single managed endpoint for intelligent LLM routing.

#### Acceptance Criteria

1. WHEN `terraform apply` is executed with variable `enable_model_router` set to `true`, THE Terraform_Module SHALL create an `azurerm_cognitive_deployment` resource with model format "OpenAI", model name "model-router", model version "2025-11-18", SKU "GlobalStandard", and a capacity of 50 (thousands of tokens-per-minute).
2. THE Terraform_Module SHALL accept an input variable `model_router_model_subset` of type list of strings (minimum 1, maximum 20 entries) that defines which underlying LLM deployment names Model Router is permitted to route to.
3. IF `enable_model_router` is set to `false` or not specified, THEN THE Terraform_Module SHALL not create the Model Router deployment resource, SHALL not produce `model_router_endpoint` or `model_router_deployment_name` outputs, and SHALL leave all existing resources unchanged.
4. THE Terraform_Module SHALL deploy Model Router in the same region as the parent AI Services account, which must be a Model Router supported region (East US 2 or Sweden Central).
5. THE Terraform_Module SHALL output the Model Router endpoint URL as `model_router_endpoint` and deployment name as `model_router_deployment_name` for consumption by agentmemory configuration.
6. IF the AI Services account region does not match a Model Router supported region (eastus2 or swedencentral), THEN THE Terraform_Module SHALL produce a Terraform variable validation error at plan time before any resources are created.
7. IF `enable_model_router` is `true` and the `model_router_model_subset` list is empty, THEN THE Terraform_Module SHALL produce a Terraform variable validation error indicating that at least one model deployment name is required. IF `enable_model_router` is `false`, THEN THE Terraform_Module SHALL skip validation of the `model_router_model_subset` parameter.

### Requirement 2: agentmemory Provider Configuration for Model Router

**User Story:** As a developer deploying agentmemory, I want to point it at the Model Router endpoint using existing environment variables, so that no application code changes are needed for basic connectivity.

#### Acceptance Criteria

1. WHEN `OPENAI_BASE_URL` is set to an Azure AI Foundry Model Router endpoint whose hostname ends with `.openai.azure.com` and `OPENAI_API_KEY` contains a non-empty string, THE OpenAI_Provider SHALL detect the endpoint as Azure and authenticate requests using the `api-key` header with the value of `OPENAI_API_KEY`.
2. WHEN `OPENAI_BASE_URL` does not contain a `/openai/deployments/` path segment, THE OpenAI_Provider SHALL use the Azure v1 URL style and route requests to the `/openai/v1/chat/completions` path on the configured host.
3. WHEN `OPENAI_MODEL` is set, THE OpenAI_Provider SHALL include its value in the request body's `model` field for both compress and summarize calls.
4. THE OpenAI_Provider SHALL send compress and summarize requests using the standard OpenAI-compatible payload structure (containing `model`, `max_tokens`, `stream`, and `messages` fields) with no Model-Router-specific fields or transformations added.
5. IF Model Router returns an HTTP response with a non-2xx status code, a network timeout, or a malformed/unparseable response, THEN THE OpenAI_Provider SHALL throw an error containing the HTTP status code and response body text (where available), which the wrapping `ResilientProvider` records as a circuit breaker failure.
6. IF the circuit breaker has recorded 3 failures within a 60-second window, THEN THE `ResilientProvider` SHALL immediately reject all subsequent calls with a `circuit_breaker_open` error until the 30-second recovery timeout elapses.

### Requirement 3: Routing Mode Configuration

**User Story:** As a developer, I want to configure the Model Router routing mode via environment variable, so that I can optimize for cost during development and quality in production.

#### Acceptance Criteria

1. WHEN `MODEL_ROUTER_ROUTING_MODE` is set to "cost", "balanced", or "quality" (case-insensitive) and `OPENAI_BASE_URL` points to an Azure AI Foundry endpoint, THE OpenAI_Provider SHALL include the `model_router_mode` field in the request body with the specified value lowercased.
2. WHEN `MODEL_ROUTER_ROUTING_MODE` is set but `OPENAI_BASE_URL` does not point to an Azure AI Foundry endpoint, THE OpenAI_Provider SHALL omit the `model_router_mode` field from the request body regardless of whether the routing mode value is valid.
3. WHEN `MODEL_ROUTER_ROUTING_MODE` is not set, THE OpenAI_Provider SHALL omit the `model_router_mode` field from the request body, allowing Model Router to use its default routing behavior.
4. IF `MODEL_ROUTER_ROUTING_MODE` is set to a value other than "cost", "balanced", or "quality" (case-insensitive comparison), THEN THE OpenAI_Provider SHALL log a warning at startup indicating the unrecognized value and the three valid options, and fall back to omitting the `model_router_mode` field from request bodies.

### Requirement 4: Embedding Provider Isolation

**User Story:** As a developer, I want embeddings to remain on a fixed model regardless of Model Router configuration, so that vector dimension consistency is maintained across all stored embeddings.

#### Acceptance Criteria

1. THE Embedding_Provider SHALL resolve its endpoint URL from `OPENAI_EMBEDDING_BASE_URL` independently of the LLM provider's `OPENAI_BASE_URL`, defaulting to `https://api.openai.com` when `OPENAI_EMBEDDING_BASE_URL` is not set and `OPENAI_BASE_URL` is not set.
2. THE Embedding_Provider SHALL use the model specified by `OPENAI_EMBEDDING_MODEL` (defaulting to text-embedding-3-small, 1536 dimensions) regardless of Model Router presence or LLM model configuration.
3. THE Embedding_Provider SHALL NOT route embedding requests through Model Router; all embedding HTTP requests SHALL be sent to the URL resolved from `OPENAI_EMBEDDING_BASE_URL` (or its fallback) rather than the Model Router endpoint configured in `OPENAI_BASE_URL`.
4. IF `OPENAI_EMBEDDING_BASE_URL` is set, THEN THE Embedding_Provider SHALL use that URL for embedding requests and THE LLM provider SHALL continue using `OPENAI_BASE_URL` for chat completions, ensuring the two request paths are independent.
5. IF the Embedding_Provider receives vectors with a dimension count different from the configured model's expected dimensions (1536 for text-embedding-3-small), THEN THE system SHALL reject the response with an error indicating a dimension mismatch and SHALL NOT store the vector in the index.

### Requirement 5: Observability and Diagnostics

**User Story:** As an operator, I want to see which model actually served each request and what routing mode was used, so that I can monitor cost, quality, and routing behavior.

#### Acceptance Criteria

1. WHEN Model Router returns a successful response containing a `model` field in the response body, THE OpenAI_Provider SHALL write a log line to process.stderr that includes the requested model name and the actual model name from the response body.
2. WHEN Model Router returns an HTTP 200 response after performing a transparent internal failover to a different model, THE OpenAI_Provider SHALL record a circuit breaker success (no failure penalty), because the client observes only the successful 200 response regardless of which upstream model served it.
3. IF Model Router returns a 429 or 503 HTTP status, THEN THE OpenAI_Provider SHALL record a circuit breaker failure and throw an error whose message contains the numeric HTTP status code.
4. IF Model Router returns a non-successful HTTP response (determined by explicit response parsing via `response_successful` and `model_router_response_received` flags rather than HTTP status code alone), THEN THE OpenAI_Provider SHALL record a circuit breaker failure and throw an error whose message contains the numeric HTTP status code and the response body text (truncated to 200 characters maximum).

### Requirement 6: Terraform Variable Integration

**User Story:** As a platform engineer, I want the Model Router deployment to coexist with the existing model deployments list without breaking current infrastructure, so that adoption is incremental.

#### Acceptance Criteria

1. THE Terraform_Module SHALL define a `model_router_config` variable as an object with fields `enabled` (bool, default: false), `routing_mode` (string), `model_subset` (list of strings), and `capacity` (number representing tokens-per-minute in thousands), separate from the existing `model_deployments` variable.
2. IF `model_router_config.enabled` is false, THEN THE Terraform_Module SHALL produce zero Model Router resources and SHALL leave the existing `model_deployments` variable structure, its provisioned resources, and all existing outputs unchanged.
3. IF `model_router_config.enabled` is true, THEN THE Terraform_Module SHALL output the Model Router endpoint URL in a dedicated output named `model_router_endpoint` in the format `https://<resource>.openai.azure.com` suitable for use as `OPENAI_BASE_URL`.
4. THE Terraform_Module SHALL accept a `model_router_config.capacity` value between 1 and 10000 (tokens-per-minute in thousands) and SHALL reject values outside this range with a validation error.
5. IF `model_router_config.enabled` is true and any entry in `model_router_config.model_subset` does not match a `name` in the `model_deployments` list, THEN THE Terraform_Module SHALL reject the configuration with a validation error indicating the unmatched model name.
