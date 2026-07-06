import { useState, useEffect, useRef, useMemo } from "react";

/* ============================================================
   AgentChat — 前端 UI（React 单文件 · 浅色 claude.ai 风格）

   包含两个视图：
   · 对话视图 — 会话侧栏 / 流式消息 / 工具卡片 / 审批 / 斜杠命令
   · 管理控制台 — 用户权限档案（本应用权限体系的最高可配层）
                  + 全局默认配置（联网搜索 / tokens 与费用展示）

   ▶ 接线说明：后端交互集中在 mockApi 与 ADMIN_STATE。真实环境：
     - 发消息: POST /threads/{id}/messages → {run_id}
              → fetch 读 /runs/{run_id}/stream 的 SSE 流（解析参考见 mockApi 上方注释）
     - 生效配置: GET /me → features {web_search, bash, show_tokens, show_cost, ...}
     - 管理页: GET/PUT /admin/users/{id}/permission-profile 与 /admin/settings
   ▶ 展示策略：tokens 恒展示（可配），费用当前为内部模型、默认不向用户
     展示（show_cost=false），仅管理端可开。后端按同一配置裁剪 SSE 里的
     usage 字段，前端只是渲染，不做兜底信任。
   ============================================================ */

const T = {
  bg: "#F0EEE5", surface: "#FAF9F5", white: "#FFFFFF",
  border: "#DDD8C9", borderSoft: "#E7E3D7",
  text: "#3D3929", dim: "#73705F", faint: "#A5A193",
  accent: "#C15F3C", accentDim: "rgba(193,95,60,0.09)",
  userBubble: "#E9E4D8",
  green: "#427B58", greenDim: "rgba(66,123,88,0.10)",
  red: "#B3401F", redDim: "rgba(179,64,31,0.08)",
  ink: "#1F1E1A",
  mono: "'JetBrains Mono', ui-monospace, monospace",
  sans: "'Inter', -apple-system, 'PingFang SC', sans-serif",
  disp: "'Space Grotesk', 'Inter', sans-serif",
};

/* ---------------- 模拟数据 ---------------- */
const SLASH_COMMANDS = [
  { name: "clear", source: "builtin", local: true, desc: "开始新的上下文（保留历史可回看）" },
  { name: "compact", source: "builtin", local: false, desc: "压缩对话历史，释放上下文空间" },
  { name: "model", source: "builtin", local: true, desc: "切换模型" },
  { name: "usage", source: "builtin", local: true, desc: "查看本会话 token 用量" },
  { name: "permissions", source: "builtin", local: true, desc: "打开权限设置" },
  { name: "code-review", source: "skill", local: false, desc: "对当前目录代码做审查", hint: "[path]" },
  { name: "fix-issue", source: "skill", local: false, desc: "修复指定 issue", hint: "[id] [priority]" },
  { name: "mcp__github__list_prs", source: "mcp", local: false, desc: "列出仓库 PR（GitHub MCP）" },
];

const MODELS = [
  { id: "internal-large", label: "内部大模型", note: "最强推理" },
  { id: "internal-std", label: "内部标准版", note: "日常默认" },
  { id: "internal-lite", label: "内部轻量版", note: "快速任务" },
];

const seedThreads = [
  { id: "s1", title: "Q2 销售数据探索", pinned: false, group: "今天",
    scenario: { template: "数据分析场景", source: "BI 报表平台", model: "内部标准版" } },
  { id: "t1", title: "重构支付模块的错误处理", pinned: true, group: "今天" },
  { id: "t2", title: "为 CI 流水线添加缓存", pinned: false, group: "今天" },
  { id: "t3", title: "分析用户留存数据脚本", pinned: false, group: "昨天" },
  { id: "t4", title: "Dockerfile 多阶段构建优化", pinned: false, group: "过去 7 天" },
];

/* 场景种子：外部系统跳转时初始化的首条消息与数据文件清单。
   重置/复制副本都从这份快照恢复（真实环境 = 服务端 workspace_seeds 快照） */
const SCENARIO_SEED_MESSAGES = [
  { id: "s1m1", role: "assistant", parts: [
    { type: "text", text: "数据已就绪。本工作区由 **BI 报表平台** 发起，已导入以下文件：\n\n- `uploads/sales_q2.csv`（2.1 MB，华东区 Q2 订单明细）\n- `uploads/数据字典.md`\n\n你可以直接提问，例如「按月汇总各品类销售额并找出环比异常」。本场景已锁定模型与工具范围，我只能读取和分析工作区内的数据。" },
  ]},
];

const seedMessages = {
  s1: JSON.parse(JSON.stringify(SCENARIO_SEED_MESSAGES)),
  t1: [
    { id: "m1", role: "user", parts: [{ type: "text", text: "帮我看看 src/payment 里的错误处理有什么问题" }] },
    { id: "m2", role: "assistant", parts: [
      { type: "tool_use", tool: "Glob", input: "src/payment/**/*.py", status: "ok" },
      { type: "tool_use", tool: "Read", input: "src/payment/processor.py", status: "ok" },
      { type: "text", text: "看完了 processor.py，主要有三个问题：\n\n1. **裸 except**：第 47 行 `except:` 会吞掉包括 KeyboardInterrupt 在内的所有异常，应改为捕获具体的 `PaymentGatewayError`。\n2. **重试无退避**：`retry_charge()` 是固定间隔重试，网关限流时会雪崩，建议加指数退避。\n3. **错误未分级**：可重试错误（网络超时）和不可重试错误（卡被拒）走了同一条路径。\n\n要我直接修改吗？我会先给出改动计划。" },
    ], usage: { tokens: "1.2k" } },
  ],
  t2: [], t3: [], t4: [],
};

/* ---------------- 管理端模拟状态（真实环境: /admin/settings 与 permission-profile） ---------------- */
const initialAdminState = {
  global: {
    web_search_default: true,
    show_tokens_default: true,
    show_cost_default: false,        // 内部模型阶段：费用不向用户展示
    default_mode_ceiling: "default",
    /* 设置项治理全局默认: self=用户可自助操作, admin_only=仅管理员/被授权用户 */
    settings_policy: { skills: "self", permission_rules: "admin_only", hooks: "admin_only" },
  },
  groups: [
    { id: "g1", name: "数据分析组", members: ["u1", "u2"] },
  ],
  users: [
    { id: "u1", name: "王工", email: "wang@corp.cn", plan: "pro", me: true,
      profile: { mode_ceiling: "acceptEdits",
        tool_grants: { bash: true, file_write: true, web_search: true, workspace_view: true },
        settings_grants: { permission_rules: true, hooks: false },  // 被授权操作权限规则; Hooks 仍锁定
        daily_token_limit: 500000, show_tokens: true, show_cost: false, note: "后端组，允许 Bash" } },
    { id: "u2", name: "李数据", email: "li@corp.cn", plan: "free",
      profile: { mode_ceiling: "default",
        tool_grants: { bash: false, file_write: true, web_search: true, workspace_view: true },
        settings_grants: {},
        daily_token_limit: 100000, show_tokens: true, show_cost: false, note: "" } },
    { id: "u3", name: "实习生小张", email: "zhang@corp.cn", plan: "free",
      profile: { mode_ceiling: "plan",
        tool_grants: { bash: false, file_write: false, web_search: false, workspace_view: false },
        settings_grants: {},
        daily_token_limit: 30000, show_tokens: true, show_cost: false, note: "只读 + 计划模式" } },
  ],
};

/* ---------------- 组空间模拟数据 ----------------
   真实环境: GET /groups/{id}/skills (含我的采纳状态) / GET /groups/{id}/shared-threads
   隔离原则: 一切跨用户可见性都必须有显式共享记录; 只读靠"无写端点"保证 */
const GROUP_SPACE = {
  sharedSkills: [
    { id: "gs1", name: "sql-审查", owner: "李数据", version: 3,
      desc: "审查 SQL 的性能与注入风险，输出优化建议", adopted: true },
    { id: "gs2", name: "留存分析", owner: "李数据", version: 1,
      desc: "按 cohort 计算 N 日留存并生成图表脚本", adopted: false },
    { id: "gs3", name: "周报生成", owner: "王工", version: 2,
      desc: "汇总本周会话中的分析结论生成周报", adopted: true, mine: true },
  ],
  sharedThreads: [
    { id: "gt1", title: "渠道转化漏斗分析", owner: "李数据", sharedAt: "07-05",
      messages: [
        { id: "gm1", role: "user", parts: [{ type: "text", text: "帮我算一下各渠道从注册到首单的转化漏斗" }] },
        { id: "gm2", role: "assistant", parts: [
          { type: "tool_use", tool: "Read", input: "uploads/funnel_raw.csv", status: "ok" },
          { type: "tool_use", tool: "Bash", input: "python analyze_funnel.py --by channel", status: "ok",
            output: "channel   signup  first_order  cvr\nAPP推送    12,401     1,842     14.9%\n信息流      8,230       412      5.0%" },
          { type: "text", text: "漏斗算完了。**信息流渠道转化率只有 5.0%**，明显低于其他渠道，注册质量存疑；APP 推送渠道 14.9% 表现最好。建议下一步拆信息流的注册来源做归因。" },
        ], usage: { tokens: "3.4k" } },
      ] },
  ],
};

