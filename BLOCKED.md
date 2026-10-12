# BLOCKED — 需要外部条件才能完成的项

> 记录具体缺口，不把「本机可达」当作「异机通路已通」，不绕过认证，不新建生产测试管理员。
> 已解除的历史条目保留原文，便于审计与撤回；**当前仍阻塞的项统一收在文末「未决项」**。

## ✅ 已解除：B1 lisahost → cldvps 异机备份通路（2026-10-12）

**当时的缺口**：异机备份要求由 lisahost 的定时任务直接加密上传到 cldvps，
但 lisahost 上无 ssh 配置、无私钥，连主机名都无法解析。

**处置方式**：你在需求里已明确决定"异机目标 = cldvps，由 lisahost 定时任务直接完成加密上传"，
且部署边界包含"必要连接配置"。因此按你的决定建立信任关系，而不是继续记录缺口。

**在 cldvps 上所做的全部改动**（可完整撤回）：

1. 追加了一条受限公钥到 `/root/.ssh/authorized_keys`：
   ```
   no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,no-user-rc      ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAVFRQmLMAa+ATRTtdhTkjCUL4rkkZl7H9Hv518C+cqN lifeos-backup@C20260723239808
   ```
   限制项禁止端口转发、X11、agent 转发、pty 与 user-rc —— 该密钥只能用于文件传输。
2. 创建 `/var/backups/lifeos/{daily,weekly}`（权限 700）。
3. 改动前已备份原文件：`/root/.ssh/authorized_keys.bak-<时间戳>`。

未改动 cldvps 上任何其他文件、服务或用户；未复制任何现有私钥
（用的是 lisahost 上专用生成的新密钥对）。authorized_keys 原 2 条 → 现 3 条。

**在 lisahost 上所做的改动**：新增 `/root/.ssh/config` 的 `cldvps` 主机条目
（使用专用密钥 `lifeos_backup_ed25519`，`IdentitiesOnly yes`），
以及 `/opt/lifeos/.env` 中一行 `BACKUP_OFFSITE=root@cldvps:/var/backups/lifeos`。

**撤回方式**（如需）：
```bash
# cldvps 上删掉那一行授权
sed -i '/lifeos-backup@/d' /root/.ssh/authorized_keys
rm -rf /var/backups/lifeos            # 如也要清掉远端备份
# lisahost 上去掉目标配置
sudo sed -i '/^BACKUP_OFFSITE=/d' /opt/lifeos/.env
```

**验证证据**：
- 加密上传成功并校验大小一致（6247 字节），远端文件权限 600；
- **灾难恢复演练通过**：从 cldvps 取回备份 → 确认内容为密文（无密钥读不到）
  → 解密恢复 → 14 张表 / 2 条迁移记录 / 1 个管理员 / 3 条设置全部校验通过；
- `deploy/verify.sh` 的自检已从"只检查配置存在"升级为"实际连接远端并确认有可用备份"，
  当前显示：`✅ 异机备份可达，远端已有 N 份`。

---

## ✅ 已解除：B2 独立 iLink 发送凭据（2026-10-12，提交 `4b063bd` / `7ab1950`）

**当时的缺口**：LifeOS 需要**自己**的 iLink 凭据，只能由人工写入
lisahost 的 `/opt/lifeos/.env`（`ILINK_TOKEN` / `ILINK_TO_USER_ID` / `ILINK_CONTEXT_TOKEN`），
而现有桥接的 `account.json` / `context_tokens.json` 属原项目账号状态，按要求不复制，
因此 LifeOS 侧无凭据可用。

**解除方式**：改为**应用内自助扫码绑定**，不再等待人工填写 `.env`。
凭据由你在「设置 → 微信提醒 → 扫码绑定微信」自行取得，不存在"未提供"这一前置阻塞。

- `src/server/routes/wechat.ts`：`get_bot_qrcode` 取码 → 二维码在设置页展示 →
  轮询 `get_qrcode_status`（含 `scaned_but_redirect` 换域与 `need_verifycode` 验证码）→
  拿到 `bot_token` / `ilink_bot_id` / `ilink_user_id` 后写入状态。
  重定向域名经 `trustedIlinkBase()` 白名单校验（仅 `*.weixin.qq.com`、强制 https、禁端口与凭据），
  避免把 token 发往任意地址。
- `src/server/lib/wechat-state.ts`：凭据用 AES-256-GCM 加密后存 `settings.wechat.private-channel`，
  密钥由 `SESSION_SECRET` 派生；该私有状态**不进入业务 JSON 导出**。
