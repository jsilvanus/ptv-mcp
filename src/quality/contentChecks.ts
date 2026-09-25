import type {
  CodeListEntry,
  ConnectionDetails,
  LocalizedText,
  Organization,
  PhoneNumber,
  Service,
  ServiceChannel,
  ServiceHour,
} from '../ptv/domain.js';
import type { NewService } from '../ptv/adapter.js';

/**
 * Deterministic content checks for PTV services and channels. They
 * automate the checks in guides/content-quality.md's review checklist that
 * can be decided from the data alone, so every proposal and every review
 * item gets the same answer regardless of which AI (if any) is involved.
 * Check ids are the guide's `Q-*` ids.
 *
 * - `error`: breaks a DVV rule outright (contact details in free text,
 *   missing or too long mandatory texts, classification limits).
 * - `warning`: a heuristic hit, mostly style (passive voice, long
 *   sentences, dates), for a human to judge.
 *
 * Only fields the shared domain model carries are checked (names,
 * summaries, descriptions, classifications, languages, connections).
 */

export type QualitySeverity = 'error' | 'warning';

export interface QualityFinding {
  checkId: string;
  severity: QualitySeverity;
  /** Domain field, e.g. `descriptions`. */
  field: string;
  language?: string;
  message: string;
  /** The offending text, shortened, when there is one. */
  excerpt?: string;
}

export interface QualityReport {
  findings: QualityFinding[];
  errors: number;
  warnings: number;
}

export const SUMMARY_MAX = 150;
export const DESCRIPTION_MAX = 5000;
/** DVV's limit for an organisation's description (the API takes 5000). */
export const ORGANIZATION_DESCRIPTION_MAX = 2500;
export const MAX_SERVICE_CLASSES = 4;
export const MAX_ONTOLOGY_TERMS = 10;
/** Words per sentence before a long-sentence warning. */
export const LONG_SENTENCE_WORDS = 25;
/** DVV: one topic and at most four sentences per paragraph. */
export const PARAGRAPH_MAX_SENTENCES = 4;

export interface ServiceCheckContext {
  /** The owning organisation's names, to flag service names that repeat them. */
  organisationNames?: LocalizedText;
  /** A new service still being proposed: no channels yet is a warning (Q-STRUCT-5). */
  creating?: boolean;
}

export interface ChannelCheckContext {
  /**
   * How many services the channel is known to be connected to. Omit when
   * unknown; 0 raises Q-STRUCT-5.
   */
  connectedServiceCount?: number;
  /**
   * A new channel still being proposed: a missing connection is the next
   * step, not a broken rule, so Q-STRUCT-5 is a warning.
   */
  creating?: boolean;
  /** Today (YYYY-MM-DD) for date checks; defaults to the current date. */
  today?: string;
}

function report(findings: QualityFinding[]): QualityReport {
  return {
    findings,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  };
}

