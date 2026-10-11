# BLOCKED — 需要外部条件才能完成的项

> 记录具体缺口，不把「本机可达」当作「异机通路已通」，不绕过认证，不新建生产测试管理员。

## B1：lisahost → cldvps 无任何通路（阻塞 A8 的异机段）

**缺口**：异机备份要求由 lisahost 的定时任务直接加密上传到 cldvps，但 lisahost 上：

- 无 `~/.ssh/config`，无任何私钥（仅 `authorized_keys`）；
- 无法解析主机名 `cldvps`（`Temporary failure in name resolution`）。

本机能连 cldvps（29G 空闲、有 gpg/rsync），但「本机 SSH 成功」不等于「异机备份已通」，
且用户明确要求不依赖本人电脑在线。

**已就绪的部分**（不依赖该通路，已实现并验证）：

- 加密备份、本地 7 日/4 周轮转、权限 700/600；
- 失败可见且非零退出；失败**不删除**最后一份可恢复副本；
- 远端轮转只匹配 `lifeos-*.sql.gz.gpg`，不影响目标目录中的其他文件；
- 上传后比对远端与本地文件大小，不一致即判失败。

**解除所需**（一次性，需你确认后执行）：

lisahost 上已生成专用 SSH 密钥（仅本机，未复制任何现有私钥）：

```
/root/.ssh/lifeos_backup_ed25519.pub
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAVFRQmLMAa+ATRTtdhTkjCUL4rkkZl7H9Hv518C+cqN lifeos-backup@C20260723239808
```

在 cldvps 上执行（最小权限：禁转发、禁 pty）：

```bash
install -d -m 700 /var/backups/lifeos/daily /var/backups/lifeos/weekly
echo 'no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAVFRQmLMAa+ATRTtdhTkjCUL4rkkZl7H9Hv518C+cqN lifeos-backup@C20260723239808' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

然后在 lisahost 的 `/opt/lifeos/.env` 补一行，即自动生效、无需重启：

```
BACKUP_OFFSITE=root@<cldvps 地址>:/var/backups/lifeos
```

**注意**：GPG 解密私钥在 `/root/lifeos-backup-keys/lifeos-backup-private.asc`，
请复制到你自己的密码管理器或离线介质，**不要**放在 cldvps 上。
该私钥丢失 = 异机备份永久无法解密。

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
