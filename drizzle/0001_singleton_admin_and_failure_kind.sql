ALTER TABLE "notification_jobs" ADD COLUMN "failure_kind" varchar(16);--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_singleton_uq" ON "admin_users" USING btree ((true));