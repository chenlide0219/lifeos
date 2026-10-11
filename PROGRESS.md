# PROGRESS — Life OS 返工轮次（修复验收报告 A1–A8）

- 轮次目标：修复 A1–A8，完成既有微信通道适配与异机加密备份，交付可独立复验的结果。
- 基线：`b5446c4`（57 跟踪文件）。本轮**不**宣称 V1 完成，**不**扩展阶段 2–4 业务。
- 证据纪律：每条验收附真实复验输出与反向失败证据；无外部证据项标 NOT RUN。

## 开工前核对结果（2026-10-11 复核）

| 项 | 结果 |
|---|---|
| git | HEAD `b5446c4`，工作树干净，57 跟踪文件 |
| `drizzle/` 迁移、`package-lock.json` | **未入库** → A4 成立 |
| `npm run dev:web` | **不存在** → A4 成立 |
| lisahost 服务 | lifeos-api/worker active；kaoyan inactive（未启停、未改自启） |
| 生产库 | 14 表、1 管理员、events/tasks/notification_jobs 均 0 |
| 备份权限 | 目录 755、文件 644 → A8 成立 |
| `/opt/lifeos` | **非 git 仓库** → 已自建回滚锚点 `/var/backups/lifeos-rollback/` |
| cldvps | 本机可达；29G 空闲；gpg+rsync 有，rclone 无 |
| lisahost → cldvps | **无通路** → A8 异机段阻塞（见 BLOCKED.md B1） |
| iLink 从 lisahost | 可达：HTTP 200，DNS 0.007s，总 0.68s |

## 复用实现记录（只读审查，未改动原项目）

| 项目 | 版本 | 许可证 | 提交 |
|---|---|---|---|
| MultiHarnessWechatNotifier | 0.1.0（Python 包 `multiharness-notify`） | **Proprietary** | `ef53993` |
| codex-wechat-handoff | `codex-wechat-ilink.ts`（5945 行） | **MIT** | `8fd2a0a` |

复用协议：`POST {baseUrl}/ilink/bot/sendmessage`，头 `Authorization: Bearer <token>` +
`AuthorizationType: ilink_bot_token` + `X-WECHAT-UIN`；体 `{msg:{to_user_id,client_id,message_type:2,
message_state:2,item_list:[{type:1,text_item:{text}}],context_token},base_info:{channel_version}}`；
回执按 `ret/errcode/message_id` 判定，HTTP 200 不足为成功凭据。

**为什么在 LifeOS 内重新实现而不是调用原 CLI**：原 CLI 深度绑定 bun（`#!/usr/bin/env bun`、
`Bun.spawn`、`Bun.argv`）且状态目录在 Windows，调用它等于要求"Windows 常开"或整体迁移 Harness，
均被明确禁止。发送本体只是一次 HTTPS POST，故按同一协议在 Linux 原生实现。
**凭据独立**：使用 LifeOS 自己的 `ILINK_*`，不读取、不复制原项目 `account.json` / `context_tokens.json`。

## 逐项状态

| 项 | 内容 | 状态 | 关键证据 |
|---|---|---|---|
| A1 | Worker 返回旧 attempts / 退避与上限错位 | **PASS** | 退避 60s→300s→900s，第 3 次耗尽，下游调用恰好 3 次；反向注入旧行为后测试失败 |
| A2 | iLink 真实协议适配，三态判定 | **PASS（模拟回执）／真实发送 NOT RUN** | 13 项判定测试（含"HTTP 200 无成功码 → unknown 不重发"）；反向注入"200 即成功"后测试失败。真实发送需凭据（B2） |
| A3 | 恢复演练假通过 + 加密备份恢复 | **PASS** | 错误 SQL → 退出码 4 且不打印"通过"；真实生产加密备份解密恢复通过（14 表/2 迁移/1 管理员/3 设置） |
| A4 | 迁移 SQL、package-lock 入库；修 dev:web | **PASS** | 空库迁移、重复迁移幂等、既有库升级保数据；线上自检比对迁移哈希一致 |
| A5 | no-store 中间件位置 | **PASS** | 200/401/404 全部带 `no-store, no-cache, must-revalidate` + `Pragma` + `Expires: 0` |
| A6 | 拒绝第二个管理员 | **PASS** | CLI 10 项测试 + 数据库常量表达式唯一索引兜底；线上管理员数仍为 1 |
| A7 | 未配置/错过策略与可查询记录 | **PASS（策略与接口）／线上联动 NOT RUN** | 未配置不领取、超阈值标 missed 并写明原因、渠道恢复可发送；「设置 → 通知记录」可查 |
| A8 | 异机加密备份 | **本地加密 PASS／异机段 NOT RUN（B1）** | 强制加密、目录 700、文件 600、轮转 7/4、失败非零退出且不删最后副本、加密取回恢复通过 |

## 复验证据

### 全量回归（`npm test`）

```
# tests 44   # pass 44   # fail 0   # skipped 0   # todo 0
A8 结果：13 通过 / 0 失败
A3 结果：7 通过 / 0 失败
✅ 全部验证通过
```

