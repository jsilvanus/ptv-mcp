import type { CodeListEntry, Service } from '../../domain.js';
import type {
  V12Described,
  V12IdRef,
  V12Names,
  V12OrganizationRef,
  V12Timestamps,
} from '../wireModel.js';

/** The content id every v12 item needs; `what` names the item in the error. */
export function contentIdOf(wire: { contentId?: string; id?: string }, what: string): string {
  const id = wire.contentId ?? wire.id;
  if (!id) throw new Error(`PTV v12 ${what} response has no contentId`);
  return id;
}

export function namesOf(wire: V12Names): Record<string, string> {
  return localized(wire.names ?? wire.name ?? wire.languageVersions, 'name');
}

export function descriptionsOf(wire: V12Described): Record<string, string> {
  return localized(wire.descriptions ?? wire.description ?? wire.languageVersions, 'description');
}

/** The declared languages, else the languages that have a language version. */
export function languagesOf(wire: {
  languages?: string[];
  serviceLanguages?: string[];
  languageVersions?: Record<string, unknown>;
}): string[] {
  return (
    wire.languages ??
    wire.serviceLanguages ??
    (wire.languageVersions ? Object.keys(wire.languageVersions) : [])
  );
}

export function organizationIdOf(wire: V12OrganizationRef): string {
  return (
    wire.organizationContentId ??
    wire.organizationId ??
    wire.organization?.organizationContentId ??
    wire.organization?.contentId ??
    wire.organization?.id ??
    wire.organization?.organizationId ??
    ''
  );
}

export function modifiedAtOf(wire: V12Timestamps): string | undefined {
  const value =
    wire.modifiedAt ?? wire.modified ?? wire.lastModified ?? wire.lastModifiedAt ?? wire.updatedAt;
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getTime() !== 0) return date.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime()) && date.getTime() !== 0) return date.toISOString();
  }
  return undefined;
}

export function modifiedAtField(wire: V12Timestamps): { modifiedAt?: string } {
  const modifiedAt = modifiedAtOf(wire);
  return modifiedAt ? { modifiedAt } : {};
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

export function isUri(value: string): boolean {
  return /^https?:\/\//.test(value);
}

/** PTV sends `""` for missing translations; treat those as absent. */
export function localized(value: unknown, preferredField?: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(localizedWithEmpty(value, preferredField)).filter(
      ([, text]) => text.trim() !== '',
    ),
  );
}

function localizedWithEmpty(value: unknown, preferredField?: string): Record<string, string> {
  if (!value) return {};

  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const e = entry as Record<string, unknown>;
        const language = String(e.languageCode ?? e.language ?? e.lang ?? '');
        const text = preferredField ? e[preferredField] : (e.value ?? e.text ?? e.description);
        return language && typeof text === 'string' ? [[language, text]] : [];
      }),
    );
  }

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;

    if (preferredField && typeof object[preferredField] === 'string') {
      return { fi: object[preferredField] as string };
    }

    if (preferredField && 'languageVersions' in object) {
      return localized(object.languageVersions, preferredField);
    }

    const entries = Object.entries(object).flatMap(([language, entry]) => {
      if (typeof entry === 'string') return [[language, entry] as [string, string]];
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      const text = preferredField ? e[preferredField] : (e.value ?? e.text ?? e.description);
      return typeof text === 'string' ? [[language, text] as [string, string]] : [];
    });
    return Object.fromEntries(entries);
  }

  if (typeof value === 'string') return { fi: value };
  return {};
}

export function codeEntries(values: unknown[] | undefined): CodeListEntry[] {
  if (!values) return [];

  return values.map((value) => {
    // v12 sends bare strings: a URI for ontology terms and industrial
    // classes, a code for the rest. withCodeNames fills in the other half.
    if (typeof value === 'string') {
      return isUri(value) ? { uri: value, names: {} } : { code: value, names: {} };
    }
    if (!value || typeof value !== 'object') return { names: {} };

    const v = value as Record<string, unknown>;
    const code = firstString(v.code, v.contentId, v.id, v.value);
    const names = localized(
      v.names ?? v.name ?? v.languageVersions ?? v.displayName ?? v.label,
      'name',
    );

    return {
      ...(code ? { code } : {}),
      ...(typeof v.uri === 'string' ? { uri: v.uri } : {}),
      names,
    };
  });
}

export function ids(values: V12IdRef[] | undefined): string[] {
  return (values ?? []).flatMap((value) => {
    if (typeof value === 'string') return [value];
    const id = value.contentId ?? value.id;
    return id ? [id] : [];
  });
}

export function normalizeServiceType(value: string | undefined): Service['serviceType'] {
  if (value === 'ProfessionalQualification' || value === 'PermitOrObligation') return value;
  // v12's wire name for the same subtype.
  if (value === 'PermitOrOtherObligation') return 'PermitOrObligation';
  return 'Service';
}

export function normalizePublishingStatus(value: string | undefined): Service['publishingStatus'] {
  if (value === 'Draft' || value === 'Modified' || value === 'Archived' || value === 'Withdrawn')
    return value;
  return 'Published';
}
