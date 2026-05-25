import Anthropic from "@anthropic-ai/sdk";
import type { MCPManager } from "./mcp-manager.js";
import type {
  MessageParam,
  ToolUseBlock,
  ToolResultBlockParam,
  ServerConfig,
  ToolCallResult,
} from "./types.js";
import { getSuccessor, isModelDeprecationError } from "./model-registry.js";
import { c } from "./console-theme.js";

const MAX_TOOL_ITERATIONS = 10;

export class ClaudeClient {
  private mcpManager: MCPManager;
  private config: ServerConfig;
  // Cache per-key Anthropic instances so we don't reconstruct on every call.
  // Keyed by API key directly — when a user rotates, the old entry just sits
  // unused (small fixed memory cost).
  private clients = new Map<string, Anthropic>();

  constructor(mcpManager: MCPManager, config: ServerConfig) {
    this.mcpManager = mcpManager;
    this.config = config;
  }

  updateConfig(updates: Partial<ServerConfig>): void {
    Object.assign(this.config, updates);
  }

  getConfig(): ServerConfig {
    return { ...this.config };
  }

  private getAnthropic(apiKey: string): Anthropic {
    let client = this.clients.get(apiKey);
    if (!client) {
      client = new Anthropic({ apiKey });
      this.clients.set(apiKey, client);
    }
    return client;
  }

  // Wraps messages.create with one-shot deprecation recovery. On a model-
  // deprecation error, retries against the latest model in the same family
  // and hot-patches this.config.model so subsequent calls skip the retry.
  // We pay the retry cost ONCE per server lifetime, then steady state.
  // Any other error (rate limit, auth, network) propagates unchanged.
  private async callWithDeprecationRetry(
    anthropic: Anthropic,
    params: Omit<Parameters<typeof anthropic.messages.create>[0], "model">
  ): Promise<Anthropic.Message> {
    const current = this.config.model;
    try {
      return (await anthropic.messages.create({
        ...params,
        model: current,
      })) as Anthropic.Message;
    } catch (err) {
      if (!isModelDeprecationError(err)) throw err;
      const successor = getSuccessor(current);
      if (successor === current) {
        // Already on the latest known model — nothing we can do but
        // re-throw and let the operator know the registry is stale.
        console.error(
          c.error(
            `[Model] "${current}" looks deprecated, but our registry has no successor for it. ` +
              `Update LATEST_PER_FAMILY in src/model-registry.ts.`
          )
        );
        throw err;
      }
      console.log(
        c.warn(
          `[Model] "${current}" returned a deprecation error — retrying once with "${successor}".`
        )
      );
      console.log(
        c.dim(
          `   Set CLAUDE_MODEL=${successor} in .env to pin permanently and skip this fallback.`
        )
      );
      const response = (await anthropic.messages.create({
        ...params,
        model: successor,
      })) as Anthropic.Message;
      // Hot-patch so the rest of the server's lifetime uses the working
      // model directly. Next operator restart, the env-var pin (or lack
      // thereof) takes effect again.
      this.config.model = successor;
      return response;
    }
  }

  async chat(
    history: MessageParam[],
    text: string,
    images: string[] | undefined,
    apiKey: string,
    // Optional — when present, the per-user MCP pool is consulted in
    // addition to the operator's shared tools, and tool_use blocks are
    // routed through invokeToolForUser so user-namespaced tools dispatch
    // to the right per-user connection. Gateway-key callers (no session)
    // omit this and only see the shared operator tools.
    userId?: string
  ): Promise<{
    responseText: string;
    toolCalls: ToolCallResult[];
    inputTokens: number;
    outputTokens: number;
  }> {
    const anthropic = this.getAnthropic(apiKey);

    // Build the user message content
    const content: Anthropic.ContentBlockParam[] = [];

    // Add images as vision content blocks
    if (images && images.length > 0) {
      for (const base64 of images) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: base64,
          },
        });
      }
    }

    // Add text
    if (text) {
      content.push({ type: "text", text });
    }

    // Append user message to history
    const userMessage: MessageParam = { role: "user", content };
    const messages = [...history, userMessage];

    // Get tools from MCP — when we have a user identity, merge their
    // per-user remote MCP tools (namespaced) with the operator's shared
    // tools. The merge can throw if any individual user-server fails to
    // connect, but the implementation swallows those errors and just
    // skips the broken server so a single bad config doesn't tank the
    // entire chat call.
    const tools = userId
      ? await this.mcpManager.getToolsForChatForUser(userId)
      : this.mcpManager.getToolsForClaude();

    // Tool use loop
    const allToolCalls: ToolCallResult[] = [];
    let currentMessages = messages;
    // Sum token usage across every iteration so the usage counter sees the
    // full cost of a tool-using response, not just the final turn.
    let inputTokens = 0;
    let outputTokens = 0;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await this.callWithDeprecationRetry(anthropic, {
        max_tokens: this.config.maxTokens,
        system: this.config.systemPrompt,
        messages: currentMessages,
        ...(tools.length > 0 ? { tools } : {}),
      });

      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;

      // Check if response contains tool use
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === "tool_use"
      );

      if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
        // Final response — extract text
        const textBlocks = response.content
          .filter((block) => block.type === "text")
          .map((block) => (block as Anthropic.TextBlock).text);

        const responseText = textBlocks.join("\n");

        // Return the messages to append to history (user + assistant)
        return { responseText, toolCalls: allToolCalls, inputTokens, outputTokens };
      }

      // Process tool calls
      const assistantMessage: MessageParam = {
        role: "assistant",
        content: response.content,
      };

      const toolResults: ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`[Claude] Tool call: ${toolUse.name}`);
        try {
          // Route through the user-aware variant when we have an identity;
          // it falls back to operator-shared if the tool name isn't in
          // the user pool, so it's safe to use universally.
          const result = userId
            ? await this.mcpManager.invokeToolForUser(
                userId,
                toolUse.name,
                toolUse.input as Record<string, unknown>
              )
            : await this.mcpManager.invokeTool(
                toolUse.name,
                toolUse.input as Record<string, unknown>
              );
          allToolCalls.push({ name: toolUse.name, result });
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          const errorMsg =
            err instanceof Error ? err.message : "Unknown error";
          console.error(`[Claude] Tool error (${toolUse.name}):`, errorMsg);
          allToolCalls.push({ name: toolUse.name, result: { error: errorMsg } });
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: errorMsg }),
            is_error: true,
          });
        }
      }

      const toolResultMessage: MessageParam = {
        role: "user",
        content: toolResults,
      };

      // Continue the loop with tool results
      currentMessages = [
        ...currentMessages,
        assistantMessage,
        toolResultMessage,
      ];
    }

    // Exceeded max iterations
    return {
      responseText:
        "I attempted to use several tools but reached the maximum number of iterations. Please try again with a simpler request.",
      toolCalls: allToolCalls,
      inputTokens,
      outputTokens,
    };
  }
}
