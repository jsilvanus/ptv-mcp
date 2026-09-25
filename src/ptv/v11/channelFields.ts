import type {
  AccessibilityLevel,
  ChannelAddress,
  FormFile,
  LanguageValue,
  LocalizedText,
  OpeningTime,
  PhoneNumber,
  ServiceHour,
  WebLink,
  Weekday,
} from '../domain.js';
import { expandOpeningTimes, WEEKDAYS } from '../serviceHours.js';

/**
 * v11 wire shapes of the type-specific channel fields and their
 * conversions to and from the domain model (src/ptv/domain.ts). The GET
 * and In (POST/PUT) schemas differ in places, noted per function; see
 * docs/ptv-v11-notes.md's "Channel fields" section.
 */

export interface V11LanguageItem {
  language: string;
  value: string;
}

export interface V11Phone {
  number: string;
  language: string;
  prefixNumber?: string | null;
  isFinnishServiceNumber?: boolean | null;
  additionalInformation?: string | null;
  serviceChargeType?: string | null;
  chargeDescription?: string | null;
  /** Phone, Sms or Fax; only on typed lists. */
  type?: string | null;
}

export interface V11WebPage {
  url: string;
  value?: string | null;
  language: string;
}

export interface V11OpeningTime {
  dayFrom?: string | null;
  dayTo?: string | null;
  from: string;
  to: string;
}

export interface V11ServiceHour {
  serviceHourType: string;
  validFrom?: string | null;
  validTo?: string | null;
  isClosed?: boolean | null;
  validForNow?: boolean | null;
  isAlwaysOpen?: boolean | null;
  isReservation?: boolean | null;
  additionalInformation?: V11LanguageItem[] | null;
  openingHour?: V11OpeningTime[] | null;
}

interface V11Municipality {
  code?: string | null;
}

export interface V11StreetAddress {
  street?: V11LanguageItem[] | null;
  streetNumber?: string | null;
  postalCode?: string | null;
  /** An object on GET, a code string on In. */
  municipality?: V11Municipality | string | null;
  additionalInformation?: V11LanguageItem[] | null;
  latitude?: string | null;
  longitude?: string | null;
}

export interface V11PostOfficeBoxAddress {
  postOfficeBox?: V11LanguageItem[] | null;
  postalCode?: string | null;
  municipality?: V11Municipality | string | null;
  additionalInformation?: V11LanguageItem[] | null;
}

export interface V11LocationAddress {
  type?: string | null;
  subType?: string | null;
  country?: string | null;
  streetAddress?: V11StreetAddress | null;
  otherAddress?: V11StreetAddress | null;
  postOfficeBoxAddress?: V11PostOfficeBoxAddress | null;
  locationAbroad?: V11LanguageItem[] | null;
  /** In-name of locationAbroad. */
  foreignAddress?: V11LanguageItem[] | null;
}

export interface V11DeliveryAddress {
  subType?: string | null;
  streetAddress?: V11StreetAddress | null;
  postOfficeBoxAddress?: V11PostOfficeBoxAddress | null;
  deliveryAddressInText?: V11LanguageItem[] | null;
  /** GET name; In uses formReceiver. */
  receiver?: V11LanguageItem[] | null;
  formReceiver?: V11LanguageItem[] | null;
}

export interface V11AccessibilityClassification {
  accessibilityClassificationLevel?: string | null;
  language: string;
}

export function languageItemsToText(items: V11LanguageItem[] | null | undefined): LocalizedText {
  const text: LocalizedText = {};
  for (const item of items ?? []) {
    if (item.value && text[item.language] === undefined) text[item.language] = item.value;
  }
  return text;
}

export function textToLanguageItems(text: LocalizedText | undefined): V11LanguageItem[] {
  return Object.entries(text ?? {})
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([language, value]) => ({ language, value }));
}

function nonEmpty(text: LocalizedText): LocalizedText | undefined {
  return Object.keys(text).length > 0 ? text : undefined;
}

export function languageValues(items: V11LanguageItem[] | null | undefined): LanguageValue[] {
  return (items ?? [])
    .filter((item) => !!item.value)
    .map((item) => ({ language: item.language, value: item.value }));
}

