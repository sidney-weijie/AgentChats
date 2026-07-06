# AgentChat · Skill 共享、组协作与设置治理（09）

本文档覆盖三个关联能力：
**A. Skill 体系**——系统内置 / 用户自建 / 导入生效；
**B. 组协作**——组内共享 Skill（采纳制）与只读会话查看，严格隔离；
**C. 设置治理**——"我的设置"中除 Skills 外的板块由管理系统控制，仅授权用户可操作。

---

## A. Skill 体系

### A.1 三类来源与统一模型

沿用并升级 02 文档的 `slash_commands` 表为 `skills`（Alembic 迁移重命名 + 加列）：

```sql
skills(
  id VARCHAR(36) PK,
  source VARCHAR(20),               -- system / user
  owner_user_id VARCHAR(36) NULL,   -- source=user 时必填; system 为空
  name VARCHAR(64), description VARCHAR(300), argument_hint VARCHAR(100),
  allowed_tools JSON, model VARCHAR(60) NULL,
  body TEXT,                        -- SKILL.md 正文
  version INT DEFAULT 1,            -- 每次保存 +1（共享更新提示的依据）
  enabled BOOLEAN DEFAULT 1,        -- 自己是否启用自己的 skill
  created_at, updated_at,
  UNIQUE (owner_user_id, name)      -- 私有命名空间, 不同用户可重名
)
```

| 来源 | 管理者 | 可见性 | 用户操作 |
|---|---|---|---|
| system 内置 | 管理员（管理端 CRUD，可全局启停/按权限档案下发） | 所有人 | 只能使用，不可改（UI 标"系统 · 不可修改"） |
| user 自建 | 用户本人 | 仅本人 | 新建/编辑/启停/删除/共享到组 |
| user 导入 | 用户本人 | 仅本人 | 上传 SKILL.md（或 zip 含资源文件）→ 解析 frontmatter 校验 → 入库为自己的 skill |

**导入生效的校验链**（安全重点，Skill 本质是注入给模型的指令）：
frontmatter 字段白名单 → `allowed-tools` 声明不得超出用户自身的工具授权
（超出部分导入时裁掉并提示）→ body 大小上限（如 64KB）→ 名称正则与保留字
（不得仿冒系统 skill 名）→ 审计 `skill_imported`。

### A.2 物化合并（生效机制）

运行前物化到会话工作区 `.claude/skills/` 的集合 =

```
system skills(全局启用 ∩ 该用户档案未禁用)
∪ 自己的 skills(enabled=1)
∪ 已采纳的组共享 skills(adoption.enabled=1, 见 B.2)
```

同名冲突时优先级：**自己的 > 采纳的 > 系统的**，物化时后者跳过并在命令面板标注被遮蔽。
物化缓存键从 `(id, updated_at)` 升级为含 version 的哈希，作者更新共享 skill 后
采纳者的下一次会话自动拿到新版（并在 UI 提示"已更新到 v{n}"）。

---

## B. 组协作

### B.1 组模型

```sql
groups(id PK, name VARCHAR(100), description, created_at)
group_members(
  group_id FK, user_id FK,
  role VARCHAR(20) DEFAULT 'member',   -- owner / admin / member
  joined_at, PRIMARY KEY (group_id, user_id)
)
```

组的创建与成员管理放在**管理端**（企业内组织结构通常由管理员维护）；
组 owner/admin 可在组空间内移除成员的共享内容（治理），member 只能管理自己的共享与采纳。
一个用户可属多组；组空间页顶部做组切换。

### B.2 Skill 共享与采纳（opt-in 双层记录）

```sql
skill_shares(                        -- 作者把 skill 共享到组
  id PK, skill_id FK, group_id FK, shared_by FK,
  created_at, revoked_at NULL,
  UNIQUE (skill_id, group_id)
)
skill_adoptions(                     -- 成员采纳（可见 ≠ 启用）
  id PK, share_id FK, user_id FK,
  enabled BOOLEAN DEFAULT 1,         -- 采纳后仍可临时停用
  adopted_version INT,               -- 采纳时的版本, 用于"作者已更新"提示
  created_at, updated_at,
  UNIQUE (share_id, user_id)
)
```

