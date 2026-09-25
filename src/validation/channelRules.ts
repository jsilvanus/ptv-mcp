import type {
  ChannelAddress,
  ConnectionDetails,
  PhoneNumber,
  ServiceChannel,
  ServiceHour,
} from '../ptv/domain.js';
import type { ValidationError, ValidationResult } from './changeValidator.js';

/**
 * PTV's hard rules for the type-specific channel fields (the v11 In
 * schemas and DVV's channel guidelines): things PTV rejects or that break
 * the data, not style (style is src/quality/contentChecks.ts). `creating`
 * adds the fields PTV requires on POST.
 */

export const SUMMARY_MAX = 150;
const PHONE_MAX = 20;
const PHONE_TEXT_MAX = 300;
const URL_MAX = 500;
const HOUR_INFO_MAX = 150;
const ADDRESS_INFO_MAX = 150;
const CONNECTION_TEXT_MAX = 500;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTAL_CODE = /^\d{5}$/;
/** PTV accepts phone numbers in fi, sv and en only (V4VmOpenApiPhone). */
const PHONE_LANGUAGES = ['fi', 'sv', 'en'];

export function checkUrl(url: string, field: string, errors: ValidationError[]): void {
  if (!/^https?:\/\//i.test(url)) {
    errors.push({ field, message: `URL must start with http:// or https://: ${url}` });
  } else if (url.length > URL_MAX) {
    errors.push({ field, message: `URL is longer than ${URL_MAX} characters` });
  }
  if (/^https?:\/\/tunnistautuminen\.suomi\.fi/i.test(url)) {
    errors.push({
      field,
      message:
        'Do not link to tunnistautuminen.suomi.fi (customers end on an error page); use the page where authentication starts in the service itself',
    });
  }
}

export function checkPhone(phone: PhoneNumber, field: string, errors: ValidationError[]): void {
  const digits = phone.number.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) {
    errors.push({
      field,
      message: `Phone number may contain only digits and spaces: ${phone.number}`,
    });
  }
  if (phone.number.length > PHONE_MAX) {
    errors.push({ field, message: `Phone number is longer than ${PHONE_MAX} characters` });
  }
  if (!phone.isFinnishServiceNumber) {
    if (digits.startsWith('0')) {
      errors.push({
        field,
        message: `Write a normal phone number without the leading 0 and give prefixNumber (e.g. +358): ${phone.number}`,
      });
    }
    if (phone.prefixNumber && !/^\+\d{1,4}$/.test(phone.prefixNumber)) {
      errors.push({ field, message: `prefixNumber must look like +358: ${phone.prefixNumber}` });
    }
  }
  if (!PHONE_LANGUAGES.includes(phone.language)) {
    errors.push({
      field,
      message: `Phone numbers can be given in fi, sv or en, not ${phone.language}`,
    });
  }
  if ((phone.additionalInformation?.length ?? 0) > PHONE_TEXT_MAX) {
    errors.push({
      field,
      message: `additionalInformation is longer than ${PHONE_TEXT_MAX} characters`,
    });
  }
  if ((phone.chargeDescription?.length ?? 0) > PHONE_TEXT_MAX) {
    errors.push({
      field,
      message: `chargeDescription is longer than ${PHONE_TEXT_MAX} characters`,
    });
  }
}

function checkServiceHour(hour: ServiceHour, field: string, errors: ValidationError[]): void {
  for (const date of [hour.validFrom, hour.validTo]) {
    if (date !== undefined && !DATE.test(date)) {
      errors.push({ field, message: `Dates are written YYYY-MM-DD: ${date}` });
    }
  }
  if (hour.validFrom && hour.validTo && hour.validTo < hour.validFrom) {
    errors.push({ field, message: 'validTo is before validFrom' });
  }
  if (hour.type === 'Exceptional' && !hour.validFrom) {
    errors.push({ field, message: 'An exceptional service hour needs validFrom' });
  }
  const times = hour.openingTimes ?? [];
  if (times.length === 0 && !hour.isAlwaysOpen && !hour.isReservation && !hour.isClosed) {
    errors.push({
      field,
      message: 'Give openingTimes, or set isAlwaysOpen, isReservation or isClosed',
    });
  }
  for (const time of times) {
    if (!TIME.test(time.from) || !TIME.test(time.to)) {
      errors.push({ field, message: `Opening times are written HH:mm: ${time.from}–${time.to}` });
    } else if (hour.type !== 'OverMidnight' && time.to <= time.from && time.to !== '00:00') {
      errors.push({
        field,
        message: `${time.dayFrom} ${time.from}–${time.to} ends before it starts; use an OverMidnight hour`,
      });
    }
  }
  for (const text of Object.values(hour.additionalInformation ?? {})) {
    if ((text?.length ?? 0) > HOUR_INFO_MAX) {
      errors.push({
        field,
        message: `Service hour title is longer than ${HOUR_INFO_MAX} characters`,
      });
    }
  }
}