/** v11 charge types, with the pre-v8 names PTV still returns on old data. */
export const CHARGE_TYPES: Record<string, PhoneNumber['chargeType']> = {
  Chargeable: 'Chargeable',
  Charged: 'Chargeable',
  FreeOfCharge: 'FreeOfCharge',
  Free: 'FreeOfCharge',
  Other: 'Other',
};

export function phoneToDomain(wire: V11Phone): PhoneNumber {
  const type = wire.type === 'Sms' || wire.type === 'Fax' ? wire.type : undefined;
  const chargeType = wire.serviceChargeType ? CHARGE_TYPES[wire.serviceChargeType] : undefined;
  return {
    language: wire.language,
    ...(type ? { type } : wire.type ? { type: 'Phone' as const } : {}),
    ...(wire.prefixNumber ? { prefixNumber: wire.prefixNumber } : {}),
    number: wire.number,
    ...(wire.isFinnishServiceNumber ? { isFinnishServiceNumber: true } : {}),
    ...(wire.additionalInformation ? { additionalInformation: wire.additionalInformation } : {}),
    ...(chargeType ? { chargeType } : {}),
    ...(wire.chargeDescription ? { chargeDescription: wire.chargeDescription } : {}),
  };
}

/** `withType` for V4VmOpenApiPhoneWithType lists (phone channel numbers). */
export function phoneToWire(phone: PhoneNumber, withType = false): V11Phone {
  return {
    language: phone.language,
    number: phone.number,
    ...(phone.isFinnishServiceNumber
      ? { isFinnishServiceNumber: true }
      : { prefixNumber: phone.prefixNumber ?? '+358' }),
    ...(phone.additionalInformation ? { additionalInformation: phone.additionalInformation } : {}),
    serviceChargeType: phone.chargeType ?? 'Chargeable',
    ...(phone.chargeDescription ? { chargeDescription: phone.chargeDescription } : {}),
    ...(withType ? { type: phone.type ?? 'Phone' } : {}),
  };
}

export function webPageToDomain(wire: V11WebPage): WebLink {
  return {
    language: wire.language,
    url: wire.url,
    ...(wire.value ? { name: wire.value } : {}),
  };
}

export function webLinkToWire(link: WebLink): V11WebPage {
  return { language: link.language, url: link.url, ...(link.name ? { value: link.name } : {}) };
}

/** First URL per language, for channels whose web page is their address. */
export function webPagesToUrls(pages: V11WebPage[] | null | undefined): LocalizedText {
  const urls: LocalizedText = {};
  for (const page of pages ?? []) {
    if (page.url && urls[page.language] === undefined) urls[page.language] = page.url;
  }
  return urls;
}

/** PTV writes and returns times as HH:mm:ss; the domain uses HH:mm. */
function shortTime(time: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  return match ? `${match[1]!.padStart(2, '0')}:${match[2]}` : time;
}

function weekday(value: string | null | undefined): Weekday | undefined {
  return WEEKDAYS.find((day) => day === value);
}

/** Dates come back as ISO date-times; the domain keeps the date. */
function isoDate(value: string | null | undefined): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

export function serviceHourToDomain(wire: V11ServiceHour): ServiceHour {
  const type =
    wire.serviceHourType === 'Exceptional' || wire.serviceHourType === 'Exception'
      ? 'Exceptional'
      : wire.serviceHourType === 'OverMidnight' || wire.serviceHourType === 'Special'
        ? 'OverMidnight'
        : 'DaysOfTheWeek';
  const openingTimes: OpeningTime[] = (wire.openingHour ?? []).flatMap((time) => {
    const dayFrom = weekday(time.dayFrom);
    if (!dayFrom) return [];
    const dayTo = weekday(time.dayTo);
    return [
      {
        dayFrom,
        ...(dayTo ? { dayTo } : {}),
        from: shortTime(time.from),
        to: shortTime(time.to),
      },
    ];
  });
  const validFrom = isoDate(wire.validFrom);
  const validTo = isoDate(wire.validTo);
  const additionalInformation = nonEmpty(languageItemsToText(wire.additionalInformation));
  return {
    type,
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    ...(wire.validForNow ? { validForNow: true } : {}),
    ...(wire.isClosed ? { isClosed: true } : {}),
    ...(wire.isAlwaysOpen ? { isAlwaysOpen: true } : {}),
    ...(wire.isReservation ? { isReservation: true } : {}),
    ...(additionalInformation ? { additionalInformation } : {}),
    ...(openingTimes.length > 0 ? { openingTimes } : {}),
  };
}

