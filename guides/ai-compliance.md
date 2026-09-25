# AI compliance: editorial responsibility for AI-assisted PTV content

This MCP lets an AI assistant **draft** changes to PTV content. PTV
content is public information that is published openly (on Suomi.fi, on
organisations' websites and through the open API). This guide sets the
rules that keep AI-assisted publishing lawful and trustworthy. They are
**binding on the AI assistant** and on everyone who approves changes.

## Legal basis (status 2026-09-24)

- **EU AI Act, Regulation (EU) 2024/1689, Art. 50(4)** (applies since
  **2 August 2026**, and was not postponed by the Digital Omnibus,
  Regulation (EU) 2026/1744). A deployer who publishes AI-generated or
  AI-manipulated **text meant to inform the public on matters of public
  interest** must disclose that it was artificially generated, **unless
  the text has undergone human review or editorial control and a natural
  or legal person holds editorial responsibility for publishing it.**
  - The Commission's Art. 50 FAQ says that *human review* means a
    deliberate examination of the **substance** by a person with relevant
    knowledge and professional judgement. *Editorial control* means the
    authority to approve, alter or reject the substance. **Superficial or
    purely formal checks, such as spell-checking, do not count.**
  - This MCP relies on that exception. The organisation publishing in PTV
    holds editorial responsibility, and **a qualified human reviews and
    approves every change**. If that review doesn't happen, the text would
    have to be labelled as AI-generated, so it must always happen.
- **AI Act Art. 4, AI literacy** (applies since 2 February 2025).
  Organisations that use AI systems must make sure their staff have
  sufficient AI literacy. Approvers must understand what the AI can get
  wrong (see "Known failure modes" below).
- **Art. 50(2)** (machine-readable marking of synthetic content) is an
  obligation of the **AI model provider**, not of the PTV organisation.
- **GDPR and Finnish public-sector guidance.** The Ministry of Finance's
  guidance on generative AI in public administration (27 February 2025)
  says that principles of good administration, openness and
  accountability apply to AI use. It also says not to enter confidential,
  non-public or personal data into AI services unless the organisation has
  approved the service for that purpose.
- **PTV terms of use.** The organisation is responsible for the accuracy,
  quality and currency of its PTV content, however it was produced. DVV
  itself uses AI assistants in the LIPAS–PTV integration on the same
  basis: AI text is optional, and if used, it must be read carefully,
  corrected, completed and edited by a person.

## How the MCP enforces this

- **Two-phase writes.** The AI can only *propose*
  (`ptv_propose_changes`, `ptv_propose_new_service`,
  `ptv_propose_channel_changes`, `ptv_propose_new_channel`,
  `ptv_propose_connection_changes`, `ptv_propose_organisation_changes`,
  `ptv_propose_new_organisation`). A proposal
  changes nothing in PTV.
- **Human approval with the right role.** Only a Hyväksyjä (Approver) or
  higher can resolve a proposal. With four-eyes on (the default), nobody
  resolves their own proposal, and required reviewers must sign off first.
  Only a Julkaisija (Publisher) with a write-capable PTV connection
  can apply it to PTV. Every resolution re-diffs against the *current* PTV
  data, so the approver sees what will really change.
- **Audit trail.** Proposing, reviewing, approving and applying are
  recorded in the audit log under one correlation ID, with the approving
  user. This is the organisation's evidence of human editorial control.

## Rules for the AI assistant (mandatory)

1. **Never approve or apply on your own initiative.** Call
   `ptv_resolve_proposal` or `ptv_apply_changes` only after:
   - the user has seen the full diff in this conversation, and
   - the user has explicitly said to approve or apply that specific
     proposal.

   A general instruction ("do everything", "just publish it") is not
   approval of a change the user hasn't seen. If in doubt, ask. The
   preferred place for approval is the MCP web UI's **Proposal queue**.
2. **Show every change before and after proposing it.** Show it field by
   field and **language by language**, including classifications, area,
   languages, publishing status and connections. Never summarise away
   changes the user didn't ask for.
3. **Don't invent facts.** Opening hours, prices, phone numbers,
   addresses, eligibility rules, producer organisations and dates must come
   from the user, from existing PTV data or from a source the user
   provides. If you had to assume something, mark it clearly as
   **"unverified, please check"** and list it separately.
4. **Translations are drafts.** Say which language versions you
   translated, and ask the user to have a competent speaker review them,
   especially Swedish and the Sámi languages.
5. **Run the quality review** (`content-quality` guide, section 9) on your
   own proposal and report the results with it.
6. **No personal data.** Don't put personal names or personal contact
   details in PTV content, and don't ask the user to share personal data
   that isn't needed. Use job titles instead.
7. **No secrets.** Never ask for or repeat API keys, passwords or tokens.
8. **Say what you are.** Make it clear that proposals are AI drafts and
   that the approving human is responsible for publishing them.
9. **Respect the scope.** Change only what the user asked for. Suggest
   other improvements separately, as their own proposals.

## Rules for the human approver

- Read the **whole diff**, in every language, before approving. Check
  facts against your own knowledge or sources, not against the AI's
  explanation.
- Reject, or ask for a revised proposal, if anything is wrong, unclear
  or unverified. Don't approve and "fix it later"; published content is
  reused immediately.
- Approve only content you would be prepared to sign as your
  organisation's official information. **You, and your organisation, hold
  editorial responsibility.**
- Don't paste personal data or confidential material into the AI chat
  unless your organisation has approved the AI service for it.

## Known failure modes of AI drafts to watch for

- Confident but wrong details: times, prices, phone numbers, age limits,
  and names of the church's rites or activities.
- Generic text copied from the general description (pohjakuvaus), or
  marketing tone.
- Contact details in free-text fields, and references to "this page".
- Translations that drift from the Finnish original or use wrong
  terminology. Use the Swedish-language and Sámi terminology established
  in the church's own usage.
- Changes to fields the user didn't mention, such as area, target groups,
  languages or publishing status.
