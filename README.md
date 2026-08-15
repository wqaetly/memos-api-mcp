# MemOS Cloud API MCP

这是为 [MemOS Cloud REST API](https://memos-docs.openmem.net/cn/api_docs/start/overview) 实现的模型上下文协议（Model Context Protocol，MCP）服务。工具入参与 MemOS Cloud REST APIs 官方文档**一比一对齐**，零封装、零转义。

- `main` 分支对接 MemOS 本地部署 v1.0.1（旧接口，字段与云端不一致，互不兼容）。
- `cloud` 分支对接 OpenMem 官方云端服务（当前所在分支）。
- 当前版本：`2.0.0`。

## 快速开始

### 前置条件

- Node.js >= 18
- 一个有效的 MemOS Cloud API Key

### 环境变量

| 变量名 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| `MEMOS_API_KEY` | 是 | - | 请求头 `Authorization: Token <KEY>` 使用的 API Key |
| `MEMOS_USER_ID` | 是 | - | MCP 请求的默认 `user_id`；建议使用稳定的用户唯一 ID |
| `MEMOS_BASE_URL` | 否 | `https://memos.memtensor.cn/api/openmem/v1` | MemOS Cloud API 接入地址；通常无需覆盖 |

### 构建与契约测试

```bash
npm install
npm test
```

`npm test` 会先构建 `build/index.js`，再用假 API 服务器启动编译产物并验证契约：

- `add_message`：数组形式的 `user_id` / `agent_id`、`allow_memory_view`、`tags`、`info`
- `search_memory`：`agent_id` 检索不注入 `user_id`、Filter DSL、`include_memory_view`
- 旧版 `include_preference` / `include_tool_memory` / `include_skill` 兼容别名
- `add_feedback`、`update_memory` 请求载荷
- README Prompt 模块与运行时 `memos_mandatory_workflow` Prompt 内容一致

### 冒烟测试（真实 API）

```bash
npm run build
MEMOS_API_KEY=sk-xxxxxxxxxxxxxxxx \
MEMOS_USER_ID=smoke_$(date +%s) \
  node scripts/smoke.mjs
```

## MCP 客户端配置

```json
{
  "mcpServers": {
    "memos-api-mcp": {
      "command": "node",
      "args": ["C:/study/wqaetly/memos-api-mcp/build/index.js"],
      "env": {
        "MEMOS_API_KEY": "sk-xxxxxxxxxxxxxxxx",
        "MEMOS_USER_ID": "stable-user-id"
      }
    }
  }
}
```

修改源码后需 `npm run build` 重新生成编译产物，再重启 MCP 客户端使新代码生效。

## MCP Prompt 模块

服务暴露 `memos_mandatory_workflow` Prompt，用于约束客户端每轮对话的强制记忆工作流：

```text
用户消息 → search_memory → 生成回答 → add_message
```

### 复制方式

复制下方代码块中**两行边界标记之间**的全部内容（含边界行）即可直接使用，无需任何改写。

### 中文规则速查（与下方 Prompt 等价）

- **每轮顺序固定**：`search_memory`（回答前）→ 回答 → `add_message`（回答后）。
- `search_memory` 与 `add_message` 必须使用**同一个项目 `app_id`** 和**稳定 `conversation_id`**。
- 默认只做项目级隔离。不要默认叠加 `tags`、`scene` 等精确条件；只有确认写入值长期一致且确需缩小范围时才追加，否则会把有效记忆过滤掉。
- `info` 中的字段会被扁平化。按场景过滤应写 `{"scene":"coding"}`，不要写 `{"info":{"scene":"coding"}}` 或 `{"info.scene":"coding"}`。
- `code: 0` 且结果列表为空表示检索成功但没有命中，常见于首次对话或该项目尚未写入记忆；此时正常回答，并继续执行 `add_message`。
- `add_message` 默认 `async_mode: true`，需要立即验证时用返回的 `task_id` 调用 `get_task_status`，任务完成后再检索或进行有界重试。
- 修正记忆：`add_feedback`（会话级修正）；按 ID 直改：`update_memory`；删除：`search_memory` 找到 ID 后 `delete_memory`。
- "我是谁 / 你知道我什么"类问题，除 `search_memory` 外再调用 `get_user_profile`。

### 完整 Prompt（可直接复制）

````text
MEMOS_PROMPT_START
# 🧠 MemOS Cloud Memory System — Mandatory Usage

## ⚠️ Always-On
The client MUST auto-invoke memory tools on every turn. Do not wait for the user to request it.

## 🎯 3-Step Workflow
```
Every user message
  → 1) 🔍 search_memory   (BEFORE answering)
  → 2) 💬 Answer           (use only relevant memories; ignore noise)
  → 3) 💾 add_message      (AFTER answering)
```

### 1) 🔍 search_memory
- Required: `query` (concise summary of the user message)
- Recommended defaults: `conversation_id` (stable per-thread ID managed by the client),
  `memory_limit_number` = 3, `include_memory_view` = ["detail_factual"]
- Start with project-level isolation only. Keep the same `app_id` here and in `add_message`:
  ```json
  { "and": [
    { "app_id": "<your-app-id>" }
  ]}
  ```
- Every filter must be wrapped in `and` or `or`.
- Do NOT add `tags`, `scene`, or other metadata filters by default. Add them only when the
  same values were written consistently and narrower retrieval is genuinely needed; otherwise
  an exact filter can hide relevant memories.
- Metadata stored in `info` is flattened by MemOS. Filter with `{ "scene": "coding" }`,
  never `{ "info": { "scene": "coding" } }` or `{ "info.scene": "coding" }`.
- `code: 0` with empty result lists means the search succeeded but found no matching memory.
  This is expected on a first turn or when the current scope has not been written yet. Answer
  normally and still run `add_message` so later turns can recall the new context.

### 2) 💬 Answer
Judge relevance; use only memories that truly help; otherwise ignore and answer normally.

### 3) 💾 add_message
- After composing the final answer, save the exact user message and exact assistant answer before
  the turn ends.
- Required by this workflow: `messages`, the same stable `conversation_id`, and the same
  project `app_id` used by `search_memory.filter`.
- Recommended defaults:
  - `async_mode`: `true`
  - `tags`: human-readable topic tags
  - `info`: structured metadata (keys become searchable filters)
    Suggested keys: `agent_id`, `module`, `scene`, `business_type`, `biz_id`, `lang`, `topic`
- Async extraction may not be searchable immediately. When immediate verification is required,
  use the returned `task_id` with `get_task_status` and search after completion (or retry).

## 🔄 Update / Delete
- Delete: find IDs via `search_memory` → call `delete_memory`.
- Direct edit by memory ID: call `update_memory`.
- Conversation-based correction: call `add_feedback` with `feedback_content` and the same `conversation_id`.

## 👤 Identity Summary
- For "Who am I?" / "What do you know about me?" questions, call `get_user_profile`
  in addition to `search_memory`.

## Non-Negotiable Client Responsibilities
1. Always call `search_memory` before answering and `add_message` after answering.
2. Maintain a stable `conversation_id` for the whole conversation.
3. Use the same project `app_id` for writes and project-scoped searches.
4. Treat empty successful searches as no-match results, not as MCP failures.
5. Use flattened metadata field names and add narrow filters only when their values are known.

MEMOS_PROMPT_END
````

## 可用 MCP 工具

共 16 个工具，参数与 MemOS 云端 OpenAPI 完全一致，详细字段语义参考 https://memos-docs.openmem.net/cn/api_docs/start/overview 。以下只列关键入参概览。

### 核心记忆工具（6 个）

#### 1. `add_message` → `POST /add/message`

保存消息并抽取记忆，用于**新增**信息（修正/删除请使用 `add_feedback` / `delete_memory`）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `messages` | ChatMessage[] | 是 | 消息数组（OpenAI 格式，见下文）。总 token ≤ 40k |
| `conversation_id` | string | 否 | 会话 ID；同一 ID 视为同一上下文 |
| `user_id` | string \| string[] | 否 | 单个或最多 20 个用户 ID；默认取 `MEMOS_USER_ID` |
| `agent_id` | string \| string[] | 否 | Agent ID 或列表 |
| `app_id` | string | 否 | 应用标识，可作为 filter 字段 |
| `allow_memory_view` | string[] | 否 | 允许抽取的记忆类型，如 `detail_factual` / `preference` / `skill` / `profile` / `event` / `tool_memory` |
| `tags` | string[] | 否 | 自定义标签，可作为 filter 字段 |
| `info` | object | 否 | 自定义元数据；所有键可作为 filter 字段 |
| `allow_public` | boolean | 否 | 是否允许写入公共库，默认 `false` |
| `allow_knowledgebase_ids` | string[] | 否 | 允许写入的知识库 ID 列表 |
| `async_mode` | boolean | 否 | 异步处理，默认 `true` |

#### 2. `search_memory` → `POST /search/memory`

检索候选记忆。**回答前必须调用。**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 搜索查询，总 token ≤ 40k |
| `conversation_id` | string | 否 | 会话 ID，作为相关性加权信号 |
| `user_id` | string | 否 | 默认取 `MEMOS_USER_ID`（与 `agent_id` 二选一） |
| `agent_id` | string | 否 | Agent 记忆检索；传了就不注入 `user_id` |
| `filter` | object | 否 | 精确过滤条件（见下文） |
| `knowledgebase_ids` | string[] | 否 | 可搜索的知识库；`["all"]` 表示全部 |
| `include_memory_view` | string[] | 否 | 允许出现的记忆类型，默认 `["detail_factual","preference"]` |
| `memory_limit_number` | int | 否 | 事实型记忆数量，默认 9，最大 25。**建议 3** |
| `relativity` | number | 否 | 相关度阈值 0–1，默认 0.45；传 0 关闭 |
| `include_preference` / `include_tool_memory` / `include_skill` | boolean | 否 | 旧版兼容别名，优先用 `include_memory_view` |

##### `filter` 参数

用于检索前精确限定记忆范围。**结构必须包一层 `and` 或 `or`**，不要传裸单字段 filter，否则后端报 400。

```json
{
  "and": [
    { "app_id": "project-name" },
    { "tags": { "contains": "topic" } }
  ]
}
```

**可用字段**：
- 顶层服务端字段：`user_id`、`conversation_id`、`agent_id`、`app_id`、`create_time`、`update_time`
- `info` 写入时的所有键 + `tags` 被平铺到 memory 顶层属性，filter 中**直接用扁平字段名**，不要写成 `info.xxx`

**运算符**：逻辑 `and` / `or`；比较 `gt` / `gte` / `lt` / `lte`；`tags` 用 `{"contains":"值"}`。

```jsonc
// 按应用 + 场景过滤
{ "and": [ { "app_id": "project-name" }, { "scene": "coding" } ] }

// 时间范围
{ "and": [ { "create_time": { "gte": "2026-01-01T00:00:00Z" } } ] }

// 复合：应用 + 多场景
{
  "and": [
    { "app_id": "project-name" },
    { "or": [ { "scene": "coding" }, { "scene": "debug" } ] }
  ]
}
```

#### 3. `update_memory` → `POST /update/memory`

按记忆 ID 直接更新。**`title` 与 `content` 至少提供一个。**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `memory_id` | string | 是 | 记忆 ID（来自 `search_memory` / `get_user_profile` 返回） |
| `title` | string | 否 | 替换后的标题 |
| `content` | string | 否 | 替换后的内容 |

#### 4. `delete_memory` → `POST /delete/memory`

按 ID 删除或按用户清空记忆。`memory_ids` 与 `user_id` 至少传一个。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `memory_ids` | string[] | 否* | 待删除记忆 ID（来自 `search_memory` / `get_user_profile`） |
| `user_id` | string | 否* | 快速删除：清空该用户全部记忆；默认取 `MEMOS_USER_ID` |

#### 5. `add_feedback` → `POST /add/feedback`

对已有记忆提交反馈 / 修正。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `conversation_id` | string | 是 | 关联的会话 ID |
| `feedback_content` | string | 是 | 自然语言反馈内容 |
| `agent_id` | string | 否 | Agent 标识 |
| `app_id` | string | 否 | 应用标识 |
| `feedback_time` | string | 否 | 结构化或自然语言时间戳 |
| `allow_public` | boolean | 否 | 是否允许写入公共库，默认 `false` |
| `allow_knowledgebase_ids` | string[] | 否 | 可写知识库 ID |
| `user_id` | string | 否 | 默认取 `MEMOS_USER_ID` |

#### 6. `get_user_profile` → `POST /get/memory`

分页获取当前用户的全部记忆（"我是谁"类问题）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | int | 否 | 页码，默认 1 |
| `size` | int | 否 | 每页条数，默认 10，最大 50 |
| `filter` | object | 否 | 同上 |
| `include_preference` | boolean | 否 | 是否包含偏好记忆，默认 `true` |
| `include_tool_memory` | boolean | 否 | 是否包含工具记忆，默认 `true` |
| `user_id` | string | 否 | 默认取 `MEMOS_USER_ID` |

### 云端独有工具（10 个）

#### 7. `extract_memory` → `POST /extract/memory`

不入库，仅提取一次记忆 / 偏好。`messages` 总 token ≤ 8k；`extraction_types` 默认 `["memory","preference"]`。

#### 8. `rerank` → `POST /rerank`

调用 MemOS 重排序模型。`model`：`memos-reranker-0.6b` | `memos-reranker-4b`；`query` 必填；`documents` 总 token ≤ 8k；`top_n` 可选。

#### 9. `chat` → `POST /chat`

带记忆 + 知识库增强的对话。本 MCP 工具固定 `stream=false`（流式不通过 MCP 暴露）。可选 LLM 参数：`model_name`（默认 `qwen2.5-72B-Instruct`）、`system_prompt`、`max_tokens`（默认 8192）、`temperature`（默认 0.7）、`top_p`（默认 0.95）。

#### 10. `get_message` → `POST /get/message`

按 `conversation_id` 拉取原始消息列表。`message_limit_number` 默认 6，最大 50。

#### 11. `get_task_status` → `POST /get/status`

查询 `add_message` 在 `async_mode=true` 下返回的 `task_id` 状态：`running` / `completed` / `failed`。

#### 12. `create_knowledge_base` → `POST /create/knowledgebase`

新建知识库：`knowledgebase_name` 必填，`knowledgebase_description` 可选。

#### 13. `remove_knowledge_base` → `POST /delete/knowledgebase`

从当前项目移除知识库（彻底删除仍需在控制台操作）。`knowledgebase_id` 必填。

#### 14. `add_kb_document` → `POST /add/knowledgebase-file`

上传文档/技能到知识库：

```json
{
  "knowledgebase_id": "kb_xxx",
  "file": [
    { "name": "report.pdf", "type": "document", "content": "https://example.com/report.pdf" },
    { "type": "skill", "content": "data:text/markdown;base64,IyBoZWxsbw==" }
  ]
}
```

#### 15. `get_kb_documents` → `POST /get/knowledgebase-file`

两种模式：
- **A 列出**：`knowledgebase_id` + 可选 `type` / `page` / `page_size`
- **B 查具体**：`file_ids[]`（与 A 互斥）

#### 16. `delete_kb_document` → `POST /delete/knowledgebase-file`

按 `file_ids[]` 删除文件（普通文档或 skill 包）。

## ChatMessage 结构

所有 `messages` 参数均接受 OpenAI Chat Completion 消息格式：

```jsonc
{
  "role": "system" | "user" | "assistant" | "tool",
  "content": "纯文本" | [ { "type": "text", "text": "..." }, ... ],
  "chat_time": "2026-04-20 15:30:00",   // 可选，MCP 会自动填充
  "message_id": "...",                   // 可选
  "tool_call_id": "...",                 // role=tool 时必填
  "tool_calls": [...]                    // role=assistant 时可选
}
```

## 上游文档

- 云端 API 总览：https://memos-docs.openmem.net/cn/api_docs/start/overview
- 控制台 / API Key：https://memos-dashboard.openmem.net/

## 许可证

见仓库根目录。