function excerpt(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// --- Q-STRUCT-1: contact details and opening hours in free text --------

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.[\w-]+\.\S+/i;
// Finnish numbers: +358 40 123 4567, 040 123 4567, 09 1234 5678, 020 634 0000.
const PHONE =
  /(?:\+358[\s-]?\(?0?\)?\s?\d{1,3}|(?<![\d.,])0\d{1,3})[\s-]?\d{2,4}[\s-]?\d{2,4}(?:[\s-]?\d{1,4})?(?![\d.,]*\d)/;
const STREET_ADDRESS =
  /(?<!\p{L})\p{Lu}[\p{L}-]*(?:katu|tie|polku|kuja|väylä|raitti|tori|puistikko|ranta|gatan|vägen|gränd|stigen)\s+\d{1,3}(?!\d)/u;
const POSTCODE_CITY = /(?<![\d.,])\d{5}\s+\p{Lu}\p{Ll}{2,}/u;
const OPENING_HOURS = [
  /\bklo\s*\d{1,2}(?:[.:]\d{2})?\s*[-–]\s*\d{1,2}/i,
  /(?<![\d.])\d{1,2}[.:]\d{2}\s*[-–]\s*\d{1,2}[.:]\d{2}(?![\d])/,
  /\b(?:ma|ti|ke|to|pe|la|su|mån|tis|ons|tor|fre|lör|sön|mon|tue|wed|thu|fri|sat|sun)\s*[-–]\s*(?:ma|ti|ke|to|pe|la|su|mån|tis|ons|tor|fre|lör|sön|mon|tue|wed|thu|fri|sat|sun)\b/i,
];

function phoneMatch(text: string): string | undefined {
  const match = PHONE.exec(text);
  if (!match) return undefined;
  const digits = match[0].replace(/\D/g, '');
  return digits.length >= 7 ? match[0] : undefined;
}

function contactHits(text: string): { kind: string; match: string }[] {
  const hits: { kind: string; match: string }[] = [];
  const email = EMAIL.exec(text);
  if (email) hits.push({ kind: 'email address', match: email[0] });
  const url = URL_PATTERN.exec(text);
  if (url) hits.push({ kind: 'web address', match: url[0] });
  const phone = phoneMatch(text);
  if (phone) hits.push({ kind: 'phone number', match: phone });
  const street = STREET_ADDRESS.exec(text) ?? POSTCODE_CITY.exec(text);
  if (street) hits.push({ kind: 'address', match: street[0] });
  for (const pattern of OPENING_HOURS) {
    const hours = pattern.exec(text);
    if (hours) {
      hits.push({ kind: 'opening hours', match: hours[0] });
      break;
    }
  }
  return hits;
}

// --- Q-STRUCT-2: references to other fields or "this page" -------------

const SELF_REFERENCES =
  /(?<!\p{L})(?:tällä sivulla|tältä sivulta|tällä verkkosivulla|alla olev\p{L}*|yllä mainit\p{L}*|edellä mainit\p{L}*|katso alta|lue alta|på denna sida|nedan|ovan nämnd\p{L}*|on this page|see below|listed below|mentioned above)(?!\p{L})/iu;

// --- Style heuristics (Finnish; other languages get the language-neutral ones)

/**
 * Present passive: haetaan, annetaan, tarvitaan, tehdään, voidaan,
 * mennään, plus a few common irregular ones. Endings that clash with
 * possessive case forms (-staan "kodistaan", -allaan "ajallaan") are only
 * matched as listed words; -ellaan (käsitellään) is matched, minus the
 * few adessive-possessive words in FI_PASSIVE_EXCEPTIONS.
 */
const FI_PASSIVE =
  /(?<!\p{L})(?:\p{L}*(?:[aeiouyäö][td]|hd|nn|ell)(?:aa|ää)n|tullaan|ollaan|kuullaan|pestään|juostaan|ratkaistaan)(?!\p{L})/giu;
/** Plural partitive + possessive (asioitaan, palveluitaan) looks passive but isn't. */
const FI_PARTITIVE_POSSESSIVE = /[aeiouyäö]it(?:aa|ää)n$/i;
/** Finnish words that look passive but aren't. */
const FI_PASSIVE_EXCEPTIONS = new Set([
  'sataan',
  'maataan',
  'itään',
  'kanadaan',
  'itsellään',
  'kädellään',
  'puolellaan',
  'puolellansa',
]);
/**
 * Participial and infinitive constructions (lauseenvastikkeet) with a
 * possessive suffix: hakiessasi, saatuasi, tehtyään.
 */
const FI_PARTICIPIAL =
  /(?<!\p{L})\p{L}+?(?:(?<!e)ess(?:a|ä)|tua|tyä)(?:ni|si|mme|nne|an|än)(?!\p{L})/giu;
const DATE_OR_YEAR = /(?<![\d/])(?:\d{1,2}\.\d{1,2}\.(?:\d{2,4})?|(?:19|20)\d{2})(?![\d/])/;
const LAW_REFERENCE =
  /§|(?<!\d)\d{1,4}\/(?:19|20)\d{2}(?!\d)|(?<!\p{L})\p{L}*(?:laki|lain|lakia|lakiin|asetus|asetuksen|asetuksessa)(?!\p{L})/iu;
const EMPHASIS_MARKUP = /\*\*[^*]+\*\*|__[^_]+__|<\/?(?:b|i|u|strong|em)>/i;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=\p{Lu}|\d)|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^\s*[-•*]/.test(p));
}

