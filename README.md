# MemOS Cloud API MCP

?????? [MemOS Cloud REST API](https://memos-docs.openmem.net/cn/api_docs/start/overview) ? Model Context Protocol?MCP????

- `main` ???????????????
- `cloud` ???? OpenMem ??????
- ?????`2.0.0`?

## ????

- Node.js >= 18
- MemOS Cloud API Key

| ???? | ?? | ??? | ?? |
|---|---:|---|---|
| `MEMOS_API_KEY` | ? | - | ??? `Authorization: Token <KEY>` ????? |
| `MEMOS_USER_ID` | ? | - | MCP ?????? `user_id` ???????? ID |
| `MEMOS_BASE_URL` | ? | `https://memos.memtensor.cn/api/openmem/v1` | MemOS Cloud API ??? |

## ?????

```bash
npm install
npm test
```

`npm test` ????? `build/index.js`????????? API???????????

- `add_message` ???????????Agent ???`allow_memory_view`?`tags`?`info` ???
- `search_memory` ? `agent_id`/`user_id` ????Filter DSL?`include_memory_view`?
- ?? `include_preference`?`include_tool_memory`?`include_skill` ???????????
- `add_feedback` ????
- `update_memory` ???? MCP ?????

?????? API ??????

```bash
npm run build
MEMOS_API_KEY=your-key MEMOS_USER_ID=smoke-user node scripts/smoke.mjs
```

## MCP ??

???????????

```json
{
  "mcpServers": {
    "memos-api-mcp": {
      "command": "node",
      "args": ["C:/study/wqaetly/memos-api-mcp/build/index.js"],
      "env": {
        "MEMOS_API_KEY": "your-key",
        "MEMOS_USER_ID": "stable-user-id"
      }
    }
  }
}
```

??????? `npm run build`???? MCP ????? MCP ?????????????

## MCP Prompt 模块

服务暴露了 `memos_mandatory_workflow` Prompt，用于约束客户端每轮执行：

```text
用户消息 → search_memory → 生成回答 → add_message
```

### 推荐的 `search_memory` 默认参数

```json
{
  "query": "<当前用户问题摘要>",
  "conversation_id": "<会话内稳定 ID>",
  "memory_limit_number": 3,
  "include_memory_view": ["detail_factual"],
  "filter": {
    "and": [
      { "app_id": "project-name" }
    ]
  }
}
```

检索规则：

- `search_memory` 与 `add_message` 必须使用同一个项目 `app_id` 和会话 `conversation_id`。
- Filter 必须包在 `and` 或 `or` 中。
- 默认只做项目级隔离。不要默认叠加 `tags`、`scene` 等精确条件；只有确认写入值长期一致且确需缩小范围时才追加，否则会把有效记忆过滤掉。
- `info` 中的字段会被扁平化。按场景过滤应写 `{"scene":"coding"}`，不要写 `{"info":{"scene":"coding"}}` 或 `{"info.scene":"coding"}`。
- `code: 0` 且结果列表为空表示检索成功但没有命中，常见于首次对话或该项目尚未写入记忆；此时正常回答，并继续执行 `add_message`。

### 推荐的 `add_message` 默认参数

```json
{
  "conversation_id": "<与检索相同的会话 ID>",
  "app_id": "project-name",
  "async_mode": true,
  "messages": [
    { "role": "user", "content": "<用户本轮问题>" },
    { "role": "assistant", "content": "<助手最终回答>" }
  ],
  "tags": ["<稳定关键词1>", "<稳定关键词2>"],
  "info": {
    "agent_id": "<可选 Agent 标识>",
    "module": "<模块名>",
    "business_type": "<业务类型>",
    "biz_id": "<业务实体 ID>",
    "topic": "<一句话主题>",
    "scene": "coding",
    "lang": "zh"
  }
}
```

`async_mode: true` 时，记忆抽取可能不会立即出现在下一次检索中。需要马上验证时，使用返回的 `task_id` 调用 `get_task_status`，任务完成后再检索，或进行有界重试。

### `add_feedback`

?????[Add Feedback](https://memos-docs.openmem.net/cn/api_docs/message/add_feedback)

??????????????????????????

```json
{
  "user_id": "stable-user-id",
  "conversation_id": "stable-conversation-id",
  "feedback_content": "???????????",
  "app_id": "project-name"
}
```

### `update_memory`

?????[Update Memory](https://memos-docs.openmem.net/cn/api_docs/core/update_memory)

?????? ID ?????????/????

```json
{
  "memory_id": "memory-id-from-search",
  "title": "??????",
  "content": "??????"
}
```

`title` ? `content` ??????

## ??

```bash
npm test
git push origin cloud
npm publish
```

???????? npm ??????????? `@memtensor/memos-api-mcp` ??????
