# Life OS V1

仅本人使用的个人生活与事务管理工作站。产品需求见上级目录的 `Life_OS_V1_PRD.md`；
当前进度与验收状态见 `PROGRESS.md`，外部阻塞见 `BLOCKED.md`。

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
src/worker/     通知 Worker：core.ts 为可测逻辑，index.ts 为入口（锁/轮询/信号）
src/scripts/    迁移与管理员初始化命令
src/shared/     前后端共享类型
web/            前端源码（构建产物输出到 dist/web）
deploy/         systemd 单元、Nginx 站点、备份/恢复/自检脚本
drizzle/        数据库迁移 SQL 与 meta（**纳入版本控制，是唯一权威来源**）
tests/          回归测试：unit/（node --test）+ shell/（恢复与备份）
```

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