语义规则：
- 共享是**引用不是拷贝**：作者改，采纳者跟着生效（有版本提示）；作者
  `revoked_at` 取消共享或删除 skill → 所有 adoption 级联失效（下次物化自动剔除，
  UI 中该项标"作者已取消共享"）。
- 采纳者对共享 skill **零写权限**：没有任何编辑端点接受非 owner 的请求；
  想改就"另存为我的副本"（显式复制成自己的 skill，与原作者断开）。
- 全部动作进审计：`skill_shared / skill_share_revoked / skill_adopted / skill_adoption_disabled`。

### B.3 组内只读会话

```sql
thread_group_shares(
  id PK, thread_id FK, group_id FK, shared_by FK,
  include_files BOOLEAN DEFAULT 0,   -- 是否连带开放工作区文件的只读浏览(默认不开)
  created_at, revoked_at NULL
)
```

- **只有会话 owner 能共享自己的会话**，可随时撤销。
- 组成员的只读视图 = `GET /groups/{gid}/threads/{tid}/messages`（服务端校验
  membership + share 记录 + 未撤销）。**只读的保证是根本没有写端点**：
  发消息/停止/审批/重命名等所有写接口仍然只校验 `thread.user_id == current_user`，
  组共享不改变这些接口的判定——这就是隔离机制的核心：读走专用只读端点，写不动原判定。
- `include_files=1` 时开放 `GET /groups/{gid}/threads/{tid}/files[...]` 只读浏览
  （复用 workspace_view 的路径校验，叠加 share 校验）；默认关闭，因为工作区里可能有
  用户不想暴露的中间产物。
- 查看行为进审计（`shared_thread_viewed`），owner 可看到谁看过。
- 正在生成中的会话：只读视图只到最后一条完整消息，不接入实时 SSE（避免旁观者
  影响 run 事件流的生命周期管理；如需"围观直播"，后续在事件总线上加只读订阅）。

### B.4 隔离规则总表（实现时的检查清单）

| 资源 | 本人 | 同组成员 | 其他人 |
|---|---|---|---|
| 私有 skill | 全权 | 不可见 | 不可见 |
| 已共享 skill | 全权 | 只读+采纳 | 不可见 |
| 会话/消息 | 全权 | 仅显式共享后只读 | 不可见 |
| 工作区文件 | 按 workspace_view | 仅 include_files=1 且只读 | 不可见 |
| 审批/停止/发送 | 可 | **永远不可** | 不可 |
| 权限档案/用量 | 只读自己的 | 不可见 | 不可见 |

---

## C. 设置治理（"我的设置"的管控）

### C.1 模型：全局策略 + 按用户授权

```
app_settings.settings_policy(全局默认):
  { "skills": "self",                 # Skill 管理默认所有人自助
    "permission_rules": "admin_only", # 权限规则/模式默认仅管理员
    "hooks": "admin_only" }           # Hook 策略默认仅管理员

user_permission_profiles 增列:
  settings_grants JSON                # {"permission_rules": true, "hooks": false}
                                      # 按用户放开特定板块的自助操作
```

生效值 = 全局策略为 self 的板块人人可操作；admin_only 的板块看该用户
`settings_grants` 是否为 true。`GET /me` 的 features 增加 `settings_grants` 字段，
前端据此把未授权板块渲染为**只读 + 锁定横幅**（"由管理员统一管理，可查看不可修改"）。

### C.2 服务端强制（一贯原则：前端只是体验）

所有用户自助设置的写接口（`/permission-rules`、`/hook-rules`、`/settings/permissions`）
在入口统一过一个依赖：

