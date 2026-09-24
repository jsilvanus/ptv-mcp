/**
 * DVV's fictional organisations in the PTV test environment
 * (asiakastestiympäristö). Mirrors docs/ptv-test-environment.md — update
 * both together. DVV publishes the test accounts in TEST_ACCOUNTS_URL.
 */
export interface PtvTestOrganisation {
  id: string;
  name: string;
  type: string;
}

export const TEST_ACCOUNTS_URL =
  'https://cdn.verkkopalvelu.suomi.fi/files/PTV-koulutusympäristön_testitunnukset_fi-9f2b374d805e50ac4289a01fdc7a65f9%20(2)-1f8f9aae472be5e085268cd363ed2572.xlsx';

export const PTV_TEST_ORGANISATIONS: readonly PtvTestOrganisation[] = [
  { id: 'b458d033-042d-4cbe-b030-34e81da28821', name: 'Testiorganisaatio 1', type: 'Valtio' },
  { id: 'df499a95-3f53-4a4c-b794-015b25710ee8', name: 'Testiorganisaatio 2', type: 'Valtio' },
  { id: '746538f1-6ddc-4042-bd7b-923d6401ecae', name: 'Testiorganisaatio 3', type: 'Valtio' },
  { id: 'c60381d6-fbd7-45d7-994e-c99ec0fc8f3f', name: 'Testiorganisaatio 4', type: 'Valtio' },
  { id: '011154df-3726-461e-ae9c-a1182d1746de', name: 'Testiorganisaatio 5', type: 'Valtio' },
  { id: '3d1759a2-e47a-4947-9a31-cab1c1e2512b', name: 'Testiorganisaatio 6', type: 'Kunta' },
  { id: '6745e341-be2a-45a4-b184-bbc2f8465615', name: 'Testiorganisaatio 7', type: 'Kunta' },
  { id: '92374b0f-7d3c-4017-858e-666ee3ca2761', name: 'Testiorganisaatio 8', type: 'Kunta' },
  { id: '7fdd7f84-e52a-4c17-a59a-d7c2a3095ed5', name: 'Testiorganisaatio 9', type: 'Kunta' },
  { id: '52e0f6dc-ec1f-48d5-a0a2-7a4d8b657d53', name: 'Testiorganisaatio 10', type: 'Kunta' },
  {
    id: '0d34eb3a-d7e5-4af0-aa0d-009b5fb0e91c',
    name: 'Testiorganisaatio 11',
    type: 'Alueellinen yhteistoimintaorganisaatio',
  },
  {
    id: 'e9d022bc-97b8-41c6-b953-d052ad53bc91',
    name: 'Testiorganisaatio 12',
    type: 'Alueellinen yhteistoimintaorganisaatio',
  },
  {
    id: '3e8356bd-377f-4cad-97b1-a027bd4bbf25',
    name: 'Testiorganisaatio 13',
    type: 'Alueellinen yhteistoimintaorganisaatio',
  },
  {
    id: '4bc4fad0-84fe-412f-8fb9-c431f4ba48b2',
    name: 'Testiorganisaatio 14',
    type: 'Alueellinen yhteistoimintaorganisaatio',
  },
  {
    id: 'ae788356-6950-48fc-b3ff-63243f74fe53',
    name: 'Testiorganisaatio 15',
    type: 'Järjestöt ja yhteisöt',
  },
  {
    id: 'c225a17a-b767-4148-80ae-b78506275534',
    name: 'Testiorganisaatio 16',
    type: 'Järjestöt ja yhteisöt',
  },
  {
    id: '269685e8-9c00-4f2e-b6c7-e61d94e13b96',
    name: 'Testiorganisaatio 17',
    type: 'Järjestöt ja yhteisöt',
  },
  { id: '53859dac-fbfa-4836-83bb-347ded4fcbe8', name: 'Testiorganisaatio 18', type: 'Yritykset' },
  { id: '30e5a664-95fd-496c-9d33-c40c13131ceb', name: 'Testiorganisaatio 19', type: 'Yritykset' },
];

export interface PtvTestApiAccount {
  username: string;
  password: string;
}

/**
 * The API user (`API…@testi.fi`, not `API-ASTI…`) of each test
 * organisation, keyed by organisation id, from DVV's public test account
 * list (TEST_ACCOUNTS_URL). Picking an organisation in the v11 API-user
 * form fills these in. Only organisations listed here can be picked
 * (all can while the table is empty). Test environment only; DVV may change these when the test
 * environment is reset.
 *
 * Example entry:
 *   'ae788356-6950-48fc-b3ff-63243f74fe53': { username: 'API…@testi.fi', password: '…' },
 */
export const PTV_TEST_API_ACCOUNTS: Readonly<Record<string, PtvTestApiAccount>> = {
  'ae788356-6950-48fc-b3ff-63243f74fe53': { username: 'API27@testi.fi', password: 'qGbfHwVcd2-' },
};

export function testOrganisationLabel(id: string | null | undefined): string | undefined {
  const organisation = PTV_TEST_ORGANISATIONS.find((item) => item.id === id);
  return organisation ? `${organisation.name} (${organisation.type})` : undefined;
}
