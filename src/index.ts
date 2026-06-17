#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dayjs from "dayjs";
import * as https from "node:https";
import * as http from "node:http";

// ============================================================================
// Configuration (MemOS Cloud API — https://memos.memtensor.cn/api/openmem/v1)
// Reference: https://memos-docs.openmem.net/cn/api_docs/start/overview
// ============================================================================

const MEMOS_BASE_URL =
  process.env.MEMOS_BASE_URL || "https://memos.memtensor.cn/api/openmem/v1";

const server = new McpServer({
  name: "memos-api-mcp",
  version: "2.0.0"
});

// ============================================================================
// Shared Zod schemas reused across tools (cloud OpenAPI-aligned)
// ============================================================================

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]).describe("Message role"),
  content: z.union([z.string(), z.array(z.any())]).optional().describe(
    "Message content. Plain string or OpenAI-compatible structured parts. Optional for 'assistant' when only tool_calls is present."
  ),
  name: z.string().optional().describe("Optional participant name"),
  chat_time: z.string().optional().describe("Message chat time (ISO string or natural-language Chinese)"),
  message_id: z.string().optional().describe("Message ID"),
  tool_call_id: z.string().optional().describe("Required when role='tool'"),
  tool_calls: z.array(z.any()).optional().describe("Tool calls list when role='assistant'")
}).describe(
  "Chat message following OpenAI ChatCompletion schema (system/user/assistant/tool)."
);

const filterSchema = z.record(z.any()).describe(
  "Memory filter. Supports logical ('and','or') and comparison ('gt','gte','lt','lte') operators. " +
  "Source-specific shortcuts: 'user', 'public', 'knowledgebase'. " +
  "All keys written via 'info'/'tags' are filterable. Always wrap in 'and'/'or' (no bare top-level field)."
);

const kbFileSchema = z.object({
  name: z.string().optional().describe("File display name"),
  type: z.enum(["document", "skill"]).optional().describe(
    "File type. 'document' (default) or 'skill' (markdown / zip skill package)."
  ),
  content: z.string().describe(
    "File content. Direct URL (e.g. https://...) or Base64 Data URI (e.g. data:text/markdown;base64,...)"
  )
}).describe("Knowledge base file entry");

// ============================================================================
// Helpers
// ============================================================================

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} is not set`);
  return v;
}

function generateChatTime(): string {
  return dayjs().format("YYYY-MM-DD HH:mm:ss");
}

async function postJson(
  path: string,
  body: Record<string, any>
): Promise<any> {
  const url = `${MEMOS_BASE_URL}${path}`;
  const payload = JSON.stringify(body);
  const apiKey = requireEnv("MEMOS_API_KEY");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Token ${apiKey}`
  };

  const gf = (globalThis as any).fetch;
  if (gf) {
    const res = await gf(url, { method: "POST", headers, body: payload });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`);
    }
    return res.json();
  }

  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        u,
        {
          method: "POST",
          headers: { ...headers, "Content-Length": Buffer.byteLength(payload) }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            const txt = Buffer.concat(chunks).toString("utf8");
            const sc = res.statusCode || 0;
            if (sc >= 200 && sc < 300) {
              try { resolve(JSON.parse(txt)); } catch { resolve(txt); }
            } else {
              reject(new Error(`HTTP ${sc} ${res.statusMessage || ""}: ${txt}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function normalizeMessages(msgs: any[] | undefined): any[] | undefined {
  if (!msgs) return undefined;
  return msgs.map((m) => ({
    ...m,
    chat_time: m.chat_time || generateChatTime()
  }));
}

function okResult(data: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data
  };
}

function errResult(e: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: `Error: ${e instanceof Error ? e.message : "Unknown error"}`
    }],
    isError: true
  };
}

// ============================================================================
// Prompt: mandatory memory workflow (cloud)
// ============================================================================

