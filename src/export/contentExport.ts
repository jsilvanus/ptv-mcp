import type { PtvAdapter } from '../ptv/adapter.js';
import type { Connection, LocalizedText } from '../ptv/domain.js';
import {
  collectOrganisationContent,
  connectionsOf,
  organisationsInScope,
  type OrganisationContent,
} from '../ptv/organisationContent.js';
import {
  checkChannel,
  checkConnection,
  checkOrganization,
  checkService,
  type QualityFinding,
} from '../quality/contentChecks.js';
import { collectedCheckContexts } from '../quality/serviceCheckContext.js';
import {
  CHANNEL_TYPE_LABELS,
  displayName,
  formatValue,
  languageRank,
} from '../format/ptvFormat.js';
import type { Cell, Sheet } from './xlsx.js';

/**
 * The content report DVV reviews before it issues IN-API production
 * credentials ("Excel-raportti", docs/dvv-in-integration-approval.md): an
 * organisation's organisations, services, channels and connections as PTV
 * has them, one row each, texts per language, plus every automated check
 * finding. Values read as in PTV's UI (src/format/ptvFormat.ts).
 */

export interface ContentExport extends OrganisationContent {
  connections: Connection[];
  /** When the data was read, ISO timestamp. */
  readAt: string;
}

/** Reads the organisation (and its sub-organisations) with all their content. */
export async function collectContent(
  adapter: PtvAdapter,
  organizationId: string,
  includeSubOrganisations: boolean,
): Promise<ContentExport> {
  const organisations = await organisationsInScope(
    adapter,
    organizationId,
    includeSubOrganisations,
  );
  const content = await collectOrganisationContent(adapter, organisations);
  const connections = await connectionsOf(adapter, content.services);
  return { ...content, connections, readAt: new Date().toISOString() };
}

function languagesOf(texts: (LocalizedText | undefined)[]): string[] {
  const found = new Set(texts.flatMap((text) => Object.keys(text ?? {})));
  return [...found].sort((a, b) => languageRank(a) - languageRank(b) || a.localeCompare(b));
}

function name(names: LocalizedText | undefined): string {
  return displayName(names) ?? '';
}

/** A structured value as PTV's UI shows it, empty when missing. */
function formatted(field: string, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value) && value.length === 0) return '';
  return formatValue(field, value);
}

/** Header cells for per-language text columns, e.g. "Nimi (fi)". */
function textHeaders(labels: string[], languages: string[]): string[] {
  return languages.flatMap((language) => labels.map((label) => `${label} (${language})`));
}

function textCells(fields: (LocalizedText | undefined)[], languages: string[]): Cell[] {
  return languages.flatMap((language) => fields.map((field) => field?.[language] ?? ''));
}

/** Severity column values of the findings sheet (column 5). */
const ERROR = 'Virhe';
const WARNING = 'Huomio';

function findingRows(
  kind: string,
  id: string,
  targetName: string,
  findings: QualityFinding[],
): Cell[][] {
  return findings.map((finding) => [
    kind,
    id,
    targetName,
    finding.checkId,
    finding.severity === 'error' ? ERROR : WARNING,
    finding.field,
    finding.language ?? '',
    finding.message,
    finding.excerpt ?? '',
  ]);
}

