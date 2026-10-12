# Life OS V1

仅本人使用的个人生活与事务管理工作站。产品需求见上级目录的 `Life_OS_V1_PRD.md`；
V1.1 微信创建与查询助手见上级目录 `Life_OS_V1.1_Wechat_Jev_PRD.md`；
当前进度与验收状态见 `PROGRESS.md`，外部阻塞见 `BLOCKED.md`。

## 微信创建与查询（V1.1）

在微信里直接说话即可**新建日程/待办**和**查询**，无需打开网页。

```
明天下午三点科研楼开组会      → 预览 + 短码，回复「确认 XXXX」保存
/add 明天开会                 → 跳过意图分类，直接进入创建
下午三点                      → 补充当前草稿（保留已确定字段）
/today /tomorrow /list        → 查询今天、明天、未来七天
/pending                      → 查看当前草稿
/recent                       → 查看最近操作结果（核实"是否保存成功"）
取消                          → 放弃当前草稿
/help                         → 用法
```

**行为要点（已确认，见 PRD 16.1）**：

- 默认提醒提前 **60 / 10 分钟**，且**逐档判定**：触发点已过则不安排该档，
  也不补发、不替换为到点提醒；距开始不足 10 分钟时预览明确写「本次不安排提醒」。
- 日期或时刻不完整**允许保存**，但不生成提醒任务，预览写明原因；
  「用户主动关闭提醒」与「因缺字段无法安排」是两种不同状态。
- 草稿有效期 30 分钟，自**最后一次有效修改**起算并续期。
- 只有**完整的 `确认 短码`** 才提交；裸「确认」、`1`/`2`/`3` 都不作为快捷键。
- 同时最多一个未保存草稿；有草稿时查询照常可用，但新建会被要求先处理当前草稿。
- 已保存事项的修改/删除/完成本版不支持，会提示到工作站操作。
- 查询单条回复最多 **8 条**、单条 **600 全角字符**，超出截断并**如实标注**总数与已显示条数。
- 发送计数沿用既有 8/10 窗口：每发出一次计一次（提醒与回复同等计数），
  第 8 条后自动发刷新提醒且该提醒也计数，第 10 条暂停，你发新消息后恢复。

**输入开关**：`WECHAT_INBOUND_ENABLED=0` 可关闭微信创建/查询处理，
**主动提醒不受影响**，仍按原调度发送。

## 微信 iLink 扫码绑定

登录后在「设置 → 微信提醒」点击「扫码绑定微信」，用微信扫描并在手机确认；成功后向该机器人发送一句话，LifeOS 才能取得该会话的 `context_token` 并开始提醒。LifeOS 使用独立的 Bot 凭据与接收游标，不读 MultiHarnessWechatNotifier 的账号和上下文。凭据在服务端加密保存，业务 JSON 导出排除私有状态。

每次实际发送请求计入当前窗口；第 8 次后另发一条刷新提醒，该提醒也计数。达到 10 次经验阈值即暂停，待你向机器人发送新消息或 `/refresh-context` 并收到有效上下文后恢复。此阈值并非微信公布的实时剩余额度；页面分别展示已接受、明确失败与结果未知。暂停中的任务保持待处理，恢复后仍遵守原有过期提醒策略。真实微信收取与手机显示必须扫码后另行验收。

## 技术形态

VPS 只有 1 核 / 1GB 内存且已运行其他业务，因此**不采用 Docker**，改为更省资源的原生部署：

| 组件 | 实现 | 常驻内存 |
|---|---|---|
| 前端 | Vite + React + TS + Tailwind，构建为静态文件由 Nginx 直出 | 0（不占进程） |
| API | Node 20 + Hono，tsx 直接运行 TS，仅监听 127.0.0.1:8890 | ~85MB |
| Worker | 独立 Node 进程，systemd 守护 | ~60MB |
| 数据库 | 复用 VPS 已有的 PostgreSQL 16，独立 `lifeos` 库与用户 | 共享实例 |
| HTTPS | 复用已有 Nginx + certbot | 共享实例 |

## 目录结构