server.prompt(
  "memos_mandatory_workflow",
  "Mandatory 3-step memory workflow enforced on every turn (cloud).",
  async () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `# 🧠 MemOS Cloud Memory System — Mandatory Usage

## ⚠️ Always-On
The client MUST auto-invoke memory tools on every turn. Do not wait for the user to request it.

## 🎯 3-Step Workflow
\`\`\`
Every user message
  → 1) 🔍 search_memory   (BEFORE answering)
  → 2) 💬 Answer           (use only relevant memories; ignore noise)
  → 3) 💾 add_message      (AFTER answering)
\`\`\`

### 1) 🔍 search_memory
- Required: \`query\` (concise summary of the user message)
- Recommended: \`conversation_id\` (stable per-thread ID managed by the client),
  \`memory_limit_number\` = 3, \`include_preference\` = false
- Use \`filter\` to narrow scope (must wrap in \`and\`/\`or\`):
  \`\`\`json
  { "and": [
    { "app_id": "<your-app-id>" },
    { "tags":  "<topic-tag>" }
  ]}
  \`\`\`

### 2) 💬 Answer
Judge relevance; use only memories that truly help; otherwise ignore and answer normally.

### 3) 💾 add_message
- Required: \`messages\` (user + assistant of this turn, OpenAI chat format),
  \`conversation_id\`
- Recommended:
  - \`tags\`: human-readable topic tags
  - \`info\`: structured metadata (keys become searchable filters)
    Suggested keys: \`app_id\`, \`agent_id\`, \`scene\`, \`business_type\`, \`biz_id\`, \`lang\`, \`topic\`

## 🔄 Update / Delete
- Delete: find IDs via \`search_memory\` → call \`delete_memory\`.
- Modify/correct: call \`add_feedback\` with \`feedback_content\` and the same \`conversation_id\`.

## 👤 Identity Summary
- For "Who am I?" / "What do you know about me?" questions, call \`get_user_profile\`
  in addition to \`search_memory\`.

## Non-Negotiable Client Responsibilities
1. Always call \`search_memory\` before answering and \`add_message\` after answering.
2. Maintain a stable \`conversation_id\` for the whole conversation.
3. Prefer \`info.<key>\` and \`tags\` for precise filter matches.
`
      }
    }]
  })
);

// ============================================================================
// Tool: add_message  →  POST /add/message
// ============================================================================

