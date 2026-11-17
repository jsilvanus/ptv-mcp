-- A proposal is `applying` while its approved change is being written to PTV,
-- so two resolutions cannot both write.
ALTER TYPE "public"."proposal_status" ADD VALUE 'applying';
