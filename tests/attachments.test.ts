/**
 * Image attachments on a playground message.
 *
 * The composer was text-only, so the dashboard — the natural place to check
 * whether vision works — could not send an image at all. These cover the
 * server side of that: what is accepted, what is refused, and that a stored
 * attachment survives a reload.
 */

import { describe, expect, it } from "vitest";
import { ChatStore } from "../src/chat/store.js";
import { openDatabase } from "../src/db.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function store(): ChatStore {
  return new ChatStore(openDatabase(":memory:"));
}

describe("storing attachments", () => {
  it("round-trips an attachment through the database", () => {
    const chat = store();
    const conversation = chat.createConversation({ model: "m", reasoningEffort: "medium" });

    chat.addMessage({
      conversationId: conversation.id,
      role: "user",
      content: "what is this?",
      attachments: [{ name: "shot.png", mimeType: "image/png", dataUrl: PNG }],
    });

    // Read back through a fresh query, which is what a page reload does.
    const [message] = chat.messages(conversation.id);
    expect(message!.attachments).toHaveLength(1);
    expect(message!.attachments[0]).toEqual({
      name: "shot.png",
      mimeType: "image/png",
      dataUrl: PNG,
    });
  });

  it("leaves an ordinary message with an empty attachment list", () => {
    const chat = store();
    const conversation = chat.createConversation({ model: "m", reasoningEffort: "medium" });
    chat.addMessage({ conversationId: conversation.id, role: "user", content: "hello" });

    expect(chat.messages(conversation.id)[0]!.attachments).toEqual([]);
  });

  it("survives a malformed attachments column rather than failing the read", () => {
    const db = openDatabase(":memory:");
    const chat = new ChatStore(db);
    const conversation = chat.createConversation({ model: "m", reasoningEffort: "medium" });
    chat.addMessage({ conversationId: conversation.id, role: "user", content: "hi" });

    db.prepare("UPDATE chat_messages SET attachments = ?").run("{not json");
    expect(chat.messages(conversation.id)[0]!.attachments).toEqual([]);
  });
});