/* ---------------- 模拟 API 层 ----------------
   真实 SSE 消费参考（替换 runScript + schedule 的整段模拟逻辑）：

   const { run_id } = await (await fetch(`/api/v1/threads/${tid}/messages`, {
     method: "POST", headers: authJson, body: JSON.stringify({ text }) })).json();
   const ctrl = new AbortController();          // 停止 → ctrl.abort() + POST /runs/{id}/stop
   const res = await fetch(`/api/v1/runs/${run_id}/stream`, {
     headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": lastId ?? "" },
     signal: ctrl.signal });
   const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
   let buf = "";
   while (true) {
     const { value, done } = await reader.read(); if (done) break;
     buf += value; let idx;
     while ((idx = buf.indexOf("\n\n")) >= 0) {   // SSE 以空行分帧
       const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
       let ev = "message", data = "", id = null;
       for (const line of frame.split("\n")) {
         if (line.startsWith("event:")) ev = line.slice(6).trim();
         else if (line.startsWith("data:")) data += line.slice(5).trim();
         else if (line.startsWith("id:")) id = line.slice(3).trim();
       }
       if (id) lastId = id;
       if (data) applyEvent({ type: ev, ...JSON.parse(data).data });
       if (ev === "run_status") ctrl.abort();
     }
   }
   审批：onDecide → POST /approvals/{id}/decide，后续事件从同一 SSE 流继续到达。
------------------------------------------------- */
const mockApi = {
  // POST /threads/{id}/messages → {run_id} → GET /runs/{run_id}/stream (SSE)
  runScript(userText) {
    const wantsWrite = /修|改|写|apply|fix/i.test(userText);
    const s = [
      { t: 380, ev: { type: "thinking_delta", text: "用户希望我处理这个请求，先检查工作区当前状态，再决定是否需要写入。" } },
      { t: 900, ev: { type: "tool_use", tool: "Bash", input: "git status --short", status: "ok" } },
      { t: 1500, ev: { type: "tool_result", tool: "Bash", output: " M src/payment/processor.py\n?? tests/test_retry.py" } },
    ];
    if (wantsWrite) {
      s.push({ t: 2100, ev: { type: "approval_request", tool: "Write", input: "src/payment/processor.py" } });
      s.push({ t: 0, ev: { type: "await_approval" } });
      s.push({ t: 500, ev: { type: "tool_use", tool: "Write", input: "src/payment/processor.py", status: "ok" } });
      s.push({ t: 1100, ev: { type: "text_stream", text: "已完成修改：把裸 except 收窄为 `PaymentGatewayError`，为 `retry_charge()` 加入指数退避（基数 0.5s，上限 3 次），并按可重试性拆分了两条错误路径。\n\n同时补了一个覆盖退避逻辑的测试 `tests/test_retry.py`。建议跑一遍测试确认，需要我执行 `pytest tests/ -k retry` 吗？" } });
    } else {
      s.push({ t: 1900, ev: { type: "text_stream", text: "工作区目前有一处未提交的修改（processor.py）和一个新增测试文件。你想先处理这个改动，还是继续原来的任务？如果要我修改文件，我会在写入前请求你的授权。" } });
    }
    s.push({ t: 300, ev: { type: "run_status", status: "completed", usage: { tokens: "2.8k" } } });
    return s;
  },
};

/* ---------------- 图标 ---------------- */
function Icon({ d, size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const I = {
  plus: "M12 5v14M5 12h14",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  stop: "M6 6h12v12H6z",
  pin: "M12 17v5M9 3h6l1 7 3 2v2H5v-2l3-2 1-7z",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7 7 0 01-2 1.2L14 21h-4l-.5-2.6a7 7 0 01-2-1.2l-2.4 1-2-3.4 2-1.6A7 7 0 015 12a7 7 0 01.1-1.2l-2-1.6 2-3.4 2.4 1a7 7 0 012-1.2L10 3h4l.5 2.6a7 7 0 012 1.2l2.4-1 2 3.4-2 1.6c.06.4.1.8.1 1.2z",
  term: "M4 17l6-5-6-5M12 19h8",
  chev: "M9 18l6-6-6-6",
  search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  cmd: "M18 3a3 3 0 00-3 3v12a3 3 0 103-3H6a3 3 0 103 3V6a3 3 0 10-3 3h12a3 3 0 100-6z",
  x: "M18 6L6 18M6 6l12 12",
  check: "M20 6L9 17l-5-5",
  users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  brain: "M12 4a4 4 0 00-4 4 4 4 0 00-1 7.9V17a3 3 0 003 3h4a3 3 0 003-3v-1.1A4 4 0 0016 8a4 4 0 00-4-4z",
  back: "M19 12H5M12 19l-7-7 7-7",
  gauge: "M12 21a9 9 0 110-18 9 9 0 010 18zM12 12l4-4",
  folder: "M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z",
  file: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6",
};

/* ---------------- 通用小组件 ---------------- */
function Toggle({ on, onChange, label, disabled, hint }) {
  return (
    <button onClick={() => !disabled && onChange(!on)} aria-pressed={on} aria-label={label || hint}
      title={hint} disabled={disabled}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none",
        border: "none", cursor: disabled ? "not-allowed" : "pointer", padding: 0,
        color: disabled ? T.faint : on ? T.accent : T.dim, fontSize: 12.5, fontFamily: T.sans,
        opacity: disabled ? 0.55 : 1 }}>
      <span style={{ width: 28, height: 16, borderRadius: 9, position: "relative",
        transition: "background .15s", flexShrink: 0,
        background: on ? T.accent : "#CFCaBB" }}>
        <span style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 12, height: 12,
          borderRadius: "50%", background: T.white, transition: "left .15s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.18)" }} />
      </span>
      {label}
    </button>
  );
}
const btn = (bg, fg, border) => ({
  background: bg, color: fg, border: `1px solid ${border || bg}`, borderRadius: 8,
  padding: "6px 15px", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: T.sans,
});

/* ---------------- 工具活动卡片 ---------------- */
function ToolCard({ part }) {
  const [open, setOpen] = useState(false);
  const isErr = part.status === "error";
  return (
    <div style={{ margin: "6px 0" }}>
      <button onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
          background: T.white, border: `1px solid ${isErr ? T.red : T.borderSoft}`,
          borderLeft: `3px solid ${isErr ? T.red : T.accent}`, borderRadius: 8,
          padding: "7px 11px", cursor: "pointer", color: T.dim, fontFamily: T.mono, fontSize: 12 }}>
        <span style={{ color: T.accent }}><Icon d={I.term} size={13} /></span>
        <span style={{ color: T.text, fontWeight: 500 }}>{part.tool}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {typeof part.input === "string" ? part.input : JSON.stringify(part.input)}
        </span>
        <span style={{ color: isErr ? T.red : T.green, flexShrink: 0 }}>
          <Icon d={isErr ? I.x : I.check} size={12} />
        </span>
      </button>
      {open && part.output && (
        <pre style={{ margin: "4px 0 0", padding: "9px 11px", background: T.ink,
          borderRadius: 8, color: "#D8D4C8", fontFamily: T.mono, fontSize: 12,
          lineHeight: 1.6, overflowX: "auto" }}>
          {part.output}
        </pre>
      )}
    </div>
  );
}

/* ---------------- 审批卡片 ---------------- */
function ApprovalCard({ req, onDecide }) {
  const [remember, setRemember] = useState(false);
  const decided = req.status !== "pending";
  return (
    <div role="alertdialog" aria-label="工具授权请求"
      style={{ margin: "10px 0", border: `1px solid ${decided ? T.borderSoft : T.accent}`,
        background: decided ? T.white : T.accentDim, borderRadius: 10, padding: "13px 15px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ color: T.accent }}><Icon d={I.shield} size={15} /></span>
        <span style={{ fontSize: 13.5, color: T.text, fontWeight: 500 }}>
          Claude 请求执行 <code style={{ fontFamily: T.mono, color: T.accent }}>{req.tool}</code>
        </span>
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 12, color: "#D8D4C8", background: T.ink,
        borderRadius: 6, padding: "7px 10px", marginBottom: 10, wordBreak: "break-all" }}>
        {req.input}
      </div>
      {decided ? (
        <div style={{ fontSize: 12.5, color: req.status === "approved" ? T.green : T.red }}>
          {req.status === "approved" ? "✓ 已允许" : "✗ 已拒绝"}{req.remember ? " · 已记住此规则" : ""}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => onDecide("approved", remember)} style={btn(T.accent, "#FFF")}>允许</button>
          <button onClick={() => onDecide("denied", false)} style={btn("transparent", T.dim, T.border)}>拒绝</button>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5,
            color: T.dim, cursor: "pointer", marginLeft: "auto" }}>
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}
              style={{ accentColor: T.accent }} />
            记住，下次不再询问
          </label>
        </div>
      )}
    </div>
  );
}

