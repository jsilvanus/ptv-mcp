-- Proposals can change a connection's extra info and create or change
-- (sub-)organisations (docs/dvv-in-integration-approval.md).
ALTER TYPE "public"."proposal_kind" ADD VALUE 'connection_update';--> statement-breakpoint
ALTER TYPE "public"."proposal_kind" ADD VALUE 'organisation_update';--> statement-breakpoint
ALTER TYPE "public"."proposal_kind" ADD VALUE 'organisation_create';