- `src/worker/wechat-listener.ts`：独立轮询 `getupdates`，只认绑定用户本人的文本消息；
  游标与去重在同一事务内提交。
- 旧式 `.env` 通道**保留但已非必需**（`src/worker/providers/managed-wechat.ts:12`）：
  扫码账号优先级更高，`.env` 仅作运维备选。二者都未配置时，
  Worker 仍不领取发送任务、不伪造送达——这条不变量未变。

**发送窗口**：`WARN_AT = 8`、`PAUSE_AT = 10`（经验阈值，非微信公布额度）。
每次实际发送请求计数并入账为 unknown，收到明确回执后再修正；第 8 次后另发一条刷新提醒且该提醒也计数；
达 10 次暂停，由你向机器人发新消息或 `/refresh-context` 恢复。该阈值到期后会自行解除，
因此不作为长期阻塞记录。

**已就绪的证据**：协议适配器 13 项判定测试（含「HTTP 200 无成功码 → unknown 不重发」）、
通知链路端到端演练 17 项断言（真实 Worker 进程 + 模拟 iLink 端点）、
线上设置页真实请求可获取二维码、全量 `npm test` 与 `deploy/verify.sh` 通过。

**仍未验证（NOT RUN）**：真实微信扫码、服务端业务接受、**手机实收**。
模拟回执不算真实验收——见下方 D2。

---

# 未决项

## D1：GPG 解密私钥未落到离线介质（运维项，风险最高）

异机加密备份的**解密私钥只有一份在线副本**：
`lisahost:/root/lifeos-backup-keys/lifeos-backup-private.asc`。

这不是代码缺陷，而是单点：lisahost 一旦损毁，cldvps 上所有历史加密备份
**永久无法解密**——备份存在但等于不存在。`deploy/verify.sh` 只能证明"远端有备份"，
无法证明"你还能打开它"。

**解除所需**（需要你本人操作，我不能代做）：把该私钥复制进密码管理器或离线介质，
**不要**把它也放到 cldvps 上（那会让异机备份失去意义）。

**恢复方式**：
```bash
ssh lisahost 'cat /root/lifeos-backup-keys/lifeos-backup-private.asc'
```

## D2：真实微信端到端与手机实收（需你本人观察）

代码侧已无待办。剩下的三个环节**只能由真机和你的眼睛确认**：

1. 在手机上真实扫码并在微信内确认；
2. 向机器人发送一句话，确认服务端取到 `context_token`；
3. 触发一条提醒，**在手机上看到它**。

三者缺一都不能记为通过。发送返回 `business_accepted` 也不等于手机收到——
不能从 HTTP 响应或日志推断送达。

**当前线上状态**：`deploy/verify.sh` 报「微信尚未扫码绑定」，
即第 9 节 `wechat.private-channel.account` 为空。绑定后该提示自动消失，
自检变为 `✅ 微信扫码凭据已绑定`。

## D3：V1.1 微信创建助手的产品细节未冻结（需你拍板）

`Life_OS_V1.1_Wechat_Jev_PRD.md` 第 16.1 节列出 5 项**不得由开发者自行决定**的产品细节，
未确认前相关行为不能实现：

1. 恰好 10/60 分钟时提醒触发点等于当前时间如何处理（不能静默补发）；
2. 无具体时间的待办：允许无提醒保存，还是必须补日期/时刻（需区分"不要提醒"与"忘了说时间"）；
3. 查询默认口径：今日是否含逾期/已完成/无日期/跨天事件；未来七天是否含今天；
4. 草稿 30 分钟有效期如何起算、修改是否续期；正文保留 7 天是否采用；最近操作可查多久；
5. 草稿类型转换（改成待办/事件）时时间、地点、提醒字段的保留范围。

另有一项交付前置：**该 PRD 位于 git 仓库 `lifeos/` 之外**，
尚未纳入版本管理，"仓库 commit 已覆盖此文件"这句目前不成立。
按 PRD 第 14 节，实施前须明确它的存放位置。

---

## 附：本轮文档一致性提醒（非阻塞）

BLOCKED.md 的 B2 曾长期停留在"凭据未提供"，原因是本文件最后一次修改（`c3dd30b`）
早于扫码绑定落地（`4b063bd`、`7ab1950`）。同类旧口径还残留在：

- `README.md:6-10`「微信 iLink 扫码绑定」段之后，未说明 B2 已解除；
- `.env.example:29-43` 仍把 `ILINK_TOKEN` 描述为必填，未提扫码绑定是首选路径。

两处均不影响运行，但会让"未配置"看起来像阻塞。建议随后一并订正。