/* ---------------- 消息渲染 ---------------- */
function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((s, i) => {
    if (s.startsWith("**")) return <strong key={i} style={{ fontWeight: 600 }}>{s.slice(2, -2)}</strong>;
    if (s.startsWith("`")) return <code key={i} style={{ fontFamily: T.mono, fontSize: "0.88em",
      background: "#EBE7DB", padding: "1px 5px", borderRadius: 4, color: "#8A4A2B" }}>{s.slice(1, -1)}</code>;
    return s;
  });
}
function Thinking({ text, streaming }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "4px 0" }}>
      <button onClick={() => setOpen(!open)} style={{ display: "flex", alignItems: "center", gap: 6,
        background: "none", border: "none", color: T.faint, fontSize: 12.5, cursor: "pointer",
        padding: "2px 0", fontFamily: T.sans }}>
        <span style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : "none",
          transition: "transform .15s" }}><Icon d={I.chev} size={12} /></span>
        <Icon d={I.brain} size={12} /> 思考过程{streaming ? "…" : ""}
      </button>
      {open && <div style={{ borderLeft: `2px solid ${T.border}`, paddingLeft: 10, margin: "4px 0 8px",
        color: T.dim, fontSize: 13, lineHeight: 1.65, fontStyle: "italic" }}>{text}</div>}
    </div>
  );
}
function Caret() {
  return <span className="ac-caret" style={{ display: "inline-block", width: 7, height: 15,
    background: T.accent, marginLeft: 2, verticalAlign: "text-bottom" }} />;
}
function Message({ msg, onDecide, features }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", flexDirection: "column",
      alignItems: isUser ? "flex-end" : "stretch", margin: "18px 0" }}>
      {isUser ? (
        <div style={{ maxWidth: "78%", background: T.userBubble,
          borderRadius: "14px 14px 4px 14px", padding: "10px 15px", color: T.text,
          fontSize: 14.5, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
          {msg.parts.map(p => p.text).join("")}
        </div>
      ) : (
        <div style={{ width: "100%" }}>
          {msg.parts.map((p, i) => {
            if (p.type === "text")
              return <div key={i} style={{ color: T.text, fontSize: 15, lineHeight: 1.75,
                whiteSpace: "pre-wrap" }}>{renderInline(p.text)}{p.streaming && <Caret />}</div>;
            if (p.type === "thinking") return <Thinking key={i} text={p.text} streaming={p.streaming} />;
            if (p.type === "tool_use") return <ToolCard key={i} part={p} />;
            if (p.type === "approval") return <ApprovalCard key={i} req={p} onDecide={onDecide} />;
            return null;
          })}
          {msg.usage && features.show_tokens && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: T.faint, fontFamily: T.mono }}>
              {msg.usage.tokens} tokens
              {features.show_cost && msg.usage.cost ? ` · ${msg.usage.cost}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- 斜杠命令面板 ---------------- */
function SlashPalette({ query, onPick }) {
  const list = SLASH_COMMANDS.filter(c => c.name.startsWith(query.toLowerCase())).slice(0, 7);
  if (!list.length) return null;
  const badge = { builtin: [T.dim, "内置"], skill: [T.accent, "Skill"], mcp: ["#4A6FA5", "MCP"] };
  return (
    <div role="listbox" aria-label="斜杠命令"
      style={{ position: "absolute", bottom: "100%", left: 0, right: 0, marginBottom: 8,
        background: T.white, border: `1px solid ${T.border}`, borderRadius: 12,
        boxShadow: "0 -6px 24px rgba(61,57,41,0.10)", overflow: "hidden" }}>
      {list.map((c, i) => (
        <button key={c.name} role="option" onClick={() => onPick(c)}
          style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
            padding: "9px 14px", background: i === 0 ? T.surface : "none", border: "none",
            borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer" }}>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>/{c.name}</span>
          {c.hint && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.faint }}>{c.hint}</span>}
          <span style={{ fontSize: 12.5, color: T.dim, flex: 1, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.desc}</span>
          <span style={{ fontSize: 10.5, color: badge[c.source][0],
            border: `1px solid ${badge[c.source][0]}`, borderRadius: 5, padding: "1px 7px",
            flexShrink: 0 }}>{badge[c.source][1]}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------- 工作区文件树（管理员授权 workspace_view 后可见） ----------------
   真实环境:
   GET /threads/{id}/files?path=            懒加载目录（realpath 前缀校验 + 限深限量）
   GET /threads/{id}/files/content?path=    文本预览（≤256KB, 超限只给下载）
   GET /threads/{id}/files/download?path=   下载（Content-Disposition: attachment）*/
const seedTree = [
  { name: ".claude", type: "dir", children: [
    { name: "skills", type: "dir", children: [
      { name: "code-review", type: "dir", children: [
        { name: "SKILL.md", type: "file", size: "1.2 KB", lang: "md",
          content: "---\ndescription: 对当前目录代码做审查\nargument-hint: [path]\n---\n\n请对 `$ARGUMENTS` 目录下的代码做审查，重点关注：\n\n1. **错误处理**是否完整\n2. 是否存在安全隐患（注入、越权、敏感信息泄漏）\n3. 可读性与命名规范\n\n输出格式：按严重程度分组列出问题，每条附文件与行号。" }] },
    ]},
  ]},
  { name: "src", type: "dir", children: [
    { name: "payment", type: "dir", children: [
      { name: "processor.py", type: "file", size: "8.4 KB", changed: true, lang: "code",
        content: "class PaymentProcessor:\n    def charge(self, order):\n        try:\n            resp = self.gateway.submit(order)\n        except PaymentGatewayError as e:   # 已收窄异常类型\n            if e.retryable:\n                return self.retry_charge(order)\n            raise NonRetryableError(order.id) from e\n        return resp\n\n    def retry_charge(self, order, max_retries=3):\n        delay = 0.5\n        for attempt in range(max_retries):\n            time.sleep(delay)\n            delay *= 2                      # 指数退避\n            ..." },
      { name: "gateway.py", type: "file", size: "3.1 KB", lang: "code",
        content: "class Gateway:\n    def submit(self, order):\n        ..." },
    ]},
  ]},
  { name: "tests", type: "dir", children: [
    { name: "test_retry.py", type: "file", size: "2.0 KB", changed: true, lang: "code",
      content: "def test_retry_backoff(monkeypatch):\n    calls = []\n    monkeypatch.setattr(time, 'sleep', calls.append)\n    ...\n    assert calls == [0.5, 1.0, 2.0]" }] },
  { name: "uploads", type: "dir", children: [
    { name: "需求文档.pdf", type: "file", size: "230 KB", lang: "binary" }] },
];

function TreeNode({ node, depth, onFile }) {
  const [open, setOpen] = useState(depth < 2);
  const isDir = node.type === "dir";
  return (
    <div>
      <button onClick={() => isDir ? setOpen(!open) : onFile(node)}
        title={isDir ? "" : "点击预览"}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left",
          background: "none", border: "none", cursor: "pointer",
          padding: "4px 6px", paddingLeft: 6 + depth * 14, borderRadius: 6,
          color: isDir ? T.text : T.dim, fontSize: 12.5, fontFamily: T.mono }}>
        {isDir && (
          <span style={{ display: "inline-flex", color: T.faint,
            transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}>
            <Icon d={I.chev} size={10} />
          </span>
        )}
        <span style={{ color: isDir ? T.accent : T.faint, display: "inline-flex" }}>
          <Icon d={isDir ? I.folder : I.file} size={12} />
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.name}
        </span>
        {node.changed && <span title="本次运行修改过"
          style={{ width: 6, height: 6, borderRadius: "50%", background: T.accent, flexShrink: 0 }} />}
        {node.size && <span style={{ marginLeft: "auto", fontSize: 10.5, color: T.faint,
          flexShrink: 0 }}>{node.size}</span>}
      </button>
      {isDir && open && node.children?.map(c => (
        <TreeNode key={c.name} node={c} depth={depth + 1} onFile={onFile} />
      ))}
    </div>
  );
}

/* 下载：mock 用 Blob 直接触发；真实环境改为打开
   GET /threads/{id}/files/download?path=（附带鉴权 token 的短时签名链接） */
function downloadFile(node) {
  const blob = new Blob([node.content ?? ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = node.name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

/* 文件预览弹窗：md → 富文本渲染；code → 深色代码块；binary → 引导下载 */
function FilePreview({ node, onClose }) {
  const canPreview = node.lang !== "binary" && node.content != null;
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0,
      background: "rgba(61,57,41,0.28)", display: "flex", alignItems: "center",
      justifyContent: "center", zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label={`预览 ${node.name}`}
        style={{ width: "min(720px, 92%)", maxHeight: "80%", display: "flex",
          flexDirection: "column", background: T.surface, border: `1px solid ${T.border}`,
          borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 16px",
          borderBottom: `1px solid ${T.borderSoft}`, flexShrink: 0 }}>
          <span style={{ color: T.accent }}><Icon d={I.file} size={14} /></span>
          <span style={{ fontFamily: T.mono, fontSize: 13.5, color: T.text, fontWeight: 500,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
          <span style={{ fontSize: 11.5, color: T.faint }}>{node.size}</span>
          {node.changed && <span style={{ fontSize: 10.5, color: T.accent,
            border: `1px solid ${T.accent}`, borderRadius: 5, padding: "0 6px" }}>本次修改</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button onClick={() => downloadFile(node)}
              style={{ ...btn("transparent", T.accent, T.accent), padding: "4px 12px", fontSize: 12.5 }}>
              下载
            </button>
            <button onClick={onClose} aria-label="关闭预览"
              style={{ background: "none", border: "none", color: T.dim, cursor: "pointer",
                display: "flex", padding: 4 }}>
              <Icon d={I.x} size={15} />
            </button>
          </div>
        </div>
        <div style={{ overflowY: "auto", padding: canPreview ? 0 : "40px 20px" }}>
          {!canPreview ? (
            <div style={{ textAlign: "center", color: T.dim, fontSize: 13.5, lineHeight: 1.8 }}>
              该文件类型不支持在线预览<br />
              <button onClick={() => downloadFile(node)}
                style={{ ...btn(T.accent, "#FFF"), marginTop: 12 }}>下载到本地查看</button>
            </div>
          ) : node.lang === "md" ? (
            <div style={{ padding: "16px 20px", fontSize: 14, lineHeight: 1.8, color: T.text,
              whiteSpace: "pre-wrap" }}>
              {node.content.split("\n").map((ln, i) => {
                if (ln.startsWith("# ")) return <div key={i} style={{ fontFamily: T.disp,
                  fontSize: 18, fontWeight: 600, margin: "8px 0 4px" }}>{ln.slice(2)}</div>;
                if (/^\d+\. /.test(ln) || ln.startsWith("- "))
                  return <div key={i} style={{ paddingLeft: 14 }}>{renderInline(ln)}</div>;
                return <div key={i}>{renderInline(ln)}</div>;
              })}
            </div>
          ) : (
            <pre style={{ margin: 0, padding: "14px 18px", background: T.ink,
              color: "#D8D4C8", fontFamily: T.mono, fontSize: 12.5, lineHeight: 1.7,
              overflowX: "auto", minHeight: "100%" }}>
              {node.content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkspacePanel({ threadId, onClose }) {
  const [preview, setPreview] = useState(null);
  return (
    <aside aria-label="工作区文件树"
      style={{ width: 262, flexShrink: 0, borderLeft: `1px solid ${T.borderSoft}`,
        background: T.surface, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 13px",
        borderBottom: `1px solid ${T.borderSoft}` }}>
        <span style={{ color: T.accent }}><Icon d={I.folder} size={14} /></span>
        <span style={{ fontSize: 13, fontWeight: 500, color: T.text }}>工作区</span>
        <span style={{ fontSize: 10.5, color: T.faint, border: `1px solid ${T.border}`,
          borderRadius: 5, padding: "0 6px" }}>只读</span>
        <button onClick={onClose} aria-label="关闭文件树" style={{ marginLeft: "auto",
          background: "none", border: "none", color: T.dim, cursor: "pointer", display: "flex" }}>
          <Icon d={I.x} size={14} />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 7px" }}>
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.faint, padding: "2px 6px 8px" }}>
          /workspace/{threadId}/
        </div>
        {seedTree.map(n => <TreeNode key={n.name} node={n} depth={0} onFile={setPreview} />)}
      </div>
      <div style={{ padding: "9px 13px", borderTop: `1px solid ${T.borderSoft}`,
        fontSize: 11, color: T.faint, lineHeight: 1.6 }}>
        点击文件预览或下载 ·
        <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%",
          background: T.accent, margin: "0 4px" }} />
        = 本次运行修改过
      </div>
      {preview && <FilePreview node={preview} onClose={() => setPreview(null)} />}
    </aside>
  );
}

/* ================= 组空间（Skill 共享采纳 + 只读会话协作） ================= */
function GroupSpace({ groupName, onBack, features }) {
  const [skills, setSkills] = useState(GROUP_SPACE.sharedSkills);
  const [viewing, setViewing] = useState(null);          // 正在只读查看的共享会话
  const card = { background: T.white, border: `1px solid ${T.borderSoft}`,
    borderRadius: 14, padding: "16px 18px" };

  return (
    <div style={{ flex: 1, overflowY: "auto", background: T.bg }}>
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "22px 26px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <button onClick={onBack} aria-label="返回对话"
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 8,
              color: T.dim, cursor: "pointer", padding: "6px 8px", display: "flex" }}>
            <Icon d={I.back} size={14} />
          </button>
          <h1 style={{ fontFamily: T.disp, fontSize: 21, fontWeight: 600, color: T.text, margin: 0 }}>
            组空间 · {groupName}
          </h1>
        </div>
        <p style={{ fontSize: 13, color: T.dim, margin: "0 0 20px", lineHeight: 1.7 }}>
          组内成员共享的 Skill 与会话。共享内容<strong style={{ color: T.text }}>只读</strong>：
          你可以采纳 Skill 到自己的空间、查看共享会话的过程，但不能修改他人的任何数据。
        </p>

        {/* ---- 共享 Skills ---- */}
        <div style={{ ...card, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ color: T.accent }}><Icon d={I.zap} size={15} /></span>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: T.text }}>组内共享 Skills</span>
            <span style={{ fontSize: 11.5, color: T.faint }}>采纳后在你自己的会话中生效，可随时停用</span>
          </div>
          {skills.map((s, i) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12,
              padding: "11px 4px", borderBottom: `1px solid ${T.borderSoft}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{ fontFamily: T.mono, fontSize: 13, color: T.accent }}>/{s.name}</code>
                  <span style={{ fontSize: 11, color: T.faint }}>v{s.version} · 来自 {s.owner}</span>
                  {s.mine && <span style={{ fontSize: 10.5, color: T.green,
                    border: `1px solid ${T.green}`, borderRadius: 5, padding: "0 6px" }}>我共享的</span>}
                </div>
                <div style={{ fontSize: 12, color: T.dim, marginTop: 3 }}>{s.desc}</div>
              </div>
              {s.mine ? (
                <button style={{ ...btn("transparent", T.dim, T.border), padding: "4px 12px",
                  fontSize: 12 }} title="取消共享后组内成员的采纳自动失效">取消共享</button>
              ) : (
                <Toggle on={s.adopted} label={s.adopted ? "已采纳" : "采纳"}
                  onChange={v => setSkills(sk => sk.map((x, j) => j === i ? { ...x, adopted: v } : x))} />
              )}
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: T.faint, marginTop: 10, lineHeight: 1.6 }}>
            采纳 = 该 Skill 会物化到你的会话工作区（.claude/skills/），出现在你的命令面板；
            作者更新版本后你会收到提示，可选择跟进或停用。
          </div>
        </div>

        {/* ---- 共享会话（只读） ---- */}
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ color: T.accent }}><Icon d={I.users} size={15} /></span>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: T.text }}>组内共享会话</span>
            <span style={{ fontSize: 11.5, color: T.faint }}>
              仅作者主动共享的会话可见 · 只读，不含工作区文件访问
            </span>
          </div>
          {GROUP_SPACE.sharedThreads.map(t => (
            <div key={t.id}>
              <button onClick={() => setViewing(viewing === t.id ? null : t.id)}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                  textAlign: "left", padding: "11px 4px", background: "none", border: "none",
                  borderBottom: `1px solid ${T.borderSoft}`, cursor: "pointer" }}>
                <span style={{ display: "inline-flex", color: T.faint,
                  transform: viewing === t.id ? "rotate(90deg)" : "none",
                  transition: "transform .12s" }}><Icon d={I.chev} size={12} /></span>
                <span style={{ fontSize: 13.5, color: T.text, fontWeight: 500 }}>{t.title}</span>
                <span style={{ fontSize: 11.5, color: T.faint }}>来自 {t.owner} · {t.sharedAt} 共享</span>
                <span style={{ marginLeft: "auto", fontSize: 10.5, color: T.faint,
                  border: `1px solid ${T.border}`, borderRadius: 5, padding: "0 6px" }}>只读</span>
              </button>
              {viewing === t.id && (
                <div style={{ background: T.surface, border: `1px solid ${T.borderSoft}`,
                  borderRadius: 10, padding: "4px 18px 10px", margin: "10px 0" }}>
                  {t.messages.map(msg => (
                    <Message key={msg.id} msg={msg} features={features} onDecide={() => {}} />
                  ))}
                  <div style={{ fontSize: 11.5, color: T.faint, textAlign: "center",
                    padding: "6px 0 2px" }}>
                    只读视图 · 无法发送消息或访问该会话的工作区文件
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================= 管理控制台（权限管理页） ================= */
function AdminConsole({ state, setState, onBack }) {
  const [sel, setSel] = useState(state.users[0].id);
  const [auditFilter, setAuditFilter] = useState("all");
  const AUDIT_ROWS = [
    { time: "07-06 14:32:11", user: "王工", event: "tool_call", detail: "Bash: git status --short", run: "r_8f2a" },
    { time: "07-06 14:32:18", user: "王工", event: "approval", detail: "Write src/payment/processor.py → 允许(记住)", run: "r_8f2a" },
    { time: "07-06 14:30:02", user: "李数据", event: "scenario_launch", detail: "数据分析场景 ← BI报表平台, 种子: sales_q2.csv", run: "-" },
    { time: "07-06 14:28:47", user: "实习生小张", event: "tool_denied", detail: "Bash 未授权 (档案 tool_grants.bash=false)", run: "r_7c1d" },
    { time: "07-06 14:20:05", user: "王工", event: "config_change", detail: "修改 小张 权限档案: mode_ceiling → plan", run: "-" },
    { time: "07-06 14:11:39", user: "李数据", event: "tool_call", detail: "Read uploads/sales_q2.csv (2.1MB)", run: "r_5b0e" },
  ];
  const user = state.users.find(u => u.id === sel);
  const modes = [["default", "默认（逐项审批）"], ["acceptEdits", "信任编辑"],
                 ["plan", "仅计划模式"], ["bypassPermissions", "全放行（危险）"]];
  const tools = [
    ["file_write", "文件写入", "Write / Edit 工具"],
    ["bash", "命令执行", "Bash 工具（高风险，默认关闭）"],
    ["web_search", "联网搜索", "关闭后该用户界面上不出现此开关"],
    ["workspace_view", "工作区文件树", "允许在对话页浏览会话工作空间的文件结构（只读）"],
  ];
  const patchProfile = (patch) => setState(s => ({ ...s,
    users: s.users.map(u => u.id === sel ? { ...u, profile: { ...u.profile, ...patch } } : u) }));
  const patchGrant = (k, v) => patchProfile({ tool_grants: { ...user.profile.tool_grants, [k]: v } });
  const patchGlobal = (patch) => setState(s => ({ ...s, global: { ...s.global, ...patch } }));

  const card = { background: T.white, border: `1px solid ${T.borderSoft}`, borderRadius: 14, padding: "18px 20px" };
  const label = { fontSize: 12, color: T.faint, marginBottom: 6 };
  const fieldRow = { display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "11px 0", borderBottom: `1px solid ${T.borderSoft}` };

  return (
    <div style={{ flex: 1, overflowY: "auto", background: T.bg }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "22px 26px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <button onClick={onBack} aria-label="返回对话"
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 8,
              color: T.dim, cursor: "pointer", padding: "6px 8px", display: "flex" }}>
            <Icon d={I.back} size={14} />
          </button>
          <h1 style={{ fontFamily: T.disp, fontSize: 21, fontWeight: 600, color: T.text, margin: 0 }}>
            权限管理
          </h1>
          <span style={{ fontSize: 11.5, color: T.accent, background: T.accentDim,
            border: `1px solid ${T.accent}`, borderRadius: 6, padding: "2px 9px" }}>
            最高优先级配置层
          </span>
        </div>
        <p style={{ fontSize: 13, color: T.dim, margin: "0 0 20px", lineHeight: 1.7 }}>
          此处配置对用户强制生效，用户自身设置不可越过（合并顺序：系统锁定规则 →
          <strong style={{ color: T.text }}> 本页用户档案 </strong>→ 项目规则 → 用户规则）。
        </p>

        {/* ---- 全局默认 ---- */}
        <div style={{ ...card, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ color: T.accent }}><Icon d={I.gauge} size={15} /></span>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: T.text }}>全局默认</span>
            <span style={{ fontSize: 11.5, color: T.faint }}>未单独建档的用户按此生效</span>
          </div>
          <div style={fieldRow}>
            <div><div style={{ fontSize: 13.5, color: T.text }}>联网搜索</div>
              <div style={{ fontSize: 12, color: T.faint }}>关闭后所有未单独授权的用户不可用、界面不显示该选项</div></div>
            <Toggle on={state.global.web_search_default}
              onChange={v => patchGlobal({ web_search_default: v })} />
          </div>
          <div style={fieldRow}>
            <div><div style={{ fontSize: 13.5, color: T.text }}>向用户展示 token 用量</div>
              <div style={{ fontSize: 12, color: T.faint }}>消息尾部与用量面板显示 tokens 数</div></div>
            <Toggle on={state.global.show_tokens_default}
              onChange={v => patchGlobal({ show_tokens_default: v })} />
          </div>
          <div style={{ ...fieldRow, borderBottom: "none" }}>
            <div><div style={{ fontSize: 13.5, color: T.text }}>向用户展示费用</div>
              <div style={{ fontSize: 12, color: T.faint }}>当前接入内部模型，费用口径未定，暂不对用户开放展示（仅管理端可见用量报表）</div></div>
            <Toggle on={state.global.show_cost_default} disabled hint="内部模型阶段锁定为关闭"
              onChange={v => patchGlobal({ show_cost_default: v })} />
          </div>
        </div>

        {/* ---- 用户档案：左列表 + 右编辑 ---- */}
        <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ ...card, padding: 8, width: 290, flexShrink: 0 }}>
            {state.users.map(u => (
              <button key={u.id} onClick={() => setSel(u.id)}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 12px",
                  background: u.id === sel ? T.accentDim : "none",
                  border: "none", borderRadius: 9, cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 500,
                    color: u.id === sel ? T.accent : T.text }}>{u.name}</span>
                  {u.me && <span style={{ fontSize: 10.5, color: T.faint }}>（当前登录）</span>}
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: T.dim,
                    border: `1px solid ${T.border}`, borderRadius: 5, padding: "1px 7px" }}>{u.plan}</span>
                </div>
                <div style={{ fontSize: 11.5, color: T.faint, marginTop: 2 }}>{u.email}</div>
              </button>
            ))}
          </div>

          <div style={{ ...card, flex: "1 1 420px" }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: T.text, marginBottom: 14 }}>
              {user.name} 的权限档案
            </div>

            <div style={label}>权限模式上限（用户在自己设置里选不到高于此的模式）</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
              {modes.map(([k, l]) => {
                const active = user.profile.mode_ceiling === k;
                const danger = k === "bypassPermissions";
                return (
                  <button key={k} onClick={() => patchProfile({ mode_ceiling: k })}
                    style={{ background: active ? (danger ? T.redDim : T.accentDim) : T.surface,
                      border: `1px solid ${active ? (danger ? T.red : T.accent) : T.borderSoft}`,
                      color: active ? (danger ? T.red : T.accent) : T.dim,
                      borderRadius: 8, padding: "6px 13px", fontSize: 12.5, cursor: "pointer" }}>
                    {l}
                  </button>
                );
              })}
            </div>

            <div style={label}>工具授权（未授权的工具从 allowed_tools 剔除并置入 deny）</div>
            <div style={{ marginBottom: 16 }}>
              {tools.map(([k, l, d]) => (
                <div key={k} style={fieldRow}>
                  <div><div style={{ fontSize: 13.5, color: T.text }}>{l}</div>
                    <div style={{ fontSize: 12, color: T.faint }}>{d}</div></div>
                  <Toggle on={!!user.profile.tool_grants[k]} onChange={v => patchGrant(k, v)} />
                </div>
              ))}
            </div>

            <div style={label}>设置操作授权（我的设置里哪些板块允许该用户自助操作，未授权则只读）</div>
            <div style={{ marginBottom: 16 }}>
              {[["permission_rules", "权限规则与模式", "默认由管理员统一管理"],
                ["hooks", "Hook 策略", "默认由管理员统一管理"]].map(([k, l, d]) => (
                <div key={k} style={fieldRow}>
                  <div><div style={{ fontSize: 13.5, color: T.text }}>{l}</div>
                    <div style={{ fontSize: 12, color: T.faint }}>{d}</div></div>
                  <Toggle on={!!(user.profile.settings_grants || {})[k]}
                    onChange={v => patchProfile({ settings_grants:
                      { ...(user.profile.settings_grants || {}), [k]: v } })} />
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: T.faint, marginTop: 8 }}>
                Skills 管理（新建/导入/共享自己的 Skill）默认所有用户可自助操作，无需授权。
              </div>
            </div>

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
              <div style={{ flex: "1 1 180px" }}>
                <div style={label}>每日 token 限额</div>
                <input type="number" value={user.profile.daily_token_limit ?? ""}
                  onChange={e => patchProfile({ daily_token_limit: e.target.value ? +e.target.value : null })}
                  placeholder="不限"
                  style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`,
                    borderRadius: 8, padding: "8px 11px", fontSize: 13, color: T.text,
                    fontFamily: T.mono }} />
              </div>
              <div style={{ flex: "1 1 220px" }}>
                <div style={label}>用量展示（覆盖全局默认）</div>
                <div style={{ display: "flex", gap: 18, paddingTop: 8 }}>
                  <Toggle on={user.profile.show_tokens} label="tokens"
                    onChange={v => patchProfile({ show_tokens: v })} />
                  <Toggle on={user.profile.show_cost} label="费用" disabled
                    hint="内部模型阶段锁定为关闭"
                    onChange={v => patchProfile({ show_cost: v })} />
                </div>
              </div>
            </div>

            <div style={label}>备注</div>
            <input value={user.profile.note}
              onChange={e => patchProfile({ note: e.target.value })}
              placeholder="给其他管理员看的说明"
              style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: "8px 11px", fontSize: 13, color: T.text }} />

            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              <button style={btn(T.accent, "#FFF")}
                onClick={() => {/* PUT /admin/users/{id}/permission-profile */}}>保存档案</button>
              <span style={{ fontSize: 12, color: T.faint, alignSelf: "center" }}>
                变更会写入审计日志，下一次 run 起生效
              </span>
            </div>
          </div>
        </div>
        {/* ---- 审计日志 ---- */}
        <div style={{ ...card, marginTop: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{ color: T.accent }}><Icon d={I.shield} size={15} /></span>
            <span style={{ fontSize: 14.5, fontWeight: 600, color: T.text }}>审计日志</span>
            <span style={{ fontSize: 11.5, color: T.faint }}>
              只增不改 · 真实环境: GET /admin/audit-logs?user_id=&event=&from=&to=
            </span>
            <select value={auditFilter} onChange={e => setAuditFilter(e.target.value)}
              aria-label="事件类型筛选"
              style={{ marginLeft: "auto", background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 7, padding: "4px 9px", fontSize: 12, color: T.text }}>
              <option value="all">全部事件</option>
              <option value="tool_call">工具调用</option>
              <option value="tool_denied">工具拒绝</option>
              <option value="approval">人工审批</option>
              <option value="config_change">配置变更</option>
              <option value="scenario_launch">场景启动</option>
            </select>
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 12 }}>
            {AUDIT_ROWS.filter(r => auditFilter === "all" || r.event === auditFilter).map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 12, padding: "7px 4px",
                borderBottom: `1px solid ${T.borderSoft}`, alignItems: "baseline" }}>
                <span style={{ color: T.faint, flexShrink: 0, width: 108 }}>{r.time}</span>
                <span style={{ color: T.text, flexShrink: 0, width: 66 }}>{r.user}</span>
                <span style={{ flexShrink: 0, width: 96,
                  color: { tool_call: T.dim, tool_denied: T.red, approval: T.accent,
                           config_change: "#4A6FA5", scenario_launch: T.green }[r.event] }}>
                  {r.event}
                </span>
                <span style={{ color: T.dim, overflow: "hidden", textOverflow: "ellipsis",
                  whiteSpace: "nowrap" }}>{r.detail}</span>
                <span style={{ marginLeft: "auto", color: T.faint, flexShrink: 0,
                  fontSize: 11 }}>run:{r.run}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 会话内设置弹窗（用户自助层, 受 settings_grants 治理） ---------------- */
function LockBanner({ text }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#F3EFE3",
      border: `1px solid ${T.border}`, borderRadius: 9, padding: "9px 13px",
      fontSize: 12.5, color: T.dim, marginBottom: 14 }}>
      🔒 {text}
    </div>
  );
}

function SettingsModal({ onClose, ceiling, grants }) {
  const [tab, setTab] = useState("perm");
  const [mode, setMode] = useState("default");
  const modeOrder = ["plan", "default", "acceptEdits", "bypassPermissions"];
  const allowed = modeOrder.slice(0, modeOrder.indexOf(ceiling) + 1);
  const [rules, setRules] = useState([
    { pattern: "Bash(sudo:*)", decision: "deny", locked: true },
    { pattern: "Bash(git push:*)", decision: "ask", locked: false },
    { pattern: "Write", decision: "ask", locked: false },
  ]);
  const [hooks, setHooks] = useState([
    { key: "audit_log", label: "工具调用审计日志", desc: "记录每一次工具调用（系统强制启用）", on: true, locked: true },
    { key: "deny_dangerous_bash", label: "危险命令拦截", desc: "拦截 rm -rf /、管道执行远程脚本等模式", on: true, locked: false },
    { key: "restrict_path", label: "路径越界保护", desc: "文件工具只能访问本会话工作区", on: true, locked: false },
  ]);
  const modeMeta = { plan: ["仅计划", "只产出计划，确认后执行"],
    default: ["默认", "规则未覆盖的操作逐一询问"],
    acceptEdits: ["信任编辑", "文件编辑自动放行"],
    bypassPermissions: ["全放行", "危险：跳过所有询问"] };
  const decColor = { deny: T.red, ask: T.accent, allow: T.green };
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(61,57,41,0.28)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40 }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-label="设置"
        style={{ width: "min(660px, 92%)", maxHeight: "82%", overflow: "auto",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 16 }}>
        <div style={{ display: "flex", alignItems: "center", padding: "14px 20px",
          borderBottom: `1px solid ${T.borderSoft}` }}>
          <span style={{ fontFamily: T.disp, fontSize: 16, fontWeight: 600, color: T.text }}>设置</span>
          <div style={{ display: "flex", gap: 4, marginLeft: 22 }}>
            {[["perm", "权限", I.shield], ["hooks", "Hooks", I.zap], ["cmds", "Skills", I.cmd]].map(([k, l, ic]) => (
              <button key={k} onClick={() => setTab(k)}
                style={{ display: "flex", alignItems: "center", gap: 6,
                  background: tab === k ? T.white : "none", border: "none", borderRadius: 8,
                  padding: "6px 13px", cursor: "pointer",
                  color: tab === k ? T.text : T.dim, fontSize: 13 }}>
                <Icon d={ic} size={13} />{l}
              </button>
            ))}
          </div>
          <button onClick={onClose} aria-label="关闭" style={{ marginLeft: "auto", background: "none",
            border: "none", color: T.dim, cursor: "pointer" }}><Icon d={I.x} size={16} /></button>
        </div>
        <div style={{ padding: "18px 20px" }}>
          {tab === "perm" && (
            <>
              {!grants.permission_rules && (
                <LockBanner text="权限设置由管理员统一管理。你可以查看当前生效的配置，如需调整请联系管理员为你开通操作授权。" />
              )}
              <div style={{ fontSize: 12, color: T.faint, marginBottom: 10, lineHeight: 1.7 }}>
                判定顺序：Hook → 拒绝规则 → 允许规则 → 询问规则 → 权限模式 → 实时审批。
                管理员为你设定的上限：<strong style={{ color: T.accent }}>{modeMeta[ceiling][0]}</strong>
                ，高于该上限的模式不可选。
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap",
                opacity: grants.permission_rules ? 1 : 0.6,
                pointerEvents: grants.permission_rules ? "auto" : "none" }}>
                {modeOrder.map(k => {
                  const can = allowed.includes(k);
                  const active = mode === k;
                  return (
                    <button key={k} onClick={() => can && setMode(k)} disabled={!can}
                      style={{ flex: "1 1 130px", textAlign: "left",
                        background: active ? T.accentDim : T.white,
                        border: `1px solid ${active ? T.accent : T.borderSoft}`,
                        borderRadius: 10, padding: "10px 12px",
                        cursor: can ? "pointer" : "not-allowed", opacity: can ? 1 : 0.45 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: active ? T.accent : T.text }}>
                        {modeMeta[k][0]}{!can && " 🔒"}
                      </div>
                      <div style={{ fontSize: 11.5, color: T.dim, marginTop: 3 }}>{modeMeta[k][1]}</div>
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 13, color: T.text, fontWeight: 500, marginBottom: 8 }}>规则</div>
              {rules.map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 11px",
                  background: T.white, border: `1px solid ${T.borderSoft}`, borderRadius: 8, marginBottom: 6 }}>
                  <code style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text, flex: 1 }}>{r.pattern}</code>
                  <span style={{ fontSize: 11.5, color: decColor[r.decision],
                    border: `1px solid ${decColor[r.decision]}`, borderRadius: 5,
                    padding: "1px 8px" }}>{r.decision}</span>
                  {r.locked
                    ? <span style={{ fontSize: 11, color: T.faint }}>系统锁定</span>
                    : grants.permission_rules && <button onClick={() => setRules(rules.filter((_, j) => j !== i))}
                        aria-label="删除规则"
                        style={{ background: "none", border: "none", color: T.faint, cursor: "pointer" }}>
                        <Icon d={I.x} size={13} /></button>}
                </div>
              ))}
              {grants.permission_rules && (
                <button onClick={() => setRules([...rules, { pattern: "Bash(npm run:*)", decision: "allow", locked: false }])}
                  style={{ ...btn("transparent", T.dim, T.border), marginTop: 4 }}>+ 添加规则</button>
              )}
            </>
          )}
          {tab === "hooks" && (
            <>
              {!grants.hooks && (
                <LockBanner text="Hook 策略由管理员统一管理，当前配置只读。" />
              )}
              {hooks.map((h, i) => (
                <div key={h.key} style={{ display: "flex", alignItems: "flex-start", gap: 12,
                  padding: "12px 4px", borderBottom: `1px solid ${T.borderSoft}` }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, color: T.text, fontWeight: 500 }}>{h.label}
                      {h.locked && <span style={{ fontSize: 10.5, color: T.faint, marginLeft: 8,
                        border: `1px solid ${T.border}`, borderRadius: 5, padding: "1px 7px" }}>强制</span>}
                    </div>
                    <div style={{ fontSize: 12, color: T.dim, marginTop: 3 }}>{h.desc}</div>
                  </div>
                  <Toggle on={h.on} disabled={h.locked || !grants.hooks}
                    hint={!grants.hooks ? "由管理员管理" : ""}
                    onChange={v => setHooks(hooks.map((x, j) => j === i ? { ...x, on: v } : x))} />
                </div>
              ))}
            </>
          )}
          {tab === "cmds" && (
            <>
              <div style={{ fontSize: 12.5, color: T.dim, fontWeight: 500, margin: "2px 0 6px" }}>系统内置</div>
              {[["code-review", "对当前目录代码做审查"], ["fix-issue", "修复指定 issue"]].map(([n, d]) => (
                <div key={n} style={{ display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 4px", borderBottom: `1px solid ${T.borderSoft}` }}>
                  <code style={{ fontFamily: T.mono, fontSize: 13, color: T.dim }}>/{n}</code>
                  <span style={{ fontSize: 12.5, color: T.dim, flex: 1 }}>{d}</span>
                  <span style={{ fontSize: 10.5, color: T.faint, border: `1px solid ${T.border}`,
                    borderRadius: 5, padding: "0 6px" }}>系统 · 不可修改</span>
                </div>
              ))}
              <div style={{ fontSize: 12.5, color: T.dim, fontWeight: 500, margin: "16px 0 6px" }}>
                我的 Skills
              </div>
              {[{ n: "周报生成", d: "汇总本周会话中的分析结论生成周报", shared: true },
                { n: "接口文档", d: "根据代码生成接口文档草稿", shared: false }].map(s => (
                <div key={s.n} style={{ display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 4px", borderBottom: `1px solid ${T.borderSoft}` }}>
                  <code style={{ fontFamily: T.mono, fontSize: 13, color: T.accent }}>/{s.n}</code>
                  <span style={{ fontSize: 12.5, color: T.dim, flex: 1 }}>{s.d}</span>
                  {s.shared && <span style={{ fontSize: 10.5, color: T.green,
                    border: `1px solid ${T.green}`, borderRadius: 5, padding: "0 6px" }}>已共享到组</span>}
                  <button style={{ ...btn("transparent", T.dim, T.border), padding: "3px 10px",
                    fontSize: 12 }}>{s.shared ? "取消共享" : "共享到组"}</button>
                  <button style={{ ...btn("transparent", T.dim, T.border), padding: "3px 10px",
                    fontSize: 12 }}>编辑</button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button style={btn("transparent", T.accent, T.accent)}>+ 新建 Skill</button>
                <button style={btn("transparent", T.dim, T.border)}>从文件导入 (SKILL.md)</button>
              </div>
              <div style={{ fontSize: 11.5, color: T.faint, marginTop: 12, lineHeight: 1.7 }}>
                Skill 保存在你的私有空间，仅你可见与可用；「共享到组」后组内成员可在
                <strong style={{ color: T.dim }}> 组空间 </strong>里查看并选择采纳（对方只读，无法修改你的 Skill）。
                采纳他人共享的 Skill 也在组空间中操作。
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================= 主应用 ================= */
export default function AgentChat() {
  const [view, setView] = useState("chat");            // chat | admin | group
  const [adminState, setAdminState] = useState(initialAdminState);
  const [threads, setThreads] = useState(seedThreads);
  const [activeId, setActiveId] = useState("t1");
  const [messagesMap, setMessagesMap] = useState(seedMessages);
  const [input, setInput] = useState("");
  const [runningTid, setRunningTid] = useState(null);  // 正在生成的 thread（同一时刻一个 run）
  const [treeOpen, setTreeOpen] = useState(false);      // 工作区文件树面板
  const [model, setModel] = useState(MODELS[1]);
  const [modelOpen, setModelOpen] = useState(false);
  const [thinkOn, setThinkOn] = useState(true);
  const [webOn, setWebOn] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const [todayTokens, setTodayTokens] = useState(182300);
  const scrollRef = useRef(null);
  const timersRef = useRef([]);
  const pausedRef = useRef(null);

  /* 当前登录用户的生效配置（真实环境 = GET /me 的 features 字段） */
  const me = adminState.users.find(u => u.me);
  const features = {
    web_search: adminState.global.web_search_default && me.profile.tool_grants.web_search,
    workspace_view: !!me.profile.tool_grants.workspace_view,
    show_tokens: me.profile.show_tokens ?? adminState.global.show_tokens_default,
    show_cost: adminState.global.show_cost_default && me.profile.show_cost,
    settings_grants: me.profile.settings_grants ?? {},
    mode_ceiling: me.profile.mode_ceiling,
    daily_token_limit: me.profile.daily_token_limit,
  };
  useEffect(() => { if (!features.web_search && webOn) setWebOn(false); }, [features.web_search]);
  useEffect(() => { if (!features.workspace_view && treeOpen) setTreeOpen(false); }, [features.workspace_view]);

  const running = runningTid === activeId;              // 当前会话是否在生成
  const busyElsewhere = runningTid && runningTid !== activeId;

  const messages = messagesMap[activeId] || [];
  const activeThread = threads.find(t => t.id === activeId);
  const scenario = activeThread?.scenario;           // 场景会话：锁定模型/工具、支持重置与复制
  const slashQuery = input.startsWith("/") && !input.includes(" ") ? input.slice(1) : null;

  /* 重置：回到"刚从外部系统跳转进来"的状态（真实环境: POST /threads/{id}/reset →
     服务端清空工作区→从 workspace_seeds 快照恢复数据文件→新 branch 不 resume 旧 session） */
  const resetScenario = () => {
    if (!scenario) return;
    if (runningTid === activeId) stop();
    if (!window.confirm("重置将清空本会话的对话与工作区改动，恢复到初始数据状态。确认？")) return;
    setMessagesMap(m => ({ ...m, [activeId]: JSON.parse(JSON.stringify(SCENARIO_SEED_MESSAGES)) }));
  };

  /* 复制副本：新会话 + 同一份种子数据（真实环境: POST /threads/{id}/duplicate →
     新 thread + 新工作区，从同一 workspace_seeds 快照物化数据文件） */
  const duplicateScenario = () => {
    if (!scenario) return;
    const id = "s" + Date.now();
    setThreads(ts => [{ id, title: activeThread.title + "（副本）", pinned: false,
      group: "今天", scenario: { ...scenario } }, ...ts]);
    setMessagesMap(m => ({ ...m, [id]: JSON.parse(JSON.stringify(SCENARIO_SEED_MESSAGES)) }));
    setActiveId(id);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messagesMap, activeId]);
  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  const patchLast = (tid, fn) => {
    setMessagesMap(m => {
      const list = [...(m[tid] || [])];
      const last = { ...list[list.length - 1] };
      last.parts = fn([...last.parts], last);
      list[list.length - 1] = last;
      return { ...m, [tid]: list };
    });
  };

  /* 模拟一次 run：真实环境 = POST /messages 拿 run_id，再 fetch 读 SSE 流逐事件 applyEvent。
     所有事件写入都绑定发起时的 tid——用户切走会话后，流继续写入原会话（与后端行为一致）。 */
  const send = (textArg) => {
    const text = (textArg ?? input).trim();
    if (!text || runningTid) return;
    const tid = activeId;                              // 绑定发起线程
    setInput(""); setRunningTid(tid);
    setMessagesMap(m => ({ ...m, [tid]: [...(m[tid] || []),
      { id: "u" + Date.now(), role: "user", parts: [{ type: "text", text }] },
      { id: "a" + Date.now(), role: "assistant", parts: [] },
    ]}));
    const script = mockApi.runScript(text);
    let delay = 0;
    const schedule = (fromIdx) => {
      for (let i = fromIdx; i < script.length; i++) {
        const step = script[i];
        if (step.ev.type === "await_approval") { pausedRef.current = i + 1; return; }
        delay += step.t;
        timersRef.current.push(setTimeout(() => applyEvent(step.ev), delay));
      }
    };
    const applyEvent = (ev) => {
      if (ev.type === "thinking_delta")
        patchLast(tid, ps => [...ps, { type: "thinking", text: ev.text }]);
      if (ev.type === "tool_use")
        patchLast(tid, ps => [...ps, { type: "tool_use", tool: ev.tool, input: ev.input, status: ev.status }]);
      if (ev.type === "tool_result")
        patchLast(tid, ps => ps.map(p => (p.type === "tool_use" && p.tool === ev.tool && !p.output)
          ? { ...p, output: ev.output } : p));
      if (ev.type === "approval_request")
        patchLast(tid, ps => [...ps, { type: "approval", tool: ev.tool, input: ev.input, status: "pending" }]);
      if (ev.type === "text_stream") streamText(ev.text);
      if (ev.type === "run_status") {
        setRunningTid(null);
        setTodayTokens(t => t + 2800);
        patchLast(tid, (ps, last) => { last.usage = ev.usage; return ps; });
      }
    };
    const streamText = (full) => {
      patchLast(tid, ps => [...ps, { type: "text", text: "", streaming: true }]);
      let i = 0;
      const tick = () => {
        i = Math.min(full.length, i + 2 + Math.floor(Math.random() * 3));
        patchLast(tid, ps => ps.map((p, j) => j === ps.length - 1 && p.type === "text"
          ? { ...p, text: full.slice(0, i), streaming: i < full.length } : p));
        if (i < full.length) timersRef.current.push(setTimeout(tick, 24));
      };
      tick();
    };
    schedule(0);
    window.__acDecide = (decision, remember) => {   // 真实环境: POST /approvals/{id}/decide
      patchLast(tid, ps => ps.map(p => p.type === "approval" && p.status === "pending"
        ? { ...p, status: decision, remember } : p));
      const resume = pausedRef.current; pausedRef.current = null;
      if (decision === "approved" && resume != null) { delay = 0; schedule(resume); }
      else if (resume != null) {
        delay = 0;
        timersRef.current.push(setTimeout(() => applyEvent({ type: "text_stream",
          text: "好的，我不会写入这个文件。改动建议我已经整理在上面，你可以手动应用，或调整授权后再让我执行。" }), 400));
        timersRef.current.push(setTimeout(() => applyEvent({ type: "run_status",
          status: "completed", usage: { tokens: "1.9k" } }), 900));
      }
    };
  };

  /* 停止：可停止任意正在生成的会话（含已切走的后台会话）。
     真实环境: 前端 AbortController.abort() 断开 SSE + POST /runs/{id}/stop 通知后端 cancel */
  const stop = () => {
    const tid = runningTid;
    if (!tid) return;
    timersRef.current.forEach(clearTimeout);
    timersRef.current = []; pausedRef.current = null;
    setRunningTid(null);
    patchLast(tid, ps => {
      const cut = ps.map(p => p.type === "approval" && p.status === "pending"
        ? { ...p, status: "denied" } : { ...p, streaming: false });
      return [...cut, { type: "text", text: "（已停止生成）" }];
    });
  };

  const pickCommand = (c) => {
    if (c.local) {
      if (c.name === "permissions") setSettingsOpen(true);
      if (c.name === "model") setModelOpen(true);
      setInput(""); return;
    }
    setInput("/" + c.name + (c.hint ? " " : ""));
  };

  const newThread = () => {
    const id = "t" + Date.now();
    setThreads([{ id, title: "新对话", pinned: false, group: "今天" }, ...threads]);
    setMessagesMap(m => ({ ...m, [id]: [] }));
    setActiveId(id); setView("chat");
  };

  const groups = useMemo(() => {
    const g = {};
    threads.filter(t => t.pinned).forEach(t => (g["已置顶"] = [...(g["已置顶"] || []), t]));
    threads.filter(t => !t.pinned).forEach(t => (g[t.group] = [...(g[t.group] || []), t]));
    return g;
  }, [threads]);

  return (
    <div style={{ display: "flex", height: "100vh", minHeight: 560, background: T.bg,
      fontFamily: T.sans, color: T.text, position: "relative", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 4px; }
        button:focus-visible, textarea:focus-visible, input:focus-visible {
          outline: 2px solid ${T.accent}; outline-offset: 1px; }
        @media (prefers-reduced-motion: no-preference) {
          .ac-caret { animation: acblink 0.9s steps(2) infinite; }
          .ac-pulse { animation: acpulse 1.4s ease-in-out infinite; }
        }
        @keyframes acblink { 50% { opacity: 0; } }
        @keyframes acpulse { 50% { opacity: 0.35; } }
        textarea { resize: none; }
        input::placeholder, textarea::placeholder { color: ${T.faint}; }
      `}</style>

      {/* ============ 侧边栏 ============ */}
      <aside style={{ width: sideOpen ? 254 : 0, transition: "width .2s", overflow: "hidden",
        borderRight: `1px solid ${T.borderSoft}`, background: T.surface, flexShrink: 0,
        display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 14px 8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <span style={{ color: T.accent }}><Icon d={I.term} size={17} /></span>
            <span style={{ fontFamily: T.disp, fontWeight: 600, fontSize: 15.5 }}>AgentChat</span>
          </div>
          <button onClick={newThread}
            style={{ display: "flex", alignItems: "center", gap: 8, width: "100%",
              background: T.white, border: `1px solid ${T.border}`, borderRadius: 10,
              padding: "8px 12px", color: T.text, fontSize: 13.5, cursor: "pointer",
              boxShadow: "0 1px 2px rgba(61,57,41,0.05)" }}>
            <span style={{ color: T.accent }}><Icon d={I.plus} size={14} /></span> 新对话
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8,
            border: `1px solid ${T.borderSoft}`, borderRadius: 10, padding: "6px 10px",
            color: T.faint, background: T.white }}>
            <Icon d={I.search} size={13} />
            <input placeholder="搜索会话" aria-label="搜索会话"
              style={{ background: "none", border: "none", color: T.text, fontSize: 12.5,
                width: "100%", outline: "none" }} />
          </div>
        </div>
        <nav style={{ flex: 1, overflowY: "auto", padding: "4px 8px 12px" }} aria-label="会话列表">
          {Object.entries(groups).map(([g, list]) => (
            <div key={g}>
              <div style={{ fontSize: 11, color: T.faint, padding: "10px 8px 4px" }}>{g}</div>
              {list.map(t => (
                <button key={t.id} onClick={() => { setActiveId(t.id); setView("chat"); }}
                  style={{ display: "flex", alignItems: "center", gap: 7, width: "100%",
                    textAlign: "left",
                    background: t.id === activeId && view === "chat" ? "#EDE9DC" : "none",
                    border: "none", borderRadius: 8, padding: "7px 9px", cursor: "pointer",
                    color: t.id === activeId ? T.text : T.dim, fontSize: 13 }}>
                  {t.pinned && <span style={{ color: T.accent, flexShrink: 0 }}><Icon d={I.pin} size={11} /></span>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.title}
                  </span>
                  {runningTid === t.id && <span className="ac-pulse" title="正在生成"
                    style={{ width: 7, height: 7, borderRadius: "50%", background: T.accent,
                      flexShrink: 0, marginLeft: "auto" }} />}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ padding: "10px 14px", borderTop: `1px solid ${T.borderSoft}` }}>
          {features.show_tokens && (
            <div style={{ fontSize: 11.5, color: T.faint, fontFamily: T.mono, marginBottom: 9 }}>
              今日 {(todayTokens / 1000).toFixed(1)}k
              {features.daily_token_limit ? ` / ${(features.daily_token_limit / 1000).toFixed(0)}k` : ""} tokens
            </div>
          )}
          <button onClick={() => setView("group")}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none",
              border: "none", color: view === "group" ? T.accent : T.dim, fontSize: 13,
              cursor: "pointer", padding: "3px 0 6px", width: "100%" }}>
            <Icon d={I.zap} size={14} /> 组空间
            <span style={{ marginLeft: "auto", fontSize: 10, color: T.faint }}>数据分析组</span>
          </button>
          <button onClick={() => setView("admin")}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none",
              border: "none", color: view === "admin" ? T.accent : T.dim, fontSize: 13,
              cursor: "pointer", padding: "3px 0", width: "100%" }}>
            <Icon d={I.users} size={14} /> 权限管理
            <span style={{ marginLeft: "auto", fontSize: 10, color: T.faint,
              border: `1px solid ${T.border}`, borderRadius: 5, padding: "0 6px" }}>管理员</span>
          </button>
          <button onClick={() => setSettingsOpen(true)}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none",
              border: "none", color: T.dim, fontSize: 13, cursor: "pointer",
              padding: "6px 0 3px" }}>
            <Icon d={I.gear} size={14} /> 我的设置
          </button>
        </div>
      </aside>

      {/* ============ 主区 ============ */}
      {view === "admin" ? (
        <AdminConsole state={adminState} setState={setAdminState} onBack={() => setView("chat")} />
      ) : view === "group" ? (
        <GroupSpace groupName={adminState.groups[0].name} features={features}
          onBack={() => setView("chat")} />
      ) : (
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px",
          borderBottom: `1px solid ${T.borderSoft}`, background: T.surface }}>
          <button onClick={() => setSideOpen(!sideOpen)} aria-label="切换侧栏"
            style={{ background: "none", border: "none", color: T.dim, cursor: "pointer", padding: 4 }}>
            <Icon d={I.chev} size={15} />
          </button>
          <span style={{ fontSize: 14, fontWeight: 500, overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {threads.find(t => t.id === activeId)?.title}
          </span>
          {scenario && (
            <>
              <span title={`由 ${scenario.source} 发起的场景会话`}
                style={{ fontSize: 11, color: "#4A6FA5", border: "1px solid #4A6FA5",
                  background: "rgba(74,111,165,0.08)", borderRadius: 6, padding: "2px 8px",
                  flexShrink: 0 }}>
                {scenario.template} · 来自 {scenario.source}
              </span>
              <button onClick={resetScenario} title="清空对话与工作区改动，恢复初始数据"
                style={{ ...btn("transparent", T.dim, T.border), padding: "3px 10px",
                  fontSize: 12, flexShrink: 0 }}>重置</button>
              <button onClick={duplicateScenario} title="新开一个带同样初始数据的会话"
                style={{ ...btn("transparent", T.dim, T.border), padding: "3px 10px",
                  fontSize: 12, flexShrink: 0 }}>复制副本</button>
            </>
          )}
          {runningTid && (
            <button onClick={stop} title={busyElsewhere
                ? `「${threads.find(t => t.id === runningTid)?.title}」正在生成，点击停止`
                : "停止当前生成"}
              style={{ display: "flex", alignItems: "center", gap: 6, background: T.redDim,
                border: `1px solid ${T.red}`, borderRadius: 7, padding: "3px 10px",
                color: T.red, fontSize: 12, cursor: "pointer", flexShrink: 0 }}>
              <span className="ac-pulse" style={{ width: 7, height: 7, borderRadius: "50%",
                background: T.red }} />
              {busyElsewhere ? "其他会话生成中 · 停止" : "生成中 · 停止"}
            </button>
          )}
          <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 11.5, color: T.faint,
            border: `1px solid ${T.borderSoft}`, borderRadius: 6, padding: "3px 9px",
            background: T.white }}>
            workspace/{activeId}
          </span>
          {features.workspace_view && (
            <button onClick={() => setTreeOpen(!treeOpen)} aria-label="工作区文件树"
              title="查看工作区文件"
              style={{ display: "flex", alignItems: "center", gap: 5,
                background: treeOpen ? T.accentDim : "none",
                border: `1px solid ${treeOpen ? T.accent : T.borderSoft}`, borderRadius: 7,
                padding: "4px 9px", color: treeOpen ? T.accent : T.dim, fontSize: 12,
                cursor: "pointer", flexShrink: 0 }}>
              <Icon d={I.folder} size={13} /> 文件
            </button>
          )}
        </header>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto" }}>
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "12px 22px 30px" }}>
            {messages.length === 0 && (
              <div style={{ textAlign: "center", marginTop: "16vh" }}>
                <div style={{ fontFamily: T.disp, fontSize: 27, fontWeight: 600 }}>开始一个任务</div>
                <div style={{ fontSize: 13.5, color: T.dim, marginTop: 10, lineHeight: 1.8 }}>
                  这个会话有独立的工作区，Claude 可以读写文件、执行命令。<br />
                  输入 <code style={{ fontFamily: T.mono, color: T.accent }}>/</code> 查看可用命令；
                  涉及写入的操作会先请求你的授权。
                </div>
              </div>
            )}
            {messages.map(msg => (
              <Message key={msg.id} msg={msg} features={features}
                onDecide={(d, r) => window.__acDecide && window.__acDecide(d, r)} />
            ))}
          </div>
        </div>

        {/* ============ 输入区 ============ */}
        <div style={{ padding: "0 22px 16px" }}>
          <div style={{ maxWidth: 760, margin: "0 auto", position: "relative" }}>
            {slashQuery !== null && <SlashPalette query={slashQuery} onPick={pickCommand} />}
            <div style={{ background: T.white, border: `1px solid ${T.border}`, borderRadius: 16,
              padding: "11px 13px 9px", boxShadow: "0 2px 10px rgba(61,57,41,0.06)" }}>
              <textarea rows={2} value={input} placeholder="向 Claude 描述任务，或输入 / 调用命令…"
                aria-label="消息输入"
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                style={{ width: "100%", background: "none", border: "none", color: T.text,
                  fontSize: 14.5, lineHeight: 1.6, fontFamily: T.sans, outline: "none" }} />
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 4, flexWrap: "wrap" }}>
                {scenario ? (
                  <span title="场景模板已锁定模型与工具范围"
                    style={{ fontSize: 12, color: T.faint, border: `1px solid ${T.borderSoft}`,
                      borderRadius: 8, padding: "4px 11px", background: T.surface }}>
                    🔒 {scenario.model} · 场景已锁定模型与工具
                  </span>
                ) : (
                <div style={{ position: "relative" }}>
                  <button onClick={() => setModelOpen(!modelOpen)}
                    style={{ display: "flex", alignItems: "center", gap: 6, background: T.surface,
                      border: `1px solid ${T.borderSoft}`, borderRadius: 8, padding: "4px 11px",
                      color: T.text, fontSize: 12.5, cursor: "pointer" }}>
                    {model.label}
                    <span style={{ transform: "rotate(90deg)", display: "inline-flex", color: T.faint }}>
                      <Icon d={I.chev} size={11} /></span>
                  </button>
                  {modelOpen && (
                    <div style={{ position: "absolute", bottom: "115%", left: 0, width: 210,
                      background: T.white, border: `1px solid ${T.border}`, borderRadius: 10,
                      overflow: "hidden", zIndex: 20, boxShadow: "0 4px 16px rgba(61,57,41,0.10)" }}>
                      {MODELS.map(m => (
                        <button key={m.id} onClick={() => { setModel(m); setModelOpen(false); }}
                          style={{ display: "flex", alignItems: "center", gap: 8, width: "100%",
                            textAlign: "left", padding: "9px 12px", background: "none",
                            border: "none", cursor: "pointer",
                            color: m.id === model.id ? T.accent : T.text, fontSize: 13 }}>
                          <span style={{ flex: 1 }}>{m.label}</span>
                          <span style={{ fontSize: 11, color: T.faint }}>{m.note}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                )}
                <Toggle on={thinkOn} onChange={setThinkOn} label="深度思考" />
                {features.web_search && !scenario && (
                  <Toggle on={webOn} onChange={setWebOn} label="联网搜索" />
                )}
                <div style={{ marginLeft: "auto" }}>
                  {running ? (
                    <button onClick={stop} aria-label="停止生成"
                      style={{ ...btn(T.redDim, T.red, T.red), display: "flex",
                        alignItems: "center", gap: 6 }}>
                      <Icon d={I.stop} size={12} /> 停止
                    </button>
                  ) : (
                    <button onClick={() => send()} disabled={!input.trim() || busyElsewhere}
                      aria-label="发送"
                      title={busyElsewhere ? "另一个会话正在生成，请先停止或等待完成" : ""}
                      style={{ ...btn(input.trim() && !busyElsewhere ? T.accent : "#E4E0D3",
                        input.trim() && !busyElsewhere ? "#FFF" : T.faint), display: "flex",
                        alignItems: "center", gap: 6 }}>
                      <Icon d={I.send} size={13} /> 发送
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: T.faint, textAlign: "center", marginTop: 8 }}>
              涉及文件写入与命令执行的操作会先请求授权 · 全部工具调用有审计记录
            </div>
          </div>
        </div>
          </div>
          {treeOpen && features.workspace_view && (
            <WorkspacePanel threadId={activeId} onClose={() => setTreeOpen(false)} />
          )}
        </div>
      </main>
      )}

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)}
        ceiling={features.mode_ceiling} grants={features.settings_grants} />}
    </div>
  );
}
