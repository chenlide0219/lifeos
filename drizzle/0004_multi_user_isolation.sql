-- 多用户改造第 2 步：业务数据按账号完全隔离，并把全局微信绑定拆成"每账号一份"。
--
-- ⚠️ 本文件不能直接用 drizzle-kit 的默认输出，有两个**会直接执行失败**的问题：
--   1. 默认输出是 `ADD COLUMN "user_id" integer NOT NULL`，在非空表上必然报错
--      （存量数据没有归属）。这里改为「先建可空列 → 按依赖顺序回填 → 再置 NOT NULL」。
--   2. 默认输出把复合外键的引用目标唯一索引排在**外键之后**创建
--      （如 `subscriptions(id, user_id)`），Postgres 会拒绝"引用不存在的唯一约束"。
--      这里把 4 个唯一索引统一提到外键之前。
-- 终态与 drizzle 生成的 0004_snapshot.json 一致，因此后续 db:generate 不会再多生成迁移。
--
-- 回填规则：改造前系统只有一个账号，全部存量数据归它（优先取管理员，其次取最小 id）。

-- ── 0) 前置守卫：有数据却没有任何账号时，立即中止并说清怎么办 ──────────────
-- 不加这条守卫的话，失败会表现为 `null value in column "user_id" violates not-null
-- constraint`，看不出根因，也不知道该做什么。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users LIMIT 1) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM events LIMIT 1)
     OR EXISTS (SELECT 1 FROM tasks LIMIT 1)
     OR EXISTS (SELECT 1 FROM subscriptions LIMIT 1)
     OR EXISTS (SELECT 1 FROM csv_import_batches LIMIT 1)
     OR EXISTS (SELECT 1 FROM wechat_inbox LIMIT 1)
     OR EXISTS (SELECT 1 FROM wechat_operations LIMIT 1)
     OR EXISTS (SELECT 1 FROM wechat_outbox LIMIT 1) THEN
    RAISE EXCEPTION '多用户迁移中止：库中已有业务数据，但 users 表为空，无法确定这些数据属于谁。请先创建账号（npm run create-user -- <用户名>）后重跑迁移；本迁移尚未做任何修改。';
  END IF;
END $$;

-- ── 1) 每个账号一份微信绑定 ────────────────────────────────────────────────
CREATE TABLE "wechat_accounts" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"generation" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"account_enc" text,
	"context_enc" text,
	"cursor" text DEFAULT '' NOT NULL,
	"bound_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone,
	"used" integer DEFAULT 0 NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"unknown" integer DEFAULT 0 NOT NULL,
	"warned" boolean DEFAULT false NOT NULL,
	"warning_result" varchar(16),
	"paused_reason" varchar(32),
	"seen" jsonb,
	"last_inbound_at" timestamp with time zone,
	"listener_at" timestamp with time zone,
	"listener_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── 2) 旧外键先撤掉：它们将被带上 user_id 的复合外键取代 ──────────────────
ALTER TABLE "expected_bills" DROP CONSTRAINT "expected_bills_subscription_id_subscriptions_id_fk";--> statement-breakpoint
ALTER TABLE "notification_attempts" DROP CONSTRAINT "notification_attempts_job_id_notification_jobs_id_fk";--> statement-breakpoint
ALTER TABLE "notification_jobs" DROP CONSTRAINT "notification_jobs_rule_id_notification_rules_id_fk";--> statement-breakpoint
ALTER TABLE "subscription_price_history" DROP CONSTRAINT "subscription_price_history_subscription_id_subscriptions_id_fk";--> statement-breakpoint

-- ── 3) 可空列（先不加约束，否则非空表上无法添加）────────────────────────────
ALTER TABLE "csv_import_batches" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "expected_bills" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "notification_attempts" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "subscription_price_history" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "wechat_inbox" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "wechat_operations" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "wechat_outbox" ADD COLUMN "user_id" integer;--> statement-breakpoint

-- ── 4) 回填归属（顺序即依赖顺序：父表先于子表）─────────────────────────────
-- 4.1 直接归属：改造前只有一个账号，存量数据全部归它
UPDATE "events" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "tasks" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "subscriptions" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "csv_import_batches" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "wechat_inbox" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "wechat_operations" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint
UPDATE "wechat_outbox" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint

-- 4.2 订阅的子表：跟随订阅的归属，绝不能各归各的（复合外键随后会强制这一点）
UPDATE "subscription_price_history" c SET "user_id" = s."user_id" FROM "subscriptions" s WHERE s."id" = c."subscription_id";--> statement-breakpoint
UPDATE "expected_bills" c SET "user_id" = s."user_id" FROM "subscriptions" s WHERE s."id" = c."subscription_id";--> statement-breakpoint
UPDATE "payments" c SET "user_id" = s."user_id" FROM "subscriptions" s WHERE s."id" = c."subscription_id";--> statement-breakpoint
-- 手动记账的付款可能没有订阅，只有预计账单；再退一步才是"无任何关联"
UPDATE "payments" c SET "user_id" = b."user_id" FROM "expected_bills" b WHERE b."id" = c."expected_bill_id" AND c."user_id" IS NULL;--> statement-breakpoint
UPDATE "payments" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint

-- 4.3 提醒规则的主体是多态的（event / task / subscription），按类型分别回填
UPDATE "notification_rules" r SET "user_id" = e."user_id" FROM "events" e WHERE r."subject_type" = 'event' AND e."id" = r."subject_id";--> statement-breakpoint
UPDATE "notification_rules" r SET "user_id" = t."user_id" FROM "tasks" t WHERE r."subject_type" = 'task' AND t."id" = r."subject_id";--> statement-breakpoint
UPDATE "notification_rules" r SET "user_id" = s."user_id" FROM "subscriptions" s WHERE r."subject_type" = 'subscription' AND s."id" = r."subject_id";--> statement-breakpoint
UPDATE "notification_rules" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint

-- 4.4 提醒任务：先跟规则，再（无规则的）跟事项，最后兜底
UPDATE "notification_jobs" j SET "user_id" = r."user_id" FROM "notification_rules" r WHERE r."id" = j."rule_id";--> statement-breakpoint
UPDATE "notification_jobs" j SET "user_id" = e."user_id" FROM "events" e WHERE j."user_id" IS NULL AND j."subject_type" = 'event' AND e."id" = j."subject_id";--> statement-breakpoint
UPDATE "notification_jobs" j SET "user_id" = t."user_id" FROM "tasks" t WHERE j."user_id" IS NULL AND j."subject_type" = 'task' AND t."id" = j."subject_id";--> statement-breakpoint
UPDATE "notification_jobs" j SET "user_id" = s."user_id" FROM "subscriptions" s WHERE j."user_id" IS NULL AND j."subject_type" = 'subscription' AND s."id" = j."subject_id";--> statement-breakpoint
UPDATE "notification_jobs" SET "user_id" = (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint
-- 4.5 发送尝试：必须与所属任务同一个人（复合外键随后强制）。不设兜底：
-- 若这里出现 NULL，说明 job_id 悬空，属于数据损坏，应当让迁移响亮失败而不是猜一个归属。
UPDATE "notification_attempts" a SET "user_id" = j."user_id" FROM "notification_jobs" j WHERE j."id" = a."job_id";--> statement-breakpoint

-- ── 5) 把改造前那行全局微信绑定搬到 wechat_accounts（纯数据搬运，不重新加密）──
-- 迁移是纯 SQL，拿不到 SESSION_SECRET，因此无法原地重新封装密文；
-- 这里保持密文原样，AAD 也仍是全局的（残留风险见 schema.ts 的注释）。
INSERT INTO "wechat_accounts" (
  "user_id", "generation", "revision", "account_enc", "context_enc", "cursor",
  "bound_at", "refreshed_at", "used", "accepted", "failed", "unknown", "warned",
  "warning_result", "paused_reason", "seen", "last_inbound_at", "listener_at", "listener_error"
)
SELECT
  (SELECT id FROM users ORDER BY is_admin DESC, id LIMIT 1),
  COALESCE(NULLIF(value->>'generation', '')::uuid, gen_random_uuid()),
  COALESCE(NULLIF(value->>'revision', '')::uuid, gen_random_uuid()),
  NULLIF(value->>'account', ''),
  NULLIF(value->>'context', ''),
  COALESCE(value->>'cursor', ''),
  CASE WHEN value->>'boundAt' ~ '^[0-9]+$' THEN to_timestamp((value->>'boundAt')::bigint / 1000.0) END,
  CASE WHEN value->>'refreshedAt' ~ '^[0-9]+$' THEN to_timestamp((value->>'refreshedAt')::bigint / 1000.0) END,
  CASE WHEN value->>'used' ~ '^[0-9]+$' THEN (value->>'used')::int ELSE 0 END,
  CASE WHEN value->>'accepted' ~ '^[0-9]+$' THEN (value->>'accepted')::int ELSE 0 END,
  CASE WHEN value->>'failed' ~ '^[0-9]+$' THEN (value->>'failed')::int ELSE 0 END,
  CASE WHEN value->>'unknown' ~ '^[0-9]+$' THEN (value->>'unknown')::int ELSE 0 END,
  COALESCE((value->>'warned')::boolean, false),
  NULLIF(value->>'warningResult', ''),
  NULLIF(value->>'pausedReason', ''),
  COALESCE(value->'seen', '[]'::jsonb),
  CASE WHEN value->>'lastInboundTime' ~ '^[0-9]+$' AND (value->>'lastInboundTime')::bigint > 0
       THEN to_timestamp((value->>'lastInboundTime')::bigint / 1000.0) END,
  CASE WHEN value->>'listenerAt' ~ '^[0-9]+$' THEN to_timestamp((value->>'listenerAt')::bigint / 1000.0) END,
  NULLIF(value->>'listenerError', '')