套件包含 10 个 suite：A6 单管理员不变量、A2 iLink 三态判定、A4 迁移可重建性、
A1 退避与上限纯函数语义、A1 首败/耗尽/不出现第 4 次调用、A2 Worker 侧不重发、
A1 租约回收、A1 并发领取不重复、A7 未配置/错过/恢复、退出策略。

### 反向验证（把修复点改回旧缺陷行为，确认测试会失败）

| 注入 | 结果 |
|---|---|
| `core.ts` 改回"返回旧 attempts" | A1 测试失败；日志出现旧症状「第 0/3 次」 |
| `ilink.ts` 改回"HTTP 200 即成功" | A2 测试失败 |

两个文件随后按哈希精确还原（`core=619c121956befdea…`、`ilink=81a4643106cf41bc…`）。

### 线上自检（`sudo bash deploy/verify.sh`）

```
线上自检结果：31 通过 / 0 失败 / 2 提示
```

2 条提示即 B1（未配置异机目标）与 B2（未配置 iLink 凭据）。

## 本轮额外发现并修复的缺陷（验证过程中暴露）

1. **状态不一致**：任务判定耗尽/成功后仍残留 `next_attempt_at`，界面会显示"下次重试"。已清空。
2. **交付完整性（严重）**：首次部署时用仓库覆盖了服务器 `drizzle/meta/_journal.json`，
   冲掉了 0001 的日志条目 —— 生产库因先迁移而幸免，但**干净检出只能应用 0000，
   重建不出 `failure_kind` 与单管理员索引**。已重建 journal 条目（`when` 与生产库记录一致）
   并把 0001 的 SQL 与 snapshot 纳入仓库；`verify.sh` 现在会比对哈希，不一致即报错。
3. **运维陷阱**：备份按 A8 收紧为 700/600 后，以 postgres 身份运行恢复演练**读不到自己的备份**。
   已改为以 root 运行，并把"读不到"与"不存在"的报错区分开。

## 未完成 / 边界（不得宣称已通过）

- 阶段 3–4：语音录入与订阅财务均未实现。
- 真实微信收取：缺凭据（B2），且手机实收必须由本人观察，**NOT RUN**。
- 异机加密备份的真实跨主机上传：缺通路（B1），**NOT RUN**。
- 定时任务是否真的每天 03:30 触发：cron 已配置，尚无跨日触发日志，**未验证**。
- 跨设备 / 手机 PWA 安装：**NOT RUN**。

---

# 阶段 2：日程核心（已完成）

交付内容：Event / Task 的完整 CRUD、统一日历聚合读视图、文本新增与编辑、
事项变更时的通知重调度。

## 逐项状态

| 项 | 状态 | 关键证据 |
|---|---|---|
| 事件 CRUD（创建/修改/取消/删除） | **PASS** | API 集成测试 21 项；UI 实机创建成功 |
| 待办 CRUD（含完成/重开/取消） | **PASS** | 四视图筛选与计数接口均有测试 |
| 统一日历聚合（事件+待办，类型着色与筛选） | **PASS** | 真实浏览器渲染确认；聚合是读视图，不复制成 Event |
| 文本新增与编辑（含提醒预设 60/10 分钟） | **PASS** | UI 实机操作截图确认 |
| 修改时间 → 旧提醒失效并重建 | **PASS** | 16 项调度测试 + API 层测试 |
| 取消/删除 → 停止未发送提醒、保留已发送历史 | **PASS** | 逐条断言，含"已发送绝不被复活" |
| 创建时已过去的提醒不补发 | **PASS** | `skippedPast` 计数并回显到界面 |
| 无具体时刻的待办不得精确提醒 | **PASS** | 服务端返回 400；调度层不排提醒 |

## 端到端实机验证（PRD 验收示例）

在隔离环境（测试库 + 临时实例 + SSH 隧道，**全程未使用生产密码**）用真实浏览器操作：

界面创建「课题组会议」，开始时间 2026-10-14 15:00，提前 60/10 分钟提醒。数据库结果：

```
title=课题组会议  start_at=2026-10-14 07:00:00+00 (=15:00 CST)  location=科研楼 302  status=active
fire_at=2026-10-14 06:00:00+00 (=14:00 CST)  status=pending   offsets=[60,10]
fire_at=2026-10-14 06:50:00+00 (=14:50 CST)  status=pending   offsets=[60,10]
```

与 PRD FR-03 的验收用例完全一致（事件 15:00 + 14:00/14:50 两条提醒），
差别仅在于本次是**文本**录入，语音链路属阶段 3。

## 阶段 2 验证中发现并修复的缺陷

1. **待办列表 500**：`asc(sql\`... NULLS LAST\`)` 生成 `NULLS LAST asc` 的非法顺序，
   导致待办页（最常用接口）报 SQL 语法错误。方向与 NULLS 位置必须写在同一个 sql 片段里。
