import { Router, type Request } from "express";
import type { ClaudeClient } from "../claude-client.js";
import type { ConversationStore } from "../conversation.js";
import type { RequestQueue } from "../middleware.js";
import type { ChatRequest, ChatResponse } from "../types.js";
import { getUserApiKey } from "../users.js";

const MAX_VISION_CONTEXT_IMAGES = Math.max(
  1,
  parseInt(process.env.MAX_VISION_CONTEXT_IMAGES || "2", 10)
);

// Resolves the caller's identity and Anthropic key. Logged-in user uses
// their own stored key; native gateway-keyed clients fall back to env
// (operator-managed shared use). Conversation scope is namespaced so one
// caller cannot read another's history even by guessing the id.
function resolveCaller(req: Request): {
  scope: string;
  anthropicKey: string | null;
} {
  const userId = req.session?.userId;
  if (userId) {
    const key = getUserApiKey(userId, "anthropic");
    return { scope: `user:${userId}`, anthropicKey: key };
  }
  const envKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  return { scope: "gateway", anthropicKey: envKey };
}

export function createChatRouter(
  claudeClient: ClaudeClient,
  conversations: ConversationStore,
  requestQueue?: RequestQueue
): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    try {
      const body = req.body as ChatRequest;

      if (!body.text && (!body.images || body.images.length === 0)) {
        res.status(400).json({ error: "Must provide text or images" });
        return;
      }

      const { scope, anthropicKey } = resolveCaller(req);
      if (!anthropicKey) {
        res.status(412).json({
          error:
            "No Anthropic API key configured. Add yours on the Account page.",
        });
        return;
      }

      const scopedId = body.conversation_id
        ? `${scope}|${body.conversation_id}`
        : undefined;
      const { id: storedId, messages } = conversations.getOrCreate(scopedId);

      const incomingImageCount = body.images?.length ?? 0;
      const historyImageBudget = Math.max(
        0,
        MAX_VISION_CONTEXT_IMAGES - incomingImageCount
      );
      conversations.pruneImageHistory(storedId, historyImageBudget);

      const chatFn = () =>
        claudeClient.chat(messages, body.text || "", body.images, anthropicKey);

      const { responseText, toolCalls } = requestQueue
        ? await requestQueue.enqueue(chatFn)
        : await chatFn();

      const userContent: any[] = [];
      if (body.images && body.images.length > 0) {
        for (const img of body.images) {
          userContent.push({
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: img },
          });
        }
      }
      if (body.text) {
        userContent.push({ type: "text", text: body.text });
      }

      conversations.append(
        storedId,
        { role: "user", content: userContent },
        { role: "assistant", content: responseText }
      );

      // Strip the scope prefix from the id we return so the client just
      // sees an opaque token. We re-prefix on the next call from the same
      // session, so this is invisible to the caller.
      const clientId = storedId.startsWith(`${scope}|`)
        ? storedId.slice(scope.length + 1)
        : storedId;

      const response: ChatResponse = {
        text: responseText,
        tool_calls: toolCalls,
        conversation_id: clientId,
      };

      res.json(response);
    } catch (err) {
      console.error("[Chat] Error:", err);
      const message = err instanceof Error ? err.message : "Internal error";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
