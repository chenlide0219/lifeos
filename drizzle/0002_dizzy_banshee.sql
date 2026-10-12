CREATE TABLE "wechat_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_generation" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"from_user_id" text NOT NULL,
	"message_type" integer DEFAULT 1 NOT NULL,
	"text" text NOT NULL,
	"context_token_enc" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_time" timestamp with time zone,
	"parse_basis_at" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"leased_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"operation_id" uuid,
	"processed_at" timestamp with time zone,
	"purge_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wechat_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_generation" uuid NOT NULL,
	"kind" varchar(16) DEFAULT 'create' NOT NULL,
	"draft_kind" varchar(16),
	"status" varchar(16) DEFAULT 'awaiting_fields' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"short_code" varchar(16),
	"draft" jsonb,
	"missing_fields" jsonb,
	"source_inbox_id" uuid,
	"idempotency_key" text NOT NULL,
	"preview_revision" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"result_subject_type" varchar(16),
	"result_subject_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wechat_operations_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "wechat_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_generation" uuid NOT NULL,
	"operation_id" uuid,
	"source_inbox_id" uuid,
	"operation_version" integer,
	"reply_type" varchar(16) NOT NULL,
	"body" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"leased_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"failure_kind" varchar(16),
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone,
	CONSTRAINT "wechat_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_inbox_msg_uq" ON "wechat_inbox" USING btree ("binding_generation","provider_message_id");--> statement-breakpoint
CREATE INDEX "wechat_inbox_claim_idx" ON "wechat_inbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "wechat_inbox_purge_idx" ON "wechat_inbox" USING btree ("purge_after");--> statement-breakpoint
CREATE UNIQUE INDEX "wechat_operations_active_uq" ON "wechat_operations" USING btree ("binding_generation") WHERE status in ('awaiting_fields','pending_confirm','committing');--> statement-breakpoint
CREATE INDEX "wechat_operations_gen_idx" ON "wechat_operations" USING btree ("binding_generation","created_at");--> statement-breakpoint
CREATE INDEX "wechat_operations_recent_idx" ON "wechat_operations" USING btree ("binding_generation","status","updated_at");--> statement-breakpoint
CREATE INDEX "wechat_outbox_claim_idx" ON "wechat_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "wechat_outbox_gen_idx" ON "wechat_outbox" USING btree ("binding_generation");--> statement-breakpoint
CREATE INDEX "wechat_outbox_purge_idx" ON "wechat_outbox" USING btree ("purge_after");