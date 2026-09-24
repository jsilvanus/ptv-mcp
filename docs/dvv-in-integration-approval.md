# Getting IN-API production credentials from DVV

What DVV requires before it issues PTV IN-API (write) production credentials,
and how ptv-mcp answers each requirement. Sources (read 2026-09-24):

- [Lisätietoa IN-integraation toteuttajalle](https://kehittajille.suomi.fi/palvelut/palvelutietovaranto/ptv-tietojen-hyodyntaminen/tekninen-dokumentaatio-integraation-toteuttajalle/lisatietoa-in-integraation-toteuttajalle) (updated 28.8.2026)
- [Näin otan IN-rajapinnan käyttöön](https://kehittajille.suomi.fi/palvelut/palvelutietovaranto/palvelutietovarannon-kayttoonotto/nain-otan-in-rajapinnan-kayttoon) (updated 23.6.2026)
- [Sisällöntuotanto IN-rajapinnan kautta](https://kehittajille.suomi.fi/palvelut/palvelutietovaranto/sisallon-tuottaminen/in-rajapinnan-kaytto) (updated 10.4.2026)

DVV publishes no template for either test report. The format is free, and
DVV may ask for more rounds ("Tämä voi vaatia useita iteraatiokierroksia").
Everything goes to **ptv-tuki@dvv.fi**.

## The process

1. **Käyttölupahakemus** (usage-permission application). An organisation
   that already uses PTV applies in Suomi.fi-palveluhallinta, with strong
   authentication: *Palvelutietovaranto → Hae käyttölupaa*. Processing
   takes 1–2 weeks.
2. **Build against the customer test environment**
   (`docs/ptv-test-environment.md`).
3. **Teknisen valmiuden testausraportti** (technical readiness test report),
   sent to ptv-tuki@dvv.fi.
4. **Tietosisällön testausraportti** (content test report). The
   organisation's PTV-pääkäyttäjä (PTV main user) fills it in and sends it
   to ptv-tuki@dvv.fi.
5. DVV reviews the reports. After approval it delivers the production API
   user "käyttölupahakemuksessa yksilöityyn osoitteeseen", to the address
   named in the application. Then comes the production installation.

## 1. What goes in the application

Five steps (the "IT-toimittajan valmis integraatio" variant, which is what
every parish after the first one will use):

1. Organisation basics: name, Y-tunnus (business ID), address.
2. Contact persons. They get DVV's instructions, and one of them becomes
   PTV-pääkäyttäjä.
3. IN-API and system details: which system the integration comes from
   (ptv-mcp), the subcontractor (IT supplier) that runs it, **the
   subcontractor's API user**, and the API user holder's contact details.
   The basic-path form also asks how the data is protected
   ("selvitys tietojen suojauksesta").
4. Acceptance of the terms of use.
5. Preview and send.

Before applying, DVV expects the organisation to have made
a **data-model mapping** (tietomallimäppäys) between the source system and
PTV's data model.

Material for step 3 and the security account: tenant isolation
(RLS plus application filtering), envelope-encrypted credentials, roles,
four-eyes, audit log (see `CLAUDE.md` and `docs/plan.md`).

## 2. Technical readiness test report

DVV's list, verbatim. The test must use **data that has not been put in the
test environment before**, for example through the UI:

| DVV test item | ptv-mcp status |
|---|---|
| "uusien aliorganisaatioiden … lisääminen ja muokkaaminen" (add and edit sub-organisations) | **Gap.** The adapter reads organisations and hierarchies but has no organisation write. Implement it, or tell DVV it is out of scope (sub-organisations stay UI-maintained). |
| "uusien palvelujen … lisääminen ja muokkaaminen" (add and edit services) | Verified live 2026-09-24 (`EXECUTION_LOG.md`): `service_create` → publish, then updates. |
| "uusien asiointikanavien lisääminen ja muokkaaminen" (add and edit channels) | Updates verified live for EChannel, Phone, ServiceLocation, WebPage. Creation verified for Phone. **Still to test:** creating the other four types, and PrintableForm update. |
| "liitosten ja liitoksen lisätietojen lisääminen ja muokkaaminen" (add and edit connections and their extra info) | Adding and removing connections works; the kept connections' extra info is preserved (`src/ptv/v11/connectionWrite.ts`). **Gap:** no proposal type edits the extra info (charge type, descriptions, hours, contact details). |
| "tietokenttien oikeellisuus (tietomuodot, pituudet, pakollisuudet jne.)" (field formats, lengths, required fields) | `src/validation/changeValidator.ts`, `channelRules.ts`, `contentChecks.ts`. Evidence: rejected invalid proposals plus the unit tests. |
| "lähdejärjestelmästä poistuneiden tietojen arkistointi" (archive data removed from the source) | Service archive verified live (`4678d0e0-…`). **Still to test:** channel archive. |

The report also covers the connection itself: firewall openings, access
rights and token handling.

What to attach per item: the proposal id, what was sent, the resulting PTV id
and read-back, and the audit-log entry. A test run on a fresh test
organisation (none of 15–17 has been used for these items yet) is the
cleanest proof.

## 3. Content test report (PTV-pääkäyttäjä)

DVV's checklist for the content sent through the API, verbatim:

- Palvelu- ja asiointikanavakuvaukset on laadittu selkeästi, oikeakielisesti ja asiakaslähtöisesti.
- Palvelun kuvauksessa ei ole osoite- tai puhelinnumerotietoja, www-osoitteita tai muita asiointikanaviin kuuluvia tietoja.
- Pohjakuvaukset on liitetty palveluihin oikein silloin, kun niitä on käytetty.
- Pohjakuvauksien tietoja ei ole kopioitu omaan palvelukuvaukseen, vaan pohjakuvausten tietoja on täydennetty itse tehdyllä kuvauksella.
- Palveluiden ja asiointikanavien välille on tehty liitokset. Asiointikanavien aukioloajat, osoitetiedot ja muut tiedot näkyvät oikein.
- Palvelun ja asiointikanavan väliset liitoksen lisätiedot näkyvät oikein.
- Mahdolliset koneellisesti tuotetut sisällöt ovat ymmärrettäviä ja asiakaslähtöisiä.

Most of these are already `Q-*` checks in `guides/content-quality.md`, run
by `ptv_check_quality`. That output, plus a review campaign over the
organisation's content, is the evidence. The last item is the AI one: cite
the human-approval flow and `guides/ai-compliance.md`. The IT-supplier
variant asks for an **Excel export** of the test-environment data for DVV to
review; ptv-mcp has no such export yet.

## Where ptv-mcp differs from a normal IN-integration

DVV's rules assume a separate source system that pushes to PTV. Explain
these in the reports up front:

- **Daily sync.** "muutokset tuodaan vähintään kerran vuorokaudessa PTV:hen"
  and removed data archived daily. ptv-mcp has no separate master copy:
  PTV stays the source of truth, and a change goes in when a person approves
  it. Nothing can go stale between syncs.
- **UI edits.** DVV warns that an IN-integration overwrites content edited
  in the PTV UI. ptv-mcp re-diffs against current PTV at resolve time and
  sends only the approved fields, so UI edits survive.
- **Multiple organisations.** Production tokens take `apiUserOrganisation`
  for an API user linked to several organisations (a parish union and its
  parishes). Test tokens bind to one organisation, so this can't be tested
  before production. Say so in the report.
- **v11 sunset.** DVV is replacing v11 with v12 and asks new integrations to
  plan for it. ptv-mcp's adapter layer already has a v12 adapter
  (`docs/ptv-v12-notes.md`).

## Open work before applying

- Organisation (sub-organisation) writes, or an agreed scope exclusion.
- Editing connection extra info.
- Live tests: channel creation for the other four types, PrintableForm
  update, channel archive.
- Excel (or CSV) export of an organisation's content for DVV's review.
- The data-model mapping document and the two reports themselves.
