#!/usr/bin/env bash
#
# 部署前验证：把**生产库克隆**一份，在克隆上真实执行 0003 + 0004，
# 然后逐项断言"迁移没有丢数据、归属正确、微信绑定原样搬运、约束真的拦得住"。
#
# 安全性：全程只读生产库（pg_dump 读取），所有写操作只发生在 lifeos_migtest。
# 结束时删除克隆库。
set -uo pipefail

TESTDB=lifeos_migtest
PSQL="sudo -n -u postgres psql"
MIGDIR=/tmp/lifeos-mig

pass=0; fail=0
ok()  { printf '  ✅ %s\n' "$*"; pass=$((pass+1)); }
bad() { printf '  ❌ %s\n' "$*" >&2; fail=$((fail+1)); }

cleanup() {
  $PSQL -q -c "DROP DATABASE IF EXISTS $TESTDB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "── 0) 清理可能残留的临时库 ──"
$PSQL -q -c "DROP DATABASE IF EXISTS $TESTDB" >/dev/null 2>&1 || true
ok "临时库名 $TESTDB 可用"

echo
echo "── 1) 克隆生产库（只读生产）──"
sudo -n -u postgres createdb "$TESTDB" || { bad "createdb 失败"; exit 1; }
# 用管道而不是 TEMPLATE，因为生产库上还有 API/Worker 的连接，TEMPLATE 会失败
sudo -n -u postgres bash -c "pg_dump lifeos | psql -q -v ON_ERROR_STOP=1 -d $TESTDB" >/dev/null 2>&1 \
  || { bad "克隆数据失败"; exit 1; }
ok "已克隆 lifeos → $TESTDB"

echo
echo "── 2) 迁移前：记录行数（克隆内建表，避免跨会话丢失）──"
$PSQL -d "$TESTDB" -q -v ON_ERROR_STOP=1 <<'SQL' || { bad "记录迁移前行数失败"; exit 1; }
DROP TABLE IF EXISTS mig_before;
CREATE TABLE mig_before AS
-- 迁移前账号表叫 admin_users（0003 才改名）；这里统一用逻辑名 users 以便前后对比
SELECT 'users' t, count(*) n FROM admin_users
UNION ALL SELECT 'events', count(*) FROM events
UNION ALL SELECT 'tasks', count(*) FROM tasks
UNION ALL SELECT 'subscriptions', count(*) FROM subscriptions
UNION ALL SELECT 'subscription_price_history', count(*) FROM subscription_price_history
UNION ALL SELECT 'expected_bills', count(*) FROM expected_bills
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'csv_import_batches', count(*) FROM csv_import_batches
UNION ALL SELECT 'notification_rules', count(*) FROM notification_rules
UNION ALL SELECT 'notification_jobs', count(*) FROM notification_jobs
UNION ALL SELECT 'notification_attempts', count(*) FROM notification_attempts
UNION ALL SELECT 'wechat_inbox', count(*) FROM wechat_inbox
UNION ALL SELECT 'wechat_operations', count(*) FROM wechat_operations
UNION ALL SELECT 'wechat_outbox', count(*) FROM wechat_outbox
UNION ALL SELECT 'settings', count(*) FROM settings
UNION ALL SELECT 'sessions', count(*) FROM sessions;
SQL
ok "已记录迁移前行数"
$PSQL -d "$TESTDB" -tA -c "SELECT t || '=' || n FROM mig_before ORDER BY t" | sed 's/^/     /'

echo
echo "── 3) 生产库当前的迁移记账（应为 3 条）──"
applied=$($PSQL -d "$TESTDB" -tA -c "SELECT count(*) FROM drizzle.__drizzle_migrations")
echo "     已应用：$applied 条"
[ "$applied" = "3" ] && ok "生产库当前处于 0000-0002（与预期一致）" || bad "记账条数异常：$applied"

echo
echo "── 4) 真实执行 0003（表改名）──"
$PSQL -d "$TESTDB" -q -v ON_ERROR_STOP=1 -f "$MIGDIR/0003.sql" >/dev/null 2>&1 \
  && ok "0003 执行成功" || { bad "0003 执行失败"; $PSQL -d "$TESTDB" -v ON_ERROR_STOP=1 -f "$MIGDIR/0003.sql" 2>&1 | tail -5; exit 1; }

echo
echo "── 5) 真实执行 0004（数据隔离 + 每账号微信绑定）──"
if $PSQL -d "$TESTDB" -q -v ON_ERROR_STOP=1 -f "$MIGDIR/0004.sql" >/tmp/mig0004.log 2>&1; then
  ok "0004 执行成功"
else
  bad "0004 执行失败，输出如下："
  tail -20 /tmp/mig0004.log >&2
  exit 1
fi