export function contentSheets(content: ContentExport): Sheet[] {
  const orgNames = new Map(content.organisations.map((org) => [org.id, name(org.names)]));
  const serviceNames = new Map(content.services.map((s) => [s.id, name(s.names)]));
  const channelNames = new Map(content.channels.map((c) => [c.id, name(c.names)]));
  const checkContexts = collectedCheckContexts(content);

  const orgLanguages = languagesOf(
    content.organisations.flatMap((o) => [o.names, o.summaries, o.descriptions]),
  );
  const organisations: Sheet = {
    name: 'Organisaatiot',
    rows: [
      [
        'Id',
        'Yläorganisaatio',
        'Tila',
        'Organisaatiotyyppi',
        'Y-tunnus',
        ...textHeaders(['Nimi', 'Vaihtoehtoinen nimi', 'Tiivistelmä', 'Kuvaus'], orgLanguages),
        'Aluetieto',
        'Sähköposti',
        'Puhelinnumerot',
        'Verkkosivut',
        'Osoitteet',
        'Muokattu',
      ],
      ...content.organisations.map((org) => [
        org.id,
        org.parentOrganizationId
          ? (orgNames.get(org.parentOrganizationId) ?? org.parentOrganizationId)
          : '',
        formatted('publishingStatus', org.publishingStatus),
        formatted('organizationType', org.organizationType),
        org.businessCode ?? '',
        ...textCells(
          [org.names, org.alternativeNames, org.summaries, org.descriptions],
          orgLanguages,
        ),
        formatted('area', org.area),
        formatted('emails', org.emails),
        formatted('phoneNumbers', org.phoneNumbers),
        formatted('webPages', org.webPages),
        formatted('addresses', org.addresses),
        org.modifiedAt ?? '',
      ]),
    ],
  };

  const serviceLanguages = languagesOf(
    content.services.flatMap((s) => [s.names, s.summaries, s.descriptions]),
  );
  const services: Sheet = {
    name: 'Palvelut',
    rows: [
      [
        'Id',
        'Organisaatio',
        'Tila',
        'Palvelutyyppi',
        'Pohjakuvaus',
        'Kielet',
        ...textHeaders(['Nimi', 'Tiivistelmä', 'Kuvaus'], serviceLanguages),
        'Palveluluokat',
        'Asiasanat',
        'Kohderyhmät',
        'Elämäntilanteet',
        'Toimialat',
        'Asiointikanavat',
        'Muokattu',
      ],
      ...content.services.map((service) => [
        service.id,
        orgNames.get(service.organizationId) ?? service.organizationId,
        formatted('publishingStatus', service.publishingStatus),
        formatted('serviceType', service.serviceType),
        service.generalDescriptionId
          ? `${name(content.generalDescriptions.get(service.generalDescriptionId)?.names)} (${service.generalDescriptionId})`
          : '',
        service.languages.join(', '),
        ...textCells([service.names, service.summaries, service.descriptions], serviceLanguages),
        formatted('serviceClasses', service.serviceClasses),
        formatted('ontologyTerms', service.ontologyTerms),
        formatted('targetGroups', service.targetGroups),
        formatted('lifeEvents', service.lifeEvents),
        formatted('industrialClasses', service.industrialClasses),
        service.serviceChannelIds
          .map((id) => `${channelNames.get(id) ?? '(toisen organisaation kanava)'} (${id})`)
          .join('\n'),
        service.modifiedAt ?? '',
      ]),
    ],
  };

  const channelLanguages = languagesOf(
    content.channels.flatMap((c) => [c.names, c.summaries, c.descriptions]),
  );
  const channels: Sheet = {
    name: 'Asiointikanavat',
    rows: [
      [
        'Id',
        'Organisaatio',
        'Tila',
        'Tyyppi',
        'Kielet',
        ...textHeaders(['Nimi', 'Tiivistelmä', 'Kuvaus'], channelLanguages),
        'Verkko-osoite',
        'Puhelinnumerot',
        'Sähköposti',
        'Käytön tuki: puhelin',
        'Käytön tuki: sähköposti',
        'Osoitteet',
        'Toimitusosoitteet',
        'Lomaketiedostot',
        'Verkkosivut',
        'Palveluajat',
        'Saavutettavuus',
        'Yhteiskäyttöinen',
        'Liitettyjä palveluita',
        'Muokattu',
      ],
      ...content.channels.map((channel) => [
        channel.id,
        orgNames.get(channel.organizationId) ?? channel.organizationId,
        formatted('publishingStatus', channel.publishingStatus),
        CHANNEL_TYPE_LABELS[channel.channelType] ?? channel.channelType,
        channel.languages.join(', '),
        ...textCells([channel.names, channel.summaries, channel.descriptions], channelLanguages),
        formatted('urls', channel.urls),
        formatted('phoneNumbers', channel.phoneNumbers),
        formatted('emails', channel.emails),
        formatted('supportPhones', channel.supportPhones),
        formatted('supportEmails', channel.supportEmails),
        formatted('addresses', channel.addresses),
        formatted('deliveryAddresses', channel.deliveryAddresses),
        formatted('formFiles', channel.formFiles),
        formatted('webPages', channel.webPages),
        formatted('serviceHours', channel.serviceHours),
        formatted('accessibility', channel.accessibility),
        channel.isVisibleForAll === undefined ? '' : channel.isVisibleForAll ? 'Kyllä' : 'Ei',
        content.connectedServiceCount.get(channel.id) ?? 0,
        channel.modifiedAt ?? '',
      ]),
    ],
  };

  const connections: Sheet = {
    name: 'Liitokset',
    rows: [
      [
        'Palvelu',
        'Palvelun id',
        'Asiointikanava',
        'Kanavan id',
        'Maksullisuus',
        'Maksullisuuden lisätieto',
        'Kuvaus',
        'Palveluajat',
        'Puhelinnumerot',
        'Sähköposti',
        'Verkkosivut',
        'Osoitteet',
      ],
      ...content.connections.map((connection) => [
        serviceNames.get(connection.serviceId) ?? '',
        connection.serviceId,
        channelNames.get(connection.channelId) ?? '(toisen organisaation kanava)',
        connection.channelId,
        formatted('chargeType', connection.chargeType),
        formatted('chargeDescriptions', connection.chargeDescriptions),
        formatted('descriptions', connection.descriptions),
        formatted('serviceHours', connection.serviceHours),
        formatted('phoneNumbers', connection.phoneNumbers),
        formatted('emails', connection.emails),
        formatted('webPages', connection.webPages),
        formatted('addresses', connection.addresses),
      ]),
    ],
  };

  const findings: Sheet = {
    name: 'Laatutarkistus',
    rows: [
      ['Kohde', 'Id', 'Nimi', 'Tarkistus', 'Vakavuus', 'Kenttä', 'Kieli', 'Viesti', 'Ote'],
      ...content.organisations.flatMap((org) =>
        findingRows('Organisaatio', org.id, name(org.names), checkOrganization(org).findings),
      ),
      ...content.services.flatMap((service) =>
        findingRows(
          'Palvelu',
          service.id,
          name(service.names),
          checkService(service, checkContexts.service(service)).findings,
        ),
      ),
      ...content.channels.flatMap((channel) =>
        findingRows(
          'Asiointikanava',
          channel.id,
          name(channel.names),
          checkChannel(channel, checkContexts.channel(channel)).findings,
        ),
      ),
      ...content.connections.flatMap((connection) =>
        findingRows(
          'Liitos',
          `${connection.serviceId}/${connection.channelId}`,
          `${serviceNames.get(connection.serviceId) ?? ''} – ${channelNames.get(connection.channelId) ?? ''}`,
          checkConnection(connection).findings,
        ),
      ),
    ],
  };

  const summary: Sheet = {
    name: 'Yhteenveto',
    rows: [
      ['Tieto', 'Arvo'],
      ['Organisaatio', name(content.organisations[0]?.names)],
      ['Organisaation id', content.organisations[0]?.id ?? ''],
      ['Luettu PTV:stä', content.readAt],
      ['Organisaatioita', content.organisations.length],
      ['Palveluita', content.services.length],
      ['Asiointikanavia', content.channels.length],
      ['Liitoksia', content.connections.length],
      ['Laatutarkistuksen virheitä', findings.rows.filter((row) => row[4] === ERROR).length],
      ['Laatutarkistuksen huomioita', findings.rows.filter((row) => row[4] === WARNING).length],
      [
        'Huom.',
        'Automaattiset tarkistukset kattavat vain koneellisesti tarkistettavat säännöt (guides/content-quality.md, Q-*). Pääkäyttäjä tarkistaa loput.',
      ],
    ],
  };

  return [summary, organisations, services, channels, connections, findings];
}
