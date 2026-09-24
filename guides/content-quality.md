# Writing good PTV content — rules and review checklist

This guide condenses the Digital and Population Data Services Agency (DVV)
content guidelines for Suomi.fi Palvelutietovaranto (PTV). Source: the
"Sisällön tuottaminen Palvelutietovarantoon" section of
kehittajille.suomi.fi and its sub-pages (retrieved 2026-09-24). Finnish UI
and field names are shown in parentheses so you can match them to the PTV
user interface and the DVV guidance.

Use it in two ways:

- **When writing**: follow sections 1–8 when you draft or change a service,
  a channel, an organisation or a service collection.
- **When checking**: go through the **review checklist** (section 9) item by
  item. Report each failed check with its ID (e.g. `Q-STRUCT-1`) and the
  field and language where it fails.

**Automated checks.** The checks marked *auto* in section 9 run
deterministically in the MCP (`src/quality/contentChecks.ts`). Their
results come back:

- in the `quality` field of every proposal,
- on every review campaign item,
- from `ptv_check_quality`.

The same text always gives the same result, whichever AI (if any) is
used. Errors break a DVV rule. Warnings are heuristics (e.g. Finnish
passive voice) for a person to judge. The MCP reads names, summaries,
descriptions, classifications, languages and connections, and for
channels also their addresses, phone numbers, emails, web addresses,
service hours, form files and accessibility. A service's instructions
(toimintaohjeet) are not read yet, so check them by hand.

Checks marked *manual* need judgement (the service test, tone, facts). The
writer, the AI assistant and in the end the human approver own them.
`ptv_validate_changes` separately checks PTV's own write rules: mandatory
fields, limits and code values.

---

## 1. Principles

By adopting PTV, an organisation agrees to follow PTV's terms of use and
editorial policy (toimituspolitiikka). That means writing content that
follows the data model, these guidelines and the quality requirements.

Good PTV content is **customer-oriented, understandable and up to date**
(asiakaslähtöinen, ymmärrettävä, ajantasainen). PTV content is **open data**.
It is shown on Suomi.fi and reused through the open API on organisations'
own websites, in chatbots, map services and service catalogues. So:

1. **Structured data: each fact goes in its own field.** Never write
   visiting addresses, phone numbers, web addresses, email addresses or
   opening hours in free-text fields (name, summary, description,
   instructions). They belong in the structured fields of the right service
   channel.