function styleFindings(field: string, language: string, text: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const warn = (checkId: string, message: string, hit?: string) =>
    findings.push({
      checkId,
      severity: 'warning',
      field,
      language,
      message,
      ...(hit ? { excerpt: excerpt(hit) } : {}),
    });

  const selfRef = SELF_REFERENCES.exec(text);
  if (selfRef) {
    warn(
      'Q-STRUCT-2',
      'Refers to another place ("below", "this page"); every text must stand on its own.',
      selfRef[0],
    );
  }
  const law = LAW_REFERENCE.exec(text);
  if (law) {
    warn(
      'Q-LAW-1',
      'Refers to legislation in running text; use the law field (Finlex links) instead.',
      law[0],
    );
  }
  const date = DATE_OR_YEAR.exec(text);
  if (date) {
    warn('Q-STYLE-7', 'Contains a date or year that will go out of date.', date[0]);
  }
  if (EMPHASIS_MARKUP.test(text)) {
    warn(
      'Q-STYLE-9',
      'Contains emphasis markup; PTV supports only paragraphs, lists and subheadings.',
    );
  }
  const long = sentences(text).find((s) => words(s).length > LONG_SENTENCE_WORDS);
  if (long) {
    warn('Q-STYLE-3', `A sentence has more than ${LONG_SENTENCE_WORDS} words; split it.`, long);
  }
  const longParagraph = paragraphs(text).find((p) => sentences(p).length > PARAGRAPH_MAX_SENTENCES);
  if (longParagraph) {
    warn(
      'Q-STYLE-3',
      `A paragraph has more than ${PARAGRAPH_MAX_SENTENCES} sentences; one topic per paragraph.`,
      longParagraph,
    );
  }
  if (language === 'fi') {
    const passives = [...text.matchAll(FI_PASSIVE)]
      .map((m) => m[0])
      .filter(
        (w) => !FI_PASSIVE_EXCEPTIONS.has(w.toLowerCase()) && !FI_PARTITIVE_POSSESSIVE.test(w),
      );
    if (passives.length > 0) {
      warn(
        'Q-STYLE-2',
        `Passive verbs (${[...new Set(passives)].slice(0, 5).join(', ')}); address the reader directly ("Hae…", "Voit…").`,
      );
    }
    const participials = [...text.matchAll(FI_PARTICIPIAL)].map((m) => m[0]);
    if (participials.length > 0) {
      warn(
        'Q-STYLE-4',
        `Participial constructions (${[...new Set(participials)].slice(0, 5).join(', ')}); use a subordinate clause ("Kun haet…").`,
      );
    }
  }
  return findings;
}

