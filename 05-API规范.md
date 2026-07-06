# AgentChat · API 规范

Base URL: `/api/v1`。除注明外均需 `Authorization: Bearer <jwt>`。
错误统一 `{ "error": { "code": "...", "message": "..." } }`；限流/额度用 429。

## 1. 认证
```
POST /auth/register        {email, password, name}
POST /auth/login           {email, password} → {access_token, refresh_token}
POST /auth/refresh         {refresh_token} → {access_token}
GET  /me                   → 用户信息 + plan + 当日用量
```

## 2. 会话与消息
```
POST   /threads                          {project_id?} → thread
GET    /threads?cursor=&limit=&q=&archived=   游标分页; q 走 SearchBackend
PATCH  /threads/{id}                     {title?|pinned?|archived?}
DELETE /threads/{id}                     软删除
GET    /threads/{id}/messages?branch_id= → content 结构见 02文档 §2.5
GET    /threads/{id}/branches            → 分支树(版本切换用)
POST   /threads/{id}/head                {branch_id}  切换展示分支

POST   /threads/{id}/messages            发送消息(异步, 内容走 SSE, 见 §6)
  body: {text, attachment_ids?: [id]   # 暂存附件随本次发送转正纳入上下文(见10文档),
         model?, thinking?: bool,
         tools_override?: {web_search?: bool}, permission_mode?}
  → {run_id, branch_id, message_id}

POST   /threads/{id}/messages/{mid}/edit {text, ...同上}   编辑→fork新分支
POST   /threads/{id}/messages/{mid}/regenerate              重新生成
POST   /runs/{id}/stop
GET    /runs/{id}                        状态/usage/错误
```

## 3. 斜杠命令
```
GET    /threads/{id}/commands?prefix=    聚合: builtin+skills+mcp, 含 local 标记
GET    /commands  POST /commands  PATCH /commands/{id}  DELETE /commands/{id}
  command: {owner_type, name, description, argument_hint,
            allowed_tools, model?, body, enabled}
```

## 4. 权限 / 审批 / Hook
```
GET/PUT /settings/permissions            {mode, max_turns, run_timeout_sec}
GET/POST/PATCH/DELETE /permission-rules  {tool_pattern, decision, priority}
POST   /approvals/{id}/decide            {decision: allow|deny, remember: bool}
GET    /approvals?status=pending         (掉线重连后补拉未决审批)

GET    /hooks/policies                   内置策略目录(key+参数schema, 前端动态渲染表单)
GET/POST/PATCH/DELETE /hook-rules        {event, matcher, rule_type,
                                          builtin_policy_key?, params, enabled}
```

## 5. Subagent / MCP / 文件 / 其他
```
GET/POST/PATCH/DELETE /subagents
GET/POST/PATCH/DELETE /mcp-servers       config中敏感字段回显打码
POST   /mcp-servers/{id}/test            连通性检查

POST   /threads/{id}/attachments         multipart 上传 → {attachment_id}
  选择文件即调用, 落暂存区 staged=true; 不随消息提交则不进上下文, 24h 后清理
DELETE /attachments/{id}                 移除暂存件(仅 staged=true 可删)
POST   /messages/{id}/feedback           {rating: up|down|null} 点赞点踩(见10文档)
GET    /threads/{id}/files?path=         工作区文件树(限深/限量, 懒加载子目录)
GET    /threads/{id}/files/content?path= 文本预览: 返回 {content, mime, truncated}
  文本类 ≤256KB 全量返回; 超限 truncated=true 且只返回前 64KB; 二进制返回 415 引导下载
GET    /threads/{id}/files/download?path= 下载(Content-Disposition: attachment;
  文件名做 RFC 5987 编码); 支持短时签名参数 ?st= 供 <a> 直链使用
  以上三个接口共同门禁: 需管理员在 user_permission_profiles.tool_grants.workspace_view
  授权, 未授权返回 403 且前端不渲染入口; 服务端对 path 做 realpath 前缀校验防越界
GET    /attachments/{id}/download

GET/POST/PATCH/DELETE /projects          /projects/{id}/files
GET/PATCH/DELETE /memory-entries
POST   /threads/{id}/share → {share_url}    DELETE /shares/{id}
GET    /s/{share_token}                  无鉴权只读快照
GET    /usage/daily?from=&to=
```

## 6. SSE 事件流

下行事件唯一通道；所有上行动作（发消息/停止/审批）都是普通 REST POST。

```
GET /runs/{run_id}/stream
  Accept: text/event-stream
  鉴权: Authorization 头（用 fetch+ReadableStream 时）
        或短时效签名参数 ?st=<signed>（用原生 EventSource 时, 其无法设自定义头;
        签名由 POST /runs/{id}/stream-token 换取, 60s 有效, 绑定 run 与用户）

事件格式:
  id: <递增序号>
  event: text_delta | thinking_delta | tool_use | tool_result
       | approval_request | run_status | title_update
  data: {"thread_id":"…","run_id":"…","data":{…}}

保活: 每 15s 一行注释帧 ": ping"
结束: 服务端发出 run_status(completed|stopped|error) 后关闭连接;
      客户端见到该事件应主动 close()，避免 EventSource 自动重连打空
```

**重连语义**：EventSource 断线自动重连并携带 `Last-Event-ID`；
服务端从 run 的内存 ring buffer 该序号处回放（run 结束即弃 buffer）。
客户端刷新页面后发现 thread 有 running 状态的 run（`GET /runs/{id}`），
可重新挂上其 stream 继续接收；已完成部分通过 REST 拉消息补齐。

**服务端实现要点（FastAPI）**：`sse-starlette` 的 `EventSourceResponse`
或原生 `StreamingResponse(media_type="text/event-stream")`；
响应头带 `Cache-Control: no-cache` 与 `X-Accel-Buffering: no`；
生成器内感知 `request.is_disconnected()`，客户端断开时停止推送但**不取消 run**
（run 继续在后台执行并写库，重连后续传——"关掉页面任务不中断"正是 Agent 产品的预期行为）。

typescript 侧建议：发送消息用 `fetch` 读 `ReadableStream` 解析 SSE（可带 Authorization 头、
可用 AbortController 主动断开）；被动重连场景才退回原生 EventSource + 签名参数。

## 7. 管理端（role=admin）
```
GET /admin/users            GET /admin/audit-logs?user_id=&from=&to=
GET /admin/usage            PATCH /admin/users/{id}  {plan|status}

GET  /admin/users/{id}/permission-profile        管理员用户权限档案(最高可配层)
PUT  /admin/users/{id}/permission-profile
  {mode_ceiling, tool_grants: {bash, file_write, web_search, mcp, ...},
   daily_token_limit, daily_run_limit, show_tokens, show_cost, note}

GET/PUT /admin/settings     全局默认: {web_search_default, show_tokens_default,
                                       show_cost_default, default_mode_ceiling}

POST /admin/hook-rules      (owner_type=global, 可置 locked=1)
POST /admin/permission-rules(owner_type=global 系统级规则)
```

`GET /me` 返回字段补充（前端渲染依据, 后端合并 app_settings + profile 得出）：
```json
{ "features": { "web_search": true, "bash": false, "show_tokens": true,
                "show_cost": false, "mode_ceiling": "acceptEdits" },
  "usage_today": { "tokens": 182300, "runs": 14 } }
```
费用字段仅当 `show_cost=true` 时下发；SSE 的 `run_status` 事件同理——
`data.usage` 只含允许该用户看到的字段（tokens 恒有, cost 按配置）。