export function checkAddress(
  address: ChannelAddress,
  field: string,
  errors: ValidationError[],
  delivery: boolean,
): void {
  if (address.kind === 'Street') {
    if (!Object.values(address.street ?? {}).some(Boolean)) {
      errors.push({ field, message: 'A street address needs the street name' });
    }
    if (!address.postalCode || !POSTAL_CODE.test(address.postalCode)) {
      errors.push({ field, message: 'A street address needs a five-digit postalCode' });
    }
    if (address.street && Object.values(address.street).some((s) => /\d/.test(s ?? ''))) {
      errors.push({
        field,
        message: 'Put the street number in streetNumber, not in the street name',
      });
    }
  }
  if (address.kind === 'Other' && (!address.latitude || !address.longitude)) {
    errors.push({
      field,
      message: 'An address without a street address needs latitude and longitude',
    });
  }
  if (
    address.kind === 'Other' &&
    !Object.values(address.additionalInformation ?? {}).some(Boolean)
  ) {
    errors.push({
      field,
      message: 'An address without a street address needs additionalInformation',
    });
  }
  if (
    (address.kind === 'Foreign' || address.kind === 'NoAddress') &&
    !Object.values(address.text ?? {}).some(Boolean)
  ) {
    errors.push({ field, message: `A ${address.kind} address needs its text` });
  }
  if (
    address.kind === 'PostOfficeBox' &&
    !Object.values(address.postOfficeBox ?? {}).some(Boolean)
  ) {
    errors.push({ field, message: 'A post office box address needs postOfficeBox' });
  }
  if (!delivery && address.kind === 'NoAddress') {
    errors.push({ field, message: 'NoAddress is only for printable form delivery addresses' });
  }
  if (delivery && address.kind === 'Other') {
    errors.push({ field, message: 'A delivery address is Street, PostOfficeBox or NoAddress' });
  }
  for (const text of Object.values(address.additionalInformation ?? {})) {
    if ((text?.length ?? 0) > ADDRESS_INFO_MAX) {
      errors.push({
        field,
        message: `Address additional information is longer than ${ADDRESS_INFO_MAX} characters`,
      });
    }
  }
}

/** Phone numbers, emails, web pages and service hours, wherever they appear. */
export function checkContactDetails(
  fields: {
    phoneNumbers?: PhoneNumber[] | undefined;
    emails?: { value: string }[] | undefined;
    webPages?: { url: string }[] | undefined;
    serviceHours?: ServiceHour[] | undefined;
  },
  errors: ValidationError[],
): void {
  (fields.webPages ?? []).forEach((page, i) => checkUrl(page.url, `webPages[${i}]`, errors));
  (fields.phoneNumbers ?? []).forEach((phone, i) =>
    checkPhone(phone, `phoneNumbers[${i}]`, errors),
  );
  (fields.emails ?? []).forEach((email) => {
    if (!EMAIL.test(email.value)) {
      errors.push({ field: 'emails', message: `Not an email address: ${email.value}` });
    }
  });
  (fields.serviceHours ?? []).forEach((hour, i) =>
    checkServiceHour(hour, `serviceHours[${i}]`, errors),
  );
}

