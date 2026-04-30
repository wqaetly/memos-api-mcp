# MemOS API 的 MCP 服务

这是为 [MemOS](https://github.com/MemTensor/MemOS) **本地部署服务 v1.0.1** 实现的模型上下文协议（Model Context Protocol，MCP）。工具入参与 MemOS Server REST APIs 的 OpenAPI schema **一比一对齐**，零封装、零转义。

## 快速开始

### 前置条件

- Node.js >= 18
- 一个可访问的 MemOS Server v1.0.1 实例（例如 `http://localhost:8000`）

### 环境变量

| 变量名 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| `MEMOS_USER_ID` | 是 | - | 用户稳定标识。作为所有请求的 `user_id` 默认值。推荐：`SHA-256(lowercase(trim(email)))` / SSO subject / 员工 ID |
| `MEMOS_BASE_URL` | 否 | `http://localhost:8000` | MemOS Server 接入地址 |
| `MEMOS_MEM_CUBE_ID` | 否 | 等于 `MEMOS_USER_ID` | `get_user_profile` 默认使用的 `mem_cube_id`。未设置时回退到 `MEMOS_USER_ID` |

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
        "MEMOS_USER_ID": "demo_project",
        "MEMOS_BASE_URL": "http://localhost:8000"
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

1. **回答前**调用 `search_memory`，用 `filter` 精确限定本项目范围
2. 仅使用**与当前问题真正相关**的记忆；无关或噪声忽略
3. **回答后**调用 `add_message`，把本轮 user+assistant 消息和 `info` 元数据写入

> 无论用户说什么都要执行第 3 步，否则后续 `search_memory` 拿不到更细的用户信息。

### 推荐默认参数（生产环境踩坑后的最小模板）

#### search_memory（项目级共享）

```json
{
  "query": "<当前用户问题摘要>",
  "session_id": "demo_project_<stableConvId>",
  "top_k": 3,
  "search_memory_type": "LongTermMemory",
  "dedup": "no",
  "include_preference": false,
  "search_tool_memory": false,
  "include_skill_memory": false,
  "filter": {
    "and": [
      { "project_id": "demo_project" }
    ]
  }
}
```

关键点：
- **`dedup: "no"`**：默认 `"mmr"` 在本地中小模型上可能让 search 慢到 40s+，务必关掉
- **`top_k: 3`**：默认 10 会导致召回噪声过多，3 条是项目实测的甜点值
- **`search_memory_type: "LongTermMemory"`**：自动记忆场景下只查长期记忆最干净
- **`include_preference` / `search_tool_memory` / `include_skill_memory` 全关**：减少不必要的分支查询
- **`session_id`**：建议 `md5(user_id + 会话第一条用户消息)`，单次会话保持稳定

#### add_message（项目级共享）

```json
{
  "session_id": "demo_project_<stableConvId>",
  "project_id": "demo_project",
  "async_mode": "async",
  "mode": "fast",
  "messages": [
    { "role": "user", "content": "<用户本轮问题>" },
    { "role": "assistant", "content": "<助手最终回答>" }
  ],
  "info": {
    "app_id": "demo_project",
    "scope_key": "demo_project:project",
    "module": "<如 FrontEnd / Backend / DevOps>",
    "business_type": "<如 web_app / script / build_tool>",
    "biz_id": "<业务实体 ID，如类名/模块名>",
    "topic": "<一句话主题>",
    "keywords": ["<稳定关键词1>", "<稳定关键词2>"],
    "scene": "<coding / debug / daily_chat / qa>",
    "lang": "zh"
  }
}
```

关键点：
- **`async_mode: "async"` + `mode: "fast"`**：最低对话延迟的组合；同步+fine 会阻塞 10s+
- **`info` 的所有键会平铺到 memory 顶层属性**，因此 `search_memory` 的 `filter` 里**直接用扁平字段名**，不要写成 `info.xxx`
- **`scope_key`** 控制共享范围：
  - 项目级：`demo_project:project`
  - 团队级：`demo_project:<team_id>`
  - 个人级：`demo_project:<personal_id>`
- 不要传 `custom_tags`；稳定标签全部写入 `info.keywords`

## 可用 MCP 工具

所有工具的参数与 MemOS Server OpenAPI 完全一致，详细字段语义请参考 `http://<MEMOS_BASE_URL>/docs`。以下只列关键入参概览。

### 1. `add_message` → `POST /product/add`

保存消息并抽取记忆。用于**新增**信息（修正/删除请使用 `add_feedback`/`delete_memory`）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `session_id` | string | 否 | 会话 ID；未传则使用服务端默认会话 |
| `task_id` | string | 否 | 异步任务监控 ID |
| `manager_user_id` | string | 否 | 管理者用户 ID |
| `project_id` | string | 否 | 项目 ID（项目级隔离） |
| `writable_cube_ids` | string[] | 否 | 可写入的 cube ID 列表（多 cube 写入） |
| `async_mode` | `"async" \| "sync"` | 否 | 默认 `"async"`；**建议保持 `"async"`**，同步模式会阻塞对话 10s+ |
| `mode` | `"fast" \| "fine"` | 否 | 仅 `async_mode="sync"` 时生效；自动记忆场景建议 `"fast"` |
| `custom_tags` | string[] | 否 | 自定义标签；**不推荐使用**，请将标签写入 `info.keywords` 以便后续 filter |
| `info` | object | 否 | 结构化元数据；**所有键会被平铺到 memory 顶层属性**，可作为 search filter 的扁平字段 |
| `messages` | string \| ChatMessage[] | 否 | 要抽取记忆的内容（字符串或 OpenAI Chat 消息数组） |
| `chat_history` | ChatMessage[] | 否 | 历史上下文；传空数组可关闭服务端内部历史 |
| `is_feedback` | boolean | 否 | 是否标记为反馈，默认 `false` |
| `mem_cube_id` | string | 否 | **（已废弃）** 目标 cube ID，请用 `writable_cube_ids` |
| `memory_content` | string | 否 | **（已废弃）** 纯文本记忆，请用 `messages` |
| `doc_path` | string | 否 | （已废弃/内部） |
| `source` | string | 否 | **（已废弃）** 请用 `info.source_type` / `info.source_url` |
| `operation` | PermissionDict[] | 否 | （内部）多 cube 写权限定义 |

> `user_id` 由 `MEMOS_USER_ID` 环境变量自动注入，不作为入参暴露。

### 2. `search_memory` → `POST /product/search`

检索候选记忆。**回答前必须调用。**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 搜索查询 |
| `readable_cube_ids` | string[] | 否 | 可读 cube ID 列表 |
| `mode` | `"fast" \| "fine" \| "mixture"` | 否 | 默认 `"fast"` |
| `session_id` | string | 否 | 作为软信号用于相关性加权（非硬过滤）；建议保持单次会话稳定 |
| `top_k` | int | 否 | 事实型记忆数量，默认 10；**建议覆盖为 `3`**，避免召回噪声 |
| `relativity` | number | 否 | 相关度阈值，默认 0.45；传 0 关闭 |
| `dedup` | `"no" \| "sim" \| "mmr"` | 否 | 去重策略，默认 `"mmr"`；**本地中小模型建议设为 `"no"`**，否则可能慢到 40s+ |
| `pref_top_k` | int | 否 | 偏好记忆数量，默认 6 |
| `include_preference` | boolean | 否 | 默认 `true`；自动记忆场景建议 `false` |
| `search_tool_memory` | boolean | 否 | 默认 `true`；自动记忆场景建议 `false` |
| `tool_mem_top_k` | int | 否 | 工具记忆数量，默认 6 |
| `include_skill_memory` | boolean | 否 | 默认 `true` |
| `skill_mem_top_k` | int | 否 | Skill 数量，默认 3 |
| `filter` | object | 否 | 精确过滤条件（详见下方） |
| `internet_search` | boolean | 否 | 默认 `false` |
| `threshold` | number | 否 | 内部相似度阈值 |
| `search_memory_type` | string | 否 | `All` / `WorkingMemory` / `LongTermMemory` / `UserMemory` / `OuterMemory` / `ToolSchemaMemory` / `ToolTrajectoryMemory` / `RawFileMemory` / `AllSummaryMemory` / `SkillMemory` / `PreferenceMemory`，默认 `All` |
| `chat_history` | ChatMessage[] | 否 | 历史上下文 |
| `source` | string | 否 | 查询来源（路由提示） |
| `neighbor_discovery` | boolean | 否 | 邻近块发现，默认 `false` |
| `mem_cube_id` | string | 否 | **（已废弃）** 请用 `readable_cube_ids` |
| `moscube` | boolean | 否 | （已废弃/内部） |
| `operation` | PermissionDict[] | 否 | （内部） |

#### `filter` 参数

用于检索前精确限定记忆范围。

**结构（必须包一层 `and` 或 `or`）：**
```json
{
  "and": [
    { "id": "uuid-xxx" },
    { "created_at": { "gt": "2024-01-01" } }
  ]
}
```

> ⚠️ 不要传裸单字段 filter（如 `{"project_id": "x"}`），必须包在 `and`/`or` 数组内，否则后端报 400。

**可用字段：**
- 顶层服务端字段：`user_id`、`session_id`、`project_id`、`created_at`、`updated_at`
- **`info` 写入时的所有键会被平铺到 memory 顶层属性**。因此 filter 里**直接使用扁平字段名**（如 `app_id`、`scope_key`、`module`），**不要写成 `info.xxx`**

**运算符：**
- 逻辑：`and`、`or`
- 比较：`gt`、`gte`、`lt`、`lte`

**示例：**
```jsonc
// 按项目 + 场景过滤（scene 来自写入时的 info.scene，查询时是扁平字段）
{
  "and": [
    { "project_id": "demo_project" },
    { "scene": "coding" }
  ]
}

// 时间范围
{ "and": [ { "created_at": { "gte": "2026-01-01T00:00:00Z" } } ] }

// 复合：组内共享 + 多场景
{
  "and": [
    { "app_id": "demo_project" },
    { "scope_key": "demo_project:<team_id>" },
    { "or": [ { "scene": "coding" }, { "scene": "debug" } ] }
  ]
}
```

### 3. `delete_memory` → `POST /product/delete_memory`

按 ID / filter / 快速条件删除记忆。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `memory_ids` | string[] | 否 | 待删除记忆 ID |
| `file_ids` | string[] | 否 | 待删除文件 ID |
| `filter` | object | 否 | 按过滤条件批量删除 |
| `writable_cube_ids` | string[] | 否 | 可写入 cube ID |
| `user_id` | string | 否 | 快速条件：按用户清空，默认取 `MEMOS_USER_ID` |
| `session_id` | string | 否 | 快速条件：按会话清空 |
| `conversation_id` | string | 否 | `session_id` 的别名（向后兼容） |
| `auto_cleanup_working` | boolean | 否 | （内部）同步清理 WorkingMemory，默认 `false` |

### 4. `add_feedback` → `POST /product/feedback`

对已有记忆提交反馈 / 修正。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `feedback_content` | string | 是 | 反馈内容（自然语言，避免嵌技术 ID） |
| `history` | ChatMessage[] | 是 | 对话历史；无可传 `[]` |
| `session_id` | string | 否 | 默认 `"default_session"` |
| `task_id` | string | 否 | 异步任务监控 ID |
| `retrieved_memory_ids` | string[] | 否 | 上一轮检索到的记忆 ID |
| `feedback_time` | string | 否 | 反馈时间 |
| `writable_cube_ids` | string[] | 否 | 可写入 cube ID |
| `async_mode` | `"async" \| "sync"` | 否 | 默认 `"async"` |
| `corrected_answer` | boolean | 否 | 是否返回修正后的答案，默认 `false` |
| `info` | object | 否 | 自定义元数据（同 `add_message`） |
| `mem_cube_id` | string | 否 | **（已废弃）** |

### 5. `get_user_profile` → `POST /product/get_memory`

分页获取某个记忆 cube 的所有记忆。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mem_cube_id` | string | 否\* | 目标 cube ID；未传则依次回退到 `MEMOS_MEM_CUBE_ID` → `MEMOS_USER_ID` |
| `user_id` | string | 否 | 默认取 `MEMOS_USER_ID` |
| `include_preference` | boolean | 否 | 默认 `true` |
| `include_tool_memory` | boolean | 否 | 默认 `true` |
| `include_skill_memory` | boolean | 否 | 默认 `true` |
| `filter` | object | 否 | 同上 |
| `page` | int | 否 | 页码（从 1 开始）。未传则不分页导出全部 |
| `page_size` | int | 否 | 每页条数。未传则不分页导出全部 |

> \* 服务端要求 `mem_cube_id` 必填，但 MCP 层提供了环境变量回退，因此在入参上设为可选。

## ChatMessage 结构

所有 `messages` / `chat_history` / `history` 参数均接受 OpenAI Chat Completion 消息格式：

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

- 本地部署文档：`http://<MEMOS_BASE_URL>/docs`
- OpenAPI 原始 schema：`http://<MEMOS_BASE_URL>/openapi.json`

## 许可证

见仓库根目录。
