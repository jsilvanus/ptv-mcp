# Automated quality checks and review campaigns

Agreed 2026-09-24. Builds on docs/roles-and-review-plan.md: the proposal
queue, four-eyes and required reviewers are unchanged. This plan adds what
comes before and around them.

## 1. Deterministic quality checks

`src/quality/contentChecks.ts` automates the checks in
`guides/content-quality.md` section 9 that can be decided from the data
alone. Every run gives the same result, like the checks in PTV's own UI,
so the AI is not relied on for them. The check ids are the guide's `Q-*`
ids.

- **Errors** (DVV rules):
  - contact details or opening hours in names, summaries or descriptions
  - a missing name, summary or description in a language version
  - a summary over 150 characters, or a summary that repeats the name
  - a description over 5,000 characters
  - 1–4 service classes with at least one sub-class, and 1–10 ontology
    terms (lower limits skipped with a general description, which supplies
    them)
  - KR2 without a sub-group
  - no service languages
  - no connected channels or services
- **Warnings** (heuristics):
  - references to "below" or "this page"
  - legislation in running text
  - dates and years
  - emphasis markup
  - sentences over 25 words, paragraphs over four sentences
  - Finnish passive verbs and participial constructions
  - the organisation name in the service name

Where they run:

- the `quality` field of every `ptv_propose_*` result and of
  `ptv_get_proposal` (and the web proposal page)
- `ptv_check_quality {kind, id}` on published content
- each review item, saved when the campaign starts and fresh in
  `ptv_review_get_item`

Only the domain model's fields are checked: instructions, contact fields
and opening hours are not mapped yet. Personal names, tone, facts and the
service test stay manual.

## 2. Review campaigns

A full check of an organisation's published PTV content.

| Step | Who | Tool / REST |
|---|---|---|
| Start: every service, channel and organisation (sub-organisations by default) becomes a review item with its check findings | Julkaisija+ | `ptv_review_start_campaign`, `POST /tenants/:id/review-campaigns` |
| Assign items to reviewers, by id or by kind and organisation (only unassigned ones unless `reassign`) | Julkaisija+ | `ptv_review_assign`, `POST …/:campaignId/assign` |
| Review: current data, fresh checks, linked proposals | the assigned Ehdottaja+ | `ptv_review_my_items`, `ptv_review_get_item` |
| Propose changes linked to the item | the assignee (or Julkaisija+) | `ptv_propose_*` with `reviewItemId` |
| Decide: `confirmed` (up to date, proper channels linked; not while linked proposals are pending) or `changes_proposed` (needs a linked proposal) | the assignee (or Julkaisija+) | `ptv_review_complete_item`, `POST /tenants/:id/review-items/:itemId/complete` |
| Resolve the proposals | Hyväksyjä / Julkaisija | the existing proposal queue |
| Send an item back | Julkaisija+ | `ptv_review_reopen_item` |
| Close | Julkaisija+ | `ptv_review_close_campaign` |

Rules:

- There is one open campaign per organisation and environment.
- A linked proposal must target the item's own service or channel. A new
  service can come from any item.
- The item must be open and its campaign open, in the same environment.
- Every step is audited under the campaign's correlation id.
- The tables `review_campaigns` and `review_items`
  (`drizzle/0022_review_campaigns.sql`) are tenant-scoped with RLS.
  `proposals.review_item_id` links a proposal to its item.

Organisation sub-units come from filtering the tenant's cached
organisation catalogue on `parentOrganizationId`. The adapter has no
children query.

### Publisher drafts for reviewers (added 2026-09-25)

A Publisher can draft the change themselves (a new channel or service, a
connection, a fix) and send it to the item's reviewer:

- Propose with `reviewItemId`, or attach an existing pending proposal
  (`ptv_review_attach_proposal`, `POST /tenants/:id/review-items/:itemId/attach`,
  web: the item's Attach field).
- A finished item reopens.
- When the link is made by someone other than the item's reviewer, the
  reviewer becomes a required reviewer of the proposal, so it can't be
  approved before they sign off. It shows in their `ptv_my_tasks`.
- What fits an item: its own service or channel; a service change that
  edits `serviceChannelIds` fits a channel's item; a new service or channel
  fits any item.
- Audited as `LinkProposal` (campaign correlation id) and `RequestReview`
  (the proposal's).

## 3. "Waiting for you" (pull, not push)

MCP notifications don't fit here:

- The server is stateless Streamable HTTP (a fresh server per request),
  so there is no open stream to push on between calls.
- MCP's notifications are protocol events (list changed, resource updated,
  progress, logging), not user-facing messages, and clients rarely show
  them to the user.

Instead, `ptv_my_tasks` (and `GET /tenants/:id/my-tasks`, shown in the
web UI as "Waiting for you") returns:

- review items assigned to the user;
- proposals waiting for their sign-off;
- for Hyväksyjä+, every suggested change in the environment still to
  handle, with its readiness: `waiting_for_reviewers`, `ready_to_resolve`,
  `needs_another_resolver` (own proposal under four-eyes) or, for
  Julkaisija+, `approved_for_manual_publish` (exported, to publish in
  PTV's own UI);
- for Julkaisija+, open campaigns' progress.

The server instructions tell the assistant to call it at the start of a
session.

Later, not planned now: email notifications (a real push, outside MCP),
rule-based reviewer assignment, and checking the channel fields
(addresses, phone numbers, URLs, opening hours) once the domain model
carries them.
