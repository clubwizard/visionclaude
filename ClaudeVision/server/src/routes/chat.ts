import { Router } from "express";
import type { ClaudeClient } from "../claude-client.js";
import type { ConversationStore } from "../conversation.js";
import type { RequestQueue } from "../middleware.js";
import type { ChatRequest, ChatResponse } from "../types.js";

// Max image content blocks the API call can carry across the full message
// array (history + the new user turn). Override via MAX_VISION_CONTEXT_IMAGES.
// 2 = current frame + one prior; older frames become text placeholders.
const MAX_VISION_CONTEXT_IMAGES = Math.max(
  1,
  parseInt(process.env.MAX_VISION_CONTEXT_IMAGES || "2", 10)
);

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

      const { id, messages } = conversations.getOrCreate(body.conversation_id);

      // Prune stored history so older images become text placeholders. The
      // new turn's images (body.images) are added by ClaudeClient on top, so
      // we reserve room for them by subtracting from the cap.
      const incomingImageCount = body.images?.length ?? 0;
      const historyImageBudget = Math.max(
        0,
        MAX_VISION_CONTEXT_IMAGES - incomingImageCount
      );
      conversations.pruneImageHistory(id, historyImageBudget);

      // Queue the API call to prevent concurrent races
      const chatFn = () =>
        claudeClient.chat(messages, body.text || "", body.images);

      const { responseText, toolCalls } = requestQueue
        ? await requestQueue.enqueue(chatFn)
        : await chatFn();

      // Update conversation history
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
        id,
        { role: "user", content: userContent },
        { role: "assistant", content: responseText }
      );

      const response: ChatResponse = {
        text: responseText,
        tool_calls: toolCalls,
        conversation_id: id,
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
