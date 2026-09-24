# PTV test environment (asiakastestiympäristö)

Source: DVV, [Lisätietoa IN-integraation toteuttajalle](https://kehittajille.suomi.fi/palvelut/palvelutietovaranto/ptv-tietojen-hyodyntaminen/tekninen-dokumentaatio-integraation-toteuttajalle/lisatietoa-in-integraation-toteuttajalle)
(page updated 28.8.2026) and
[Harjoittele ensin koulutusympäristössä](https://kehittajille.suomi.fi/palvelut/palvelutietovaranto/sisallon-tuottaminen/kayttoliittyman-yleiset-ohjeet#harjoittele-ensin-koulutusymparistossa).

The test environment has only DVV's fictional test organisations. Nothing real
(e.g. Riihimäen seurakunta) exists there. **Its database is wiped whenever PTV
is upgraded**, so never keep anything there you want to keep.

| | URL |
|---|---|
| UI (login) | https://palvelutietovaranto.trn.suomi.fi/ |
| v11 API | https://api.palvelutietovaranto.trn.suomi.fi (`V11_BASE_URLS.test`) |
| v11 Swagger | https://api.palvelutietovaranto.trn.suomi.fi/swagger/ui/index.html |
| v11 API login | `POST https://palvelutietovaranto.trn.suomi.fi/api/auth/api-login` |
| v12 API | https://api-gw.palvelutietovaranto.trn.suomi.fi (`V12_BASE_URLS.test`) |

## Test accounts

DVV publishes the usernames and passwords in
[PTV-asiakastestiympäristön testitunnukset (XLSX)](https://cdn.verkkopalvelu.suomi.fi/files/PTV-koulutusympäristön_testitunnukset_fi-9f2b374d805e50ac4289a01fdc7a65f9%20(2)-1f8f9aae472be5e085268cd363ed2572.xlsx).
They are public. DVV can change them, so the spreadsheet is the source of
truth. Each organisation has:

- `paakayttaja*` — main users, for the web UI
- `yllapitaja*` — maintainers, for the web UI
- `API*` — **API users, for IN-API (write) integration**. Use one of these for
  the tenant's v11 API user (web UI: *PTV connections → Connect a PTV v11 API
  user*, environment `test`).
- `API-ASTI*` — ASTI-register integration only. Out of scope; don't use.

The web UI's test organisation picker fills in the API username and password
from `PTV_TEST_API_ACCOUNTS` in `web/src/ptv/testOrganisations.ts`, keyed by
organisation id. Add a row for each organisation from DVV's list. Only
organisations with a row can be picked; while the table is empty, all are
selectable and the credentials are typed in by hand.

A test-environment token is bound to exactly one organisation (no
`apiUserOrganisation`), so an API user can only write to its own
organisation. Pick the organisation first, then use that row's API user.

## Test organisations

| Organisation id | Name | Type |
|---|---|---|
| b458d033-042d-4cbe-b030-34e81da28821 | Testiorganisaatio 1 (Valtio) | State |
| df499a95-3f53-4a4c-b794-015b25710ee8 | Testiorganisaatio 2 (Valtio) | State |
| 746538f1-6ddc-4042-bd7b-923d6401ecae | Testiorganisaatio 3 (valtio) | State |
| c60381d6-fbd7-45d7-994e-c99ec0fc8f3f | Testiorganisaatio 4 (Valtio) | State |
| 011154df-3726-461e-ae9c-a1182d1746de | Testiorganisaatio 5 (Valtio) | State |
| 3d1759a2-e47a-4947-9a31-cab1c1e2512b | Testiorganisaatio 6 (Kunta) | Municipality |
| 6745e341-be2a-45a4-b184-bbc2f8465615 | Testiorganisaatio 7 (Kunta) | Municipality |
| 92374b0f-7d3c-4017-858e-666ee3ca2761 | Testiorganisaatio 8 (Kunta) | Municipality |
| 7fdd7f84-e52a-4c17-a59a-d7c2a3095ed5 | Testiorganisaatio 9 (Kunta) | Municipality |
| 52e0f6dc-ec1f-48d5-a0a2-7a4d8b657d53 | Testiorganisaatio 10 (Kunta) | Municipality |
| 0d34eb3a-d7e5-4af0-aa0d-009b5fb0e91c | Testiorganisaatio 11 (Alueellinen yhteistoimintaorganisaatio) | Regional joint organization |
| e9d022bc-97b8-41c6-b953-d052ad53bc91 | Testiorganisaatio 12 (Alueellinen yhteistoimintaorganisaatio) | Regional joint organization |
| 3e8356bd-377f-4cad-97b1-a027bd4bbf25 | Testiorganisaatio 13 (Alueellinen yhteistoimintaorganisaatio) | Regional joint organization |
| 4bc4fad0-84fe-412f-8fb9-c431f4ba48b2 | Testiorganisaatio 14 (Alueellinen yhteistoimintaorganisaatio) | Regional joint organization |
| ae788356-6950-48fc-b3ff-63243f74fe53 | Testiorganisaatio 15 (Järjestöt ja yhteisöt) | Non-profit organization |
| c225a17a-b767-4148-80ae-b78506275534 | Testiorganisaatio 16 (Järjestöt ja yhteisöt) | Non-profit organization |
| 269685e8-9c00-4f2e-b6c7-e61d94e13b96 | Testiorganisaatio 17 (Järjestöt ja yhteisöt) | Non-profit organization |
| 53859dac-fbfa-4836-83bb-347ded4fcbe8 | Testiorganisaatio 18 (Yritykset) | Company |
| 30e5a664-95fd-496c-9d33-c40c13131ceb | Testiorganisaatio 19 (Yritykset) | Company |

For church work, the closest match to a parish is a non-profit organisation
(15–17). Parishes are legally public bodies, though, so any of them works for
testing writes.

Large organisations that need permanent test accounts can ask
ptv-tuki@dvv.fi.
