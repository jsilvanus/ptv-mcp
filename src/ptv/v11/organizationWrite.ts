import type { NewOrganization } from '../adapter.js';
import type { LocalizedText, Organization, OrganizationArea } from '../domain.js';
import { phoneToWire, textToLanguageItems, webLinkToWire } from './channelFields.js';
import { organizationAddressToWire } from './mappers/organization.js';
import { toV11WritePublishingStatus } from './mappers/common.js';
import type { V11LocalizedItem, V11OrganizationWire } from './wireModel.js';

/**
 * Bodies for `PUT /api/v11/Organization/{id}` (V9VmOpenApiOrganizationInBase)
 * and `POST /api/v11/Organization` (V9VmOpenApiOrganizationIn).
 *
 * Like a service or channel PUT (writeMapping.ts, channelChangesToV11Body),
 * the PUT is built on the current record: publishingStatus is always sent,
 * names are sent as the whole Name + AlternativeName list with a
 * displayNameType for every name language, and descriptions as the whole
 * Description + Summary list, keeping the type the change doesn't touch.
 * Contact lists are sent only when they change; an emptied one is cleared
 * with its deleteAll* flag. The e-invoicing addresses, area and type are
 * never sent on a PUT, so PTV keeps them.
 */

function toWireList(text: LocalizedText | undefined, type: string): V11LocalizedItem[] {
  return textToLanguageItems(text).map((item) => ({ ...item, type }));
}

function kept(items: V11LocalizedItem[] | null | undefined, type: string): V11LocalizedItem[] {
  return (items ?? []).filter((item) => !!item.value && item.type === type);
}

function displayNameTypes(
  nameLanguages: string[],
  alternativeNameShownIn: string[],
): { language: string; type: string }[] {
  return nameLanguages.map((language) => ({
    language,
    type: alternativeNameShownIn.includes(language) ? 'AlternativeName' : 'Name',
  }));
}

function contactFields(changes: Partial<Organization>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ('emails' in changes) {
    const emails = changes.emails ?? [];
    if (emails.length > 0) {
      body.emails = emails.map((email) => ({ language: email.language, value: email.value }));
    } else body.deleteAllEmails = true;
  }
  if ('phoneNumbers' in changes) {
    const phones = changes.phoneNumbers ?? [];
    if (phones.length > 0) body.phoneNumbers = phones.map((phone) => phoneToWire(phone));
    else body.deleteAllPhones = true;
  }
  if ('webPages' in changes) {
    const pages = changes.webPages ?? [];
    if (pages.length > 0) body.webPages = pages.map(webLinkToWire);
    else body.deleteAllWebPages = true;
  }
  if ('addresses' in changes) {
    const addresses = changes.addresses ?? [];
    if (addresses.length > 0) body.addresses = addresses.map(organizationAddressToWire);
    else body.deleteAllAddresses = true;
  }
  return body;
}

export function organizationChangesToV11Body(
  changes: Partial<Organization>,
  current: V11OrganizationWire,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    publishingStatus: changes.publishingStatus
      ? toV11WritePublishingStatus(changes.publishingStatus)
      : current.publishingStatus,
  };

  if ('names' in changes || 'alternativeNames' in changes || 'alternativeNameShownIn' in changes) {
    const names =
      'names' in changes
        ? toWireList(changes.names, 'Name')
        : kept(current.organizationNames, 'Name');
    const alternatives =
      'alternativeNames' in changes
        ? toWireList(changes.alternativeNames, 'AlternativeName')
        : kept(current.organizationNames, 'AlternativeName');
    const shownIn =
      changes.alternativeNameShownIn ??
      (current.displayNameType ?? [])
        .filter((entry) => entry.type === 'AlternativeName' || entry.type === 'AlternateName')
        .map((entry) => entry.language);
    const alternativeLanguages = new Set(alternatives.map((item) => item.language));
    body.organizationNames = [...names, ...alternatives];
    body.displayNameType = displayNameTypes(
      names.map((item) => item.language),
      shownIn.filter((language) => alternativeLanguages.has(language)),
    );
  }

  if ('summaries' in changes || 'descriptions' in changes) {
    body.organizationDescriptions = [
      ...('summaries' in changes
        ? toWireList(changes.summaries, 'Summary')
        : kept(current.organizationDescriptions, 'Summary')),
      ...('descriptions' in changes
        ? toWireList(changes.descriptions, 'Description')
        : kept(current.organizationDescriptions, 'Description')),
    ];
  }

  if ('businessCode' in changes) body.businessCode = changes.businessCode ?? '';

  return { ...body, ...contactFields(changes) };
}

/**
 * The organisation's area on the POST: `areaType`, and for a LimitedType
 * one `subAreaType` plus its codes. The In schema takes one sub area type
 * only, so an area of several types keeps the first type's codes.
 */
export function organizationAreaToV11Post(area: OrganizationArea | undefined): {
  areaType: string;
  subAreaType?: string;
  areas?: string[];
} {
  if (!area || area.areaType !== 'LimitedType') {
    return { areaType: area?.areaType ?? 'Nationwide' };
  }
  const first = area.areas?.[0]?.type;
  return {
    areaType: 'LimitedType',
    ...(first
      ? {
          subAreaType: first,
          areas: (area.areas ?? []).filter((a) => a.type === first).map((a) => a.code),
        }
      : {}),
  };
}

export function newOrganizationToV11Body(organization: NewOrganization): Record<string, unknown> {
  const names = toWireList(organization.names, 'Name');
  const alternatives = toWireList(organization.alternativeNames, 'AlternativeName');
  const alternativeLanguages = new Set(alternatives.map((item) => item.language));
  const contacts = contactFields(organization);
  // Nothing to clear on a new organisation.
  for (const key of Object.keys(contacts)) {
    if (key.startsWith('deleteAll')) delete contacts[key];
  }
  return {
    parentOrganizationId: organization.parentOrganizationId,
    organizationType: organization.organizationType,
    publishingStatus: toV11WritePublishingStatus(organization.publishingStatus),
    organizationNames: [...names, ...alternatives],
    displayNameType: displayNameTypes(
      names.map((item) => item.language),
      (organization.alternativeNameShownIn ?? []).filter((language) =>
        alternativeLanguages.has(language),
      ),
    ),
    organizationDescriptions: [
      ...toWireList(organization.summaries, 'Summary'),
      ...toWireList(organization.descriptions, 'Description'),
    ],
    ...(organization.businessCode ? { businessCode: organization.businessCode } : {}),
    ...(organization.sourceId ? { sourceId: organization.sourceId } : {}),
    ...(organization.municipality ? { municipality: organization.municipality } : {}),
    ...organizationAreaToV11Post(organization.area),
    ...contacts,
  };
}
