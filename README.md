# Life OS V1

仅本人使用的个人生活与事务管理工作站。产品需求见仓库上级目录的 `Life_OS_V1_PRD.md`。

## 技术形态

VPS 只有 1 核 / 1GB 内存且已运行其他业务，因此**不采用 Docker**，改为更省资源的原生部署：

| 组件 | 实现 | 常驻内存 |
|---|---|---|
| 前端 | Vite + React + TS + Tailwind，构建为静态文件由 Nginx 直出 | 0（不占进程） |
| API | Node 20 + Hono，tsx 直接运行 TS，仅监听 127.0.0.1:8890 | ~80MB |
| Worker | 独立 Node 进程，systemd 守护 | ~60MB |
| 数据库 | 复用 VPS 已有的 PostgreSQL 16，独立 `lifeos` 库与用户 | 共享实例 |
| HTTPS | 复用已有 Nginx + certbot | 共享实例 |

## 目录结构

```
src/server/     API 服务：路由、认证、数据库访问
src/worker/     通知 Worker：任务调度、租约、重试、渠道适配器
src/scripts/    迁移与管理员初始化命令
src/shared/     前后端共享类型
web/            前端源码（构建产物输出到 dist/web）
deploy/         systemd 单元、Nginx 站点、备份与恢复校验脚本
drizzle/        数据库迁移 SQL（由 schema 生成，纳入版本控制）
```

## 本地开发

```bash
npm install
cp .env.example .env      # 填写 DATABASE_URL 等
npm run db:migrate
npm run dev:api           # API: http://127.0.0.1:8890
npm run dev:web           # 前端: http://127.0.0.1:5173（已代理 /api）
```

## 服务器部署

服务器上的 `/opt/lifeos/.env` 保存真实密钥（权限 600），**不随代码同步**。

```bash
# 1. 同步代码（排除 node_modules 与 .env）
tar czf - --exclude=node_modules --exclude=.env --exclude=dist . \
  | ssh lisahost "tar xzf - -C /opt/lifeos"

# 2. 安装依赖并初始化数据库
ssh lisahost "cd /opt/lifeos && npm install --omit=dev && npm i -D drizzle-kit typescript tsx vite @vitejs/plugin-react tailwindcss postcss autoprefixer @types/node @types/pg @types/react @types/react-dom react react-dom react-router-dom"
ssh lisahost "cd /opt/lifeos && npm run db:generate && npm run db:migrate"
ssh lisahost "cd /opt/lifeos && npm run create-admin -- <用户名>"

# 3. 构建前端
ssh lisahost "cd /opt/lifeos && node scripts/generate-icons.mjs && npm run build:web"
```

## 运维命令

```bash
sudo systemctl status lifeos-api lifeos-worker
sudo journalctl -u lifeos-api -f
sudo systemctl restart lifeos-api

# 备份与恢复演练
sudo /opt/lifeos/deploy/backup.sh
sudo -u postgres /opt/lifeos/deploy/restore-test.sh

# 重置管理员密码
cd /opt/lifeos && npm run create-admin -- <用户名> --update
```

## 关键约定

- 时间型数据按 UTC 存 `timestamptz`；日期型数据（全天待办、扣费日）存 `date`，不当作 UTC 午夜。
- 金额一律 `numeric`，禁止二进制浮点。
- 预计账单**永不自动**转为已付款，必须人工确认。
- 渠道未配置时 Worker 不消费提醒任务，任务留在 `pending`，不丢失也不伪造送达。
- 密钥只存在于服务器 `/opt/lifeos/.env`，前端构建产物中不得出现。