2. **Every description must stand on its own.** Don't refer to other
   descriptions, other fields of the same description ("see below", "as
   mentioned above"), or to the website that will show the content ("on
   this page").
3. **Write for the customer**, not for the organisation. Describe the
   service, not the organisation's tasks, processes or internal structure.
4. **Use formatting sparingly.** The consuming system usually sets the
   style. Only paragraphs, bullet lists and subheadings are available.
   There is no bold, italic or underline. Subheadings reach the receiving
   system only for API v11 consumers.
5. **Keep content current.** The organisation must keep published
   information accurate at all times. Don't write things that go out of
   date (see section 7).

## 2. Style: plain, customer-oriented web text

PTV uses **plain language** (selkeä yleiskieli): clear, standard language
without special vocabulary or hard-to-follow structures. Good web text:

- is short and easy to scan
- is easy to understand
- puts the most important thing first
- is written from the customer's point of view
- is objective and doesn't make value judgements or advertise
- stays valid over time.

Concrete rules:

- **Address the reader as "you" (sinä) and use the imperative** to guide
  action: "Hae asumistukea Kelalta sähköisesti", not "Asumistukea haetaan
  Kelasta". Avoid the passive and other impersonal structures.
  - Exception: on sensitive topics a neutral wording may be kinder than
    addressing the reader directly.
- **Most important thing first**, in the first paragraph. Background
  comes after.
- **One topic per paragraph, and at most four sentences per paragraph.**
  Keep sentences short, usually at most three clauses each.
- **Use full clauses.** Replace participial and infinitive constructions
  (lauseenvastikkeet) with subordinate clauses: "Jos sinun ei ole
  mahdollista käyttää verkkoasiointia, vie hakemus toimistoon", not
  "Verkkoasiointikanavan käytön ollessa mahdotonta …".
- **Use precise verbs with a subject** (saada, hakea, kirjoittaa,
  postittaa). Prefer simple, familiar words. Explain any abbreviation or
  term you have to use. Avoid vague, empty sentences.
- **Avoid administrative jargon and references to laws** in running text.
  Legal references go in the dedicated law field (see 3.1).
- **No personal names.** Use job or role titles instead. PTV data is
  published openly and can be reused anywhere.
- **No dates or years** in descriptions unless they are unavoidable. They
  go out of date.
- **Proofread**: spelling, grammar and punctuation. Unusual abbreviations,
  rare place names and institution names are fine if the reader
  understands them.

Useful references: Kielitoimiston ohjepankki (kielitoimistonohjepankki.fi),
Kielitoimiston sanakirja, Saavutettavan kielen työkalupakki
(saavutettavakieli.fi), and Selkeästi meille (selkeastimeille.fi).

**Plan before you write**: first read what each free-text field is for.
If a general description (pohjakuvaus) is used, read it first so you don't
repeat it (see 3.3).

## 3. Service (Palvelu)

In PTV, a **service** is the reason a customer contacts an organisation.
The customer can be a person, a company, a community or an authority.
Permits and notifications that customers must make are also services.

A thing is a service only if:

- **it has customers who want it**, and
- **it has service channels** (asiointikanavat) through which the customer
  can use it. If you can't imagine a channel for it, it isn't a service.
- **The customer is active**: they start the contact, or they fulfil an
  obligation such as applying for a permit or filing a notification.
  Things like "administration", invoicing, elections, supervision, or a
  plan the customer can't ask for are not services.

**Pick the right level.** Describe the narrowest need a customer can have.
For example, "Taxation" is too broad, but "Tax card" is a service. Changing
a first name and changing a surname are separate services, even if the
process behind them is the same. Don't bundle all of an organisation's
activity into one service.

### 3.1 Service fields

| Field (UI)                                                                                        | Rules                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name (Nimi)                                                                                       | Customer-oriented. **Don't include the organisation's name** unless it's truly necessary. An organisation can't have two services with the same name. An alternative name (Vaihtoehtoinen nimi), such as an informal name customers use, can be added and works as a search term.                                                                   |
| Service type (Palvelun tyyppi)                                                                    | Service (basic), Permit/obligation (Lupa ja velvoite), or Professional qualification (Ammattipätevyys; only for competent authorities).                                                                                                                                                                                                              |
| Summary (Tiivistelmä)                                                                             | **Max 150 characters.** A customer-oriented summary of the most important content, shown for example in Suomi.fi search results. **Must not copy the name.** **Must not contain anything that isn't in** the description, instructions or conditions fields. It is **not** a lead-in to the description and isn't shown with it. Tip: write it last. |
| Description (Kuvaus)                                                                              | Max 5,000 characters, but shorter is better. Say what the service includes, what need it meets and what the customer gets. Describe the service, not the organisation. **No addresses, phone numbers or web addresses.** Paragraphs, lists and subheadings are allowed.                                                                             |
| Instructions (Toimintaohjeet)                                                                     | Max 5,000 characters. Say how the customer gets the service and in what order to do things. The reader must be able to act on their own and find the right channel. **No contact details.** Point to the channels in words instead, e.g. "Varaa aika verkossa tai soita".                                                                           |
| Conditions and criteria (Ehdot ja kriteerit)                                                      | Optional, max 5,000 characters. Conditions the customer must meet, e.g. "only for unemployed people".                                                                                                                                                                                                                                               |
| Deadline / processing time / validity (Määräaika / Käsittelyaika / Voimassaoloaika)               | Optional, permits and obligations only. Keep them short. Leave the processing time empty if a typical time is hard to estimate.                                                                                                                                                                                                                     |
| Laws (Lakitiedot)                                                                                 | Optional. **Links only to up-to-date legislation in Finlex** (finlex.fi/fi/laki/ajantasa), using the law's name as it appears in Finlex. No other databases.                                                                                                                                                                                       |
| Languages (Palvelun kielet)                                                                       | The languages the customer can **get the service in**. This is not the language of the description.                                                                                                                                                                                                                                                |
| Area (Aluetieto)                                                                                  | Usually the same as the organisation's area. Use "Koko maa" only for truly nationwide services. For a municipality, use its own municipality (and others only by agreement). A local organisation uses its municipality or municipalities. **Don't make the area wider than it is "to be safe."** The area is for search, not for eligibility.      |
| Charges (Maksullisuus)                                                                            | Free or chargeable. Details go in the additional info field. Keep prices current. If they change often, link a web page channel instead. If only some channels charge, mark the service as chargeable and put the channel-specific details in the connection (see 5).                                                                              |
| Responsible organisations, funding, production method, producers, service voucher (Organisointi) | One main responsible organisation (päävastuuorganisaatio), which is the only one that can edit. Other responsible organisations are added when you arrange the service on their behalf by agreement. Production: self-produced, purchased (Ostopalvelut) or other. Record the service voucher option if one is in use.                               |

### 3.2 Classification (metadata)

Metadata is used for finding and grouping content. It isn't necessarily
shown to readers, but it drives search. Take it seriously.

- **Target group (Kohderyhmä)**, two levels: Citizens / Businesses and
  communities / Authorities.
  - Citizens: choose a subgroup **only if the service is only for that
    subgroup**. Never tick all the subgroups.
  - Businesses and communities: a subgroup is **mandatory**.
  - Authorities: has no subgroups.
- **Service class (Palveluluokka)**: **1–4 classes, and at least one must be
  a subclass.** Prefer subclasses; publishing fails if all the chosen
  classes are main classes. Codes come from `ptvserclass2`.
- **Ontology terms (Asiasanat)**: **1–10**, taken from Finto (JUHO, JUPO,
  TERO, TSR, YSO). Use them to narrow the topic. **Don't add general terms**
  whose topic is already clear from the target group or service class. Use
  `ptv_search_ontology_terms`.
- **Free keywords (Vapaat asiasanat)**: optional, for words missing from
  the ontology (e.g. "nuokkari", "eskari"). They must not replace real
  ontology terms.
- **Life event (Elämäntilanne)**: optional, citizens only, and only if one
  truly fits.
- **Industrial class (Toimiala, TOL 2008)**: required for business permits
  and for services aimed at specific industries. Choose the industry of the
  customer company, not your own. Leave it empty if the permit concerns all
  industries. Always choose the most specific level.

### 3.3 General descriptions (Pohjakuvaukset)

DVV maintains general descriptions for municipalities, wellbeing services
counties and employment areas. **For Evangelical Lutheran parishes,
Kirkkohallitus (the National Church Council) maintains general
descriptions** with the usage type "Evankelis-luterilaisen kirkon
palvelut", covering for example confirmation school, catechist activities
and day clubs. Parishes should use them. Find them with
`ptv_search_general_descriptions`.

A general description provides the name, service type, background or main
description, possibly conditions and instructions, target groups, service
classes, ontology terms and more. Its texts summarise the service in
general. They **don't** say how your organisation delivers it.

- **Read the general description first** and check that it fits. If it
  doesn't fit, describe the service without one.
- **Don't repeat or copy its text** into your own fields. DVV's quality
  report flags "general description text copied into the service fields".
  Add only local, organisation-specific details: how the service is
  arranged here, where, when and for whom, and what's special about it.
- Its classifications come with it, and you can add more.
- You can use one general description for several services if you name
  them differently.
- It may suggest shared channels. They aren't connected automatically, so
  connect them yourself.

## 4. Service channels (Asiointikanavat)

There are five channel types. A channel is **a way the customer can use a
service**.

### 4.1 Common rules for all channels

- **Name**: customer-oriented. It describes the channel itself, not the
  service it belongs to. **Don't repeat the organisation's name** unless
  needed to avoid confusion. Keep it simple and short. For e-service and
  web page channels, the name must work as link text. It can't be the same
  as one of your services' names, and two channels of the same type in
  your organisation can't share a name.
- **Description language vs. service languages**: the language
  version(s) of the description are the languages the content is shown in.
  "Languages the channel serves in" (Kielet, joilla asiointikanava palvelee)
  lists the languages a customer can actually use. For example, a phone
  line described in fi/sv/en may also serve in Arabic and Somali.
- **Summary**: max 150 characters. Not a copy of the name. Nothing that
  isn't in the description. Not a lead-in.
- **Description**: max 5,000 characters, shorter is better. **Only about
  the channel.** No addresses, phone numbers or URLs; they go in the
  channel's own fields.
- **Area**: inherited from the connected service by default, which is
  recommended. Override it only when the channel's area really differs.
  Don't make it too wide.
- **Sharing (Yhteiskäyttöisyys)**: the default and recommendation is that
  other organisations may connect the channel. Restrict it only when needed.
- **Accessibility (Saavutettavuus)**, for e-service and web page channels:
  "Ei tietoa" unless an accessibility assessment has been done (the Act on
  the Provision of Digital Services applies). Don't guess.
- **Support (Käytön tuki)**, for all types except service location: give
  direct support contacts, not the switchboard or registry, unless those
  really handle support.
- **Phone numbers**: a normal number is entered **without the leading 0**
  and with a country code (+358 default). A national service number (e.g.
  020202) has no area code. The price type is chargeable (normal call
  cost), extra charge (lisämaksullinen) or free. Explain any extra cost in
  words, e.g. if queueing is charged. Additional info such as "Vaihde" or
  "Asiakaspalvelu" is recommended when there are several numbers. **Never
  use personal names there.** Max 300 characters.
- **URLs** always start with `http://` or `https://`. Give the exact
  address for each language version.
- **Opening hours (Palveluajat)**, for e-service (only if it's not always
  available), phone and service location channels:
  - Types: Always open, Open by appointment, Exceptional hours,
    Weekdays and times, Across midnight.
  - Holiday hours (Juhlapyhien palveluajat) are valid **until further
    notice**. **Check them every year.** For parishes this matters
    especially around Christmas, Easter, Ascension Day, Midsummer and All
    Saints' Day, when parish activities differ from normal opening hours.
  - Times are written like `12.00`: no colon, no leading zero, always with
    minutes. An optional title of up to 150 characters, e.g. "Vain
    syyskaudella", helps the customer tell sets of hours apart.
- **Never describe another organisation's channel yourself.** Connect their
  shared channel instead. The only exception is a producer that won't join
  PTV (see 6).

### 4.2 Channel-specific rules

- **E-service (Verkkoasiointi)**: booking, enrolment and application
  systems, chats and similar.
  - Give the exact URL that takes the customer straight to the service. For
    services that require Suomi.fi authentication, use the page where
    authentication starts on the service's side, **never a
    `tunnistautuminen.suomi.fi` address**.
  - Record whether authentication is required (default: yes) and whether an
    e-signature is required (default: no; if yes, give the number of
    signatures).
  - Attachments must be external links.
- **Web page (Verkkosivu)**: extra information only. **Use it sparingly and
  only alongside other channels.** Direct customers first to channels where
  they can actually get the service. The description says briefly what
  information the page offers.
- **Printable form (Tulostettava lomake)**:
  - **One subject per channel.** Several forms are fine only if they
    concern the same subject.
  - Give the form code if there is one, and a file URL for each format
    (PDF, DOC/DOCX, XLS/XLSX, RTF, ODT).
  - Give delivery details (toimitustiedot) unless the form itself clearly
    says where to send it. Putting them only in the service instructions
    is not enough.
- **Phone (Puhelinasiointi)**: calls, text messages (including WhatsApp)
  and fax.
  - **One subject per channel.** Several numbers are fine only when they
    are alternatives for the same matter, e.g. "Terveydenhoitaja (luokat
    1–6)" and "(luokat 7–9)".
  - Each language version needs at least one number.