FROM "settings"
WHERE "key" = 'wechat.private-channel'
  AND coalesce(value->>'account', '') <> ''
  AND EXISTS (SELECT 1 FROM users LIMIT 1)
ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
-- 搬完即删除旧行：避免同一份凭据在两处各留一份（也避免有人以为它还在生效）
DELETE FROM "settings" WHERE "key" = 'wechat.private-channel';--> statement-breakpoint

-- ── 6) 回填完成，才允许置为 NOT NULL ───────────────────────────────────────
ALTER TABLE "csv_import_batches" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "expected_bills" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_attempts" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_jobs" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_rules" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_price_history" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wechat_inbox" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wechat_operations" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wechat_outbox" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint

-- ── 7) 复合外键的引用目标唯一索引：**必须在外键之前**建立 ──────────────────
CREATE UNIQUE INDEX "expected_bills_id_user_uq" ON "expected_bills" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_jobs_id_user_uq" ON "notification_jobs" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_rules_id_user_uq" ON "notification_rules" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_id_user_uq" ON "subscriptions" USING btree ("id","user_id");--> statement-breakpoint

-- ── 8) 外键 ────────────────────────────────────────────────────────────────
ALTER TABLE "wechat_accounts" ADD CONSTRAINT "wechat_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_import_batches" ADD CONSTRAINT "csv_import_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expected_bills" ADD CONSTRAINT "expected_bills_sub_user_fk" FOREIGN KEY ("subscription_id","user_id") REFERENCES "public"."subscriptions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_job_user_fk" FOREIGN KEY ("job_id","user_id") REFERENCES "public"."notification_jobs"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_rule_user_fk" FOREIGN KEY ("rule_id","user_id") REFERENCES "public"."notification_rules"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- payments 的两个复合外键刻意是 NO ACTION：单列外键负责"删除订阅/账单时保留付款记录"，
-- 复合外键只做归属校验。若给它 SET NULL，会把 NOT NULL 的 user_id 一起置空而导致删除失败。
ALTER TABLE "payments" ADD CONSTRAINT "payments_sub_user_fk" FOREIGN KEY ("subscription_id","user_id") REFERENCES "public"."subscriptions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_user_fk" FOREIGN KEY ("expected_bill_id","user_id") REFERENCES "public"."expected_bills"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_price_history" ADD CONSTRAINT "price_history_sub_user_fk" FOREIGN KEY ("subscription_id","user_id") REFERENCES "public"."subscriptions"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_inbox" ADD CONSTRAINT "wechat_inbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_operations" ADD CONSTRAINT "wechat_operations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wechat_outbox" ADD CONSTRAINT "wechat_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── 9) 查询用索引 ──────────────────────────────────────────────────────────
CREATE INDEX "csv_import_batches_user_idx" ON "csv_import_batches" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "events_user_start_idx" ON "events" USING btree ("user_id","start_at");--> statement-breakpoint
CREATE INDEX "notification_jobs_claim_idx" ON "notification_jobs" USING btree ("user_id","status","fire_at");--> statement-breakpoint
CREATE INDEX "notification_rules_user_idx" ON "notification_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_user_paid_idx" ON "payments" USING btree ("user_id","paid_at");--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_user_due_idx" ON "tasks" USING btree ("user_id","due_date");--> statement-breakpoint
CREATE INDEX "wechat_inbox_user_claim_idx" ON "wechat_inbox" USING btree ("user_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "wechat_operations_user_idx" ON "wechat_operations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "wechat_outbox_user_claim_idx" ON "wechat_outbox" USING btree ("user_id","status","next_attempt_at");