echo
echo "── 6) 行数一条不少？──"
$PSQL -d "$TESTDB" -tA <<'SQL' > /tmp/mig_counts.txt
SELECT b.t || '|' || b.n || '|' || a.n || '|' || CASE WHEN b.n = a.n THEN 'OK' ELSE 'MISMATCH' END
FROM mig_before b
JOIN (
  SELECT 'users' t, count(*) n FROM users
  UNION ALL SELECT 'events', count(*) FROM events
  UNION ALL SELECT 'tasks', count(*) FROM tasks
  UNION ALL SELECT 'subscriptions', count(*) FROM subscriptions
  UNION ALL SELECT 'subscription_price_history', count(*) FROM subscription_price_history
  UNION ALL SELECT 'expected_bills', count(*) FROM expected_bills
  UNION ALL SELECT 'payments', count(*) FROM payments
  UNION ALL SELECT 'csv_import_batches', count(*) FROM csv_import_batches
  UNION ALL SELECT 'notification_rules', count(*) FROM notification_rules
  UNION ALL SELECT 'notification_jobs', count(*) FROM notification_jobs
  UNION ALL SELECT 'notification_attempts', count(*) FROM notification_attempts
  UNION ALL SELECT 'wechat_inbox', count(*) FROM wechat_inbox
  UNION ALL SELECT 'wechat_operations', count(*) FROM wechat_operations
  UNION ALL SELECT 'wechat_outbox', count(*) FROM wechat_outbox
  UNION ALL SELECT 'settings', count(*) FROM settings
  UNION ALL SELECT 'sessions', count(*) FROM sessions
) a ON a.t = b.t WHERE b.n <> a.n
SQL
mismatch=$(wc -l < /tmp/mig_counts.txt | tr -d ' ')
if [ "$mismatch" = "0" ]; then ok "16 张表行数全部一致（settings 会因删除旧微信行而减少，见下一步）"; else
  # settings 例外：0004 会删掉旧的全局微信状态行
  non_settings=$(grep -v '^settings|' /tmp/mig_counts.txt | wc -l | tr -d ' ')
  if [ "$non_settings" = "0" ]; then
    ok "除 settings（旧微信状态行被有意删除）外行数全部一致"
    grep '^settings|' /tmp/mig_counts.txt | sed 's/^/     /'
  else
    bad "以下表行数发生变化："; cat /tmp/mig_counts.txt >&2
  fi
fi

