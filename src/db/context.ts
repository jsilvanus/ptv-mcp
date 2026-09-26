import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/**
 * Every RLS-protected table (drizzle/0001_row_level_security.sql) gates on
 * `app.current_tenant_id` and/or `app.current_user_id`, set per-transaction
 * with `set_config(..., true)` — `SET LOCAL ... = $1` isn't valid Postgres
 * syntax (see EXECUTION_LOG.md's Phase 1 deviation note), and the setting
 * must be scoped to one transaction since connections are pooled and
 * reused across unrelated requests. This is the one place application code
 * should set that context — callers never write `set_config` themselves.
 */
export interface RequestContext {
  tenantId?: string;
  userId?: string;
}

export type TransactionalDb = Parameters<Parameters<Database['transaction']>[0]>[0];

export async function withContext<T>(
  db: Database,
  context: RequestContext,
  fn: (tx: TransactionalDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const settings = [
      context.tenantId !== undefined
        ? sql`set_config('app.current_tenant_id', ${context.tenantId}, true)`
        : undefined,
      context.userId !== undefined
        ? sql`set_config('app.current_user_id', ${context.userId}, true)`
        : undefined,
    ].filter((setting) => setting !== undefined);
    if (settings.length > 0) {
      await tx.execute(sql`SELECT ${sql.join(settings, sql`, `)}`);
    }
    return fn(tx);
  });
}