export function serviceHourToWire(hour: ServiceHour): V11ServiceHour {
  const validForNow = hour.validForNow ?? !hour.validTo;
  return {
    serviceHourType: hour.type,
    ...(hour.validFrom ? { validFrom: hour.validFrom } : {}),
    ...(hour.validTo ? { validTo: hour.validTo } : {}),
    validForNow,
    isClosed: hour.isClosed ?? false,
    isAlwaysOpen: hour.isAlwaysOpen ?? false,
    isReservation: hour.isReservation ?? false,
    ...(hour.additionalInformation
      ? { additionalInformation: textToLanguageItems(hour.additionalInformation) }
      : {}),
    openingHour: expandOpeningTimes(hour).map((time) => ({
      dayFrom: time.dayFrom,
      ...(time.dayTo ? { dayTo: time.dayTo } : {}),
      from: time.from,
      to: time.to,
    })),
  };
}

function municipalityCode(value: V11Municipality | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? value : (value.code ?? undefined);
}

function streetToDomain(street: V11StreetAddress): Partial<ChannelAddress> {
  const municipality = municipalityCode(street.municipality);
  const streetText = nonEmpty(languageItemsToText(street.street));
  const additionalInformation = nonEmpty(languageItemsToText(street.additionalInformation));
  return {
    ...(streetText ? { street: streetText } : {}),
    ...(street.streetNumber ? { streetNumber: street.streetNumber } : {}),
    ...(street.postalCode ? { postalCode: street.postalCode } : {}),
    ...(municipality ? { municipality } : {}),
    ...(street.latitude ? { latitude: street.latitude } : {}),
    ...(street.longitude ? { longitude: street.longitude } : {}),
    ...(additionalInformation ? { additionalInformation } : {}),
  };
}

function postOfficeBoxToDomain(box: V11PostOfficeBoxAddress): Partial<ChannelAddress> {
  const postOfficeBox = nonEmpty(languageItemsToText(box.postOfficeBox));
  const additionalInformation = nonEmpty(languageItemsToText(box.additionalInformation));
  return {
    ...(postOfficeBox ? { postOfficeBox } : {}),
    ...(box.postalCode ? { postalCode: box.postalCode } : {}),
    ...(additionalInformation ? { additionalInformation } : {}),
  };
}

export function locationAddressToDomain(wire: V11LocationAddress): ChannelAddress {
  const purpose = wire.type === 'Postal' ? ('Postal' as const) : ('Visiting' as const);
  switch (wire.subType) {
    case 'Other':
      return { kind: 'Other', purpose, ...streetToDomain(wire.otherAddress ?? {}) };
    case 'Abroad': {
      const text = nonEmpty(languageItemsToText(wire.locationAbroad ?? wire.foreignAddress));
      return { kind: 'Foreign', purpose, ...(text ? { text } : {}) };
    }
    case 'PostOfficeBox':
      return {
        kind: 'PostOfficeBox',
        purpose,
        ...postOfficeBoxToDomain(wire.postOfficeBoxAddress ?? {}),
      };
    default:
      return { kind: 'Street', purpose, ...streetToDomain(wire.streetAddress ?? {}) };
  }
}

export function streetToWire(address: ChannelAddress): V11StreetAddress {
  return {
    ...(address.street ? { street: textToLanguageItems(address.street) } : {}),
    ...(address.streetNumber ? { streetNumber: address.streetNumber } : {}),
    ...(address.postalCode ? { postalCode: address.postalCode } : {}),
    ...(address.latitude ? { latitude: address.latitude } : {}),
    ...(address.longitude ? { longitude: address.longitude } : {}),
    ...(address.additionalInformation
      ? { additionalInformation: textToLanguageItems(address.additionalInformation) }
      : {}),
  };
}

