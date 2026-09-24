-- What a proposal does (see proposalKindEnum in src/db/schema/enums.ts).
-- Existing rows are service updates, the only kind there was.
CREATE TYPE "public"."proposal_kind" AS ENUM('service_update', 'service_create', 'channel_update');--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "kind" "proposal_kind" DEFAULT 'service_update' NOT NULL;
