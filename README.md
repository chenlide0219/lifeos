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

**每个账号各自绑定自己的微信**：登录后在「设置 → 微信提醒」点击「扫码绑定微信」，用微信扫描并在手机确认；成功后向该机器人发送一句话，LifeOS 才能取得该会话的 `context_token` 并开始提醒。每个账号各有自己的 Bot 凭据、接收游标、8/10 发送窗口与暂停状态，互不影响——把 A 的提醒发到 B 的微信、或 B 的窗口用尽连带停掉 A 的提醒，都是必须避免的故障。LifeOS 使用独立的 Bot 凭据，不读 MultiHarnessWechatNotifier 的账号和上下文。凭据在服务端加密保存，业务 JSON 导出排除私有状态。

⚠️ **发送凭据不再来自环境变量**：`ILINK_TOKEN` / `ILINK_TO_USER_ID` / `ILINK_CONTEXT_TOKEN` 三个变量已失效（保留注释仅为历史对照）。原因是一个全局凭据无法归属到任何账号，留着它就会变成跨账号泄露的入口。因此**必须扫码绑定**才能收到提醒与微信回复。

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

### ⚠️ 多用户改造（0003 + 0004）的部署顺序**不能**照搬上面这一套

上面那套的前提是"新代码对旧库也能跑"。**本次不成立**：0003 把 `admin_users` 改名为
`users` 并给 13 张业务表加了 NOT NULL 的 `user_id`，因此：

- **迁移之前**：新代码跑不起来（表名/列还不存在）；
- **迁移之后**：**旧代码立刻失效**（它查的 `admin_users` 已经没了）。

也就是说存在一个"两边都不兼容"的窗口，必须**先停服务再迁移**，不能像平时那样
"先迁移、再重启"——否则这段时间里 API 会对你的手机返回 500。

#### 正确的顺序

```bash
# 0. 先在**生产库的克隆**上把迁移跑一遍（只读生产，结束时自动删克隆库）
scp drizzle/0003_multi_user.sql drizzle/0004_multi_user_isolation.sql \
    deploy/verify-migration-on-clone.sh lisahost:/tmp/lifeos-mig/
ssh lisahost "cd /tmp/lifeos-mig && mv 0003_multi_user.sql 0003.sql && \
  mv 0004_multi_user_isolation.sql 0004.sql && bash verify-migration-on-clone.sh"
#    必须 17 通过 / 0 失败 才继续。这一步能提前发现只在真实数据上才暴露的问题
#    （例如 id 序列与数据不同步——那会让"迁移后创建第一个新账号"直接失败）。

# 1. 加密备份生产库（失败就停在这里，不要继续）
ssh lisahost "sudo bash /opt/lifeos/deploy/backup.sh"

# 2. 停服务（缩短"两边都不兼容"的窗口）
ssh lisahost "sudo systemctl stop lifeos-api lifeos-worker"

# 3. 同步代码
tar czf - --exclude=node_modules --exclude='*.env' --exclude=dist --exclude=.git . \
  | ssh lisahost "tar xzf - -C /opt/lifeos"

# 4. 依赖 + 迁移 + 构建前端（依赖没变，但 npm ci 保持习惯）
ssh lisahost "cd /opt/lifeos && npm ci && npm run db:migrate && \
  node scripts/generate-icons.mjs && npm run build:web"

# 5. 起服务
ssh lisahost "sudo systemctl start lifeos-api lifeos-worker"

# 6. 自检（会校验迁移哈希、隔离不变量、逐账号绑定概览）
ssh lisahost "sudo bash /opt/lifeos/deploy/verify.sh"

# 7. 建第二个账号（密码经 stdin，不进命令行历史）
ssh lisahost "cd /opt/lifeos && printf '%s\n' 'Wangliu66' | npm run create-user -- Wangliu --password-stdin"
```

#### 回滚

迁移不可逆（表已改名、列已 NOT NULL），因此**唯一**的回滚方式是恢复备份：

```bash
ssh lisahost "sudo bash /opt/lifeos/deploy/restore-test.sh"   # 先在 _test 库演练
# 确认备份可用后，按 deploy/backup.sh 的说明用备份覆盖生产库，再检出上一个 tag：
#   git checkout pre-multiuser-20261012
```

所以第 1 步的备份不是形式：**没有它就没有退路**。

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

# 账号维护（不开放注册：账号只能由管理界面或本命令创建）
cd /opt/lifeos
npm run create-user -- --list                                  # 列出账号、权限与状态
npm run create-user -- <用户名> --password-stdin [--admin]      # 新建（首个账号自动成为管理员）
npm run create-user -- <用户名> --update [新密码]                # 重置密码并强制其下次登录改密
npm run create-user -- <新用户名> --rename <旧用户名>            # 重命名（不是新增）
npm run create-user -- <用户名> --disable                      # 禁用（立即撤销其全部会话）
npm run create-user -- <用户名> --enable                       # 恢复
```

初始密码不要写在命令行上（`ps` 与 shell 历史都会留下它），优先用 `--password-stdin`。
由管理员设置或生成的初始密码一律标记为**必须首次登录改密**，在改密之前该账号
无法使用任何业务功能（后端返回 403 `password_change_required`，不只是前端跳转）。

## 关键约定

- 时间型数据按 UTC 存 `timestamptz`；日期型数据（全天待办、扣费日）存 `date`，不当作 UTC 午夜。
- 金额一律 `numeric`，禁止二进制浮点。
- **不开放注册**：账号只能由管理界面或 `create-user` 命令创建；没有注册入口与自助找回，
  忘记密码由管理员重置。多用户改造后**没有**"单管理员"约束了，但仍然保留两条硬性要求：
  新建账号默认不是管理员（`is_admin` 默认 false），且系统必须始终至少有一个启用中的管理员。
- **数据按账号完全隔离**，由两侧共同保证，缺一不可：
  - 数据库层：13 张业务表都有 `user_id NOT NULL`；子表用**复合外键**
    （如 `expected_bills(subscription_id, user_id) → subscriptions(id, user_id)`）
    让"子表归属必须等于父表归属"无法被违反。引用目标需要 `(id, user_id)` 唯一索引，
    该索引**必须在外键之前创建**，否则迁移本身会执行失败。
  - 应用层：每条对归属表的 `select / update / delete` 都必须带 `ownedBy(表, userId)`
    （见 `src/server/lib/scope.ts`）。数据库能挡住"写错归属"，挡不住"查询忘了过滤"，
    而后者才是真正会发生的跨用户泄露。
  - 别人的资源与不存在的资源**一律返回同一个 404**，不用 403 区分——否则等于向调用方
    确认"这个 id 存在"。
  - 回归保障：`tests/unit/isolation.test.ts` 用哨兵字符串扫描 bob 的每一个读取端点，
    并断言 alice 的数据攻击后完好无损。
- **提醒的发送资格逐账号判定**：Worker 绝不依据"全局有没有配置渠道"领取任务，
  只领取"该任务所属账号**自己**的绑定可用"的任务；暂停也只影响该账号自己。
- **每账号一份微信绑定**（`wechat_accounts`，user_id 为主键）：凭据、接收游标、
  8/10 发送窗口、暂停状态都按账号独立。发送凭据**不来自环境变量**。
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
