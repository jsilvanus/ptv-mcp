import { describe, expect, it } from 'vitest';
import { organizationWireToDomain } from './mappers/organization.js';
import {
  newOrganizationToV11Body,
  organizationAreaToV11Post,
  organizationChangesToV11Body,
} from './organizationWrite.js';
import type { V11OrganizationWire } from './wireModel.js';

/** A parish as GET /api/v11/Organization/{id} returns it (fields trimmed). */
const wire: V11OrganizationWire = {
  id: 'org-1',
  parentOrganizationId: 'root',
  businessCode: '0204819-8',
  publishingStatus: 'Published',
  organizationType: 'Organization',
  organizationNames: [
    { language: 'fi', value: 'Testin seurakunta', type: 'Name' },
    { language: 'fi', value: 'Testin srk', type: 'AlternativeName' },
    { language: 'sv', value: 'Testens församling', type: 'Name' },
  ],
  displayNameType: [
    { language: 'fi', type: 'AlternativeName' },
    { language: 'sv', type: 'Name' },
  ],
  organizationDescriptions: [
    { language: 'fi', value: 'Seurakunta palvelee jäseniään.', type: 'Description' },
    { language: 'fi', value: 'Evankelis-luterilainen seurakunta', type: 'Summary' },
  ],
  areaType: 'LimitedType',
  areas: [
    { type: 'Municipality', code: '694' },
    { type: 'Municipality', code: '165' },
  ],
  emails: [{ language: 'fi', value: 'kirjaamo@example.fi' }],
  phoneNumbers: [
    { number: '19123456', prefixNumber: '+358', language: 'fi', serviceChargeType: 'Chargeable' },
  ],
  webPages: [{ url: 'https://example.fi', value: 'Seurakunta', language: 'fi' }],
  addresses: [
    {
      type: 'Visiting',
      subType: 'Street',
      streetAddress: {
        street: [{ language: 'fi', value: 'Kirkkokatu' }],
        streetNumber: '1',
        postalCode: '11100',
        municipality: { code: '694' },
      },
    },
    {
      type: 'Postal',
      subType: 'Foreign',
      foreignAddress: [{ language: 'fi', value: 'Box 1, Stockholm' }],
    },
  ],
  modified: '2026-09-24T00:00:00',
};

describe('organizationWireToDomain', () => {
  it('reads names by type, texts, area and contact details', () => {
    const org = organizationWireToDomain(wire);
    expect(org).toMatchObject({
      names: { fi: 'Testin seurakunta', sv: 'Testens församling' },
      alternativeNames: { fi: 'Testin srk' },
      alternativeNameShownIn: ['fi'],
      summaries: { fi: 'Evankelis-luterilainen seurakunta' },
      descriptions: { fi: 'Seurakunta palvelee jäseniään.' },
      organizationType: 'Organization',
      area: {
        areaType: 'LimitedType',
        areas: [
          { type: 'Municipality', code: '694' },
          { type: 'Municipality', code: '165' },
        ],
      },
      emails: [{ language: 'fi', value: 'kirjaamo@example.fi' }],
      webPages: [{ url: 'https://example.fi', name: 'Seurakunta', language: 'fi' }],
    });
    expect(org.addresses).toEqual([
      expect.objectContaining({ kind: 'Street', purpose: 'Visiting', streetNumber: '1' }),
      { kind: 'Foreign', purpose: 'Postal', text: { fi: 'Box 1, Stockholm' } },
    ]);
  });
});

describe('organizationChangesToV11Body', () => {
  it('always sends publishingStatus and nothing the change leaves alone', () => {
    expect(organizationChangesToV11Body({}, wire)).toEqual({ publishingStatus: 'Published' });
    expect(organizationChangesToV11Body({ publishingStatus: 'Archived' }, wire)).toEqual({
      publishingStatus: 'Deleted',
    });
  });

  it('resends the whole name list with a display name type for each language', () => {
    const body = organizationChangesToV11Body(
      { names: { fi: 'Uusi seurakunta', sv: 'Nya församlingen' } },
      wire,
    );
    expect(body.organizationNames).toEqual([
      { language: 'fi', value: 'Uusi seurakunta', type: 'Name' },
      { language: 'sv', value: 'Nya församlingen', type: 'Name' },
      { language: 'fi', value: 'Testin srk', type: 'AlternativeName' },
    ]);
    expect(body.displayNameType).toEqual([
      { language: 'fi', type: 'AlternativeName' },
      { language: 'sv', type: 'Name' },
    ]);
  });

  it('shows the official name again when the alternative name is removed', () => {
    const body = organizationChangesToV11Body({ alternativeNames: {} }, wire);
    expect(body.displayNameType).toEqual([
      { language: 'fi', type: 'Name' },
      { language: 'sv', type: 'Name' },
    ]);
  });

  it('keeps the summary when only the description changes', () => {
    expect(
      organizationChangesToV11Body({ descriptions: { fi: 'Uusi kuvaus.' } }, wire)
        .organizationDescriptions,
    ).toEqual([
      { language: 'fi', value: 'Evankelis-luterilainen seurakunta', type: 'Summary' },
      { language: 'fi', value: 'Uusi kuvaus.', type: 'Description' },
    ]);
  });

  it('writes addresses in the organisation In shape and clears emptied lists', () => {
    const org = organizationWireToDomain(wire);
    const body = organizationChangesToV11Body({ addresses: org.addresses ?? [], emails: [] }, wire);
    expect(body.addresses).toEqual([
      expect.objectContaining({ type: 'Visiting', subType: 'Street' }),
      {
        type: 'Postal',
        subType: 'Foreign',
        foreignAddress: [{ language: 'fi', value: 'Box 1, Stockholm' }],
      },
    ]);
    expect(body.deleteAllEmails).toBe(true);
    expect(body).not.toHaveProperty('emails');
  });
});

describe('newOrganizationToV11Body', () => {
  it('builds the POST body with the parent, type, area and display name types', () => {
    const body = newOrganizationToV11Body({
      parentOrganizationId: 'root',
      organizationType: 'Organization',
      publishingStatus: 'Draft',
      names: { fi: 'Diakoniakeskus' },
      summaries: { fi: 'Seurakunnan diakoniatyö' },
      descriptions: { fi: 'Diakoniakeskus auttaa.' },
      businessCode: '0204819-8',
      area: { areaType: 'LimitedType', areas: [{ type: 'Municipality', code: '694' }] },
      emails: [],
    });
    expect(body).toEqual({
      parentOrganizationId: 'root',
      organizationType: 'Organization',
      publishingStatus: 'Draft',
      organizationNames: [{ language: 'fi', value: 'Diakoniakeskus', type: 'Name' }],
      displayNameType: [{ language: 'fi', type: 'Name' }],
      organizationDescriptions: [
        { language: 'fi', value: 'Seurakunnan diakoniatyö', type: 'Summary' },
        { language: 'fi', value: 'Diakoniakeskus auttaa.', type: 'Description' },
      ],
      businessCode: '0204819-8',
      areaType: 'LimitedType',
      subAreaType: 'Municipality',
      areas: ['694'],
    });
  });

  it('keeps one sub area type, and defaults to nationwide', () => {
    expect(organizationAreaToV11Post(undefined)).toEqual({ areaType: 'Nationwide' });
    expect(
      organizationAreaToV11Post({
        areaType: 'LimitedType',
        areas: [
          { type: 'Region', code: '05' },
          { type: 'Municipality', code: '694' },
        ],
      }),
    ).toEqual({ areaType: 'LimitedType', subAreaType: 'Region', areas: ['05'] });
  });
});
