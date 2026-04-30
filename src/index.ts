#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dayjs from "dayjs";
import * as https from "node:https";
import * as http from "node:http";

// ============================================================================
// Configuration (MemOS Server v1.0.1 local deployment)
// ============================================================================

const MEMOS_BASE_URL =
  process.env.MEMOS_BASE_URL || "http://localhost:8000";

const server = new McpServer({
  name: "memos-api-mcp",
  version: "2.0.0"
});

// ============================================================================
// Shared Zod schemas reused across tools (OpenAPI-aligned)
// ============================================================================

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]).describe("Message role"),
  content: z.union([z.string(), z.array(z.any())]).optional().describe(
    "Message content. Plain string or OpenAI-compatible structured parts. Optional for 'assistant' when only tool_calls is present."
  ),
  name: z.string().optional().describe("Optional participant name"),
  chat_time: z.string().optional().describe("Message chat time (ISO string or custom)"),
  message_id: z.string().optional().describe("Message ID"),
  tool_call_id: z.string().optional().describe("Required when role='tool'"),
  tool_calls: z.array(z.any()).optional().describe("Tool calls list when role='assistant'"),
  refusal: z.string().optional().describe("Refusal text (assistant only)"),
  audio: z.any().optional().describe("Audio payload (assistant only)")
}).describe(
  "Chat message following OpenAI ChatCompletion schema (system/user/assistant/tool)."
);

const permissionDictSchema = z.object({
  mem_cube_id: z.string().describe("Target memory cube ID"),
  permissions: z.array(z.enum(["read", "write", "delete", "execute"])).describe("Granted permissions")
}).describe("Per-cube permission entry");

const filterSchema = z.record(z.any()).describe(
  "Memory filter. Supports logical ('and','or') and comparison ('gt','gte','lt','lte') operators. " +
  "Example: { and: [ { session_id: 'xxx' }, { created_at: { gt: '2024-01-01' } }, { 'info.scene': 'coding' } ] }. " +
  "All keys written via 'info' (and custom_tags in some builds) are filterable."
);

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
  const headers: Record<string, string> = { "Content-Type": "application/json" };

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
// Prompt: mandatory memory workflow
// ============================================================================

server.prompt(
  "memos_mandatory_workflow",
  "Mandatory 3-step memory workflow enforced on every turn.",
  async () => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `# 🧠 MemOS Automatic Memory System — Mandatory Usage (Local v1.0.1)

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
- Recommended: \`session_id\` (stable per-thread ID managed by the client), \`top_k\` = 3
- Use \`filter\` to narrow scope, e.g. by \`session_id\`, \`info.app_id\`, \`info.scene\`.
  Example:
  \`\`\`json
  { "and": [
    { "info.app_id": "<your-app-id>" },
    { "info.scene":  "<coding|debug|qa|daily_chat>" }
  ]}
  \`\`\`

### 2) 💬 Answer
Judge relevance; use only memories that truly help; otherwise ignore and answer normally.

### 3) 💾 add_message
- Required: \`messages\` (user + assistant of this turn, OpenAI chat format)
- Recommended:
  - \`session_id\`: stable per-thread ID (same one used in search_memory)
  - \`project_id\`: project isolation (optional but recommended)
  - \`custom_tags\`: human-readable tag list
  - \`info\`: structured metadata (keys become searchable filters)
    Suggested keys: \`app_id\`, \`agent_id\`, \`scene\`, \`business_type\`, \`biz_id\`, \`lang\`, \`topic\`

## 🔄 Update / Delete
- Delete: find IDs via \`search_memory\` → call \`delete_memory\`.
- Modify/correct: call \`add_feedback\` with \`feedback_content\` and the conversation \`history\`.

## 👤 Identity Summary
- For "Who am I?" / "What do you know about me?" questions, call \`get_user_profile\`
  in addition to \`search_memory\`.

## Non-Negotiable Client Responsibilities
1. Always call \`search_memory\` before answering and \`add_message\` after answering.
2. Maintain a stable \`session_id\` for the whole conversation.
3. Prefer \`info.<key>\` over \`custom_tags\` when you need precise filter matches.
`
      }
    }]
  })
);

// ============================================================================
// Tool: add_message  →  POST /product/add   (APIADDRequest)
// ============================================================================

