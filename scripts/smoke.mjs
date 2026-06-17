// Smoke test: spawn the built MCP server, call a few tools, print results.
// Uses the official MCP SDK client over stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

const API_KEY = process.env.MEMOS_API_KEY;
const USER_ID = process.env.MEMOS_USER_ID || "mcp_smoke_user";
const CONV_ID = `${USER_ID}_smoke_run`;

if (!API_KEY) {
  console.error("MEMOS_API_KEY env var is required. Example:");
  console.error("  MEMOS_API_KEY=sk-xxxx MEMOS_USER_ID=smoke_user node scripts/smoke.mjs");
  process.exit(1);
}

function log(label, data) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  env: {
    ...process.env,
    MEMOS_API_KEY: API_KEY,
    MEMOS_USER_ID: USER_ID
  }
});

const client = new Client({ name: "smoke-test", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

// 1. List tools
const tools = await client.listTools();
log("tools.list (count=" + tools.tools.length + ")", tools.tools.map(t => t.name));

// 2. add_message
const addRes = await client.callTool({
  name: "add_message",
  arguments: {
    conversation_id: CONV_ID,
    messages: [
      { role: "user", content: "我打算下个月去成都吃火锅,有什么推荐的店吗?" },
      { role: "assistant", content: "推荐【蜀大侠、小龙坎、大龙燚】这几家连锁,本地老店可以试【马路边边】" }
    ],
    app_id: "smoke_test_app",
    tags: ["travel", "chengdu", "hotpot"],
    info: { scene: "qa", topic: "成都火锅推荐", lang: "zh" },
    async_mode: false
  }
});
log("add_message", addRes);

// 3. Wait briefly for indexing if it returned a task
await new Promise(r => setTimeout(r, 3000));

// 4. search_memory
const searchRes = await client.callTool({
  name: "search_memory",
  arguments: {
    query: "成都吃饭",
    conversation_id: CONV_ID,
    memory_limit_number: 3,
    include_preference: false,
    include_tool_memory: false,
    include_skill: false,
    relativity: 0
  }
});
log("search_memory", searchRes);

// 5. get_user_profile (page 1)
const profileRes = await client.callTool({
  name: "get_user_profile",
  arguments: { page: 1, size: 5, include_preference: false, include_tool_memory: false }
});
log("get_user_profile", profileRes);

// 6. extract_memory (no persistence)
const extractRes = await client.callTool({
  name: "extract_memory",
  arguments: {
    messages: [
      { role: "user", content: "我喜欢喝拿铁,不加糖" },
      { role: "assistant", content: "好的,记下来了" }
    ],
    extraction_types: ["memory", "preference"]
  }
});
log("extract_memory", extractRes);

// 7. rerank
const rerankRes = await client.callTool({
  name: "rerank",
  arguments: {
    model: "memos-reranker-0.6b",
    query: "成都火锅",
    documents: [
      "成都最有名的火锅店是蜀大侠和小龙坎",
      "上海的本帮菜值得尝试",
      "马路边边是成都老牌火锅店",
      "拿铁咖啡的做法"
    ],
    top_n: 3
  }
});
log("rerank", rerankRes);

// 8. delete_memory by user_id (cleanup)
const delRes = await client.callTool({
  name: "delete_memory",
  arguments: { user_id: USER_ID }
});
log("delete_memory (cleanup)", delRes);

await client.close();
console.log("\n[smoke] done.");