- **Service location (Palvelupaikka)**: a physical place, such as an office,
  church, parish centre, camp centre or cemetery office.
  - Enter the street address in the structured fields: street, number and
    postcode picked from the Posti database. Adjust the map pin to the
    entrance.
  - Use "Muu sijaintitieto" (coordinates plus additional info) only when
    there is no official address. Such locations are **not shown on
    Suomi.fi**.
  - Several addresses are allowed only for the same place, or for a mobile
    service.
  - Check for duplicates.
  - Accessibility information is entered through the separate
    accessibility app.
  - Contact details: phone, email, web page, postal address or fax,
    whichever are relevant.

## 5. Connections (Liitokset)

- **Connect every channel through which the service is available.** Every
  service needs at least one channel, and every channel at least one
  service. One channel can serve many services.
- You can connect other organisations' shared channels to your services.
- **Connection details** (description, charges, opening hours, contacts)
  are optional. Use them **only** when something differs from the channel's
  general data, e.g. different hours for the pool and the gym in the same
  building.

## 6. Organisation (Organisaatio)

- The organisation is created as a draft when the PTV permit is granted and
  the first user logs in. **Complete and publish it first.** Nothing else
  can be published before it.
- **Publish it in every language you will describe services in** (fi, sv,
  en and the Sámi languages). Add language versions to the existing
  organisation; don't create a new one.
