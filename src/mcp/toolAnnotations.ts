import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

interface ToolMetadata {
  /** Display name for MCP clients, in Finnish like the web UI. */
  title: string;
  annotations: ToolAnnotations;
}

/** Reads nothing but the MCP's own database. */
const LOCAL_READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Reads PTV. */
const PTV_READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
/** Changes only the MCP's own proposal queue or review campaigns, never PTV. */
const QUEUE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
/** As QUEUE_WRITE, but reads PTV to do it (e.g. the current state for a diff). */
const QUEUE_WRITE_READING_PTV: ToolAnnotations = { ...QUEUE_WRITE, openWorldHint: true };
/** Can write to PTV: clients should ask the human before calling. */
const PTV_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Titles and behaviour hints for every tool, in one place. Clients group
 * tools by `readOnlyHint` and may ask for confirmation before tools with
 * `destructiveHint`, which backs up the human-approval rule for PTV writes.
 */
export const TOOL_METADATA: Record<string, ToolMetadata> = {
  ptv_get_guide: { title: 'Lue ohje', annotations: LOCAL_READ },

  ptv_search_services: { title: 'Hae palveluita', annotations: PTV_READ },
  ptv_get_service: { title: 'Näytä palvelu', annotations: PTV_READ },
  ptv_search_channels: { title: 'Hae asiointikanavia', annotations: PTV_READ },
  ptv_get_channel: { title: 'Näytä asiointikanava', annotations: PTV_READ },
  ptv_search_organisations: { title: 'Hae organisaatioita', annotations: PTV_READ },
  ptv_find_organisation_and_children: {
    title: 'Hae organisaatio ja alaorganisaatiot',
    annotations: PTV_READ,
  },
  ptv_get_organisation: { title: 'Näytä organisaatio', annotations: PTV_READ },
  ptv_get_organisation_hierarchy: { title: 'Näytä organisaatiohierarkia', annotations: PTV_READ },
  ptv_search_service_collections: { title: 'Hae palvelukokonaisuuksia', annotations: PTV_READ },
  ptv_search_general_descriptions: { title: 'Hae pohjakuvauksia', annotations: PTV_READ },
  ptv_search_connections: { title: 'Hae palvelun ja kanavan liitoksia', annotations: PTV_READ },
  ptv_search_ontology_terms: { title: 'Hae ontologiakäsitteitä', annotations: PTV_READ },
  ptv_list_codes: { title: 'Listaa koodisto', annotations: PTV_READ },
  ptv_check_quality: { title: 'Tarkista sisällön laatu', annotations: PTV_READ },

  ptv_propose_changes: { title: 'Ehdota palvelun muutoksia', annotations: QUEUE_WRITE_READING_PTV },
  ptv_propose_new_service: { title: 'Ehdota uutta palvelua', annotations: QUEUE_WRITE },
  ptv_propose_channel_changes: {
    title: 'Ehdota asiointikanavan muutoksia',
    annotations: QUEUE_WRITE_READING_PTV,
  },
  ptv_propose_connection_changes: {
    title: 'Ehdota liitoksen lisätietojen muutoksia',
    annotations: QUEUE_WRITE_READING_PTV,
  },
  ptv_propose_new_channel: { title: 'Ehdota uutta asiointikanavaa', annotations: QUEUE_WRITE },
  ptv_list_proposals: { title: 'Listaa muutosehdotukset', annotations: LOCAL_READ },
  ptv_get_proposal: { title: 'Näytä muutosehdotus', annotations: PTV_READ },
  ptv_comment_proposal: { title: 'Kommentoi muutosehdotusta', annotations: QUEUE_WRITE },
  ptv_request_review: { title: 'Pyydä tarkastusta', annotations: QUEUE_WRITE },
  ptv_sign_off_proposal: { title: 'Kuittaa tarkastus', annotations: QUEUE_WRITE },
  ptv_validate_changes: { title: 'Validoi muutokset', annotations: LOCAL_READ },
  ptv_export_for_manual_publish: {
    title: 'Vie käsin julkaistavaksi',
    annotations: QUEUE_WRITE_READING_PTV,
  },
  ptv_confirm_manual_publish: {
    title: 'Kuittaa käsin julkaistuksi',
    annotations: QUEUE_WRITE_READING_PTV,
  },
  ptv_resolve_proposal: { title: 'Hyväksy tai hylkää muutosehdotus', annotations: PTV_WRITE },
  ptv_apply_changes: { title: 'Julkaise muutokset PTV:hen', annotations: PTV_WRITE },

  ptv_my_tasks: { title: 'Omat tehtävät', annotations: LOCAL_READ },
  ptv_review_start_campaign: {
    title: 'Aloita sisällön tarkastuskierros',
    annotations: QUEUE_WRITE_READING_PTV,
  },
  ptv_review_list_campaigns: { title: 'Listaa tarkastuskierrokset', annotations: LOCAL_READ },
  ptv_review_get_campaign: { title: 'Näytä tarkastuskierros', annotations: LOCAL_READ },
  ptv_review_assign: { title: 'Määrää tarkastajat', annotations: QUEUE_WRITE },
  ptv_review_my_items: { title: 'Omat tarkastettavat', annotations: LOCAL_READ },
  ptv_review_get_item: { title: 'Näytä tarkastettava kohde', annotations: PTV_READ },
  ptv_review_complete_item: { title: 'Merkitse kohde tarkastetuksi', annotations: QUEUE_WRITE },
  ptv_review_reopen_item: { title: 'Avaa kohde uudelleen', annotations: QUEUE_WRITE },
  ptv_review_attach_proposal: {
    title: 'Liitä ehdotus tarkastettavaan kohteeseen',
    annotations: QUEUE_WRITE,
  },
  ptv_review_close_campaign: { title: 'Sulje tarkastuskierros', annotations: QUEUE_WRITE },
};

export class MissingToolMetadataError extends Error {
  constructor(name: string) {
    super(`Tool ${name} has no entry in TOOL_METADATA (src/mcp/toolAnnotations.ts)`);
    this.name = 'MissingToolMetadataError';
  }
}

/**
 * Makes every later `server.registerTool` call take its title and
 * annotations from TOOL_METADATA, and refuse a tool that has no entry, so a
 * new tool can't ship without deciding whether it is read-only or writes
 * to PTV. Call before registering any tools.
 */
export function useToolMetadata(server: McpServer): void {
  const register = server.registerTool.bind(server) as (
    name: string,
    config: Record<string, unknown>,
    callback: unknown,
  ) => ReturnType<McpServer['registerTool']>;
  server.registerTool = ((name: string, config: Record<string, unknown>, callback: unknown) => {
    const metadata = TOOL_METADATA[name];
    if (!metadata) throw new MissingToolMetadataError(name);
    return register(
      name,
      { ...config, title: metadata.title, annotations: metadata.annotations },
      callback,
    );
  }) as McpServer['registerTool'];
}
