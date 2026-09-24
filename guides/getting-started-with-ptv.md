# Getting started with PTV as an organisation

How an organisation (for example a parish or a parish union) starts using
Suomi.fi Palvelutietovaranto (PTV). This guide condenses DVV's
"Palvelutietovarannon käyttöönotto" and "Työskentelyn organisointi"
guidance on kehittajille.suomi.fi (retrieved 2026-09-24).

The steps below take place in DVV's services: Suomi.fi-palveluhallinta and
the PTV user interface. **They happen before this MCP can do anything
useful.** Setting up the MCP itself is covered by the `ptv-mcp-admin`
skill/guide.

## 1. Get the organisation on board

Taking PTV into use is a matter for the **whole organisation**. Management,
IT and communications should understand what PTV is and commit to it.
Before you start, read:

- PTV's benefits and data model (organisation → services → service
  channels, plus the connections between them) on kehittajille.suomi.fi.
- The **terms of use** (käyttöehdot) and the **editorial policy**
  (toimituspolitiikka). By accepting them, the organisation commits to
  producing content that follows the data model, the guidelines and the
  quality requirements, and to keeping it up to date.

## 2. Apply for the PTV permit and accept the terms

The permit is applied for in **Suomi.fi-palveluhallinta**
(palveluhallinta.suomi.fi). Anyone the organisation agrees on can do it,
including an IT supplier acting on the organisation's behalf.

1. Log in to Palveluhallinta with **strong authentication**.
2. Use the business ID search to check whether the organisation is already
   registered.
   - If it isn't, register the organisation and yourself.
   - If it already has a Palveluhallinta account (from another Suomi.fi
     service), ask the organisation's **Palveluhallinta main user** to
     invite you.
3. Answer the **background survey**, which checks that you understand what
   the organisation commits to.
4. Fill in the permit application:
   - Part 1: organisation and contact persons.
   - Part 2: the connecting information system and its security. **Needed
     only for machine integration through the IN API**, which is how this
     MCP writes to PTV.
   - Part 3: the organisation's commitments.
   - If an external application supplier is used, give their technical
     contact person, and say whether they already have a production PTV API
     user.
5. Accept the terms of use.
6. **Processing takes about 1–2 weeks.** The decision appears under
   *Hakemukset* in Palveluhallinta. Once the permit is granted, the
   applicant becomes the organisation's PTV main user and Palveluhallinta
   main user.

If the organisation already uses PTV and only needs IN API access (for
example for writes through this MCP), apply from the logged-in
Palveluhallinta dashboard: **Palvelutietovaranto → Hae käyttölupaa**.
Only a PTV main user can apply. How API credentials are then obtained is
covered in the `api-credentials` guide.

## 3. Run it as a project

Set up an adoption project with a schedule, goals and enough resources.
DVV publishes an example adoption and maintenance work plan (XLSX) on
kehittajille.suomi.fi. Make sure the people leading it have the mandate
to assign responsibilities across the organisation.

## 4. Name the people and roles

| PTV role                                | Who / what                                                                                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PTV main user** (PTV-pääkäyttäjä)     | **At least two**, a main user and a deputy. Under the terms of use, one of them should come from communications if the organisation has communications staff. They coordinate content, oversee quality, guide maintainers and act as the contacts towards DVV. |
| **PTV maintainer** (PTV-ylläpitäjä)     | Writes and maintains content. There is no limit on their number. They can cover everything or one area, such as a unit or a type of activity.                                                                                                                        |
| **Palveluhallinta main user**           | Manages users and rights in Suomi.fi-palveluhallinta. Often the same person as a PTV main user in small organisations. Changing rights requires strong authentication.                                                                                          |

Write PTV tasks into **job descriptions and roles**, not only onto named
people, so that the work and the know-how survive staff changes. If you
don't know who your Palveluhallinta main user is, ask ptv-tuki@dvv.fi.

The PTV roles are DVV's roles. **This MCP has its own, separate role
model**: Katselija (Viewer), Ehdottaja (Contributor), Hyväksyjä (Approver),
Julkaisija (Publisher) and Pääkäyttäjä (Administrator). Only people who also
have the right PTV rights should hold MCP roles that write to PTV (see
`ptv-mcp-admin`).

## 5. Train people

- Main users complete the **PTV-ajokortti** (the PTV "driving licence"
  online course on eOppiva) first. Then they make sure everyone who
  produces content completes it too.
- Follow DVV's PTV news and trainings. Only people with PTV user rights
  get DVV's PTV bulletins by email.
- Using an AI assistant through this MCP **doesn't replace training**.
  The human who approves a change must know the PTV rules well enough to
  judge the AI's proposal. This also meets the AI literacy duty (EU AI Act
  Art. 4); see the `ai-compliance` guide.

## 6. Identify and describe your content, in this order

You can start describing content once the permit is granted, users have
rights, and users are trained.

1. **Complete and publish the organisation first**, in every language you
   will use (fi / sv / en …). Nothing else can be published before it.
   Add sub-organisations only if customers benefit from them. For example,
   a parish union may show its member parishes.
2. **Identify the services** from the customer's point of view, not the
   organisation chart. An organisation's website structure is a useful
   starting list.
   - **Parishes: start from the general descriptions (pohjakuvaukset)
     maintained by Kirkkohallitus** (usage type "Evankelis-luterilaisen
     kirkon palvelut"), for example confirmation school, day clubs,
     baptism, weddings, funerals, diaconal work and family counselling.
     Add only the local details.
3. **Describe the channels**: service locations (churches, parish centres,
   offices), phone lines, e-services (booking and enrolment), printable
   forms and web pages. **Reuse shared channels** from other organisations
   instead of describing them again.
4. **Connect** each service to all its channels.
5. **Publish**, and schedule regular reviews.

When a service is produced by several organisations (for example a parish
union and its parishes, or a municipality and a parish), agree who
describes what. The organisation responsible for arranging the service is
the main responsible organisation, and the others are listed as other
responsible organisations. See DVV's "Vastuut monituottajatilanteessa".

## 7. Plan and resource maintenance

Maintenance never ends. Everyone involved needs enough working time for
PTV. Review content at least once a year, and holiday opening hours before
each church holiday season. Hand over know-how when people change. DVV's
quality report for the organisation's descriptions is published a few
times a year on kehittajille.suomi.fi.

## Contacts

- PTV support: **ptv-tuki@dvv.fi** (content, users, organisation mergers
  and transfers)
- Parish-specific general descriptions: Kirkkohallitus, "Palvelutietovaranto
  PTV" page on evl.fi/plus