2. **提醒静默丢失（严重）**：重调度原先"先取消旧任务、再插入同键任务"，
   插入被幂等键唯一约束挡住 → 提醒凭空消失。改为差量处理：
   计划内的提醒**原地复活**，计划外的才取消，**已发送的绝不复活**（避免重复送达）。
3. 测试自身缺陷：`jobsOf()` 未 select `attempts` 列导致断言拿到 undefined。

## 阶段 2 复验命令

```bash
npm test                              # 83 项，0 失败 0 跳过
sudo bash deploy/verify.sh            # 线上 31 项自检
```

关于 `npm test` 的隔离性：测试库名必须以 `_test` 结尾（硬性守卫，防止误伤生产库）；
管理员账号由测试自行创建，不涉及生产凭据。

## 回滚（阶段 2）

阶段 2 未新增数据库迁移，回滚只需还原源码：
`sudo tar xzf /var/backups/lifeos-rollback/pre-rework-<TS>.tar.gz -C /opt` 后重启服务。


## 回滚

- 改动前锚点：`/var/backups/lifeos-rollback/pre-rework-<时间戳>.tar.gz`（含源码、.env、
  systemd 单元、nginx 配置；目录 700、文件 600）。
- 还原源码：`sudo tar xzf /var/backups/lifeos-rollback/pre-rework-<TS>.tar.gz -C /opt`
- 还原服务配置：`sudo cp /var/backups/lifeos-rollback/lifeos-api.service.<TS> /etc/systemd/system/`
  （worker 与 nginx 同理），随后 `daemon-reload && restart`。
- 数据库回滚：迁移 0001 仅新增一列与一个索引（附加性），本次备份
  `/var/backups/lifeos/daily/lifeos-<日期>.sql.gz.gpg` 可用于整库还原。
- 变更前源码校验和：`0c96a6ca7397f6040a0080dd40f694c8b4239e750a91483a7dffd16abad41d3f`

---

# 阶段 3：语音录入（已完成，真实微信链路除外）

## 逐项状态

| 项 | 状态 | 关键证据 |
|---|---|---|
| 麦克风录音 + 授权失败可恢复 | **PASS** | 权限被拒时明确提示并引导手动录入 |
| 音频转 WAV 并限制长度/大小 | **PASS** | 浏览器端 Web Audio 重采样 16kHz 单声道；上限 120 秒 / 8MB，超限 413 |
| MiMo ASR 集成 | **PASS（链路）／真实语音 NOT RUN** | 真实调用返回文本；测试音频为纯音调，非真实语音 |
| 转写文字可人工修改后重新解析 | **PASS** | 界面提供可编辑转写框 + 重新解析 |
| DeepSeek 结构化草稿 | **PASS** | 真实模型对 PRD 例句返回 kind/title/地点/提醒 [60,10] |
| 含糊时间不擅自补全 | **PASS** | 服务端强制：缺时间自动追加 ambiguities；界面必填校验 |
| 确认前不落库、不建通知任务 | **PASS** | 测试断言解析后 events/notification_jobs 均为 0 |
| 失败可恢复且不产生半成品 | **PASS** | 未配置 503 / 上游失败 502，均标 recoverable |
| AI 调用限流 | **PASS** | 每 IP 每小时 60 次 |

## 与 PRD 的刻意偏离（需知悉）

1. **音频转码放在浏览器端**，而非 PRD 建议的服务端转码：服务器无 ffmpeg，
   在 1GB 内存的机器上安装整套多媒体工具链不划算。浏览器用 Web Audio 解码后
   重采样为 16kHz 单声道 16bit WAV，正是 MiMo 接受的格式。
   PRD 的真实要求（送入 MiMo 的必须是 WAV/MP3、原始音频不永久保留）仍然满足——
   音频从不写入磁盘，只在进程内存中处理。

2. **"下周三"的周界约定存在解释分歧（需用户确认）**：真实模型把它解析为 2026-10-21，
   而 PRD 验收用例写的是 2026-10-14。今天是周日，"下周"按标准中文习惯指下一整周。
   当前保留模型理解，且草稿可编辑。**这个约定需要你定一个标准**，我可以据此在
   system prompt 里写死规则。

## 阶段 3 验证中发现并修复的缺陷

1. **时区偏移符号反了**：`formatWithOffset` 对 Asia/Shanghai 输出 `-08:00`，
   会让模型按错误偏移换算相对日期。已修正为 `+08:00`。
2. **413 分支不可达**：音频大小校验前先过了带长度上限的字符串校验，超大音频走 400；
   已调整校验顺序，413 现在可达。

## 复验命令

```bash
npm test                    # 101 项，0 失败 0 跳过
curl -s https://life.o2lin1.com/api/voice/status   # 未登录应 401
```

## 尚未验证的部分

- **真实语音转写**：需要你用手机或电脑实际说一句话走一遍。测试音频是纯音调，
  只能证明集成通路可用，不能证明真实识别质量。
- **真实微信提醒送达**：仍待 B2 凭据 + 你手机观察确认。
