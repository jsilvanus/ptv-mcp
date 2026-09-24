# PTV v11 write paths: plan and exit criteria

Goal: every v11 write path works live in PTV's **test** environment through
the PTV-MCP connector, with tests and docs. Writes only go to
**Testiorganisaatio 15** (`ae788356-6950-48fc-b3ff-63243f74fe53`), because
the test API user can only write to its own organisation. Production is out
of scope.

Loop per step: try it live through the connector → fix in a small PR →
CI green → merge → Farcmd "Deploy: PTV-MCP" → retest live → record
findings in `docs/ptv-v11-notes.md` and `EXECUTION_LOG.md`.

Test targets in organisation 15 (test data is wiped when DVV upgrades PTV):
`Hautauspalvelu` `c67da57e-ea12-4c90-bd53-1fa5f82e26af` (2 channels) and
`Testipalvelu 7` `411983fb-d1d4-4db3-bad4-9150a977a302` (no channels).

## Phase 1: update an existing service (PUT)

1. Description sentence through propose → `approve_and_apply`, read back.
2. Names, summaries, languages (add/remove a language).
3. Classifications: service classes, KOKO ontology terms (validator rule 9),
   target groups, life events, industrial classes.
4. Publishing status (Published ↔ Draft) and the `userName` field.

Exit: each field kind changes in PTV as the diff said, and untouched fields
(alternative names, user instructions, other languages) survive the PUT.

## Phase 2: removals and delete flags

Clear a field with a delete flag (`lifeEvents`, `industrialClasses`,
`generalDescriptionId`) and a full-replace field (a language's text).

Exit: an approved removal is gone on read-back, never silently dropped.

## Phase 3: error surfacing

PTV's 400 validation body reaches the MCP caller as a readable, per-field
message. The proposal is marked `failed`. No credentials appear in errors.

Exit: a deliberately invalid change comes back with PTV's field errors.

## Phase 4: draft reads

`Service/active/{id}` and `ServiceChannel/active/{id}` with the API-user
token, so proposals diff against the latest version (draft or modified),
not only the last published one. `supportsDraftRead: true`.

Exit: a service saved as Draft is read back as Draft through the connector.

## Phase 5: create and archive services

POST `/Service` for a new service in organisation 15 (new MCP path, same
two-phase approval), and archive with `publishingStatus: Deleted`.

Exit: a created service is readable by id; an archived one no longer shows
as published.

## Phase 6: channels and connections

Channel updates for each type (EChannel, Phone, PrintableForm,
ServiceLocation, WebPage); service↔channel connections with extra info
(`PUT /Connection/serviceId/{id}`).

Exit: a channel name/description change and a connection add/remove are
visible on read-back.

## Phase 7: audit of credential changes

Audit entries for the v11 API-user routes and the v12 API-key routes.

Exit: saving or deleting either credential writes one audit entry with no
secret in it; covered by an integration test.
