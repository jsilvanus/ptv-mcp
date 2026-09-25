import type { PtvAdapter } from '../ptv/adapter.js';
import type {
  CodeListEntry,
  Connection,
  GeneralDescription,
  LocalizedText,
  Organization,
  Service,
  ServiceChannel,
} from '../ptv/domain.js';
import {
  checkChannel,
  checkConnection,
  checkOrganization,
  checkService,
  type QualityFinding,
} from '../quality/contentChecks.js';
import { loadGeneralDescription } from '../quality/generalDescriptionContext.js';
import { formatValue } from '../mcp/manualPublish.js';
import { fetchAll, organisationsToReview } from '../reviews/reviewCampaigns.js';
import type { Cell, Sheet } from './xlsx.js';

/**
 * The content report DVV reviews before it issues IN-API production
 * credentials ("Excel-raportti", docs/dvv-in-integration-approval.md): an
 * organisation's organisations, services, channels and connections as PTV
 * has them, one row each, texts per language, plus every automated check
 * finding. Structured values (hours, phones, addresses) read as in PTV's
 * UI (manualPublish.ts's formatValue).
 */

export interface ContentExport {
  organisations: Organization[];
  services: Service[];
  channels: ServiceChannel[];
  connections: Connection[];
  generalDescriptions: Map<string, GeneralDescription>;
  /** When the data was read, ISO timestamp. */
  readAt: string;
}

const LANGUAGE_ORDER = ['fi', 'sv', 'en', 'se', 'smn', 'sms'];

const STATUS_LABELS: Record<string, string> = {
  Published: 'Julkaistu',
  Draft: 'Luonnos',
  Modified: 'Muokattu',
  Archived: 'Arkistoitu',
  Withdrawn: 'Poistettu',
};

const CHANNEL_TYPE_LABELS: Record<string, string> = {
  EChannel: 'Verkkoasiointi',
  WebPage: 'Verkkosivu',
  PrintableForm: 'Tulostettava lomake',
  Phone: 'Puhelinasiointi',
  ServiceLocation: 'Palvelupaikka',
};

const SERVICE_TYPE_LABELS: Record<string, string> = {
  Service: 'Palvelu',
  PermitOrObligation: 'Lupa tai velvoite',
  ProfessionalQualification: 'Ammattipätevyys',
};

/** Reads the organisation (and its sub-organisations) with all their content. */
export async function collectContent(
  adapter: PtvAdapter,
  organizationId: string,
  includeSubOrganisations: boolean,
): Promise<ContentExport> {
  const organisations = await organisationsToReview(
    adapter,
    organizationId,
    includeSubOrganisations,
  );
  const services: Service[] = [];
  const channels: ServiceChannel[] = [];
  for (const org of organisations) {
    services.push(...(await fetchAll((p) => adapter.searchServices(p), org.id)));
    channels.push(...(await fetchAll((p) => adapter.searchChannels(p), org.id)));
  }
  const connections: Connection[] = [];
  const cache = new Map<string, Promise<GeneralDescription | null>>();
  const generalDescriptions = new Map<string, GeneralDescription>();
  for (const service of services) {
    if (service.serviceChannelIds.length > 0) {
      connections.push(...(await adapter.getConnectionsFor(service.id).catch(() => [])));
    }
    const gd = await loadGeneralDescription(adapter, service.generalDescriptionId, cache);
    if (gd) generalDescriptions.set(gd.id, gd);
  }
  return {
    organisations,
    services,
    channels,
    connections,
    generalDescriptions,
    readAt: new Date().toISOString(),
  };
}

function languagesOf(texts: (LocalizedText | undefined)[]): string[] {
  const found = new Set(texts.flatMap((text) => Object.keys(text ?? {})));
  return [...found].sort(
    (a, b) =>
      (LANGUAGE_ORDER.indexOf(a) + 1 || 99) - (LANGUAGE_ORDER.indexOf(b) + 1 || 99) ||
      a.localeCompare(b),
  );
}

function name(names: LocalizedText | undefined): string {
  return names?.fi ?? names?.sv ?? names?.en ?? Object.values(names ?? {}).find(Boolean) ?? '';
}

function codes(entries: CodeListEntry[] | undefined): string {
  return (entries ?? [])
    .map((entry) => {
      const label = name(entry.names);
      const code = entry.code ?? entry.uri ?? '';
      return label ? `${label} (${code})` : code;
    })
    .join('\n');
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
    finding.severity === 'error' ? 'Virhe' : 'Huomio',
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
  const connectedCount = new Map<string, number>();
  for (const connection of content.connections) {
    connectedCount.set(connection.channelId, (connectedCount.get(connection.channelId) ?? 0) + 1);
  }

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
        STATUS_LABELS[org.publishingStatus] ?? org.publishingStatus,
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
        STATUS_LABELS[service.publishingStatus] ?? service.publishingStatus,
        SERVICE_TYPE_LABELS[service.serviceType] ?? service.serviceType,
        service.generalDescriptionId
          ? `${name(content.generalDescriptions.get(service.generalDescriptionId)?.names)} (${service.generalDescriptionId})`
          : '',
        service.languages.join(', '),
        ...textCells([service.names, service.summaries, service.descriptions], serviceLanguages),
        codes(service.serviceClasses),
        codes(service.ontologyTerms),
        codes(service.targetGroups),
        codes(service.lifeEvents),
        codes(service.industrialClasses),
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
        'Liitettyjä palveluita (oma organisaatio)',
        'Muokattu',
      ],
      ...content.channels.map((channel) => [
        channel.id,
        orgNames.get(channel.organizationId) ?? channel.organizationId,
        STATUS_LABELS[channel.publishingStatus] ?? channel.publishingStatus,
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
        connectedCount.get(channel.id) ?? 0,
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
      ...content.services.flatMap((service) => {
        const org = content.organisations.find((o) => o.id === service.organizationId);
        const gd = service.generalDescriptionId
          ? content.generalDescriptions.get(service.generalDescriptionId)
          : undefined;
        return findingRows(
          'Palvelu',
          service.id,
          name(service.names),
          checkService(service, {
            ...(org ? { organisationNames: org.names } : {}),
            ...(gd ? { generalDescription: gd } : {}),
          }).findings,
        );
      }),
      ...content.channels.flatMap((channel) =>
        findingRows(
          'Asiointikanava',
          channel.id,
          name(channel.names),
          checkChannel(channel, { connectedServiceCount: connectedCount.get(channel.id) ?? 0 })
            .findings,
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
      ['Laatutarkistuksen virheitä', findings.rows.filter((row) => row[4] === 'Virhe').length],
      ['Laatutarkistuksen huomioita', findings.rows.filter((row) => row[4] === 'Huomio').length],
      [
        'Huom.',
        'Automaattiset tarkistukset kattavat vain koneellisesti tarkistettavat säännöt (guides/content-quality.md, Q-*). Pääkäyttäjä tarkistaa loput.',
      ],
    ],
  };

  return [summary, organisations, services, channels, connections, findings];
}
