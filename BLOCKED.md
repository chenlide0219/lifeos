# BLOCKED — 需要外部条件才能完成的项

> 记录具体缺口，不把「本机可达」当作「异机通路已通」，不绕过认证，不新建生产测试管理员。

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

**遗留提醒**：GPG 解密私钥在 lisahost 的 `/root/lifeos-backup-keys/lifeos-backup-private.asc`，
请复制到你自己的密码管理器或离线介质，**不要**放在 cldvps 上。该私钥丢失 = 异机备份永久无法解密。

---

## B2：iLink 发送凭据未提供（阻塞 A2 的真实发送段）

**缺口**：LifeOS 需要**自己**的 iLink 凭据：

```
ILINK_TOKEN=          # 必填
ILINK_TO_USER_ID=     # 必填，收件人
ILINK_CONTEXT_TOKEN=  # 可留空
ILINK_BASE_URL=https://ilinkai.weixin.qq.com
```

现有桥接的 `account.json` / `context_tokens.json` 属原项目账号状态，按要求**不复制**，
因此 LifeOS 侧无凭据可用。

**已就绪的部分**：

- 协议适配器按真实实现完成（端点、鉴权头、消息体、分片均对齐）；
- 三态判定经 13 项测试验证，含「HTTP 200 无成功码 → unknown 不重发」与「部分接受 → unknown」；
- 配置动态读取：补上凭据后 Worker 下一轮即生效，无需重启；
- 设置页「凭据 / 链路」分开显示，未配置时明确说明不会发送。

**解除所需**：为 LifeOS 提供独立凭据（或明确授权某个专用机器人账号），写入 lisahost 的
`/opt/lifeos/.env`。

**注意**：真实发送与**手机实收**是两件事。即使发送返回 `business_accepted`，
也必须在手机上**由你本人观察确认**才算验收通过，不能从 HTTP 响应或日志推断。
