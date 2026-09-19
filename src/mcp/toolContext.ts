import type { PtvEnvironment } from '../ptv/adapter.js';

/**
 * Read tools may omit tenantId when they are using PTV v11's public OUT
 * interface. If tenantId is present, it identifies the tenant/integration
 * whose PTV configuration is being used; it does NOT limit which public
 * PTV organisation may be queried.
 */
export interface ToolContext {
  tenantId: string;
  environment: PtvEnvironment;
  readApiVersion: string;
  writeApiVersion: string;
  actingUserId: string;
}