```
src/server/     API 服务：路由、认证、数据库访问
src/server/lib/ 领域逻辑：scheduling（提醒重调度）、wechat-*（V1.1 微信链路）、ai/（Jev 与 DeepSeek）
src/worker/     通知 Worker：core.ts 为可测逻辑，index.ts 为入口（锁/轮询/信号）
                wechat-listener.ts 轮询入站、outbox-sender.ts 发送回复
src/scripts/    迁移与管理员初始化命令
src/shared/     前后端共享类型
web/            前端源码（构建产物输出到 dist/web）
deploy/         systemd 单元、Nginx 站点、备份/恢复/自检脚本
drizzle/        数据库迁移 SQL 与 meta（**纳入版本控制，是唯一权威来源**）
tests/          回归测试：unit/（node --test）+ shell/（恢复与备份）
```

### V1.1 微信链路的模块分工

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `wechat-listener.ts` | 轮询 `getupdates`，**只做持久化** | 消息+游标+上下文同一短事务；不做业务判断 |
| `wechat-inbox.ts` | 入站持久化、去重、租约、退避、正文清理 | 去重靠数据库唯一约束，不靠内存数组 |
| `wechat-processor.ts` | 领取入站 → 路由 → 落操作/回复 | **模型调用不在事务内**；唯一的写入入口 |
| `wechat-handler.ts` | 确定性命令与意图路由 | 能用规则判断的一律不调模型 |
| `wechat-model.ts` | Jev 意图路由 + DeepSeek 抽取 | 失败一律不写库；只发草稿摘要，不发聊天历史 |
| `wechat-draft.ts` | 草稿状态机、逐档提醒判定 | 纯函数，穷举式测试覆盖 |
| `wechat-operations.ts` | 草稿读写 + **原子创建** | 事项+提醒+操作+回复同事务 |
| `wechat-outbox.ts` / `outbox-sender.ts` | 回复队列与发送 | 发送前复核代际与版本，过时作废 |
| `wechat-query.ts` | 查询执行 | 结果全部来自数据库；口径对齐 Web |
| `wechat-reply.ts` | 回复排版 | 8 条 / 600 全角字符，超出如实标注 |

## 本地开发

```bash
npm ci                    # 使用 lockfile 安装，保证可重现
cp .env.example .env
npm run db:migrate
npm run dev:api           # API:  http://127.0.0.1:8890
npm run dev:web           # 前端: http://127.0.0.1:5173（已代理 /api）
npm run dev:worker        # 通知 Worker
npm run typecheck
```

## 验证

```bash
# 全量回归（需要独立测试库，库名必须以 _test 结尾，这是硬性保护）
export TEST_DATABASE_URL=postgresql://lifeos:***@127.0.0.1:5432/lifeos_test
npm test

# 线上只读自检（服务、响应头、缓存控制、认证隔离、限速、库不变量、备份）
sudo bash deploy/verify.sh
```

`npm test` 会依次执行：测试库迁移 → `tsc --noEmit` → 44 项单元/集成回归 → shell 级验证
（恢复脚本必须对错误 SQL 失败、备份必须加密且失败不毁最后副本）。
任何一项失败都会以非零码退出，不使用 skip/放宽断言/吞错。

## 服务器部署

服务器上的 `/opt/lifeos/.env` 保存真实密钥（权限 600），**不随代码同步**。

```bash
# 1. 同步代码（排除 node_modules 与 .env）
tar czf - --exclude=node_modules --exclude='*.env' --exclude=dist --exclude=.git . \
  | ssh lisahost "tar xzf - -C /opt/lifeos"

# 2. 安装依赖并迁移
ssh lisahost "cd /opt/lifeos && npm ci && npm run db:migrate"

# 3. 构建前端
ssh lisahost "cd /opt/lifeos && node scripts/generate-icons.mjs && npm run build:web"

# 4. 重启服务
ssh lisahost "sudo systemctl restart lifeos-api lifeos-worker"

# 5. 自检
ssh lisahost "sudo bash /opt/lifeos/deploy/verify.sh"
```

### ⚠️ 服务器 `.env` 的配置项必须在部署时人工确认

`.env` **不随代码同步**，因此**新增配置项很容易漏掉**，而漏掉往往是静默的。
V1.1 上线时就发生过一次：服务器只有官方 Jev key、**没有任何中转配置**，
于是文档承诺的"官方不可用时回退中转"在线上**根本不存在**——
官方端点一旦失效就整体不可用，而且没有任何报错提示。

因此每次部署后，用这条**只列键名与长度、不显示值**的命令核对：

