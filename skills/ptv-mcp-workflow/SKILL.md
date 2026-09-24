---
name: ptv-mcp-workflow
description: Day-to-day workflow for maintaining an organisation's PTV (Suomi.fi Palvelutietovaranto) content through ptv-mcp. Covers finding content, drafting changes as proposals, quality review, human review and approval, publishing (apply or export for manual publishing) and follow-up. Use whenever the user wants to create, update, translate, review or publish PTV services, service channels or organisation information.
---

# PTV content workflow: propose → review → approve → publish

Every change goes through **two phases**. The AI drafts a **proposal**,
and a **human with the right role approves it**. Nothing reaches PTV until
then. This isn't optional: it's how the organisation keeps editorial
responsibility under the EU AI Act (see the `ai-compliance` guide).

Before drafting, load the `content-quality` guide
(`ptv_get_guide {"topic":"content-quality"}`) and follow it. The
`ai-compliance` rules are binding throughout.

## 1. Understand the request and the current state

1. Find out **what** should change, **in which languages**, and **why**,
   along with the source of any new facts (web page, decision, the
   user's own knowledge).
2. Look up the current data. Never draft blind.
   - Organisation: `ptv_find_organisation_and_children` or
     `ptv_get_organisation`
   - Services: `ptv_search_services` → `ptv_get_service`
   - Channels: `ptv_search_channels` → `ptv_get_channel`
   - Connections: `ptv_search_connections`
   - General descriptions (parishes: Kirkkohallitus's "Evankelis-luterilaisen
     kirkon palvelut"): `ptv_search_general_descriptions`
   - Classifications: `ptv_list_codes` (service classes, target groups,
     life events, industrial classes) and `ptv_search_ontology_terms`
3. Check whether a proposal for the same content is already pending:
   `ptv_list_proposals {"status":"pending"}` (Contributor+).

## 2. Draft the change

- **Update an existing service**: `ptv_propose_changes` with only the
  fields that change.
- **Create a new service**: `ptv_propose_new_service`. Use the right
  general description when one exists, and add only local details.
  - Include classes, target groups and ontology terms, and the IDs of the
    channels it is delivered through.
  - Make sure the organisation is already published in every language the
    service will have.
- **Change a channel**: `ptv_propose_channel_changes`. The type's
  structured fields (address, phone numbers, web address, service hours
  and so on) can be changed too; see "Channel fields" below.
- **Create a channel**: `ptv_propose_new_channel`. First check that the
  channel doesn't already exist, and that no other organisation has
  described a shared channel you should connect instead. Give
  `serviceIds` to connect it to its services in the same step.
- **Connect or disconnect a channel**: `ptv_propose_changes` on the
  service, with its full `serviceChannelIds` list.
- Optional pre-check: `ptv_validate_changes` validates the merged
  `proposed` object against PTV's mandatory-field and limit rules.

Drafting rules:

- Follow the style rules: "you" form, imperatives, most important thing
  first, short paragraphs, no contact details in free text, no personal
  names, no dates.
- Localized fields replace **all** languages of that field. Include every
  language version the field should keep.
- If you translate, say so and flag the translation for human review.
- Mark every fact you could not verify as **unverified**.

## 3. Present the proposal to the user

After proposing, show the user:

1. The **proposal ID** and what kind it is (service update, new service,
   or channel update).
2. The **diff**: every changed field, language by language, old → new.
3. The **quality review**:
   - The tool result's `quality` holds the **automated checks**. They are
     deterministic, so the same text always gives the same result. Show
     every `error`, and fix it before asking for approval unless the user
     knowingly accepts it. Show the `warning`s for the user to judge.
   - Then check by hand only the items the automation can't decide
     (marked *manual* in `content-quality` section 9). Always list the
     `Q-FACT-1` facts that need human confirmation.
4. The **validation result** from the tool (mandatory fields, limits).
5. **Who can approve it and how** (next step).

If the user wants changes, create a **new** proposal with the corrected
content and have the old one rejected, so the audit trail stays clear.

## 4. Human review and approval

Approval is a **human** act.

- **Preferred:** a Hyväksyjä (Approver) or higher opens the web UI → **Proposal queue**,
  reads the re-diffed proposal (always computed against the *current* PTV
  data), and resolves it.
- **In chat:** call `ptv_resolve_proposal` only after the user has seen the
  diff and **explicitly** asked for that specific proposal to be approved
  or rejected. Always use `ptv_get_proposal` first to show the current
  re-diff.

Resolution options:

| Action               | Who                                                   | Effect                                                                                                                                           |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reject`             | Approver+                                             | Closes the proposal. Nothing is written.                                                                                                        |
| `approve_and_export` | Approver+                                             | Approves it and produces a per-language preview for **manual** entry in PTV's own UI (`ptv_export_for_manual_publish`). The human then publishes it in PTV. |
| `approve_and_apply`  | Publisher + write-capable PTV connection              | Validates it and writes it to PTV through the API. The proposal becomes `applied`, or `failed` with the error.                                                   |

v12 writing is not yet enabled in this MCP. Until it is, use
`approve_and_export`, or `approve_and_apply` on connections that support
writes.

## 5. After publishing

1. Check the result: fetch the service or channel again and compare it with
   the approved diff.
2. **Language versions**: in PTV, publishing some languages sends the
   others back to draft. Check that every intended language is published.
3. **Connections**: make sure every new service has its channels and every
   new channel has a service.
4. If a proposal ended as `failed`, show the error and draft a corrected
   proposal. Don't retry blindly.
5. Remind the user of recurring maintenance: an annual review of all
   content, and **holiday opening hours before each church holiday
   season** (Christmas, Easter, Ascension Day, Midsummer, All Saints' Day).

## Reviewing existing content (no change requested yet)

When asked to "check" or "review" content, fetch it and run the
`content-quality` checklist on every language version. Report the results
as a table of check ID, result, field/language and suggested fix. Offer to
draft proposals for the fixes. Don't create proposals unasked.

## Review campaigns: checking all content

A **review campaign** is a full check of the organisation's PTV content.
It makes sure every service, channel and organisation is up to date and
has the proper channels linked.

1. **Start** (Julkaisija/Publisher+): `ptv_review_start_campaign` with the
   PTV organisation id. Sub-organisations are included by default. Every
   published service, channel and organisation becomes a **review item**,
   and the automated checks (`ptv_check_quality`) run on each one.
2. **Assign** (Publisher+): `ptv_review_assign` gives items to reviewers
   (Ehdottaja/Contributor+). Assign by item ids, or by kind and/or
   organisation (e.g. all channels of one parish to its office secretary).
3. **Review** (the assigned reviewer): `ptv_review_my_items`, then for each
   item `ptv_review_get_item`. That shows the current PTV data, fresh
   automated findings and any linked proposals. With the reviewer, check
   that:
   - the facts are current (the automated checks can't know this);
   - every real channel is connected, and nothing outdated is;
   - the automated findings are fixed, or knowingly accepted.
4. **Decide** with the reviewer:
   - Nothing to change → `ptv_review_complete_item` with `decision: "confirmed"`.
   - Changes needed → draft them with `ptv_propose_changes`,
     `ptv_propose_channel_changes` or `ptv_propose_new_service`, **passing
     `reviewItemId`**. Show the diff and quality results as in sections
     2–3, then `ptv_review_complete_item` with
     `decision: "changes_proposed"`. This sends the item to the Publishers.
5. **Publish** (Approver/Publisher): the proposals appear in the proposal
   queue and in `ptv_my_tasks`, and are resolved as in section 4. If a
   proposal is rejected, a Publisher can send the item back with
   `ptv_review_reopen_item`.
6. **Close** (Publisher+): `ptv_review_close_campaign` once the items are
   handled. Every step is in the audit log under the campaign's
   correlation id.

The same flow is available in the web UI under **Content review**.

### A Publisher's draft for a reviewer

A Publisher can draft a change themselves (a new channel, a new
connection, a fix) and send it to the item's reviewer:

- Propose it with `reviewItemId`, or attach an existing proposal with
  `ptv_review_attach_proposal` (web UI: the item's **Attach** field).
- The item reopens if it was already finished.
- The item's reviewer becomes a **required reviewer** of the draft. It
  shows up in their `ptv_my_tasks`, and nobody can approve it before
  they sign off with `ptv_sign_off_proposal`.
- The reviewer then sends the item on as usual.

## Channel fields

A channel's structured fields, by type (the domain model's
`ServiceChannel`). A field in `changes` replaces **all** of its values,
every language and every list entry. Read the channel first and send the
complete list.

| Field | Types | Shape and rules |
|---|---|---|
| `names`, `summaries` (max 150), `descriptions` | all | `{ "fi": "…", "sv": "…" }`. These keys are the language versions. |
| `languages` | all | The languages the channel **serves customers in** (e.g. `["fi","sv","ar"]`). |
| `isVisibleForAll` | all | Other organisations may connect it (recommended: `true`). |
| `serviceHours` | all | `[{ "type": "DaysOfTheWeek", "openingTimes": [{ "dayFrom": "Monday", "dayTo": "Friday", "from": "09:00", "to": "15:00" }], "additionalInformation": { "fi": "Syyskausi" } }]`. `Exceptional` hours need `validFrom` (plus `validTo`, and `isClosed` for closures). `OverMidnight` hours can end on another day. Without times, use `isAlwaysOpen` or `isReservation`. Dates are `YYYY-MM-DD`, times `HH:mm`. |
| `urls` | EChannel, WebPage (required for every language version), Phone (optional) | `{ "fi": "https://…" }`. The exact page for each language, never `tunnistautuminen.suomi.fi`. |
| `phoneNumbers` | Phone (required), ServiceLocation | `[{ "language": "fi", "type": "Phone" \| "Sms" \| "Fax", "prefixNumber": "+358", "number": "19 123 4567", "additionalInformation": "Vaihde", "chargeType": "Chargeable" \| "FreeOfCharge" \| "Other", "chargeDescription": "…" }]`. No leading 0. For a national service number (e.g. 020…), set `"isFinnishServiceNumber": true` and no prefix. Languages fi, sv or en only. |
| `addresses` | ServiceLocation (a visiting street address is required) | `[{ "kind": "Street", "street": { "fi": "Kirkkokatu" }, "streetNumber": "5", "postalCode": "11100", "additionalInformation": { "fi": "Sisäänkäynti pihalta" } }]`. `kind` can also be `Other` (latitude and longitude plus additionalInformation, for places without an address; not shown on Suomi.fi) or `Foreign` (`text`). `"purpose": "Postal"` marks a postal address. |
| `emails`, `webPages` | ServiceLocation | `[{ "language": "fi", "value": "…@…" }]`; `[{ "language": "fi", "url": "https://…", "name": "…" }]`. |
| `supportPhones`, `supportEmails` | all but ServiceLocation | Käytön tuki: direct support for using the channel, not the switchboard. |
| `requiresAuthentication`, `requiresSignature`, `signatureQuantity`, `accessibility` | EChannel (accessibility also WebPage) | `accessibility` is `FullyCompliant`, `PartiallyCompliant`, `NonCompliant` or `Unknown` ("Ei tietoa", the default unless assessed). |
| `formFiles` (required), `formIdentifiers`, `deliveryAddresses`, `webPages` | PrintableForm | `[{ "language": "fi", "format": "PDF", "url": "https://…" }]`. A delivery address has `kind` `Street`, `PostOfficeBox` or `NoAddress` (`text`: instructions), and optionally a `receiver`. |

Validation (`validation` in the propose result) checks PTV's hard rules
on these fields. `quality` adds the guideline warnings.

## What is waiting for me?

Call `ptv_my_tasks` at the start of a session and tell the user its
`summary` lines. It lists:

- review items assigned to them,
- proposals waiting for their sign-off,
- for Approvers and above, every suggested change that still needs review,
  resolving or publishing, each with its readiness.

The web UI shows the same list under Content review → **Waiting for you**.

## Roles cheat-sheet

- **Katselija (Viewer)**: read and run quality checks.
- **Ehdottaja (Contributor)**: also propose, comment, sign off, and review
  assigned campaign items.
- **Hyväksyjä (Approver)**: also resolve (reject, or approve and export).
- **Julkaisija (Publisher)**: also approve and apply (write to PTV), and run
  review campaigns.
- **Pääkäyttäjä (Administrator)**: also members, PTV connections, settings
  and the audit log. See the `ptv-mcp-admin` skill.