function freeTextFindings(field: string, language: string, text: string): QualityFinding[] {
  const findings: QualityFinding[] = contactHits(text).map((hit) => ({
    checkId: 'Q-STRUCT-1',
    severity: 'error' as const,
    field,
    language,
    message: `Contains ${hit.kind}; contact details and opening hours belong in the service channel's own fields.`,
    excerpt: excerpt(hit.match),
  }));
  return [...findings, ...styleFindings(field, language, text)];
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function languagesOf(...fields: LocalizedText[]): string[] {
  return [...new Set(fields.flatMap((f) => Object.keys(f)))].sort();
}

/** The code of a classification entry, from `code` or the last URI segment (`…/code/P4.10`). */
export function classificationCode(entry: CodeListEntry): string {
  if (entry.code) return entry.code;
  const uri = entry.uri ?? '';
  return (
    uri
      .split(/[/#;=]/)
      .filter(Boolean)
      .pop() ?? ''
  );
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textFieldFindings(
  names: LocalizedText,
  summaries: LocalizedText | undefined,
  descriptions: LocalizedText,
  descriptionMax = DESCRIPTION_MAX,
): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const error = (checkId: string, field: string, language: string, message: string) =>
    findings.push({ checkId, severity: 'error', field, language, message });

  const withSummaries = summaries ?? {};
  for (const language of languagesOf(names, withSummaries, descriptions)) {
    // Anything but text (a malformed stored proposal) counts as missing.
    const name = textOf(names[language]);
    const summary = textOf(withSummaries[language]);
    const description = textOf(descriptions[language]);

    if (!name) {
      error('Q-LANG-2', 'names', language, 'Language version has no name.');
    } else {
      findings.push(
        ...freeTextFindings('names', language, name).filter((f) => f.severity === 'error'),
      );
    }

    if (summaries) {
      if (!summary) {
        error('Q-SUM-1', 'summaries', language, 'Language version has no summary.');
      } else {
        if (summary.length > SUMMARY_MAX) {
          error(
            'Q-SUM-1',
            'summaries',
            language,
            `Summary is ${summary.length} characters; the maximum is ${SUMMARY_MAX}.`,
          );
        }
        if (name && normalized(summary) === normalized(name)) {
          error('Q-SUM-1', 'summaries', language, 'Summary repeats the name; say something new.');
        }
        findings.push(...freeTextFindings('summaries', language, summary));
      }
    }

    if (!description) {
      error('Q-DESC-1', 'descriptions', language, 'Language version has no description.');
    } else {
      if (description.length > descriptionMax) {
        error(
          'Q-DESC-1',
          'descriptions',
          language,
          `Description is ${description.length} characters; the maximum is ${descriptionMax}.`,
        );
      }
      findings.push(...freeTextFindings('descriptions', language, description));
    }
  }
  return findings;
}

/** Checks a service (existing, proposed or new) against the deterministic rules. */
export function checkService(
  service: Service | NewService,
  context: ServiceCheckContext = {},
): QualityReport {
  const findings = textFieldFindings(service.names, service.summaries, service.descriptions);
  const error = (checkId: string, field: string, message: string) =>
    findings.push({ checkId, severity: 'error', field, message });
  const warn = (checkId: string, field: string, message: string, language?: string) =>
    findings.push({
      checkId,
      severity: 'warning',
      field,
      message,
      ...(language ? { language } : {}),
    });

  const organisationNames = context.organisationNames ?? {};
  for (const [language, name] of Object.entries(service.names)) {
    const orgName = organisationNames[language];
    if (name && orgName && normalized(name).includes(normalized(orgName))) {
      warn(
        'Q-NAME-1',
        'names',
        'Name repeats the organisation name; leave it out unless it is really needed.',
        language,
      );
    }
  }

  // With a general description, PTV inherits its classifications and the
  // service's own lists may legitimately be empty; only the upper limits apply.
  const inherits = Boolean(service.generalDescriptionId);
  const classes = service.serviceClasses.map(classificationCode);
  if (classes.length > MAX_SERVICE_CLASSES) {
    error(
      'Q-CLASS-1',
      'serviceClasses',
      `${classes.length} service classes; the maximum is ${MAX_SERVICE_CLASSES}.`,
    );
  } else if (!inherits && classes.length === 0) {
    error('Q-CLASS-1', 'serviceClasses', 'No service class; choose 1–4, at least one sub-class.');
  } else if (classes.length > 0 && !classes.some((code) => code.includes('.'))) {
    error(
      'Q-CLASS-1',
      'serviceClasses',
      'Only main service classes; at least one must be a sub-class (e.g. P4.10).',
    );
  }

  const terms = service.ontologyTerms.length;
  if (terms > MAX_ONTOLOGY_TERMS) {
    error(
      'Q-CLASS-2',
      'ontologyTerms',
      `${terms} ontology terms; the maximum is ${MAX_ONTOLOGY_TERMS}.`,
    );
  } else if (!inherits && terms === 0) {
    error('Q-CLASS-2', 'ontologyTerms', 'No ontology terms; choose 1–10 specific terms.');
  }

  const targetGroups = service.targetGroups.map(classificationCode);
  if (targetGroups.includes('KR2') && !targetGroups.some((code) => code.startsWith('KR2.'))) {
    error(
      'Q-CLASS-3',
      'targetGroups',
      'Businesses and communities (KR2) needs at least one sub-group.',
    );
  }
  const citizenSubgroups = targetGroups.filter((code) => code.startsWith('KR1.')).length;
  if (citizenSubgroups >= 5) {
    warn(
      'Q-CLASS-3',
      'targetGroups',
      `${citizenSubgroups} citizen sub-groups; choose sub-groups only when the service is limited to them.`,
    );
  }

  if (service.languages.length === 0) {
    error('Q-LANG-1', 'languages', 'No service languages (the languages customers are served in).');
  }
  if (service.serviceChannelIds.length === 0) {
    if (context.creating) {
      // Services and channels are created one at a time and linked after:
      // expected at this step, but the link must follow before publishing.
      findings.push({
        checkId: 'Q-STRUCT-5',
        severity: 'warning',
        field: 'serviceChannelIds',
        message:
          'No channels yet. Once the service exists, connect it: propose a new channel with its id in serviceIds, or add existing channel ids to its serviceChannelIds.',
      });
    } else {
      error('Q-STRUCT-5', 'serviceChannelIds', 'No connected service channels.');
    }
  }
  return report(findings);
}

/**
 * The structured channel fields: contacts (Q-CONTACT-1) and service hours
 * (Q-HOURS-1). PTV's hard rules on the same fields (formats, required
 * fields) are validation errors (src/validation/channelRules.ts); these are
 * the guideline checks on top.
 */
type Warn = (checkId: string, field: string, message: string, language?: string) => void;

function warner(findings: QualityFinding[]): Warn {
  return (checkId, field, message, language) =>
    findings.push({
      checkId,
      severity: 'warning',
      field,
      message,
      ...(language ? { language } : {}),
    });
}

function phoneFindings(field: string, phones: PhoneNumber[], warn: Warn): void {
  for (const phone of phones) {
    if (phone.chargeType === 'Other' && !phone.chargeDescription) {
      warn(
        'Q-CONTACT-1',
        field,
        `${phone.number}: an extra-charge number needs the price in chargeDescription.`,
        phone.language,
      );
    }
  }
  for (const phone of phones) {
    if (!phone.isFinnishServiceNumber && phone.number.replace(/\D/g, '').length < 5) {
      warn(
        'Q-CONTACT-1',
        field,
        `${phone.number}: too short to be a phone number; check it.`,
        phone.language,
      );
    }
  }
  const byLanguage = new Map<string, number>();
  for (const phone of phones)
    byLanguage.set(phone.language, (byLanguage.get(phone.language) ?? 0) + 1);
  for (const [language, count] of byLanguage) {
    if (count > 1 && phones.some((p) => p.language === language && !p.additionalInformation)) {
      warn(
        'Q-CONTACT-1',
        field,
        'Several numbers: give each one additional information (e.g. "Vaihde") so customers know which to call.',
        language,
      );
    }
  }
}

function serviceHourFindings(hours: ServiceHour[], today: string, warn: Warn): void {
  for (const hour of hours) {
    // A single-day exceptional hour has only validFrom: it ends that day.
    const ends = hour.validTo ?? (hour.type === 'Exceptional' ? hour.validFrom : undefined);
    if (ends && ends < today) {
      warn(
        'Q-HOURS-1',
        'serviceHours',
        `A ${hour.type} service hour ended on ${ends}; remove it or update it.`,
      );
    }
    if (hour.type === 'Exceptional') {
      if (!hour.validFrom) {
        warn('Q-HOURS-1', 'serviceHours', 'An exceptional service hour has no date (validFrom).');
      }
      if (!Object.values(hour.additionalInformation ?? {}).some(Boolean)) {
        warn(
          'Q-HOURS-1',
          'serviceHours',
          `An exceptional service hour${hour.validFrom ? ` (${hour.validFrom})` : ''} has no title; name it (e.g. "Jouluaatto") so customers know why the hours differ.`,
        );
      }
    }
  }
  const weekly = hours.filter((hour) => hour.type === 'DaysOfTheWeek');
  if (
    weekly.length > 1 &&
    weekly.some((hour) => !Object.values(hour.additionalInformation ?? {}).some(Boolean))
  ) {
    warn(
      'Q-HOURS-1',
      'serviceHours',
      'Several weekly schedules: give each a title (e.g. "Kesäaika") so customers can tell them apart.',
    );
  }
}

function channelDetailFindings(channel: ServiceChannel, today: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const warn = warner(findings);
  for (const field of ['phoneNumbers', 'supportPhones'] as const) {
    phoneFindings(field, channel[field] ?? [], warn);
  }

  if (
    channel.channelType === 'ServiceLocation' &&
    channel.addresses !== undefined &&
    !channel.addresses.some((a) => a.kind === 'Street' && a.purpose !== 'Postal')
  ) {
    warn(
      'Q-CONTACT-1',
      'addresses',
      'No street visiting address: Suomi.fi does not show service locations without one.',
    );
  }

  serviceHourFindings(channel.serviceHours ?? [], today, warn);
  if (channel.channelType === 'EChannel' && channel.accessibility === undefined) {
    warn(
      'Q-CONTACT-1',
      'accessibility',
      'Accessibility is not given; use Unknown ("Ei tietoa") unless it has been assessed.',
    );
  }
  return findings;
}

/** Checks a service channel against the deterministic rules. */
export function checkChannel(
  channel: ServiceChannel,
  context: ChannelCheckContext = {},
): QualityReport {
  // Channels read without summaries (e.g. v12 today) skip the summary checks.
  const findings = textFieldFindings(channel.names, channel.summaries, channel.descriptions);
  findings.push(
    ...channelDetailFindings(channel, context.today ?? new Date().toISOString().slice(0, 10)),
  );
  if (channel.languages.length === 0) {
    findings.push({
      checkId: 'Q-LANG-1',
      severity: 'error',
      field: 'languages',
      message: 'No languages the channel serves in.',
    });
  }
  if (context.connectedServiceCount === 0) {
    findings.push(
      context.creating
        ? {
            checkId: 'Q-STRUCT-5',
            severity: 'warning',
            field: 'serviceIds',
            message:
              "Not connected to a service yet. Give serviceIds, or once the channel exists, add its id to the service's serviceChannelIds.",
          }
        : {
            checkId: 'Q-STRUCT-5',
            severity: 'error',
            field: 'connections',
            message: 'Not connected to any service; every channel needs at least one.',
          },
    );
  }
  return report(findings);
}

/**
 * Checks a connection's extra info (liitoksen lisätiedot): its texts like
 * any free text (contact details belong in the connection's own contact
 * fields, Q-STRUCT-1), a charge that is Other needs its explanation, and
 * phones and hours as on channels.
 */
export function checkConnection(
  details: ConnectionDetails,
  context: { today?: string } = {},
): QualityReport {
  const findings: QualityFinding[] = [];
  for (const field of ['descriptions', 'chargeDescriptions'] as const) {
    for (const [language, value] of Object.entries(details[field] ?? {})) {
      const text = textOf(value);
      if (text) findings.push(...freeTextFindings(field, language, text));
    }
  }
  const warn = warner(findings);
  if (
    details.chargeType === 'Other' &&
    !Object.values(details.chargeDescriptions ?? {}).some(Boolean)
  ) {
    warn(
      'Q-CONTACT-1',
      'chargeDescriptions',
      'The charge type is Other: explain the charge in chargeDescriptions.',
    );
  }
  phoneFindings('phoneNumbers', details.phoneNumbers ?? [], warn);
  serviceHourFindings(
    details.serviceHours ?? [],
    context.today ?? new Date().toISOString().slice(0, 10),
    warn,
  );
  return report(findings);
}

/**
 * Checks an organisation (DVV's organisation guidelines): every language
 * version has a name, a summary that doesn't repeat the name and a
 * description of at most 2500 characters, without contact details; phones
 * as on channels.
 */
export function checkOrganization(organization: Partial<Organization>): QualityReport {
  const findings = textFieldFindings(
    organization.names ?? {},
    organization.summaries ?? {},
    organization.descriptions ?? {},
    ORGANIZATION_DESCRIPTION_MAX,
  );
  phoneFindings('phoneNumbers', organization.phoneNumbers ?? [], warner(findings));
  return report(findings);
}
