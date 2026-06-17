# MemOS 云端 API 的 MCP 服务

这是为 [MemOS 云端 API](https://memos-docs.openmem.net/cn/api_docs/start/overview) 实现的模型上下文协议（Model Context Protocol，MCP）。工具入参与 MemOS Cloud REST APIs 的官方文档 **一比一对齐**，零封装、零转义。

> 本仓库 `main` 分支对接 MemOS 本地部署 v1.0.1；当前 `cloud` 分支对接 OpenMem 官方云端服务。两套接口字段不一致，互不兼容。

## 快速开始

### 前置条件

- Node.js >= 18
- 一个有效的 MemOS Cloud API Key（在 https://memos-dashboard.openmem.net/apikeys/ 创建）

### 环境变量

| 变量名 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| `MEMOS_API_KEY` | 是 | - | OpenMem 控制台生成的 API Key，注入到 `Authorization: Token <KEY>` |
| `MEMOS_USER_ID` | 是 | - | 用户稳定标识。作为所有请求的默认 `user_id`。推荐：`SHA-256(lowercase(trim(email)))` / SSO subject / 员工 ID |
| `MEMOS_BASE_URL` | 否 | `https://memos.memtensor.cn/api/openmem/v1` | MemOS 云端接入地址；通常无需覆盖 |

### 构建

```bash
npm install
npm run build
```

## MCP 客户端配置

```json
{
  "mcpServers": {
    "memos-api-mcp": {
      "command": "node",
      "args": ["D:/memos-api-mcp/build/index.js"],
      "env": {
        "MEMOS_API_KEY": "sk-xxxxxxxxxxxxxxxx",
        "MEMOS_USER_ID": "demo_project"
      }
    }
  }
}
```

## 强制工作流

每轮对话必须按顺序执行：

```
用户消息 → 1) search_memory → 2) 回答 → 3) add_message
```

1. **回答前**调用 `search_memory`，用 `filter` / `tags` / `conversation_id` 精确限定本项目范围
2. 仅使用**与当前问题真正相关**的记忆；无关或噪声忽略
3. **回答后**调用 `add_message`，把本轮 user+assistant 消息和 `info` / `tags` 元数据写入

> 无论用户说什么都要执行第 3 步，否则后续 `search_memory` 拿不到更细的用户信息。

### 推荐默认参数

#### search_memory（项目级共享）

```json
{
  "query": "<当前用户问题摘要>",
  "conversation_id": "demo_project_<stableConvId>",
  "memory_limit_number": 3,
  "include_preference": false,
  "include_tool_memory": false,
  "include_skill": false,
  "filter": {
    "and": [
      { "app_id": "demo_project" }
    ]
  }
}
```

关键点：
- **`memory_limit_number: 3`**：默认 9 会导致召回噪声过多，3 条是项目实测的甜点值
- **`include_preference` / `include_tool_memory` / `include_skill` 全关**：减少不必要的分支查询
- **`conversation_id`**：建议 `md5(user_id + 会话第一条用户消息)`，单次会话保持稳定（云端会用它做相关性加权）

#### add_message（项目级共享）

```json
{
  "conversation_id": "demo_project_<stableConvId>",
  "app_id": "demo_project",
  "async_mode": true,
  "messages": [
    { "role": "user", "content": "<用户本轮问题>" },
    { "role": "assistant", "content": "<助手最终回答>" }
  ],
  "tags": ["<稳定关键词1>", "<稳定关键词2>"],
  "info": {
    "agent_id": "<可选，区分多 Agent 实例>",
    "module": "<如 FrontEnd / Backend / DevOps>",
    "business_type": "<如 web_app / script / build_tool>",
    "biz_id": "<业务实体 ID，如类名/模块名>",
    "topic": "<一句话主题>",
    "scene": "<coding / debug / daily_chat / qa>",
    "lang": "zh"
  }
}
```

关键点：
- **`async_mode: true`**：默认即异步，无需阻塞对话；同步模式建议仅在批处理脚本中使用
- **`info` 与 `tags` 的所有键都可作为 `search_memory.filter` 的扁平字段**，不要写成 `info.xxx`
- 项目级隔离推荐用 `app_id` 作 filter；多团队/多用户场景再叠加 `agent_id`

## 可用 MCP 工具

所有工具的参数与 MemOS 云端 OpenAPI 完全一致，详细字段语义请参考 https://memos-docs.openmem.net/cn/api_docs/start/overview 。以下只列关键入参概览。

### 核心 5 个

#### 1. `add_message` → `POST /add/message`

保存消息并抽取记忆。用于**新增**信息（修正/删除请使用 `add_feedback`/`delete_memory`）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `conversation_id` | string | 是 | 会话 ID；同一 ID 视为同一上下文 |
| `messages` | string \| ChatMessage[] | 是 | 消息内容（字符串或 OpenAI Chat 消息数组）。总 token ≤ 40k |
| `agent_id` | string | 否 | 关联 Agent 标识 |
| `app_id` | string | 否 | 关联应用标识 |
| `tags` | string[] | 否 | 自定义主题/分类标签，可作为 filter |
| `info` | object | 否 | 自定义元数据；所有键可作为 filter 字段 |
| `allow_public` | boolean | 否 | 是否允许写入公共库，默认 `false` |
| `allow_knowledgebase_ids` | string[] | 否 | 允许写入的知识库 ID 列表 |
| `async_mode` | boolean | 否 | 异步处理，默认 `true` |
| `user_id` | string | 否 | 默认取 `MEMOS_USER_ID` |

#### 2. `search_memory` → `POST /search/memory`

检索候选记忆。**回答前必须调用。**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 搜索查询，总 token ≤ 40k |
| `conversation_id` | string | 否 | 会话 ID，会作为相关性加权信号 |
| `filter` | object | 否 | 精确过滤条件（详见下方） |
| `knowledgebase_ids` | string[] | 否 | 限定可搜索的知识库；`["all"]` 表示全部 |
| `memory_limit_number` | int | 否 | 事实型记忆数量，默认 9，最大 25。**建议 3** |
| `include_preference` | boolean | 否 | 默认 `true`；自动记忆建议关 |
| `preference_limit_number` | int | 否 | 偏好记忆数量，默认 9，最大 25 |
| `include_tool_memory` | boolean | 否 | 默认 `false` |
| `tool_memory_limit_number` | int | 否 | 工具记忆数量，默认 6，最大 25 |
| `include_skill` | boolean | 否 | 默认 `false` |
| `skill_limit_number` | int | 否 | Skill 数量，默认 6，最大 25 |
| `relativity` | number | 否 | 相关度阈值 0–1，默认 0.45；传 0 关闭 |
| `user_id` | string | 否 | 默认取 `MEMOS_USER_ID` |

##### `filter` 参数

用于检索前精确限定记忆范围。

**结构（必须包一层 `and` 或 `or`）：**

```json
{
  "and": [
    { "app_id": "demo_project" },
    { "tags": "coding" }
  ]
}
```

> ⚠️ 不要传裸单字段 filter（如 `{"app_id": "x"}`），必须包在 `and`/`or` 数组内，否则后端报 400。

**可用字段：**
- 顶层服务端字段：`user_id`、`conversation_id`、`agent_id`、`app_id`、`create_time`、`update_time`
- **`info` 写入时的所有键 + `tags`** 都被平铺到 memory 顶层属性，filter 中**直接用扁平字段名**，不要写成 `info.xxx`
- 来源类快捷字段：`user`、`public`、`knowledgebase`

**运算符：**
- 逻辑：`and`、`or`
- 比较：`gt`、`gte`、`lt`、`lte`

**示例：**

```jsonc
// 按应用 + 场景过滤
{
  "and": [
    { "app_id": "demo_project" },
    { "scene": "coding" }
  ]
}

// 时间范围
{ "and": [ { "create_time": { "gte": "2026-01-01T00:00:00Z" } } ] }

// 复合：应用 + 多场景
{
  "and": [
    { "app_id": "demo_project" },
    { "or": [ { "scene": "coding" }, { "scene": "debug" } ] }
  ]
}
```

#### 3. `delete_memory` → `POST /delete/memory`

按 ID / 用户清空记忆。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `memory_ids` | string[] | 否\* | 待删除记忆 ID（来自 search_memory / get_user_profile 返回） |
| `user_id` | string | 否\* | 快速删除：清空该用户全部记忆。默认取 `MEMOS_USER_ID` |

\* 二者至少传一个。

#### 4. `add_feedback` → `POST /add/feedback`

对已有记忆提交反馈 / 修正。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `conversation_id` | string | 是 | 关联的会话 ID |
| `feedback_content` | string | 是 | 自然语言反馈内容 |
| `agent_id` | string | 否 | Agent 标识 |
| `app_id` | string | 否 | 应用标识 |
| `feedback_time` | string | 否 | 结构化或自然语言时间戳 |
| `allow_public` | boolean | 否 | 默认 `false` |
| `allow_knowledgebase_ids` | string[] | 否 | 可写知识库 ID |
| `user_id` | string | 否 | 默认取 `MEMOS_USER_ID` |

#### 5. `get_user_profile` → `POST /get/memory`

分页获取当前用户的全部记忆。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | int | 否 | 页码，默认 1 |
| `size` | int | 否 | 每页条数，默认 10，最大 50 |
| `filter` | object | 否 | 同上 |
| `include_preference` | boolean | 否 | 默认 `true` |
| `include_tool_memory` | boolean | 否 | 默认 `true` |
| `user_id` | string | 否 | 默认取 `MEMOS_USER_ID` |

### 云端独有 10 个

#### 6. `extract_memory` → `POST /extract/memory`

不入库，仅提取一次记忆 / 偏好。`messages` 总 token ≤ 8k；`extraction_types` 默认 `["memory","preference"]`。

#### 7. `rerank` → `POST /rerank`

调用 MemOS 重排序模型。`model`：`memos-reranker-0.6b` | `memos-reranker-4b`；`documents` 总 token ≤ 8k；`top_n` 可选。

#### 8. `chat` → `POST /chat`

带记忆 + 知识库增强的对话。本 MCP 工具固定 `stream=false`（流式不通过 MCP 暴露）。可选 LLM 参数：`model_name`（默认 `qwen2.5-72B-Instruct`）、`system_prompt`、`max_tokens`、`temperature`、`top_p`。

#### 9. `get_message` → `POST /get/message`

按 `conversation_id` 拉取原始消息列表。`message_limit_number` 默认 6，最大 50。

#### 10. `get_task_status` → `POST /get/status`

查询 `add_message` 在 `async_mode=true` 下返回的 `task_id` 状态：`running` / `completed` / `failed`。

#### 11. `create_knowledge_base` → `POST /create/knowledgebase`

新建知识库：`knowledgebase_name` 必填，`knowledgebase_description` 可选。

#### 12. `remove_knowledge_base` → `POST /delete/knowledgebase`

从当前项目移除知识库（彻底删除仍需在控制台操作）。

#### 13. `add_kb_document` → `POST /add/knowledgebase-file`

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

#### 14. `get_kb_documents` → `POST /get/knowledgebase-file`

两种模式：
- **A 列出**：`knowledgebase_id` + 可选 `type` / `page` / `page_size`
- **B 查具体**：`file_ids[]`

#### 15. `delete_kb_document` → `POST /delete/knowledgebase-file`

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

## 与上游文档

- 云端 API 总览：https://memos-docs.openmem.net/cn/api_docs/start/overview
- 控制台 / API Key：https://memos-dashboard.openmem.net/

## 许可证

见仓库根目录。
