-- 多用户改造第 1 步：把「单管理员表」改造成通用账号表 admin_users → users。
--
-- ⚠️ 本文件**不能**用 drizzle-kit 的默认输出。
-- 默认输出是 `CREATE TABLE "users"` + `DROP TABLE "admin_users" CASCADE`，
-- 直接执行会删掉唯一的 admin 账号，并级联清空 sessions —— 生产上是数据丢失。
-- 因此改写成 RENAME：既有行、会话归属与审计记录全部原地保留，
-- 终态与 drizzle 生成的 0003_snapshot.json 完全一致（表名/列/约束名/外键名都对得上），
-- 后续 db:generate 不会因为"名字不一致"而再生成多余的迁移。
--
-- 同时解除单管理员不变量：账号仍**只能**由管理界面或 CLI 显式创建，不开放注册。

ALTER TABLE "admin_users" RENAME TO "users";--> statement-breakpoint
ALTER TABLE "users" RENAME CONSTRAINT "admin_users_pkey" TO "users_pkey";--> statement-breakpoint
ALTER TABLE "users" RENAME CONSTRAINT "admin_users_username_unique" TO "users_username_unique";--> statement-breakpoint
ALTER SEQUENCE "admin_users_id_seq" RENAME TO "users_id_seq";--> statement-breakpoint

-- 账号管理相关字段。
-- is_admin 默认 false：新建账号默认**没有**账号管理权限，必须显式授权。
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint

-- 改造前存在的账号就是管理员（当时只有一个，且它就是管理员）。
-- 幂等：空库上影响 0 行，重复执行也不会改变结果。
UPDATE "users" SET "is_admin" = true WHERE "is_admin" = false;--> statement-breakpoint

-- 单管理员不变量在此解除。
DROP INDEX IF EXISTS "admin_users_singleton_uq";--> statement-breakpoint

-- 外键跟随改名：先按旧名删除，再按新名重建，名称与 0003_snapshot.json 一致。
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_user_id_admin_users_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_admin_users_id_fk";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
