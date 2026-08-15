import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const requests = [];
const api = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    requests.push({ path: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, data: { success: true }, message: "ok" }));
  });
});

await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const address = api.address();
assert(address && typeof address === "object");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/index.js"],
  env: {
    ...process.env,
    MEMOS_API_KEY: "contract-test-key",
    MEMOS_USER_ID: "default-user",
    MEMOS_BASE_URL: `http://127.0.0.1:${address.port}`
  }
});
const client = new Client(
  { name: "memos-contract-test", version: "1.0.0" },
  { capabilities: {} }
);

try {
  await client.connect(transport);

  const readmeText = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readmeText, /## MCP Prompt 模块/);
  assert.match(readmeText, /默认只做项目级隔离/);
  assert.match(readmeText, /code: 0.*结果列表为空表示检索成功但没有命中/s);
  assert.match(readmeText, /task_id.*get_task_status/s);
  assert.doesNotMatch(readmeText, /\uFFFD|\uFFFE/, "README must not contain replacement characters");
  assert.doesNotMatch(readmeText, /\?{3,}/, "README must not contain garbled text (3+ consecutive question marks)");
  assert.equal((readmeText.match(/MEMOS_PROMPT_START/g) || []).length, 1, "README prompt boundary start must be unique");
  assert.equal((readmeText.match(/MEMOS_PROMPT_END/g) || []).length, 1, "README prompt boundary end must be unique");
  const readmePromptMatch = readmeText.match(/MEMOS_PROMPT_START\n([\s\S]*?)\nMEMOS_PROMPT_END/);
  assert(readmePromptMatch, "README must contain a copyable prompt module between MEMOS_PROMPT_START and MEMOS_PROMPT_END");

  const { prompts } = await client.listPrompts();
  assert(
    prompts.some((prompt) => prompt.name === "memos_mandatory_workflow"),
    "mandatory memory workflow prompt must be exposed"
  );
  const workflowPrompt = await client.getPrompt({ name: "memos_mandatory_workflow" });
  const workflowText = workflowPrompt.messages
    .map((message) => message.content.type === "text" ? message.content.text : "")
    .join("\n");
  assert.match(workflowText, /Start with project-level isolation only/);
  assert.match(workflowText, /Do NOT add `tags`, `scene`, or other metadata filters by default/);
  assert.match(workflowText, /code: 0.*empty result lists means the search succeeded/s);
  assert.match(workflowText, /never `\{ "info": \{ "scene": "coding" \} \}`/);
  assert.match(workflowText, /use the returned `task_id` with `get_task_status`/);
  assert.match(workflowText, /same project `app_id` for writes and project-scoped searches/);
  assert.match(workflowText, /stable `conversation_id` for the whole conversation/);
  assert.equal(
    readmePromptMatch[1],
    workflowText,
    "README copyable prompt module must be byte-identical to the runtime workflow prompt"
  );

  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert(byName.has("update_memory"), "update_memory must be exposed");
  assert.deepEqual(byName.get("add_message").inputSchema.required, ["messages"]);
  assert(byName.get("search_memory").inputSchema.properties.include_memory_view);
  assert(byName.get("search_memory").inputSchema.properties.agent_id);

  await client.callTool({
    name: "add_message",
    arguments: {
      user_id: ["user-a", "user-b"],
      agent_id: ["agent-a", "agent-b"],
      conversation_id: "contract-conversation",
      messages: [{
        role: "user",
        role_id: "speaker-1",
        role_name: "测试用户",
        content: "测试消息"
      }],
      app_id: "contract-app",
      allow_memory_view: ["detail_factual", "event"],
      tags: ["contract"],
      info: { scene: "test", biz_id: "contract-1" },
      allow_public: false,
      allow_knowledgebase_ids: ["kb-1"],
      async_mode: false
    }
  });

  await client.callTool({
    name: "search_memory",
    arguments: {
      agent_id: "agent-only",
      conversation_id: "contract-conversation",
      query: "查询测试记忆",
      filter: {
        and: [
          { app_id: "contract-app" },
          { tags: { contains: "contract" } }
        ]
      },
      knowledgebase_ids: ["all"],
      include_memory_view: ["detail_factual", "skill"],
      memory_limit_number: 3,
      relativity: 0
    }
  });

  await client.callTool({
    name: "search_memory",
    arguments: {
      query: "兼容旧版开关",
      include_preference: false,
      include_tool_memory: false,
      include_skill: false
    }
  });

  await client.callTool({
    name: "add_feedback",
    arguments: {
      conversation_id: "contract-conversation",
      feedback_content: "请修正这段记忆",
      app_id: "contract-app"
    }
  });

  await client.callTool({
    name: "update_memory",
    arguments: {
      memory_id: "memory-1",
      title: "更新后的标题",
      content: "更新后的内容"
    }
  });

  assert.equal(requests.length, 5);

  const add = requests[0];
  assert.equal(add.path, "/add/message");
  assert.deepEqual(add.body.user_id, ["user-a", "user-b"]);
  assert.deepEqual(add.body.agent_id, ["agent-a", "agent-b"]);
  assert.equal(add.body.messages[0].role_id, "speaker-1");
  assert.equal(add.body.messages[0].role_name, "测试用户");
  assert.deepEqual(add.body.allow_memory_view, ["detail_factual", "event"]);

  const search = requests[1];
  assert.equal(search.path, "/search/memory");
  assert.equal(search.body.agent_id, "agent-only");
  assert.equal("user_id" in search.body, false, "agent search must not inject user_id");
  assert.deepEqual(search.body.filter.and[1], { tags: { contains: "contract" } });
  assert.deepEqual(search.body.include_memory_view, ["detail_factual", "skill"]);

  const legacySearch = requests[2];
  assert.equal(legacySearch.body.user_id, "default-user");
  assert.deepEqual(legacySearch.body.include_memory_view, ["detail_factual"]);
  assert.equal("include_preference" in legacySearch.body, false);
  assert.equal("include_tool_memory" in legacySearch.body, false);
  assert.equal("include_skill" in legacySearch.body, false);

  const feedback = requests[3];
  assert.equal(feedback.path, "/add/feedback");
  assert.equal(feedback.body.user_id, "default-user");
  assert.equal(feedback.body.app_id, "contract-app");

  const update = requests[4];
  assert.equal(update.path, "/update/memory");
  assert.deepEqual(update.body, {
    memory_id: "memory-1",
    title: "更新后的标题",
    content: "更新后的内容"
  });

  console.log("contract-test: README prompt, runtime workflow prompt, and 5 API payloads verified");
} finally {
  await client.close().catch(() => {});
  await new Promise((resolve) => api.close(resolve));
}