echo
echo "── 7) 归属是否全部回填、且指向同一个账号 ──"
orphans=$($PSQL -d "$TESTDB" -tA -c "
  SELECT (SELECT count(*) FROM events WHERE user_id IS NULL)
       + (SELECT count(*) FROM tasks WHERE user_id IS NULL)
       + (SELECT count(*) FROM subscriptions WHERE user_id IS NULL)
       + (SELECT count(*) FROM subscription_price_history WHERE user_id IS NULL)
       + (SELECT count(*) FROM expected_bills WHERE user_id IS NULL)
       + (SELECT count(*) FROM payments WHERE user_id IS NULL)
       + (SELECT count(*) FROM notification_rules WHERE user_id IS NULL)
       + (SELECT count(*) FROM notification_jobs WHERE user_id IS NULL)
       + (SELECT count(*) FROM notification_attempts WHERE user_id IS NULL)
       + (SELECT count(*) FROM wechat_inbox WHERE user_id IS NULL)
       + (SELECT count(*) FROM wechat_operations WHERE user_id IS NULL)
       + (SELECT count(*) FROM wechat_outbox WHERE user_id IS NULL);")
[ "$orphans" = "0" ] && ok "没有任何业务行缺少归属" || bad "有 $orphans 行 user_id 为空"

owners=$($PSQL -d "$TESTDB" -tA -c "SELECT count(DISTINCT user_id) FROM events")
[ "$owners" = "1" ] && ok "存量数据全部归属同一个账号" || bad "存量数据归属了 $owners 个账号"

nouser=$($PSQL -d "$TESTDB" -tA -c "SELECT count(*) FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE u.id IS NULL")
[ "$nouser" = "0" ] && ok "归属全部指向真实存在的账号" || bad "有 $nouser 行指向不存在的账号"

echo
echo "── 8) 微信绑定是否原样搬到 wechat_accounts ──"
acc=$($PSQL -d "$TESTDB" -tA -c "SELECT user_id || '|' || coalesce(cursor,'') || '|' || coalesce(account_enc,'') || '|' || coalesce(context_enc,'') || '|' || used || '|' || warned FROM wechat_accounts")
echo "     克隆中的绑定：$acc"
enc_len=${#acc}
[ "$enc_len" -gt 40 ] && ok "已搬入一份微信绑定（含密文）" || bad "wechat_accounts 里没有绑定数据"
legacy=$($PSQL -d "$TESTDB" -tA -c "SELECT count(*) FROM settings WHERE key = 'wechat.private-channel'")
[ "$legacy" = "0" ] && ok "旧的全局 settings 行已删除" || bad "settings 里仍有 $legacy 行旧微信状态"

echo
echo "── 9) 约束真的拦得住跨账号错配？──"
$PSQL -d "$TESTDB" -q -v ON_ERROR_STOP=1 -c "INSERT INTO users (username, password_hash, is_admin) VALUES ('mig-second', 'x', false)" \
  && ok "已插入用于错配测试的第二个账号" || bad "插入第二个账号失败（后续断言会失去意义）"

sub_n=$($PSQL -d "$TESTDB" -tA -c "SELECT count(*) FROM subscriptions")
sec_id=$($PSQL -d "$TESTDB" -tA -c "SELECT id FROM users WHERE username = 'mig-second'")
echo "     前置条件：订阅 $sub_n 条，测试账号 id=$sec_id"
if [ "$sub_n" = "0" ] || [ -z "$sec_id" ]; then
  bad "前置条件不成立，无法验证复合外键"
else
  set +e
  out=$($PSQL -d "$TESTDB" -tA -c "
    INSERT INTO expected_bills (subscription_id, user_id, planned_date, amount, currency)
    SELECT s.id, u.id, current_date + 99, 1.00, 'CNY'
    FROM subscriptions s CROSS JOIN users u WHERE u.username = 'mig-second' LIMIT 1
  " 2>&1)
  code=$?
  set -e
  if [ $code -ne 0 ] && printf '%s' "$out" | grep -qi 'foreign key'; then
    ok "复合外键拒绝了「账单归 second、订阅归 admin」的错配"
  elif [ $code -ne 0 ]; then
    bad "插入被拒绝了，但不是因为外键（需人工确认）：$out"
  else
    bad "复合外键没有拦住跨账号错配 —— 插入竟然成功了。这是严重缺陷，必须暂停部署"
  fi
  # 反向确认：归属一致时应当能插进去（避免"其实什么都没插进去"造成假通过）
  set +e
  ok_out=$($PSQL -d "$TESTDB" -tA -c "
    INSERT INTO expected_bills (subscription_id, user_id, planned_date, amount, currency)
    SELECT s.id, s.user_id, current_date + 98, 1.00, 'CNY' FROM subscriptions s LIMIT 1
  " 2>&1)
  ok_code=$?
  set -e
  if [ $ok_code -eq 0 ]; then
    ok "归属一致时可以正常插入（说明上一条的拒绝确实来自归属校验）"
    $PSQL -d "$TESTDB" -q -c "DELETE FROM expected_bills WHERE planned_date = current_date + 98" >/dev/null 2>&1
  else
    bad "归属一致时也插不进去，说明约束写错了：$ok_out"
  fi
fi

echo
echo "── 10) 「删除订阅保留付款」的既有语义仍成立？──"
$PSQL -d "$TESTDB" -tA > /tmp/mig_pay.log 2>&1 <<'SQL'
DO $$
DECLARE sub uuid; before_n int; after_n int;
BEGIN
  SELECT id INTO sub FROM subscriptions WHERE id IN (SELECT subscription_id FROM payments WHERE subscription_id IS NOT NULL) LIMIT 1;
  IF sub IS NULL THEN RAISE NOTICE 'SKIP'; RETURN; END IF;
  SELECT count(*) INTO before_n FROM payments;
  DELETE FROM subscriptions WHERE id = sub;
  SELECT count(*) INTO after_n FROM payments;
  IF after_n = before_n THEN RAISE NOTICE 'KEPT %', after_n; ELSE RAISE NOTICE 'LOST % -> %', before_n, after_n; END IF;
END $$;
SQL
if grep -q KEPT /tmp/mig_pay.log; then ok "删除订阅后付款记录仍保留（$(grep -o 'KEPT [0-9]*' /tmp/mig_pay.log)）"; else
  if grep -q SKIP /tmp/mig_pay.log; then ok "（无关联付款，跳过该断言）"; else bad "付款记录被删掉了：$(cat /tmp/mig_pay.log | tr '\n' ' ')"; fi
fi

echo
echo "── 11) 迁移后能否再建第二个账号并存？──"
$PSQL -d "$TESTDB" -tA -c "INSERT INTO users (username, password_hash) VALUES ('mig-third', 'x')" >/dev/null 2>&1 \
  && ok "可以插入第二个账号（单管理员约束已解除）" || bad "无法插入第二个账号"

printf '\n══════════════════════════════════════\n'
printf '克隆库验证结果：%d 通过 / %d 失败\n' "$pass" "$fail"
printf '══════════════════════════════════════\n'
[ "$fail" -eq 0 ]