```python
def require_settings_grant(section: str):
    async def dep(user=Depends(current_user)):
        if resolve_policy(section, user) != "self" and user.role != "admin":
            raise HTTPException(403, f"{section} 由管理员管理")
    return dep
```

Skills 相关端点不套这个依赖（默认自助），但导入/共享有自己的校验链（A.1/B.2）。
所有 config_change 审计带 `granted_via` 字段（self / settings_grant / admin），
可追溯"这条配置是谁、凭什么权限改的"。

### C.3 权限合并链最终版（汇总所有文档）

```
① 系统锁定规则（全局 deny，任何人不可越过）
② 管理员用户档案 user_permission_profiles（工具授权/模式上限/额度/展示/设置授权）
③ 场景模板 scenario_grants（∩ 交集，只收窄——场景会话时）
④ project 规则
⑤ user 自身规则（仅在 settings_grants 允许时才可能存在新增；审批"记住"生成的规则归此层）
```

---

## D. API 汇总（并入 05 文档）

```
# Skills
GET  /skills?source=                我的+系统（含启用状态）
POST /skills                         新建
POST /skills/import                  multipart SKILL.md/zip → 校验链 → 入库
PATCH/DELETE /skills/{id}            仅 owner；system 类型仅 admin
POST /skills/{id}/duplicate          另存为我的副本（可复制被采纳的共享 skill）

# 组与共享
GET  /groups                         我所在的组
GET  /groups/{id}/skills             组内共享列表（含 owner、version、我的采纳状态）
POST /skills/{id}/share              {group_id} 共享到组   DELETE /skill-shares/{id} 撤销
PUT  /skill-shares/{id}/adoption     {enabled} 采纳/停用（写 skill_adoptions）
POST /threads/{id}/group-share       {group_id, include_files}   DELETE 撤销
GET  /groups/{gid}/shared-threads    组内共享会话列表
GET  /groups/{gid}/threads/{tid}/messages          只读消息（无对应写端点）
GET  /groups/{gid}/threads/{tid}/files?path=       仅 include_files=1

# 治理（管理端）
GET/PUT /admin/settings              settings_policy 并入全局配置
（settings_grants 在既有 PUT /admin/users/{id}/permission-profile 中）
GET/POST/PATCH /admin/system-skills  系统内置 skill 管理
GET/POST/DELETE /admin/groups        组与成员管理
```

## E. 页面设计（已在 AgentChatUI.jsx 实现演示）

- **我的设置 → Skills 标签**：三段式——系统内置（灰显不可改）/ 我的 Skills
  （编辑、共享到组/取消共享、新建、从文件导入）/ 底部说明指向组空间采纳他人 skill。
- **组空间**（侧边栏新入口）：共享 Skills 列表（作者、版本、描述，非本人的用
  "采纳"开关，本人的显示"取消共享"）+ 共享会话列表（点击展开只读消息流，
  含工具卡片与用量，底部标注"只读视图 · 无法发送消息或访问工作区文件"）。
- **我的设置 → 权限/Hooks 标签**：未授权用户看到锁定横幅，内容只读
  （模式选择与规则增删禁用）；被授权用户（如演示中王工的权限规则板块）正常操作。
- **管理控制台 → 用户档案**：新增"设置操作授权"区块，按用户开关
  权限规则/Hook 策略 的自助操作权。

## F. 排期

插入 **M-Group 里程碑（~6d）**，依赖 M3（权限）与 M5（命令物化）：
skills 表迁移 + 导入校验链 + groups/shares/adoptions + 只读会话端点 + 治理依赖注入 + 三处 UI。
验收：A 共享 skill → B 采纳后命令面板出现且物化生效 → A 更新版本 B 收到提示 →
A 取消共享 B 侧自动失效；B 尝试编辑 A 的 skill / 向 A 的共享会话发消息 → 均 403 且有审计；
未授权用户改权限规则 → 403，管理员授权后可改，审计记录 granted_via。
