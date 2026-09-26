import { z } from 'zod';
import type { PtvAdapterRegistry } from '../../ptv/registry.js';
import type { SearchParams } from '../../ptv/domain.js';
import * as searchTools from '../searchTools.js';
import { readToolContext, type RegisterTool } from './shared.js';

const pageSchema = z.number().int().min(1).optional();
const pageSizeSchema = z.number().int().min(1).max(1000).optional();

const publicReadSearchParamsSchema = {
  query: z
    .string()
    .optional()
    .describe('Optional PTV text search. Omit it to browse using the other filters.'),
  organizationId: z
    .string()
    .uuid()
    .optional()
    .describe('Optional PTV organisation filter. This is not the OAuth tenant.'),
  page: pageSchema,
  pageSize: pageSizeSchema,
};
const publicReadGetByIdSchema = {
  id: z.string(),
};

/** `exactOptionalPropertyTypes` means an explicit `page: undefined` doesn't satisfy `page?: number` — omit the key entirely instead. */
function searchParams(args: {
  query?: string | undefined;
  organizationId?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}): SearchParams {
  return {
    ...(args.query !== undefined ? { query: args.query } : {}),
    ...(args.organizationId !== undefined ? { organizationId: args.organizationId } : {}),
    ...(args.page !== undefined ? { page: args.page } : {}),
    ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
  };
}

/** The published-data read tools; they also work on a public connection without a tenant. */
export function registerReadTools(tool: RegisterTool, registry: PtvAdapterRegistry): void {
  tool(
    'ptv_search_services',
    {
      description:
        'Search published PTV services. The OAuth-selected PTV connection determines tenant, environment, read API version and write API version; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    },
    (args, extra) =>
      searchTools.searchServices(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_get_service',
    {
      description:
        'Fetch one published PTV service by id. The PTV tenant, environment, read API version and write API version are selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) => searchTools.getService(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_search_channels',
    {
      description:
        'Search published PTV service channels. The OAuth-selected tenant determines which PTV integration/API key is used; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    },
    (args, extra) =>
      searchTools.searchChannels(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_get_channel',
    {
      description:
        'Fetch one published PTV service channel by id. The organisation context is selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) => searchTools.getChannel(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_search_organisations',
    {
      description: 'Search published PTV organisations. Query searches organisation names.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Optional text search in PTV organisation names. Omit it to browse organisations.',
          ),
        page: pageSchema,
        pageSize: pageSizeSchema,
      },
    },
    (args, extra) =>
      searchTools.searchOrganisations(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_find_organisation_and_children',
    {
      description:
        'Find a PTV organisation by name/text and return that organisation together with its published services and service channels. This is a compound convenience operation; use the individual search tools when you need independent searches.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Organisation name or text, for example "Riihimäen seurakunta".'),
      },
    },
    (args, extra) =>
      searchTools.findOrganisationAndChildren(registry, readToolContext(extra), args.query),
  );

  tool(
    'ptv_get_organisation',
    {
      description:
        'Fetch one published PTV organisation by id. The PTV tenant, environment, read API version and write API version are selected during OAuth authorization. The tenant does not limit which PTV organisation may be queried.',
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) => searchTools.getOrganisation(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_get_organisation_hierarchy',
    {
      description:
        'Fetch a published PTV organisation and every ancestor up to its root. The organisation context is selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) =>
      searchTools.getOrganisationHierarchy(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_search_service_collections',
    {
      description:
        'Search published PTV service collections. The OAuth-selected tenant determines which PTV integration/API key is used; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    },
    (args, extra) =>
      searchTools.searchServiceCollections(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_search_general_descriptions',
    {
      description:
        'Search published PTV general descriptions. The OAuth-selected tenant determines which PTV integration/API key is used; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    },
    (args, extra) =>
      searchTools.searchGeneralDescriptions(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_search_connections',
    {
      description:
        "List a service's or channel's connections (give the service or channel id), with each connection's extra info (charge type, descriptions, service hours, contact details). Published data.",
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) => searchTools.searchConnections(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_search_ontology_terms',
    {
      description:
        'Search PTV ontology terms (asiasanat) by name, e.g. "kaste" or "rippikoulu". ' +
        'Terms are KOKO concepts, which cover YSO, MAO and other Finto ontologies; each ' +
        "result's `uri` (http://www.yso.fi/onto/koko/p…) is the value a service's " +
        '`ontologyTerms` must use. KOKO numbers differ from YSO numbers, so use these URIs ' +
        'rather than YSO ones. Only valid terms are returned. Requires the v12 read API.',
      inputSchema: {
        query: z.string().min(1).describe('Term name or part of it, e.g. "siunaus".'),
        page: pageSchema,
        pageSize: z.number().int().min(1).max(100).optional(),
      },
    },
    (args, extra) =>
      searchTools.searchOntologyTerms(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_list_codes',
    {
      description: 'List entries in a PTV code list (e.g. "languages", "service-classes").',
      inputSchema: {
        codeListName: z.string(),
      },
    },
    (args, extra) => searchTools.listCodes(registry, readToolContext(extra), args.codeListName),
  );
}