export function validateChannelDetails(
  channel: ServiceChannel,
  errors: ValidationError[],
  creating: boolean,
): void {
  // Language versions (the languages it is described in), not `languages`.
  const languages = Object.keys(channel.names ?? {}).filter((language) => channel.names[language]);
  for (const [language, summary] of Object.entries(channel.summaries ?? {})) {
    if ((summary?.length ?? 0) > SUMMARY_MAX) {
      errors.push({
        field: `summaries.${language}`,
        message: `Longer than ${SUMMARY_MAX} characters`,
      });
    }
  }
  for (const [language, url] of Object.entries(channel.urls ?? {})) {
    if (url) checkUrl(url, `urls.${language}`, errors);
  }
  (channel.formFiles ?? []).forEach((file, i) => checkUrl(file.url, `formFiles[${i}]`, errors));
  (channel.supportPhones ?? []).forEach((phone, i) =>
    checkPhone(phone, `supportPhones[${i}]`, errors),
  );
  checkContactDetails(
    { ...channel, emails: [...(channel.emails ?? []), ...(channel.supportEmails ?? [])] },
    errors,
  );
  (channel.addresses ?? []).forEach((address, i) =>
    checkAddress(address, `addresses[${i}]`, errors, false),
  );
  (channel.deliveryAddresses ?? []).forEach((address, i) =>
    checkAddress(address, `deliveryAddresses[${i}]`, errors, true),
  );
  if (channel.requiresSignature && !(channel.signatureQuantity && channel.signatureQuantity > 0)) {
    errors.push({ field: 'signatureQuantity', message: 'Required when requiresSignature is true' });
  }

  // What each type must have (the v11 In schemas' required fields).
  const type = channel.channelType;
  if (type === 'EChannel' || type === 'WebPage') {
    const missing = languages.filter((language) => !channel.urls?.[language]);
    if (missing.length > 0 && (creating || channel.urls !== undefined)) {
      errors.push({
        field: 'urls',
        message: `Give the web address for every language version: ${missing.join(', ')}`,
      });
    }
  }
  if (type === 'Phone' && (creating || channel.phoneNumbers !== undefined)) {
    const missing = languages.filter(
      (language) =>
        PHONE_LANGUAGES.includes(language) &&
        !(channel.phoneNumbers ?? []).some((phone) => phone.language === language),
    );
    if ((channel.phoneNumbers ?? []).length === 0) {
      errors.push({ field: 'phoneNumbers', message: 'A phone channel needs at least one number' });
    } else if (missing.length > 0) {
      errors.push({
        field: 'phoneNumbers',
        message: `Give at least one number for every language version: ${missing.join(', ')}`,
      });
    }
  }
  if (type === 'ServiceLocation' && (creating || channel.addresses !== undefined)) {
    if (!(channel.addresses ?? []).some((address) => address.purpose !== 'Postal')) {
      errors.push({ field: 'addresses', message: 'A service location needs a visiting address' });
    }
  }
  if (type === 'PrintableForm' && (creating || channel.formFiles !== undefined)) {
    if ((channel.formFiles ?? []).length === 0) {
      errors.push({
        field: 'formFiles',
        message: 'A printable form needs at least one form file URL',
      });
    }
  }
}

const CHARGE_TYPES = ['Chargeable', 'FreeOfCharge', 'Other'];
const CONNECTION_ADDRESS_KINDS = ['Street', 'PostOfficeBox', 'Foreign'];

/**
 * PTV's rules for a connection's extra info (V11VmOpenApiServiceServiceChannelInBase):
 * texts max 500 characters, contact details as on channels, and postal
 * addresses only.
 */
export function validateConnectionDetails(details: ConnectionDetails): ValidationResult {
  const errors: ValidationError[] = [];
  if (details.chargeType !== undefined && !CHARGE_TYPES.includes(details.chargeType)) {
    errors.push({
      field: 'chargeType',
      message: `chargeType is one of ${CHARGE_TYPES.join(', ')}`,
    });
  }
  for (const field of ['descriptions', 'chargeDescriptions'] as const) {
    for (const [language, text] of Object.entries(details[field] ?? {})) {
      if ((text?.length ?? 0) > CONNECTION_TEXT_MAX) {
        errors.push({
          field: `${field}.${language}`,
          message: `Longer than ${CONNECTION_TEXT_MAX} characters`,
        });
      }
    }
  }
  checkContactDetails(details, errors);
  (details.addresses ?? []).forEach((address, i) => {
    if (!CONNECTION_ADDRESS_KINDS.includes(address.kind)) {
      errors.push({
        field: `addresses[${i}]`,
        message: `A connection's address is a postal address: ${CONNECTION_ADDRESS_KINDS.join(', ')}`,
      });
      return;
    }
    checkAddress(address, `addresses[${i}]`, errors, false);
  });
  return { valid: errors.length === 0, errors };
}