server.tool(
  "add_message",
  `Save messages and extract memories via MemOS /product/add.
Auto-invoked by the client after every answer to persist turn history.
Use this for storing NEW information. For corrections use add_feedback.`,
  {
    session_id: z.string().optional().describe(
      "Session ID. If not provided, server uses a default session."
    ),
    task_id: z.string().optional().describe("Task ID for monitoring async tasks"),
    manager_user_id: z.string().optional().describe("Manager user ID"),
    project_id: z.string().optional().describe("Project ID (for project-level isolation)"),
    writable_cube_ids: z.array(z.string()).optional().describe(
      "Cube IDs this user may write to (multi-cube add)"
    ),
    async_mode: z.enum(["async", "sync"]).optional().describe(
      "Add mode. 'async' enqueues a background job; 'sync' adds inline. Default: 'async'."
    ),
    mode: z.enum(["fast", "fine"]).optional().describe(
      "(Internal) Pipeline mode. Only used when async_mode='sync'."
    ),
    custom_tags: z.array(z.string()).optional().describe(
      "Custom tags (e.g. ['travel','family']) usable as filters in search."
    ),
    info: z.record(z.any()).optional().describe(
      "Additional metadata. All keys become filterable in search. " +
      "Example: { agent_id, app_id, source_type, source_url, source_content }"
    ),
    messages: z.union([
      z.string(),
      z.array(chatMessageSchema)
    ]).optional().describe(
      "Messages to store. Either a plain string or an array of OpenAI chat messages."
    ),
    chat_history: z.array(chatMessageSchema).optional().describe(
      "Historical chat context used internally by algorithms. Empty array disables internal history."
    ),
    is_feedback: z.boolean().optional().describe(
      "Whether this request represents user feedback. Default: false."
    ),
    mem_cube_id: z.string().optional().describe(
      "(Deprecated) Target cube ID. Prefer writable_cube_ids."
    ),
    memory_content: z.string().optional().describe(
      "(Deprecated) Plain memory content. Prefer 'messages'."
    ),
    doc_path: z.string().optional().describe("(Deprecated/internal) Path to a document to store."),
    source: z.string().optional().describe(
      "(Deprecated) Simple source tag. Prefer info.source_type / info.source_url."
    ),
    operation: z.array(permissionDictSchema).optional().describe(
      "(Internal) Multi-cube write permission definitions."
    )
  },
  async (args) => {
    try {
      const user_id = requireEnv("MEMOS_USER_ID");
      const body: Record<string, any> = { user_id };

      const messagesNormalized = Array.isArray(args.messages)
        ? normalizeMessages(args.messages)
        : args.messages;
      const historyNormalized = normalizeMessages(args.chat_history);

      // Assign only defined fields (1:1 with OpenAPI APIADDRequest)
      const passthrough: (keyof typeof args)[] = [
        "session_id", "task_id", "manager_user_id", "project_id",
        "writable_cube_ids", "async_mode", "mode", "custom_tags", "info",
        "is_feedback", "mem_cube_id", "memory_content", "doc_path",
        "source", "operation"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      if (messagesNormalized !== undefined) body.messages = messagesNormalized;
      if (historyNormalized !== undefined) body.chat_history = historyNormalized;

      const data = await postJson("/product/add", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: search_memory  →  POST /product/search   (APISearchRequest)
// ============================================================================

server.tool(
  "search_memory",
  `Retrieve memories via MemOS /product/search.
MUST be auto-invoked by the client before generating every answer.
Use 'filter' for precise scoping (e.g., by session_id, info.app_id, info.scene).`,
  {
    query: z.string().describe("User search query (required)"),
    readable_cube_ids: z.array(z.string()).optional().describe(
      "Readable cube IDs for this request (required for algorithm-facing API)."
    ),
    mode: z.enum(["fast", "fine", "mixture"]).optional().describe(
      "Search mode. Default: 'fast'."
    ),
    session_id: z.string().optional().describe(
      "Session ID used as a soft signal for relevance weighting (not a hard filter)."
    ),
    top_k: z.number().int().min(1).optional().describe(
      "Number of textual memories to retrieve. Default: 10."
    ),
    relativity: z.number().min(0).optional().describe(
      "Relevance threshold. Memories with metadata.relativity >= value are returned. 0 disables. Default: 0.45."
    ),
    dedup: z.enum(["no", "sim", "mmr"]).optional().describe(
      "Dedup strategy for textual memories. Default: 'mmr'."
    ),
    pref_top_k: z.number().int().min(0).optional().describe(
      "Number of preference memories to retrieve. Default: 6."
    ),
    include_preference: z.boolean().optional().describe(
      "Retrieve preference memories alongside general memories. Default: true."
    ),
    search_tool_memory: z.boolean().optional().describe(
      "Retrieve tool memories alongside general memories. Default: true."
    ),
    tool_mem_top_k: z.number().int().min(0).optional().describe(
      "Number of tool memories to retrieve. Default: 6."
    ),
    include_skill_memory: z.boolean().optional().describe(
      "Retrieve skill memories alongside general memories. Default: true."
    ),
    skill_mem_top_k: z.number().int().min(0).optional().describe(
      "Number of skill memories to retrieve. Default: 3."
    ),
    filter: filterSchema.optional(),
    internet_search: z.boolean().optional().describe(
      "Enable internet search in addition to memory search. Default: false."
    ),
    threshold: z.number().optional().describe(
      "Internal similarity threshold for plaintext memories. If omitted, server defaults apply."
    ),
    search_memory_type: z.string().optional().describe(
      "Memory type: All | WorkingMemory | LongTermMemory | UserMemory | OuterMemory | ToolSchemaMemory | ToolTrajectoryMemory | RawFileMemory | AllSummaryMemory | SkillMemory | PreferenceMemory. Default: 'All'."
    ),
    chat_history: z.array(chatMessageSchema).optional().describe(
      "Historical chat messages used internally by algorithms."
    ),
    mem_cube_id: z.string().optional().describe(
      "(Deprecated) Single cube ID. Prefer readable_cube_ids."
    ),
    moscube: z.boolean().optional().describe("(Deprecated/internal) Use legacy MemOSCube path."),
    operation: z.array(permissionDictSchema).optional().describe(
      "(Internal) Multi-cube read permission definitions."
    ),
    source: z.string().optional().describe("Source of the search query (plugin router hint)."),
    neighbor_discovery: z.boolean().optional().describe(
      "Enable neighbor-chunk discovery. Default: false."
    )
  },
  async (args) => {
    try {
      const user_id = requireEnv("MEMOS_USER_ID");
      const body: Record<string, any> = { query: args.query, user_id };

      const passthrough: (keyof typeof args)[] = [
        "readable_cube_ids", "mode", "session_id", "top_k", "relativity",
        "dedup", "pref_top_k", "include_preference", "search_tool_memory",
        "tool_mem_top_k", "include_skill_memory", "skill_mem_top_k", "filter",
        "internet_search", "threshold", "search_memory_type",
        "mem_cube_id", "moscube", "operation", "source", "neighbor_discovery"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      const historyNormalized = normalizeMessages(args.chat_history);
      if (historyNormalized !== undefined) body.chat_history = historyNormalized;

      const data = await postJson("/product/search", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: delete_memory  →  POST /product/delete_memory   (DeleteMemoryRequest)
// ============================================================================

server.tool(
  "delete_memory",
  `Delete memories via MemOS /product/delete_memory.
Provide at least one of: memory_ids, file_ids, filter, or quick conditions (user_id/session_id).
For user-requested deletion without IDs, first call search_memory to find them.`,
  {
    writable_cube_ids: z.array(z.string()).optional().describe("Writable cube IDs"),
    memory_ids: z.array(z.string()).optional().describe("Memory IDs to delete"),
    file_ids: z.array(z.string()).optional().describe("File IDs to delete"),
    filter: filterSchema.optional(),
    user_id: z.string().optional().describe(
      "Quick delete: remove all memories for this user_id. Defaults to MEMOS_USER_ID env when provided."
    ),
    session_id: z.string().optional().describe(
      "Quick delete: remove all memories for this session_id."
    ),
    conversation_id: z.string().optional().describe(
      "Alias of session_id for backward compatibility."
    ),
    auto_cleanup_working: z.boolean().optional().describe(
      "(Internal) Also delete related WorkingMemory nodes based on working_binding metadata. Default: false."
    )
  },
  async (args) => {
    try {
      const body: Record<string, any> = {};
      // user_id defaults to env if not explicitly overridden
      body.user_id = args.user_id ?? process.env.MEMOS_USER_ID;
      const passthrough: (keyof typeof args)[] = [
        "writable_cube_ids", "memory_ids", "file_ids", "filter",
        "session_id", "conversation_id", "auto_cleanup_working"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      if (!body.user_id) delete body.user_id;

      const data = await postJson("/product/delete_memory", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: add_feedback  →  POST /product/feedback   (APIFeedbackRequest)
// ============================================================================

server.tool(
  "add_feedback",
  `Submit feedback / corrections via MemOS /product/feedback.
Use this for modifying or correcting existing memories, NOT for adding new ones (use add_message).`,
  {
    session_id: z.string().optional().describe(
      "Session ID for soft-filtering memories. Default: 'default_session'."
    ),
    task_id: z.string().optional().describe("Task ID for monitoring async tasks"),
    history: z.array(chatMessageSchema).describe(
      "Chat history (required). Pass [] if no history is available."
    ),
    retrieved_memory_ids: z.array(z.string()).optional().describe(
      "Memory IDs that were retrieved in the previous turn."
    ),
    feedback_content: z.string().describe("Feedback content to process (required)"),
    feedback_time: z.string().optional().describe("Feedback timestamp"),
    writable_cube_ids: z.array(z.string()).optional().describe("Writable cube IDs"),
    async_mode: z.enum(["async", "sync"]).optional().describe(
      "Feedback mode. Default: 'async'."
    ),
    corrected_answer: z.boolean().optional().describe(
      "Whether to return a corrected answer. Default: false."
    ),
    info: z.record(z.any()).optional().describe(
      "Additional metadata. All keys become filterable. " +
      "Example: { agent_id, app_id, source_type, source_url, source_content }"
    ),
    mem_cube_id: z.string().optional().describe(
      "(Deprecated) Single cube ID. Prefer writable_cube_ids."
    )
  },
  async (args) => {
    try {
      const user_id = requireEnv("MEMOS_USER_ID");
      const body: Record<string, any> = {
        user_id,
        history: normalizeMessages(args.history) ?? [],
        feedback_content: args.feedback_content
      };
      const passthrough: (keyof typeof args)[] = [
        "session_id", "task_id", "retrieved_memory_ids", "feedback_time",
        "writable_cube_ids", "async_mode", "corrected_answer", "info",
        "mem_cube_id"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      const data = await postJson("/product/feedback", body);
      return okResult(data);
    } catch (e) {
      return errResult(e);
    }
  }
);

// ============================================================================
// Tool: get_user_profile  →  POST /product/get_memory   (GetMemoryRequest)
// ============================================================================

server.tool(
  "get_user_profile",
  `Retrieve paginated memories from a memory cube via MemOS /product/get_memory.
Use this for identity/profile summaries ("Who am I?") in addition to search_memory.`,
  {
    mem_cube_id: z.string().optional().describe(
      "Target memory cube ID (required by server). If omitted, resolves to env MEMOS_MEM_CUBE_ID, then MEMOS_USER_ID."
    ),
    user_id: z.string().optional().describe(
      "User ID. Defaults to MEMOS_USER_ID env when omitted."
    ),
    include_preference: z.boolean().optional().describe("Return preference memory. Default: true."),
    include_tool_memory: z.boolean().optional().describe("Return tool memory. Default: true."),
    include_skill_memory: z.boolean().optional().describe("Return skill memory. Default: true."),
    filter: filterSchema.optional(),
    page: z.number().int().min(1).optional().describe(
      "Page number (starts from 1). If omitted, exports all data without pagination."
    ),
    page_size: z.number().int().min(1).optional().describe(
      "Items per page. If omitted, exports all data without pagination."
    )
  },
  async (args) => {
    try {
      const resolvedCubeId =
        args.mem_cube_id ||
        process.env.MEMOS_MEM_CUBE_ID ||
        process.env.MEMOS_USER_ID;
      if (!resolvedCubeId) {
        throw new Error(
          "mem_cube_id is required. Provide it explicitly, or set MEMOS_MEM_CUBE_ID / MEMOS_USER_ID env."
        );
      }
      const body: Record<string, any> = { mem_cube_id: resolvedCubeId };
      body.user_id = args.user_id ?? process.env.MEMOS_USER_ID;
      if (!body.user_id) delete body.user_id;

      const passthrough: (keyof typeof args)[] = [
        "include_preference", "include_tool_memory", "include_skill_memory",
        "filter", "page", "page_size"
      ];
      for (const k of passthrough) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      const data = await postJson("/product/get_memory", body);
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