```bash
ssh lisahost "awk -F= '/^(JEV_|WECHAT_|ILINK_|DEEPSEEK_|MIMO_|BACKUP_)/{print \$1\" 长度=\"length(\$2)}' /opt/lifeos/.env"
```

V1.1 起必须存在的项：

| 键 | 作用 | 缺失后果 |
| --- | --- | --- |
| `JEV_OFFICIAL_API_KEY` | Jev 官方端点（首选） | 自然语言创建/查询不可用（确定性命令仍可用） |
| `JEV_BASE_URL` + `JEV_API_KEY` | Jev 中转（官方失效时回退） | **回退路径不存在**，官方一挂就整体不可用 |
| `DEEPSEEK_API_KEY` | 字段抽取与草稿补丁 | 无法把一句话解析成草稿 |
| `WECHAT_INBOUND_ENABLED` | 业务输入开关（默认 1） | 设 0 时不处理微信输入，**主动提醒不受影响** |
| `WECHAT_MODEL_CALLS` | 模型调用开关（默认 1） | 设 0 时仅确定性命令可用；**生产不应为 0** |

写入方式建议 base64 经 stdin + `python` 插入，**避免密钥出现在命令行历史或进程列表**；
写入前备份原文件，写入后 `chmod 600`。

### ⚠️ 迁移文件的权威来源是 Git 仓库

**绝不要在服务器上 `npm run db:generate` 后不同步回仓库。** 曾经因此发生过：
服务器生成的迁移未被纳入仓库，下一次部署用仓库内容覆盖了 `drizzle/meta/_journal.json`，
导致干净检出只能应用第一个迁移、重建不出完整结构。

正确流程：在仓库里改 `schema.ts` → `npm run db:generate` → 提交 SQL 与 meta → 再部署。
`deploy/verify.sh` 会比对「已应用迁移哈希」与「仓库 SQL 哈希」，不一致即报错。

## 运维命令

```bash
sudo systemctl status lifeos-api lifeos-worker
sudo journalctl -u lifeos-api -f
sudo systemctl restart lifeos-api

# 备份（加密 + 可选异机）
sudo bash /opt/lifeos/deploy/backup.sh
sudo bash /opt/lifeos/deploy/restore-test.sh          # 恢复演练，只碰 _test 库

# 管理员维护（单管理员：不会新增第二个账号）
cd /opt/lifeos
npm run create-admin -- <用户名>                       # 首次初始化
npm run create-admin -- <用户名> --update              # 重置密码
npm run create-admin -- <新用户名> --rename            # 重命名（非新增）
```

## 关键约定

- 时间型数据按 UTC 存 `timestamptz`；日期型数据（全天待办、扣费日）存 `date`，不当作 UTC 午夜。
- 金额一律 `numeric`，禁止二进制浮点。
- **单管理员是不变量**：CLI 拒绝创建第二个账号，数据库还有常量表达式唯一索引兜底。
- **预计账单永不自动转为已付款**，必须人工确认。
- **通知结果分三态**：明确可重试才重试；明确拒绝/需人工介入直接终止；
  **无法确认是否送达（HTTP 200 但无可靠业务回执、超时、发送中中断）一律不自动重发**，
  标记为需人工核实，避免重复送达。
- **渠道未配置时 Worker 不领取任何发送任务**：不消费、不记尝试、不伪造送达。
  超过 `MISSED_AFTER_MINUTES` 的提醒标记 `missed` 并写明原因，可在「设置 → 通知记录」查询。
- 密钥只存在于服务器 `/opt/lifeos/.env`，前端构建产物中不得出现。
- **V1.1 微信链路**：`wechat_inbox` 用 `(绑定代际, 提供方消息 ID)` 唯一约束去重；
  `wechat_operations` 用**偏唯一索引**在数据库层保证"每个代际至多一个活动草稿"，
  不依赖应用判断；解析基准（`parse_basis_at`）在**入站那一刻冻结**，
  重试不得用新的"现在"重新解释"明天"。
- **不确定的发送绝不自动重发**：HTTP 200 无可靠业务回执、超时、发送中断
  一律归入 `unknown` 并终止；过时回复（代际变更或草稿版本被替代）标记 `suppressed` 而非迟到送达。
- **正文保留 7 天**只清正文，去重键与终态审计保留，因此 `/recent` 的核实能力不受保留期限制。
