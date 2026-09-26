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
| "uusien aliorganisaatioiden … lisääminen ja muokkaaminen" (add and edit sub-organisations) | `ptv_propose_new_organisation`, `ptv_propose_organisation_changes`. Not verified live yet. |
| "uusien palvelujen … lisääminen ja muokkaaminen" (add and edit services) | Verified live 2026-09-24 (`EXECUTION_LOG.md`): `service_create` → publish, then updates. |
| "uusien asiointikanavien lisääminen ja muokkaaminen" (add and edit channels) | Updates verified live for EChannel, Phone, ServiceLocation, WebPage. Creation verified for Phone. **Still to test:** creating the other four types, and PrintableForm update. |
| "liitosten ja liitoksen lisätietojen lisääminen ja muokkaaminen" (add and edit connections and their extra info) | Adding and removing connections verified live. Extra info: `ptv_propose_connection_changes`, not verified live yet. |
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
review: the content report (see the checklist).

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

## Checklist

Status: `[x]` done, `[~]` code done but not yet verified live, `[ ]` open,
`[-]` does not apply to ptv-mcp (explain in the report).

Application and prerequisites

- [ ] Data-model mapping (tietomallimäppäys): which PTV fields ptv-mcp
      reads and writes, per entity. Written with the reports.
- [x] Security account: tenant isolation, encrypted credentials, roles,
      four-eyes, audit log.
- [-] A source system kept up to date. PTV itself is the master copy.

Technical readiness (DVV's test items)

- [~] Sub-organisations: create (`ptv_propose_new_organisation`) and edit
      (`ptv_propose_organisation_changes`), including archiving.
- [x] Services: create, edit, archive (live 2026-09-24).
- [~] Channels: edit (live for four types; PrintableForm open), create (live
      for Phone; four types open), archive (open).
- [x] Connections: add and remove (live).
- [~] Connection extra info: edit charge type, descriptions, service hours
      and contact details (`ptv_propose_connection_changes`).
- [x] Field correctness: formats, lengths, required fields (validators,
      unit tests).
- [x] Token handling: v11 API login, `apiUserOrganisation` in production.
- [-] Daily sync of changes and deletions: changes go in when approved.

Content review (DVV's checklist)

- [~] 1. Clear, correct, customer-oriented text: style heuristics
      (Q-STYLE-*), the rest by people.
- [x] 2. No contact details in service descriptions: Q-STRUCT-1.
- [-] 3. General description connected correctly: people (Q-GD-1).
- [x] 4. General-description text not copied into the service's own
      description: Q-GD-1 flags copied sentences.
- [x] 5. Connections exist; hours and addresses are right: Q-STRUCT-5,
      Q-HOURS-1, Q-CONTACT-1.
- [x] 6. Connection extra info is right: `checkConnection`, also in
      `ptv_check_quality` for a service's connections.
- [x] 7. Machine-generated content is understandable: human approval of
      every AI proposal (`guides/ai-compliance.md`).
- [x] Excel export of an organisation's content for DVV's review: web UI
      *Content review → Content report (Excel)*, or
      `GET /tenants/:tenantId/ptv/content-export?organizationId=…`. Sheets:
      summary, organisations, services, channels, connections and every
      automated check finding.

Live tests (test environment, after deploying the above)

- [ ] Channel creation: EChannel, WebPage, PrintableForm, ServiceLocation.
- [ ] PrintableForm update.
- [ ] Channel archive.
- [ ] Sub-organisation create, edit, archive.
- [ ] Connection extra info edit.
- [ ] All of the above on a fresh test organisation, for the report.