server.tool(
  "add_message",
  `Save messages and extract memories via MemOS cloud /add/message.
Auto-invoked by the client after every answer to persist turn history.
Use this for storing NEW information. For corrections use add_feedback.`,
  {
    conversation_id: z.string().describe(
      "Conversation ID. Messages with the same conversation_id are treated as one context."
    ),
    messages: z.union([
      z.string(),
      z.array(chatMessageSchema)
    ]).describe(
      "Messages to store. Either a plain string or an array of OpenAI chat messages. Total tokens ≤ 40k."
    ),
    agent_id: z.string().optional().describe("Associated Agent identifier"),
    app_id: z.string().optional().describe("Associated application identifier"),
    tags: z.array(z.string()).optional().describe(
      "Custom topic/classification labels. Filterable via search_memory.filter."
    ),
    info: z.record(z.any()).optional().describe(
      "Custom metadata. Keys become filterable in search. " +
      "Example: { app_id, agent_id, source_type, source_url, source_content }"
    ),
    allow_public: z.boolean().optional().describe(
      "Allow memory writes to public library. Default: false."
    ),
    allow_knowledgebase_ids: z.array(z.string()).optional().describe(
      "Knowledge base IDs allowed for memory write. Default: []."
    ),
    async_mode: z.boolean().optional().describe(
      "Enable async memory processing. Default: true."
    ),
    user_id: z.string().optional().describe(
      "User ID. Defaults to MEMOS_USER_ID env when omitted."
    )
  },
  async (args) => {
    try {
      const user_id = args.user_id ?? requireEnv("MEMOS_USER_ID");
      const messagesNormalized = Array.isArray(args.messages)
        ? normalizeMessages(args.messages)
        : args.messages;

      const body: Record<string, any> = {
        user_id,
        conversation_id: args.conversation_id,
        messages: messagesNormalized
      };
      const passthrough: (keyof typeof args)[] = [
        "agent_id", "app_id", "tags", "info", "allow_public",
        "allow_knowledgebase_ids", "async_mode"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }

      const data = await postJson("/add/message", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: search_memory  →  POST /search/memory
// ============================================================================

server.tool(
  "search_memory",
  `Retrieve memories via MemOS cloud /search/memory.
MUST be auto-invoked by the client before generating every answer.
Use 'filter' for precise scoping (e.g., by tags, app_id, agent_id).`,
  {
    query: z.string().describe("Search query text. Max 40k tokens per query."),
    conversation_id: z.string().optional().describe(
      "Conversation ID. Prioritizes memories from the current session for ranking."
    ),
    filter: filterSchema.optional(),
    knowledgebase_ids: z.array(z.string()).optional().describe(
      "Restrict searchable knowledge bases. Use ['all'] for project-wide access."
    ),
    memory_limit_number: z.number().int().min(1).max(25).optional().describe(
      "Max factual memories. Default: 9, Max: 25. Recommended: 3 for low-noise auto-recall."
    ),
    include_preference: z.boolean().optional().describe(
      "Enable preference memory retrieval. Default: true."
    ),
    preference_limit_number: z.number().int().min(0).max(25).optional().describe(
      "Max preference memories. Default: 9, Max: 25."
    ),
    include_tool_memory: z.boolean().optional().describe(
      "Enable tool memory retrieval. Default: false."
    ),
    tool_memory_limit_number: z.number().int().min(0).max(25).optional().describe(
      "Max tool memories. Default: 6, Max: 25."
    ),
    include_skill: z.boolean().optional().describe(
      "Enable skill/procedure retrieval. Default: false."
    ),
    skill_limit_number: z.number().int().min(0).max(25).optional().describe(
      "Max skill memories. Default: 6, Max: 25."
    ),
    relativity: z.number().min(0).max(1).optional().describe(
      "Relevance threshold (0–1). Default: 0.45. 0 disables filtering."
    ),
    user_id: z.string().optional().describe(
      "User ID. Defaults to MEMOS_USER_ID env when omitted."
    )
  },
  async (args) => {
    try {
      const user_id = args.user_id ?? requireEnv("MEMOS_USER_ID");
      const body: Record<string, any> = { user_id, query: args.query };

      const passthrough: (keyof typeof args)[] = [
        "conversation_id", "filter", "knowledgebase_ids",
        "memory_limit_number", "include_preference", "preference_limit_number",
        "include_tool_memory", "tool_memory_limit_number",
        "include_skill", "skill_limit_number", "relativity"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }

      const data = await postJson("/search/memory", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: delete_memory  →  POST /delete/memory
// ============================================================================

server.tool(
  "delete_memory",
  `Delete memories via MemOS cloud /delete/memory.
Provide either memory_ids[] (preferred) or user_id (purges all memories for that user).
For user-requested deletion without IDs, first call search_memory to find them.`,
  {
    memory_ids: z.array(z.string()).optional().describe(
      "Memory IDs to delete (from search_memory or get_user_profile result)."
    ),
    user_id: z.string().optional().describe(
      "Quick delete: remove all memories for this user. Defaults to MEMOS_USER_ID env when present."
    )
  },
  async (args) => {
    try {
      const body: Record<string, any> = {};
      if (args.memory_ids !== undefined) body.memory_ids = args.memory_ids;
      const uid = args.user_id ?? process.env.MEMOS_USER_ID;
      if (uid) body.user_id = uid;

      const data = await postJson("/delete/memory", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: add_feedback  →  POST /add/feedback
// ============================================================================

server.tool(
  "add_feedback",
  `Submit feedback / corrections via MemOS cloud /add/feedback.
Use this for modifying or correcting existing memories, NOT for adding new ones (use add_message).`,
  {
    conversation_id: z.string().describe("Conversation ID this feedback belongs to"),
    feedback_content: z.string().describe("Natural-language feedback content"),
    agent_id: z.string().optional().describe("Agent identifier for agent-scoped recall"),
    app_id: z.string().optional().describe("Application identifier for app-scoped queries"),
    feedback_time: z.string().optional().describe(
      "Structured or natural-language timestamp"
    ),
    allow_public: z.boolean().optional().describe(
      "Allow writing memory to public library. Default: false."
    ),
    allow_knowledgebase_ids: z.array(z.string()).optional().describe(
      "Knowledge base IDs allowed for memory write."
    ),
    user_id: z.string().optional().describe(
      "User ID. Defaults to MEMOS_USER_ID env when omitted."
    )
  },
  async (args) => {
    try {
      const user_id = args.user_id ?? requireEnv("MEMOS_USER_ID");
      const body: Record<string, any> = {
        user_id,
        conversation_id: args.conversation_id,
        feedback_content: args.feedback_content
      };
      const passthrough: (keyof typeof args)[] = [
        "agent_id", "app_id", "feedback_time",
        "allow_public", "allow_knowledgebase_ids"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }

      const data = await postJson("/add/feedback", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: get_user_profile  →  POST /get/memory
// ============================================================================

server.tool(
  "get_user_profile",
  `Paginated memory listing via MemOS cloud /get/memory.
Use this for identity/profile summaries ("Who am I?") in addition to search_memory.`,
  {
    page: z.number().int().min(1).optional().describe("Page number. Default: 1."),
    size: z.number().int().min(1).max(50).optional().describe(
      "Items per page. Default: 10, Max: 50."
    ),
    filter: filterSchema.optional(),
    include_preference: z.boolean().optional().describe(
      "Include preference memories. Default: true."
    ),
    include_tool_memory: z.boolean().optional().describe(
      "Include tool memories. Default: true."
    ),
    user_id: z.string().optional().describe(
      "User ID. Defaults to MEMOS_USER_ID env when omitted."
    )
  },
  async (args) => {
    try {
      const user_id = args.user_id ?? requireEnv("MEMOS_USER_ID");
      const body: Record<string, any> = { user_id };
      const passthrough: (keyof typeof args)[] = [
        "page", "size", "filter", "include_preference", "include_tool_memory"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }

      const data = await postJson("/get/memory", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: extract_memory  →  POST /extract/memory
// ============================================================================

server.tool(
  "extract_memory",
  `Extract factual / preference memories from a transcript without persisting them.
Useful for previewing what would be stored or for offline analysis.`,
  {
    messages: z.array(chatMessageSchema).describe(
      "Messages to analyze. Total tokens ≤ 8k."
    ),
    extraction_types: z.array(z.enum(["memory", "preference"])).optional().describe(
      "Which extractions to run. Default: ['memory','preference']."
    )
  },
  async (args) => {
    try {
      const body: Record<string, any> = {
        messages: normalizeMessages(args.messages)
      };
      if (args.extraction_types !== undefined) {
        body.extraction_types = args.extraction_types;
      }
      const data = await postJson("/extract/memory", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: rerank  →  POST /rerank
// ============================================================================

server.tool(
  "rerank",
  `Rerank candidate documents by relevance via MemOS reranker model.`,
  {
    model: z.enum(["memos-reranker-0.6b", "memos-reranker-4b"]).describe(
      "Reranker model. Allowed values: 'memos-reranker-0.6b' (lightweight, faster) or 'memos-reranker-4b' (more accurate)."
    ),
    query: z.string().describe("Query text used for relevance matching."),
    documents: z.array(z.string()).describe(
      "Candidate documents. Total tokens ≤ 8k."
    ),
    top_n: z.number().int().min(1).optional().describe(
      "Return top N results. Default: all."
    )
  },
  async (args) => {
    try {
      const body: Record<string, any> = {
        model: args.model,
        query: args.query,
        documents: args.documents
      };
      if (args.top_n !== undefined) body.top_n = args.top_n;
      const data = await postJson("/rerank", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: chat  →  POST /chat
// ============================================================================

server.tool(
  "chat",
  `Chat with memory + knowledge base augmented LLM via MemOS cloud /chat.
Streaming is not supported through this MCP tool; pass stream=false (default).`,
  {
    conversation_id: z.string().describe("Conversation session identifier"),
    query: z.string().describe("User input content"),
    filter: filterSchema.optional(),
    knowledgebase_ids: z.array(z.string()).optional().describe(
      "Knowledge base IDs to consult. Use ['all'] for project-wide access."
    ),
    memory_limit_number: z.number().int().min(1).max(25).optional().describe(
      "Max factual memories. Default: 9, Max: 25."
    ),
    include_preference: z.boolean().optional().describe(
      "Include preference memories. Default: true."
    ),
    preference_limit_number: z.number().int().min(0).max(25).optional().describe(
      "Max preference memories. Default: 9, Max: 25."
    ),
    relativity: z.number().min(0).max(1).optional().describe(
      "Relevance threshold (0–1). Default: 0.45."
    ),
    model_name: z.string().optional().describe(
      "LLM model name. Default: 'qwen2.5-72B-Instruct'."
    ),
    system_prompt: z.string().optional().describe("Custom system instructions"),
    max_tokens: z.number().int().min(1).optional().describe(
      "Max generation tokens. Default: 8192."
    ),
    temperature: z.number().min(0).max(2).optional().describe(
      "Sampling temperature (0–2). Default: 0.7."
    ),
    top_p: z.number().min(0).max(1).optional().describe(
      "Nucleus sampling (0–1). Default: 0.95."
    ),
    user_id: z.string().optional().describe(
      "User ID. Defaults to MEMOS_USER_ID env when omitted."
    )
  },
  async (args) => {
    try {
      const user_id = args.user_id ?? requireEnv("MEMOS_USER_ID");
      const body: Record<string, any> = {
        user_id,
        conversation_id: args.conversation_id,
        query: args.query,
        stream: false
      };
      const passthrough: (keyof typeof args)[] = [
        "filter", "knowledgebase_ids", "memory_limit_number",
        "include_preference", "preference_limit_number", "relativity",
        "model_name", "system_prompt", "max_tokens", "temperature", "top_p"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      const data = await postJson("/chat", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: get_message  →  POST /get/message
// ============================================================================

server.tool(
  "get_message",
  `Retrieve raw conversation messages via MemOS cloud /get/message.`,
  {
    conversation_id: z.string().describe("Conversation ID to fetch messages for"),
    message_limit_number: z.number().int().min(1).max(50).optional().describe(
      "Max messages to return. Default: 6, Max: 50."
    ),
    user_id: z.string().optional().describe(
      "User ID. Defaults to MEMOS_USER_ID env when omitted."
    )
  },
  async (args) => {
    try {
      const user_id = args.user_id ?? requireEnv("MEMOS_USER_ID");
      const body: Record<string, any> = {
        user_id,
        conversation_id: args.conversation_id
      };
      if (args.message_limit_number !== undefined) {
        body.message_limit_number = args.message_limit_number;
      }
      const data = await postJson("/get/message", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: get_task_status  →  POST /get/status
// ============================================================================

server.tool(
  "get_task_status",
  `Query the status of an async memory task by task_id (returned by add_message in async mode).`,
  {
    task_id: z.string().describe("Async task identifier")
  },
  async (args) => {
    try {
      const data = await postJson("/get/status", { task_id: args.task_id });
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: create_knowledge_base  →  POST /create/knowledgebase
// ============================================================================

server.tool(
  "create_knowledge_base",
  `Create a new knowledge base under the current project.`,
  {
    knowledgebase_name: z.string().describe("Knowledge base name"),
    knowledgebase_description: z.string().optional().describe(
      "Knowledge base description"
    )
  },
  async (args) => {
    try {
      const body: Record<string, any> = {
        knowledgebase_name: args.knowledgebase_name
      };
      if (args.knowledgebase_description !== undefined) {
        body.knowledgebase_description = args.knowledgebase_description;
      }
      const data = await postJson("/create/knowledgebase", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: remove_knowledge_base  →  POST /delete/knowledgebase
// ============================================================================

server.tool(
  "remove_knowledge_base",
  `Detach a knowledge base from the current project.
Note: complete deletion still requires action from the dashboard.`,
  {
    knowledgebase_id: z.string().describe("Knowledge base ID to remove")
  },
  async (args) => {
    try {
      const data = await postJson("/delete/knowledgebase", {
        knowledgebase_id: args.knowledgebase_id
      });
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: add_kb_document  →  POST /add/knowledgebase-file
// ============================================================================

server.tool(
  "add_kb_document",
  `Upload one or more files (URL or Base64 Data URI) into a knowledge base.
Files are processed asynchronously; check status via get_kb_documents.`,
  {
    knowledgebase_id: z.string().describe("Target knowledge base ID"),
    file: z.array(kbFileSchema).min(1).describe(
      "Files to add. Each entry: { name?, type?='document'|'skill', content (URL or data: URI) }"
    )
  },
  async (args) => {
    try {
      const data = await postJson("/add/knowledgebase-file", {
        knowledgebase_id: args.knowledgebase_id,
        file: args.file
      });
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: get_kb_documents  →  POST /get/knowledgebase-file
// ============================================================================

server.tool(
  "get_kb_documents",
  `List or fetch knowledge base files via MemOS cloud /get/knowledgebase-file.
Two mutually exclusive modes — pick exactly one:
  • Mode A (list): pass knowledgebase_id (+ optional type/page/page_size). Do NOT pass file_ids.
  • Mode B (lookup): pass file_ids[]. Do NOT pass knowledgebase_id/type/page/page_size.`,
  {
    knowledgebase_id: z.string().optional().describe(
      "Mode A only: knowledge base ID to list files from. Mutually exclusive with file_ids."
    ),
    type: z.enum(["document", "skill"]).optional().describe(
      "Mode A only: filter by file type ('document' or 'skill'). Ignored in Mode B."
    ),
    page: z.number().int().min(1).optional().describe(
      "Mode A only: page number. Ignored in Mode B."
    ),
    page_size: z.number().int().min(1).optional().describe(
      "Mode A only: items per page. Ignored in Mode B."
    ),
    file_ids: z.array(z.string()).optional().describe(
      "Mode B only: explicit file IDs to fetch. Mutually exclusive with knowledgebase_id."
    )
  },
  async (args) => {
    try {
      const body: Record<string, any> = {};
      const passthrough: (keyof typeof args)[] = [
        "knowledgebase_id", "type", "page", "page_size", "file_ids"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      const data = await postJson("/get/knowledgebase-file", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: delete_kb_document  →  POST /delete/knowledgebase-file
// ============================================================================

server.tool(
  "delete_kb_document",
  `Delete one or more knowledge base files (documents or skills) by file_ids.`,
  {
    file_ids: z.array(z.string()).min(1).describe(
      "File IDs to delete (regular documents or skill files)"
    )
  },
  async (args) => {
    try {
      const data = await postJson("/delete/knowledgebase-file", {
        file_ids: args.file_ids
      });
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Boot
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("memos-api-mcp failed to start:", err);
  process.exit(1);
});