- Business ID (Y-tunnus): `1234567-8`. Check whether sub-organisations have
  their own.
- **Summary**: not a copy of the name.
- **Description**: max 2,500 characters. What the organisation is and does,
  **from the customer's point of view**. Neutral, not promotional. No
  contact details.
- Organisation type and area:
  - Public types are state, region, regional joint organisation and
    municipality. Private types are "Järjestöt ja yhteisöt" and "Yritykset".
  - The area is pre-filled into new services and channels.
  - A parish's area is normally its own municipality or municipalities.
- Contact details go in the structured contact fields: postal address,
  phone, general email (e.g. the registry), e-invoicing address, and web
  page with a short descriptive name.
- **Visiting locations are service location channels, not organisation
  data.**
- **Sub-organisations**: at most 5 levels. Keep the hierarchy as flat as
  possible. Create one only when customers benefit from seeing the
  sub-unit as the responsible organisation, or when you need per-unit
  reporting. For example, a parish union (seurakuntayhtymä) and its
  parishes.
- Name change: edit the name, and the services follow. Also update any
  free text where you wrote the old name yourself. For mergers or moving
  content to another organisation, ask DVV at ptv-tuki@dvv.fi. IDs are
  preserved.

## 7. Languages and keeping content current

- PTV supports fi, sv, en, se (Northern Sámi), smn (Inari Sámi) and sms
  (Skolt Sámi).