export function postOfficeBoxToWire(address: ChannelAddress): V11PostOfficeBoxAddress {
  return {
    postOfficeBox: textToLanguageItems(address.postOfficeBox),
    ...(address.postalCode ? { postalCode: address.postalCode } : {}),
    ...(address.additionalInformation
      ? { additionalInformation: textToLanguageItems(address.additionalInformation) }
      : {}),
  };
}

/** V9VmOpenApiAddressLocationIn. */
export function locationAddressToWire(address: ChannelAddress): V11LocationAddress {
  const type = address.purpose === 'Postal' ? 'Postal' : 'Location';
  switch (address.kind) {
    case 'Other':
      return { type, subType: 'Other', otherAddress: streetToWire(address) };
    case 'Foreign':
      return { type, subType: 'Abroad', foreignAddress: textToLanguageItems(address.text) };
    case 'PostOfficeBox':
      return { type, subType: 'PostOfficeBox', postOfficeBoxAddress: postOfficeBoxToWire(address) };
    default:
      return { type, subType: 'Street', streetAddress: streetToWire(address) };
  }
}

export function deliveryAddressToDomain(wire: V11DeliveryAddress): ChannelAddress {
  const receiver = nonEmpty(languageItemsToText(wire.receiver ?? wire.formReceiver));
  const base = receiver ? { receiver } : {};
  if (wire.subType === 'PostOfficeBox') {
    return {
      kind: 'PostOfficeBox',
      ...base,
      ...postOfficeBoxToDomain(wire.postOfficeBoxAddress ?? {}),
    };
  }
  if (wire.subType === 'Street') {
    return { kind: 'Street', ...base, ...streetToDomain(wire.streetAddress ?? {}) };
  }
  const text = nonEmpty(languageItemsToText(wire.deliveryAddressInText));
  return { kind: 'NoAddress', ...base, ...(text ? { text } : {}) };
}

/** V8VmOpenApiAddressDeliveryIn. */
export function deliveryAddressToWire(address: ChannelAddress): V11DeliveryAddress {
  const receiver = address.receiver ? { formReceiver: textToLanguageItems(address.receiver) } : {};
  if (address.kind === 'PostOfficeBox') {
    return {
      subType: 'PostOfficeBox',
      ...receiver,
      postOfficeBoxAddress: postOfficeBoxToWire(address),
    };
  }
  if (address.kind === 'Street') {
    return { subType: 'Street', ...receiver, streetAddress: streetToWire(address) };
  }
  return {
    subType: 'NoAddress',
    ...receiver,
    deliveryAddressInText: textToLanguageItems(address.text),
  };
}

const ACCESSIBILITY_LEVELS: AccessibilityLevel[] = [
  'FullyCompliant',
  'PartiallyCompliant',
  'NonCompliant',
  'Unknown',
];

/** v11 has one level per language; the domain keeps the first. */
export function accessibilityToDomain(
  items: V11AccessibilityClassification[] | null | undefined,
): AccessibilityLevel | undefined {
  const level = (items ?? [])[0]?.accessibilityClassificationLevel;
  return ACCESSIBILITY_LEVELS.find((candidate) => candidate === level);
}

export function accessibilityToWire(
  level: AccessibilityLevel,
  languages: string[],
): V11AccessibilityClassification[] {
  return languages.map((language) => ({ accessibilityClassificationLevel: level, language }));
}

const FORM_FORMATS: FormFile['format'][] = ['PDF', 'DOC', 'Excel'];

export function formFilesToDomain(
  items: { language: string; value?: string | null; type?: string | null }[] | null | undefined,
): FormFile[] {
  return (items ?? []).flatMap((item) => {
    const format = FORM_FORMATS.find((candidate) => candidate === item.type);
    return format && item.value ? [{ language: item.language, format, url: item.value }] : [];
  });
}

export function formFilesToWire(
  files: FormFile[],
): { language: string; value: string; type: string }[] {
  return files.map((file) => ({ language: file.language, value: file.url, type: file.format }));
}
