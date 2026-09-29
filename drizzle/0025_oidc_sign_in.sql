-- OpenID Connect sign-in (src/oidc/): this app is a Relying Party toward an
-- IdP such as authentik. Accounts created by OIDC sign-in have no password.
-- Not tenant-scoped (like users/refresh_tokens), so no RLS; explicit grants
-- as in 0015.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
CREATE TABLE "oidc_identities" (
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "oidc_identities_issuer_subject_pk" PRIMARY KEY("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "oidc_login_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"code_verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"purpose" text NOT NULL,
	"oauth_request" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_login_states_purpose_check" CHECK ("oidc_login_states"."purpose" IN ('web', 'oauth'))
);
--> statement-breakpoint
CREATE TABLE "oidc_web_handoffs" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oidc_identities" ADD CONSTRAINT "oidc_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_web_handoffs" ADD CONSTRAINT "oidc_web_handoffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oidc_identities_user_idx" ON "oidc_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oidc_login_states_expires_idx" ON "oidc_login_states" USING btree ("expires_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE oidc_identities TO ptv_mcp_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE oidc_login_states TO ptv_mcp_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE oidc_web_handoffs TO ptv_mcp_app;
