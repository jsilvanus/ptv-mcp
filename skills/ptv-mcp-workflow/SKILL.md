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
   `ptv_list_proposals {"status":"pending"}` (Editor+).

## 2. Draft the change

- **Update an existing service**: `ptv_propose_changes` with only the
  fields that change.
- **Create a new service**: `ptv_propose_new_service`. Use the right
  general description when one exists, and add only local details.
  - Include classes, target groups and ontology terms, and the IDs of the
    channels it is delivered through.
  - Make sure the organisation is already published in every language the
    service will have.
- **Change a channel** (names, descriptions, languages, publishing status):
  `ptv_propose_channel_changes`.
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
3. The **quality review**: go through checklist section 9 of
   `content-quality` and list any `FAIL` items with suggested fixes. Also
   list the `Q-FACT-1` items that need human confirmation.
4. The **validation result** from the tool (mandatory fields, limits).
5. **Who can approve it and how** (next step).

If the user wants changes, create a **new** proposal with the corrected
content and have the old one rejected, so the audit trail stays clear.

## 4. Human review and approval

Approval is a **human** act.

- **Preferred:** an Editor or higher opens the web UI → **Proposal queue**,
  reads the re-diffed proposal (always computed against the *current* PTV
  data), and resolves it.
- **In chat:** call `ptv_resolve_proposal` only after the user has seen the
  diff and **explicitly** asked for that specific proposal to be approved
  or rejected. Always use `ptv_get_proposal` first to show the current
  re-diff.

Resolution options:

| Action               | Who                                                   | Effect                                                                                                                                           |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reject`             | Editor+                                               | Closes the proposal. Nothing is written.                                                                                                        |
| `approve_and_export` | Editor+                                               | Approves it and produces a per-language preview for **manual** entry in PTV's own UI (`ptv_export_for_manual_publish`). The human then publishes it in PTV. |
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

## Roles cheat-sheet

- **Reader**: search, read and propose.
- **Editor**: also list, review, reject, and approve and export.
- **Publisher**: also approve and apply (write to PTV).
- **Tenant Admin**: also members, PTV connections and the audit log. See the
  `ptv-mcp-admin` skill.
