import { describe, expect, it } from 'vitest';
import { InMemoryPtvAdapter } from '../ptv/testing/inMemoryAdapter.js';
import { collectContent, contentSheets } from './contentExport.js';

const adapter = new InMemoryPtvAdapter({
  organizations: [
    {
      id: 'root',
      publishingStatus: 'Published',
      names: { fi: 'Seurakuntayhtymä' },
      summaries: { fi: 'Yhtymä' },
      descriptions: { fi: 'Yhtymä hoitaa yhteiset asiat.' },
    },
  ],
  services: [
    {
      id: 's1',
      organizationId: 'root',
      serviceType: 'Service',
      publishingStatus: 'Published',
      names: { fi: 'Kaste', sv: 'Dop' },
      summaries: { fi: 'Kasteen varaaminen' },
      descriptions: { fi: 'Soita 040 123 4567.' },
      serviceClasses: [],
      ontologyTerms: [],
      targetGroups: [],
      lifeEvents: [],
      industrialClasses: [],
      languages: ['fi', 'sv'],
      serviceChannelIds: ['c1'],
    },
  ],
  channels: [
    {
      id: 'c1',
      organizationId: 'root',
      channelType: 'Phone',
      publishingStatus: 'Published',
      names: { fi: 'Kirkkoherranvirasto' },
      descriptions: { fi: 'Virasto neuvoo.' },
      languages: ['fi'],
      phoneNumbers: [{ language: 'fi', prefixNumber: '+358', number: '19123456' }],
    },
  ],
  connections: [{ serviceId: 's1', channelId: 'c1', chargeType: 'FreeOfCharge' }],
  capabilities: {
    apiVersion: 'v11',
    environment: 'test',
    credentialScope: 'tenant',
    supportsRead: true,
    supportsWrite: false,
    supportsDraftRead: false,
  },
});

describe('content export', () => {
  it('lists every item with texts per language, connections and findings', async () => {
    const content = await collectContent(adapter, 'root', true);
    const sheets = contentSheets(content);
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      'Yhteenveto',
      'Organisaatiot',
      'Palvelut',
      'Asiointikanavat',
      'Liitokset',
      'Laatutarkistus',
    ]);
    const [, , services, channels, connections, findings] = sheets;
    expect(services!.rows[0]).toEqual(
      expect.arrayContaining(['Nimi (fi)', 'Kuvaus (fi)', 'Nimi (sv)']),
    );
    expect(services!.rows[1]).toEqual(expect.arrayContaining(['Kaste', 'Dop']));
    expect(channels!.rows[1]).toEqual(
      expect.arrayContaining(['Puhelinasiointi', 'fi: +358 19123456']),
    );
    expect(connections!.rows[1]).toEqual([
      'Kaste',
      's1',
      'Kirkkoherranvirasto',
      'c1',
      'Maksuton',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]);
    expect(findings!.rows).toContainEqual(
      expect.arrayContaining(['Palvelu', 's1', 'Kaste', 'Q-STRUCT-1', 'Virhe']),
    );
  });
});
