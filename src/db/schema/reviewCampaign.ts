import { date, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import {
  ptvEnvironmentEnum,
  reviewCampaignStatusEnum,
  reviewItemStatusEnum,
  reviewTargetKindEnum,
} from './enums.js';
import { tenants } from './tenant.js';
import { users } from './user.js';

/**
 * A full check of an organisation's PTV content (docs/review-campaigns-plan.md):
 * a Publisher+ starts it, every service, channel and organisation becomes a
 * review item, and reviewers confirm each one or propose changes.
 */
export const reviewCampaigns = pgTable('review_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  environment: ptvEnvironmentEnum('environment').notNull(),
  name: text('name').notNull(),
  /** The PTV organisation the campaign covers, with its sub-organisations. */
  organizationId: text('organization_id').notNull(),
  status: reviewCampaignStatusEnum('status').notNull().default('open'),
  dueDate: date('due_date'),
  createdByUserId: uuid('created_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  correlationId: uuid('correlation_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

/** One service, channel or organisation to check within a campaign. */
export const reviewItems = pgTable(
  'review_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => reviewCampaigns.id, { onDelete: 'cascade' }),
    targetKind: reviewTargetKindEnum('target_kind').notNull(),
    /** PTV id of the service, channel or organisation. */
    targetId: text('target_id').notNull(),
    /** Name when the campaign started, for lists (fi, else any language). */
    targetName: text('target_name').notNull(),
    /** Channel type for channels (EChannel, Phone, …), else null. */
    channelType: text('channel_type'),
    /** The (sub-)organisation that owns the target. */
    organizationId: text('organization_id').notNull(),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: reviewItemStatusEnum('status').notNull().default('open'),
    /** Automated quality check (src/quality/contentChecks.ts) when the campaign started. */
    findings: jsonb('findings').notNull().default([]),
    note: text('note'),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('review_items_campaign_target_unique').on(
      table.campaignId,
      table.targetKind,
      table.targetId,
    ),
    index('review_items_assignee_idx').on(table.tenantId, table.assigneeUserId, table.status),
  ],
);
