/**
 * PTV v11 Delete Flags Mapping
 *
 * PTV v11's PUT (update) endpoints perform partial updates — omitting a field
 * does NOT clear it. Some fields have explicit companion boolean flags (like
 * `deleteAllLifeEvents: true`) that must be set to actually clear that field.
 * Other fields have NO such flag, making them "full-replace" fields — you must
 * send the complete desired value/list to update them, never just additions.
 *
 * This module provides:
 * 1. Complete mapping of all delete flags per entity type
 * 2. A helper function to look up delete flags
 * 3. Documentation of which fields are full-replace vs delete-flag-gated
 */

/** Entity types that may have delete flags */
export type EntityType =
  | 'Service'
  | 'EChannel'
  | 'Phone'
  | 'PrintableForm'
  | 'ServiceLocation'
  | 'WebPage'
  | 'GeneralDescription'
  | 'ServiceCollection'
  | 'Organization';

/**
 * Maps entity type and field name to the delete flag property name.
 * If a field is not listed, it's a full-replace field with no delete flag.
 */
const deleteFlagMap: Record<EntityType, Record<string, string>> = {
  // SERVICE (V9VmOpenApiServiceInBase)
  // Domain model fields and their delete flags:
  // - names: NO DELETE FLAG (full-replace)
  // - descriptions: NO DELETE FLAG (full-replace)
  // - summaries: NO DELETE FLAG (full-replace)
  // - serviceClasses: NO DELETE FLAG (full-replace)
  // - ontologyTerms: NO DELETE FLAG (full-replace)
  // - targetGroups: NO DELETE FLAG (full-replace)
  // - lifeEvents: deleteAllLifeEvents ✓
  // - industrialClasses: deleteAllIndustrialClasses ✓
  // - languages: NO DELETE FLAG (full-replace)
  // - generalDescriptionId: deleteGeneralDescriptionId ✓
  // - serviceChannelIds: NO DELETE FLAG (full-replace)
  Service: {
    lifeEvents: 'deleteAllLifeEvents',
    industrialClasses: 'deleteAllIndustrialClasses',
    legislation: 'deleteAllLaws',
    keywords: 'deleteAllKeywords',
    serviceChargeType: 'deleteServiceChargeType',
    generalDescriptionId: 'deleteGeneralDescriptionId',
    serviceVouchers: 'deleteAllServiceVouchers',
    areas: 'deleteAllMunicipalities', // Note: 'areas' in domain model, 'municipalities' in PTV
  },

  // ECHANNEL (V11VmOpenApiElectronicChannelInBase)
  // Domain model fields and their delete flags:
  // - names: NO DELETE FLAG (full-replace)
  // - descriptions: NO DELETE FLAG (full-replace)
  // - languages: NO DELETE FLAG (full-replace)
  EChannel: {
    attachments: 'deleteAllAttachments',
    serviceHours: 'deleteAllServiceHours',
    supportEmails: 'deleteAllSupportEmails',
    supportPhones: 'deleteAllSupportPhones',
    webPages: 'deleteAllWebPages',
  },

  // PHONE (V11VmOpenApiPhoneChannelInBase)
  // Domain model fields and their delete flags:
  // - names: NO DELETE FLAG (full-replace)
  // - descriptions: NO DELETE FLAG (full-replace)
  // - languages: NO DELETE FLAG (full-replace)
  Phone: {
    serviceHours: 'deleteAllServiceHours',
    supportEmails: 'deleteAllSupportEmails',
    supportPhones: 'deleteAllSupportPhones',
    webPages: 'deleteAllWebPages',
  },

  // PRINTABLEFORM (V10VmOpenApiPrintableFormChannelInBase)
  // Domain model fields and their delete flags:
  // - names: NO DELETE FLAG (full-replace)
  // - descriptions: NO DELETE FLAG (full-replace)
  // - languages: NO DELETE FLAG (full-replace)
  PrintableForm: {
    attachments: 'deleteAllAttachments',
    channelUrls: 'deleteAllChannelUrls',
    deliveryAddresses: 'deleteAllDeliveryAddresses',
    formIdentifier: 'deleteAllFormIdentifiers',
    serviceHours: 'deleteAllServiceHours',
    supportEmails: 'deleteAllSupportEmails',
    supportPhones: 'deleteAllSupportPhones',
    webPages: 'deleteAllWebPages',
  },

  // SERVICELOCATION (V11VmOpenApiServiceLocationChannelInBase)
  // Domain model fields and their delete flags:
  // - names: NO DELETE FLAG (full-replace)
  // - descriptions: NO DELETE FLAG (full-replace)
  // - languages: NO DELETE FLAG (full-replace)
  ServiceLocation: {
    faxNumbers: 'deleteAllFaxNumbers',
    phoneNumbers: 'deleteAllPhoneNumbers',
    serviceHours: 'deleteAllServiceHours',
    supportEmails: 'deleteAllSupportEmails',
    supportPhones: 'deleteAllSupportPhones',
    webPages: 'deleteAllWebPages',
    oid: 'deleteOid',
  },

  // WEBPAGE (V10VmOpenApiWebPageChannelInBase)
  // Domain model fields and their delete flags:
  // - names: NO DELETE FLAG (full-replace)
  // - descriptions: NO DELETE FLAG (full-replace)
  // - languages: NO DELETE FLAG (full-replace)
  WebPage: {
    serviceHours: 'deleteAllServiceHours',
    supportEmails: 'deleteAllSupportEmails',
    supportPhones: 'deleteAllSupportPhones',
    webPages: 'deleteAllWebPages',
  },

  // GENERALDESCRIPTION (V10VmOpenApiGeneralDescriptionInBase)
  // Domain model fields and their delete flags:
  // - names: NO DELETE FLAG (full-replace)
  // - descriptions: NO DELETE FLAG (full-replace)
  // - serviceClasses: NO DELETE FLAG (full-replace)
  // - ontologyTerms: NO DELETE FLAG (full-replace)
  // - targetGroups: NO DELETE FLAG (full-replace)
  // - lifeEvents: deleteAllLifeEvents ✓
  // - industrialClasses: deleteAllIndustrialClasses ✓
  GeneralDescription: {
    industrialClasses: 'deleteAllIndustrialClasses',
    legislation: 'deleteAllLaws',
    lifeEvents: 'deleteAllLifeEvents',
    serviceChargeType: 'deleteServiceChargeType',
  },

  // SERVICECOLLECTION (V11VmOpenApiServiceCollectionInBase)
  // Domain model fields and their delete flags:
  // - names: NO DELETE FLAG (full-replace)
  // - descriptions: NO DELETE FLAG (full-replace)
  // - serviceIds: deleteAllServices ✓
  ServiceCollection: {
    serviceChannels: 'deleteAllChannels',
    services: 'deleteAllServices',
  },

  // ORGANIZATION (V9VmOpenApiOrganizationInBase)
  // Domain model fields and their delete flags:
  // - names: NO DELETE FLAG (full-replace)
  Organization: {
    addresses: 'deleteAllAddresses',
    electronicInvoicings: 'deleteAllElectronicInvoicings',
    emails: 'deleteAllEmails',
    phoneNumbers: 'deleteAllPhones',
    webPages: 'deleteAllWebPages',
  },
};

/**
 * Determines if a field on a given entity type requires an explicit delete flag.
 *
 * @param entityType The entity type (e.g., 'Service', 'EChannel')
 * @param fieldName The domain-model field name (e.g., 'lifeEvents', 'names')
 * @returns The delete flag property name if one exists, or null if the field
 *          is a full-replace field (you must send the complete new value to update it)
 *
 * @example
 * // Delete flag exists for this field
 * needsDeleteFlag('Service', 'lifeEvents') // => 'deleteAllLifeEvents'
 *
 * // No delete flag — it's a full-replace field
 * needsDeleteFlag('Service', 'names') // => null
 */
export function needsDeleteFlag(entityType: EntityType, fieldName: string): string | null {
  const flags = deleteFlagMap[entityType];
  if (!flags) {
    throw new Error(`Unknown entity type: ${entityType}`);
  }
  return flags[fieldName] ?? null;
}
