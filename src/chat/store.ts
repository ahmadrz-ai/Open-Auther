/**
 * Persistence for the built-in chat playground.
 *
 * Kept separate from the credential store: conversations are a convenience
 * feature, and nothing here should ever be able to interfere with routing.
 */

import { type Database, now } from "../db.js";

export interface Conversation {
  id: number;
  title: string;
  model: string;
  reasoningEffort: string;
  /** null means normal rotation; a value pins every turn to that Auth. */
  pinnedCredentialId: number | null;
  createdAt: number;
  updatedAt: number;
  messageCount?: number;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant" | "system";
  content: string;
  credentialId: number | null;
  credentialName: string | null;
  tokens: number;
  latencyMs: number | null;
  error: string | null;
  createdAt: number;
}

interface ConversationRow {
  id: number;
  title: string | null;
  model: string | null;
  reasoning_effort: string | null;
  pinned_credential_id: number | null;
  created_at: number;
  updated_at: number;
  message_count?: number;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  credential_id: number | null;
  credential_name: string | null;
  tokens: number;
  latency_ms: number | null;
  error: string | null;
  created_at: number;
}

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  title: r.title ?? "New chat",
  model: r.model ?? "",
  reasoningEffort: r.reasoning_effort ?? "medium",
  pinnedCredentialId: r.pinned_credential_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  messageCount: r.message_count ?? 0,
});

const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role as ChatMessage["role"],
  content: r.content,
  credentialId: r.credential_id,
  credentialName: r.credential_name,
  tokens: r.tokens,
  latencyMs: r.latency_ms,
  error: r.error,
  createdAt: r.created_at,
});

export class ChatStore {
  constructor(private readonly db: Database) {}

  listConversations(): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id)
                     AS message_count
           FROM conversations c
          ORDER BY c.updated_at DESC`,
      )
      .all() as unknown as ConversationRow[];
    return rows.map(toConversation);
  }

  getConversation(id: number): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
      | ConversationRow
      | undefined;
    return row ? toConversation(row) : null;
  }

  createConversation(input: {
    title?: string;
    model: string;
    reasoningEffort?: string;
    pinnedCredentialId?: number | null;
  }): Conversation {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO conversations
           (title, model, reasoning_effort, pinned_credential_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.title ?? "New chat",
        input.model,
        input.reasoningEffort ?? "medium",
        input.pinnedCredentialId ?? null,
        ts,
        ts,
      );
    const row = this.db
      .prepare("SELECT * FROM conversations ORDER BY id DESC LIMIT 1")
      .get() as unknown as ConversationRow;
    return toConversation(row);
  }

  updateConversation(
    id: number,
    patch: {
      title?: string;
      model?: string;
      reasoningEffort?: string;
      pinnedCredentialId?: number | null;
    },
  ): Conversation | null {
    const existing = this.getConversation(id);
    if (!existing) return null;

    this.db
      .prepare(
        `UPDATE conversations
            SET title = ?, model = ?, reasoning_effort = ?, pinned_credential_id = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.title ?? existing.title,
        patch.model ?? existing.model,
        patch.reasoningEffort ?? existing.reasoningEffort,
        patch.pinnedCredentialId === undefined
          ? existing.pinnedCredentialId
          : patch.pinnedCredentialId,
        now(),
        id,
      );
    return this.getConversation(id);
  }

  deleteConversation(id: number): boolean {
    if (!this.getConversation(id)) return false;
    // Explicit child delete: SQLite only cascades when foreign_keys is on for
    // this connection, and relying on that silently is how orphans happen.
    this.db.prepare("DELETE FROM chat_messages WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return true;
  }

  messages(conversationId: number): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC")
      .all(conversationId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  addMessage(input: {
    conversationId: number;
    role: ChatMessage["role"];
    content: string;
    credentialId?: number | null;
    credentialName?: string | null;
    tokens?: number;
    latencyMs?: number | null;
    error?: string | null;
  }): ChatMessage {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO chat_messages
           (conversation_id, role, content, credential_id, credential_name,
            tokens, latency_ms, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.role,
        input.content,
        input.credentialId ?? null,
        input.credentialName ?? null,
        input.tokens ?? 0,
        input.latencyMs ?? null,
        input.error ?? null,
        ts,
      );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(ts, input.conversationId);

    const row = this.db
      .prepare("SELECT * FROM chat_messages ORDER BY id DESC LIMIT 1")
      .get() as unknown as MessageRow;
    return toMessage(row);
  }

  /** Derive a title from the first user message, so the list is navigable. */
  autoTitle(conversationId: number, firstMessage: string): void {
    const conv = this.getConversation(conversationId);
    if (!conv || conv.title !== "New chat") return;

    const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, conversationId);
  }
}
