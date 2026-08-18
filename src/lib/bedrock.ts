/**
 * Minimal Bedrock API client — plain bearer-token auth, no AWS SDK.
 *
 * The Worker's 10 MB script limit rules out @anthropic-ai/bedrock-sdk
 * (which pulls the full AWS SDK v3 + @smithy/eventstream-serde-node).
 * This is a plain fetch call with no signing dependency.
 */

export interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockContent[];
}

export type BedrockContent =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface BedrockRequest {
  anthropic_version: "bedrock-2023-05-31";
  max_tokens: number;
  messages: BedrockMessage[];
  system?: BedrockContent[];
  /**
   * Structured output. The schema sits directly under `format` — the
   * OpenAI-style `json_schema: { name, schema }` wrapper is rejected with
   * "Unexpected key 'json_schema'", which fails every call at runtime while
   * type-checking perfectly.
   */
  output_config?: {
    format: {
      type: "json_schema";
      schema: Record<string, unknown>;
    };
  };
}

/**
 * A block in the response.
 *
 * Not text-only: the current Claude models run adaptive thinking, which emits
 * a `thinking` block ahead of the answer. Typing this as text-only made
 * `content[0].text` look safe when it is in fact usually `undefined`.
 */
export type BedrockResponseBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string }
  | { type: string; [k: string]: unknown };

export interface BedrockResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: BedrockResponseBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class BedrockError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Bedrock ${status}: ${body.slice(0, 200)}`);
    this.name = "BedrockError";
  }
}

export interface BedrockClientConfig {
  apiKey: string;
  region: string;
}

/**
 * The first text block of a response.
 *
 * Indexing `content[0]` is wrong on any thinking-enabled model: the thinking
 * block comes first and carries no `text`, so the caller silently gets "".
 * A truncated response is raised rather than parsed, because a half-written
 * JSON body fails far more confusingly downstream than here.
 */
export function firstText(response: BedrockResponse): string {
  if (response.stop_reason === "max_tokens") {
    throw new BedrockError(
      200,
      "response truncated at max_tokens; raise max_tokens or shrink the batch",
    );
  }
  for (const block of response.content) {
    if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
      return (block as { text: string }).text;
    }
  }
  throw new BedrockError(200, `no text block in response (stop_reason=${response.stop_reason})`);
}

export class BedrockClient {
  private readonly apiKey: string;
  private readonly region: string;

  constructor(config: BedrockClientConfig) {
    this.apiKey = config.apiKey;
    this.region = config.region;
  }

  async invoke(modelId: string, request: BedrockRequest): Promise<BedrockResponse> {
    const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new BedrockError(response.status, body);
    }

    return response.json() as Promise<BedrockResponse>;
  }
}