- Describe services as the Language Act and the Sámi Language Act require.
  DVV **recommends fi, sv and en for all organisations**. Business permits
  must be in fi, sv and en (SDG regulation).
- **Describe channels only in the languages they actually serve in.** If a
  Swedish service has no Swedish channel, connect a general advice channel
  that serves in Swedish.
- Put all language versions in the **same** content item, never in separate
  ones. The versions must match each other.
- Translation is the organisation's own responsibility; the PTV
  translation service was discontinued in 2024. AI translations must be
  reviewed by a competent human.
- **Publishing only some language versions sends the rest back to draft.**
  Always check which languages a publish will affect.
- Archiving applies to all language versions. There is no delete.
  Archived versions stay visible for 15 months.
- Review all content regularly, at least once a year. Look especially at
  prices, opening hours, holiday hours, contact details and staff titles.

## 8. Service collections (Palvelukokonaisuudet)

A service collection groups services and channels (yours and/or other
organisations') so an API consumer can fetch them as one set. Name it so
the name shows what's grouped. Its name, summary and description are
mostly for PTV maintainers, and DVV doesn't show them to the public.

## 9. Review checklist

Use this list to check a draft, a proposal diff or published content.
Check every language version separately. Report `PASS`, `FAIL` (with the
field, language and a suggested fix) or `N/A` for each item.

### Structure and data model

- `Q-STRUCT-1` (*auto*): No phone numbers, email addresses, URLs, street or visiting
  addresses, or opening hours in names, summaries, descriptions,
  instructions or conditions.
- `Q-STRUCT-2` (*auto (heuristic)*): The text doesn't refer to other descriptions, other fields
  ("see below"), or "this page/website".
- `Q-STRUCT-3` (*manual*): A service's content is about the service, not the
  organisation. A channel's description is about the channel only. An
  organisation's description is neutral and not promotional.
- `Q-STRUCT-4` (*manual*): The service passes the service test: customers want it,
  the customer is active, it has channels, and it's at the right level
  (not bundled, not internal).
- `Q-STRUCT-5` (*auto*): Every service has at least one connected channel and every
  channel at least one service. All real channels are connected.
- `Q-STRUCT-6` (*manual*): Another organisation's channel is connected, not described
  again.

### Fields

- `Q-NAME-1` (*partly auto: organisation name in the service name*): The name is customer-oriented, doesn't repeat the
  organisation's name without need, and isn't a duplicate. A channel name
  describes the channel, and e-service or web page names work as link
  text.
- `Q-SUM-1` (*auto*): The summary is at most 150 characters, isn't a copy of the
  name, adds information, and contains nothing that's missing from the
  description, instructions or conditions.
- `Q-DESC-1` (*auto: presence and length*): The description is within its limit (service and channel
  5,000, organisation 2,500 characters) and says what the customer gets
  and what need it meets.
- `Q-INSTR-1` (*manual*): The instructions tell the customer what to do and in what
  order, and point to the channels in words.
- `Q-GD-1` (*manual*): If a general description is used, its text isn't repeated or
  copied, and only local details are added.
- `Q-LAW-1` (*auto (heuristic)*): Laws appear only as Finlex links in the law field, not as
  references in running text.
- `Q-CLASS-1` (*auto*): There are 1–4 service classes, with at least one subclass.
- `Q-CLASS-2` (*auto: count*): There are 1–10 ontology terms, specific rather than generic,
  and free keywords don't replace real terms.
- `Q-CLASS-3` (*auto: KR2 sub-group, many citizen sub-groups*): Citizen subgroups are used only for services limited to
  those groups (never all of them), and business services have a subgroup.
- `Q-AREA-1` (*manual*): The area isn't wider than the real service area.
- `Q-LANG-1` (*partly auto: languages present*): The service languages list the languages the customer is
  actually served in. Channels are described only in the languages they
  serve in.
- `Q-LANG-2` (*auto: every language version has name, summary and description*): The language versions match each other in content, and all
  of them are published or intentionally drafted.
- `Q-CONTACT-1` (*mostly auto*: number and URL formats are validation
  errors; extra-charge numbers without a price, several numbers without
  additional info, a service location without a street address and an
  e-service without accessibility info are warnings; personal names stay
  manual): phone numbers have no leading 0, include a price type and any
  extra cost in words, and have no personal names in additional info.
  URLs start with http(s):// and aren't `tunnistautuminen.suomi.fi`.
- `Q-HOURS-1` (*partly auto*: the time format is a validation error; ended
  exceptional hours and untitled parallel weekly schedules are warnings):
  the times are right, holiday hours are checked for the current church
  and calendar year, and exceptional hours have a clear title. In the MCP,
  times are written `HH:mm` (PTV's UI shows `12.00`).

### Style

- `Q-STYLE-1` (*manual*): The most important thing comes first.
- `Q-STYLE-2` (*auto (heuristic, Finnish)*): The reader is addressed as "you", uses imperatives, and
  there is no unnecessary passive voice.
- `Q-STYLE-3` (*auto (heuristic)*): Paragraphs have at most four sentences and one topic each,
  and sentences are short (usually three clauses or fewer).
- `Q-STYLE-4` (*auto (heuristic, Finnish)*): There are no participial or infinitive constructions
  (lauseenvastikkeet); subordinate clauses are used instead.
- `Q-STYLE-5` (*manual*): Plain language: no jargon, and abbreviations are explained.
- `Q-STYLE-6` (*manual*): No personal names; titles or roles are used instead.
- `Q-STYLE-7` (*auto (heuristic)*): No dates or years that will go out of date.
- `Q-STYLE-8` (*manual*): No spelling or grammar errors.
- `Q-STYLE-9` (*auto*): Formatting is limited to paragraphs, lists and
  subheadings, with no emphasis markup.

### Accuracy (always a human check)

- `Q-FACT-1` (*manual*): Every fact is correct and current: prices, opening hours,
  eligibility, contacts and the producer. Facts that came from an AI
  suggestion and haven't been confirmed from an authoritative source must
  be flagged to the human approver, not presented as certain.

DVV also publishes an automated text-check report (tekstintarkastuksen
raportti) for published service descriptions. It covers checks similar to
the ones above: contact details in the wrong field, passive voice,
participial constructions, long sentences, law references, personal
names, dates and years, a summary with content not found in the
description, copied general description text, and spelling. Reviewing
against this checklist before publishing keeps an organisation's report
clean.
