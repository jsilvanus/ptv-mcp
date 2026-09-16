# PTV MCP Server – Arkkitehtuurisuunnitelma (MVP)

> Tämä dokumentti on alkuperäisen suunnitelman **kriittinen läpikäynti ja
> täydennys**, tehty PTV:n v12-rajapinnan julkisen OpenAPI-kuvauksen
> (`https://docs.palvelutietovaranto.trn.suomi.fi/api-documentation/v12/openapi.json`)
> ja Suomi.fi:n kehittäjädokumentaation
> (`rajapinta-ja-arkkitehtuuriuudistus`) pohjalta 2026-09-16.
> Kappale ["Kriittiset havainnot PTV v12 -rajapinnasta"](#kriittiset-havainnot-ptv-v12--rajapinnasta)
> kannattaa lukea **ennen** muuta suunnitelmaa, koska se muuttaa MVP:n
> rajausta merkittävästi.

---

## Kriittiset havainnot PTV v12 -rajapinnasta

Alkuperäinen suunnitelma olettaa, että PTV v12 -rajapinnan kautta voidaan
sekä **hakea** että **kirjoittaa** (`ptv_apply_changes`) tietoa suoraan API-avaimella.
Todellisen OpenAPI-kuvauksen tarkastelu (32 polkua, tilanne 2026-09-16)
osoittaa, että näin ei ole vielä.

### 1. v12 on tällä hetkellä pelkkä hakurajapinta – kirjoitusta ei ole vielä julkaistu

Kaikki 32 dokumentoitua endpointtia ovat **GET**-metodeja:

```text
GET /api/v12/service/{contentId}            GET /api/v12/service/search
GET /api/v12/service-channel/{contentId}    GET /api/v12/service-channel/search
GET /api/v12/organization/{contentId}       GET /api/v12/organization/search
GET /api/v12/organization/hierarchy/{id}
GET /api/v12/general-description/{contentId}
GET /api/v12/service-collection/{contentId}
GET /api/v12/connection/{serviceId}/{channelId}
GET /api/v12/service/archived, /service-channel/archived, /organization/archived, ...
GET /api/v12/{target-groups,life-events,industrial-classes,ontology-terms,
              service-classes,language-codes,country-codes,municipality-codes,
              region-codes,wellbeing-services-county-codes,postal-codes}
GET /health/liveness, /health/readiness
```

Ei yhtään `POST`/`PUT`/`PATCH`/`DELETE`-endpointtia. `ptv_apply_changes`,
sellaisena kuin alkuperäinen suunnitelma sen kuvaa, **ei ole tällä hetkellä
teknisesti mahdollinen v12-rajapinnan kautta**.

### 2. Aikataulu: kirjoitusrajapinta on tulossa vasta myöhemmin

Suomi.fi:n kehittäjäsivun (`rajapinta-ja-arkkitehtuuriuudistus`) mukaan v12
julkaistaan vaiheittain, ja siihen kuuluu erikseen haku- (OUT) ja
tuontimetodit (IN, eli kirjoitus):

| Ajankohta | Tapahtuma |
|---|---|
| 01/2026 | v12 hakumetodit testiympäristössä |
| 03–04/2026 | v12 hakumetodit betana tuotannossa |
| **10/2026** | **v12 kirjoitusmetodit testiympäristössä** |
| 11/2026 | v12 hakumetodit valmiina tuotannossa |
| **04/2027** | **v12 kirjoitusmetodit tuotannossa**; v11-rajapinta poistuu kokonaan |

Tämä tarkoittaa, että **tänään (2026-09-16) v12-kirjoitusrajapintaa ei ole
edes testiympäristössä** – se avautuu arviolta noin kuukauden kuluttua, ja
tuotantoon se tulee vasta huhtikuussa 2027. Nykyinen tuotantokäytön
kirjoitustie on vanha **v11-rajapinta**, jota ei tässä suunnitelmassa ole
vielä analysoitu (eri autentikointimalli, eri tietomalli, eroaa
todennäköisesti merkittävästi v12:sta).

Tästä seuraa suoraan: **MVP:n rajaus ja vaiheistus on kirjoitettava
uusiksi** (ks. [uusi vaiheistus](#tarkistettu-vaiheistus)). "Julkaisu PTV:hen
API:n kautta" ei voi olla MVP:n ominaisuus, ellei erikseen päätetä
toteuttaa myös v11-integraatiota rinnalle.

### 3. Kirjoitusskeemat ovat jo nähtävissä OpenAPI-dokumentissa – hyödynnä niitä suunnittelussa

Vaikka polkuja ei ole, `components/schemas`-osiossa on jo valmiina tulevien
kirjoitusoperaatioiden pyyntömallit: `PostServiceRequest`, `PutServiceRequest`,
`PostEServiceChannelRequest`, `PostServiceLocationChannelRequest`,
`PostPrintableFormChannelRequest`, `PostTelephoneChannelRequest`,
`PostWebPageChannelRequest` (ja vastaavat `Put*`-versiot). Näitä kannattaa
käyttää jo nyt sisäisen tietomallin ja validointilogiikan pohjana, jotta
kun v12-kirjoitusrajapinta avautuu testiympäristöön (~10/2026), PTV Client
-kerros on suurelta osin valmis.

Tästä nähdään myös tärkeä rakenteellinen seikka, jota alkuperäinen
suunnitelma ei huomioi:

- **Palvelu ("Service") ei ole yksi tyyppi vaan kolme**: `Service`,
  `ProfessionalQualificationService`, `PermitOrOtherObligationService` –
  kullakin oma pakollisten kenttien joukko ja oma language-version-malli.
- **Palvelukanavia ("Service channel") on viisi tyyppiä**: sähköinen asiointi
  (`EServiceChannel`), asiointipiste (`ServiceLocationChannel`), lomake
  (`PrintableFormChannel`), puhelin (`TelephoneChannel`) ja verkkosivu
  (`WebPageChannel`) – kullakin oma pyyntömallinsa.

MCP-työkalujen ja validointilogiikan (`ptv_validate_changes`) pitää siis
olla **tyyppitietoisia**, ei yhtä geneeristä "palvelu"-kaaviota. Tämä
lisää validointikerroksen laajuutta merkittävästi MVP:ssä.

Esimerkkejä pakollisista/rajoitetuista kentistä `Service`-pyynnössä, jotka
kannattaa tuoda `ptv_validate_changes`-sääntöihin: `ontologyTerms`
(maks. 10 kpl), `serviceClasses` (maks. 4 kpl), kontrolloidut URI-koodistot
`industrialClasses`/`ontologyTerms`/`serviceClasses`/`lifeEvents`/`targetGroups`,
sekä pakollinen `serviceLanguages`, `area`, `chargeType`, `fundingType`,
`organizationContentId`, `languageVersions`.

### 4. Autentikointi rajapintaan

Dokumentaation mukaan: *"API key is required to use the API"* – rajapinnassa
on määritelty kaksi turvallisuusskeemaa, `apiKeyHeader` (`x-api-key`-otsake)
ja `bearerAuth` (JWT). Käytännössä nykyiset (haku-)endpointit käyttävät
`x-api-key`-mallia, mikä tukee alkuperäisen suunnitelman API-avainten
salattua tallennusta. `bearerAuth` on varattu, ja on syytä varautua siihen,
että **tuleva kirjoitusrajapinta voi vaatia OAuth/JWT-pohjaisen tokenin eikä
pelkkää staattista API-avainta** – tästä ei ole vielä varmuutta, joten
PTV Client -kerros kannattaa suunnitella tukemaan molempia
autentikointimalleja (adapteripattern), ei kovakoodata pelkkää staattista
avainta.

Rajapinta ei dokumentoi rate limitejä (ei `429`-vastauksia eikä
`X-RateLimit-*`-otsakkeita spesifikaatiossa) – niitä pitää silti *olettaa*
olevan tuotannossa, ja PTV Client -kerroksen retry-logiikka pitää tehdä
yleiskäyttöiseksi (exponential backoff + jitter, kunnioittaen
`Retry-After`-otsaketta jos sellainen joskus tulee) sen sijaan, että
nojataan dokumentoituun rajaan.

### 5. Ympäristöt

Rajapinnalla on kaksi ympäristöä, jotka löytyvät myös DNS-nimestä:
asiakastestiympäristö (`...trn.suomi.fi`, "trn" = training/testi) ja
tuotantoympäristö. Tämä tukee suunnitelman `TenantEnvironment`-mallia
sellaisenaan, mutta on syytä lisätä ympäristön tietoihin myös
**rajapintaversio ja sen kyvykkyydet** (ks. alla), koska testi- ja
tuotantoympäristöillä on eri ajanhetkinä eri kyvykkyydet (esim. testissä
kirjoitus mahdollista 10/2026 alkaen, tuotannossa vasta 04/2027).

### 6. "Archived"-endpointit – synkronointimekanismi

Jokaiselle sisältötyypille (service, service-channel, organization,
general-description, service-collection, connection) on oma
`.../archived`-endpoint, parametrina `archivedAtOrAfter`. Tämä on
suunniteltu inkrementaaliseen synkronointiin/cache-invalidointiin. Kannattaa
hyödyntää MCP-palvelimen mahdollisessa paikallisessa
välimuistissa/hakuindeksissä, jotta ei tarvitse pollata koko datasettiä.

---

## Tarkistettu vaiheistus

Alkuperäinen "MVP-rajaus" olettaa julkaisutoiminnon (`ptv_apply_changes`)
kuuluvan ensimmäiseen versioon. Koska v12-kirjoitusrajapintaa ei ole vielä
edes testiympäristössä, ehdotan MVP:n jakamista kolmeen alavaiheeseen:

### MVP-0 (nyt – rakennettavissa heti)

✅ käyttäjä- ja tenant-hallinta, roolit, audit-loki
✅ PTV-haku v12:n kautta (service, service-channel, organization,
   general-description, service-collection, connection, koodistot)
✅ AI-avusteiset **muutosehdotukset** (`ptv_propose_changes`) ja diff-näkymä
✅ `ptv_validate_changes` **paikallisena** (skeemavalidointi tulevia
   Post/Put-skeemoja vasten + PTV:n dokumentoituja sääntöjä vasten), ilman
   että mitään lähetetään PTV:hen
✅ **Vientitoiminto ilman API-kirjoitusta**: hyväksytty ehdotus viedään
   muodossa, joka on helppo kopioida PTV:n omaan hallintakäyttöliittymään
   (esim. kieliversioittain jäsennelty teksti / JSON-esikatselu), ja
   merkitään audit-lokiin tilaan `ReadyForManualPublish`
❌ ei suoraa kirjoitusta PTV:hen — teknisesti ei mahdollista

Tämä tuottaa jo itsenäisesti arvokkaan tuotteen (AI-avusteinen sisällön
parantelu + hallittu hyväksyntäprosessi), joka ei ole riippuvainen PTV:n
kirjoitusrajapinnan aikataulusta.

### MVP-1 (arviolta 10/2026 →, kun v12-kirjoitus avautuu testiin)

✅ `ptv_apply_changes` toteutetaan v12-kirjoitusrajapintaa vasten, aluksi
   vain `environment = test`
✅ Publisher-rooli pääsee kirjoittamaan **testiympäristöön**
✅ Tuotantoympäristö pysyy MVP-0-tilassa (vain manuaalinen vienti), koska
   v12-kirjoitus ei ole tuotannossa vielä

Vaihtoehtoisesti, jos organisaatiolla on jo käytössä v11-integraatio
tuotannon kirjoitukseen, tämä voidaan tuoda erillisenä sovittimena
(`Ptv11WriteAdapter`) jo MVP-0/MVP-1-aikataulussa — vaatii kuitenkin
erillisen selvityksen v11:n autentikoinnista ja tietomallista, koska sitä
ei ole tässä katselmoinnissa käyty läpi.

### MVP-2 (arviolta 04/2027 →, kun v12-kirjoitus avautuu tuotantoon)

✅ `ptv_apply_changes` sallitaan myös `environment = production`
✅ v11-sovitin (jos toteutettu) voidaan alkaa ajaa alas rinnakkain

Tämä aikataulu on syytä pitää **konfiguraationa, ei koodiin kovakoodattuna
oletuksena** — ks. alla oleva kyvykkyystaulukko.

### Rajapinnan kyvykkyyksien hallinta koodissa

Suosittelen lisäämään tietomalliin `PtvCapability`-käsitteen per ympäristö
ja rajapintaversio, jotta kirjoitustoiminnallisuus voidaan avata
konfiguraatiolla sitä mukaa kun PTV julkaisee sen, ilman koodimuutosta:

```text
PtvApiCapabilities
 ├─ api_version         (v11 | v12)
 ├─ environment         (test | production)
 ├─ supports_read
 ├─ supports_write
 └─ updated_at
```

`ptv_apply_changes`-työkalu tarkistaa tämän taulun ennen kirjoitusyritystä
ja palauttaa selkeän virheen ("PTV v12 -kirjoitusrajapinta ei ole vielä
käytössä tuotantoympäristössä, arvioitu saatavuus 04/2027") sen sijaan että
yrittäisi kutsua olematonta endpointtia.

---

## Muut havainnot ja täydennykset alkuperäiseen suunnitelmaan

### Multi-tenant-eristys: sovellustason suodatus ei riitä

Alkuperäinen suunnitelma nojaa organisaatiotietojen erotteluun
sovelluslogiikan (`tenant_id`-suodatus) varassa. Suosittelen lisäksi
**PostgreSQL Row-Level Securityä (RLS)** jokaiselle tenant-sidonnaiselle
taululle, jotta yksikin unohtunut `WHERE tenant_id = ...` -ehto
sovelluskoodissa ei johda tietovuotoon organisaatioiden välillä. Tämä on
erityisen tärkeää, koska data koskee seurakuntien palvelutietoja ja
audit-lokeja, joissa voi olla epäsuorasti erityisiin henkilötietoryhmiin
viittaavaa sisältöä (esim. diakonia-, perheneuvonta- tai
kriisiapupalvelujen kuvaukset) — ks. myös tietosuojahuomio alla.

### API-avainten salaus: envelope encryption ja rotaatio

Yhden ympäristökohtaisen master-avaimen sijaan suosittelen
**envelope-salausta**: jokaiselle tenant/environment-parille oma
data-avain, joka on salattu ympäristön master-avaimella (tai
KMS:llä/HashiCorp Vaultilla, jos sellainen on saatavilla). Tämä
mahdollistaa yksittäisen tenantin avaimen mitätöinnin/rotaation ilman että
kaikki muut pitää salata uudelleen, ja rajoittaa yhden master-avaimen
vuodon vaikutusta. Lisää myös:

- avainten rotaatiokäytäntö (esim. master-avain vaihdetaan X kk välein)
- pääsylokitus sille, **milloin** salattua avainta on tosiasiassa
  purettu käyttöön (ei vain kuka sitä on hallinnoinut) — tämä kuuluu
  luontevasti samaan audit-lokiin muiden tapahtumien kanssa

### Autentikoinnin täydennykset

Suunnitelma mainitsee `password_hash`-kentän muttei hajautusalgoritmia —
täsmennä: **Argon2id** (tai bcrypt, jos halutaan pysyä laajasti tuetuissa
Node-kirjastoissa). Lisäksi MVP:hen kannattaa lisätä, muuten
käyttäjähallinta on epätäydellinen ensimmäisestä päivästä asti:

- kirjautumisyritysten rajoitus/lockout
- sähköpostin vahvistus
- salasanan nollaus
- refresh-tokenin mitätöinti/kierto uloskirjautuessa (token rotation +
  denylist), koska muuten "logout" ei tosiasiassa tee mitään JWT:n kanssa

### Diffin ja hyväksynnän suhde PTV:n omaan luonnos/julkaisu-tilaan

Kun v12-kirjoitusrajapinta joskus valmistuu, on syytä selvittää, tukeeko se
erillistä **luonnos- ja julkaisutilaa** (PTV:n admin-UI:ssa on perinteisesti
ollut käsite "Draft"/"Published"). Jos tukee, suosittelen että
`ptv_apply_changes` kirjoittaa oletuksena PTV:n omaksi **luonnokseksi**, ja
varsinainen julkaisu PTV:hen on **oma erillinen toimintonsa**
(`ptv_publish`), joka vaatii Publisher-oikeuden erikseen. Tämä tuo toisen,
PTV:n omaan tilamalliin nojaavan turvakerroksen MCP-palvelimen oman
kaksivaiheisen hyväksynnän lisäksi, ja pienentää riskiä, että virheellinen
AI-ehdotus päätyy suoraan julkiseksi ilman PTV:n omaa katselmointimahdollisuutta.
Tätä ei voi vahvistaa ennen kuin kirjoitusskeemat julkaistaan lopullisina —
merkitään avoimeksi selvitettäväksi asiaksi MVP-1:tä varten.

### Validoinnin laajuus aliarvioitu

`ptv_validate_changes` kuulostaa suunnitelmassa yhdeltä geneeriseltä
tarkistuslistalta. Todellisuudessa validoinnin pitää kattaa (skeemojen
perusteella): tyyppikohtaiset pakolliset kentät (3 palvelutyyppiä × 5
kanavatyyppiä), maksimimäärärajoitteet (esim. `ontologyTerms` ≤ 10,
`serviceClasses` ≤ 4), kontrolloitujen koodistojen (`service-classes`,
`ontology-terms`, `life-events`, `industrial-classes`,
`target-groups`, aluekoodit) jäsenyystarkistus PTV:n omia koodisto-endpointeja
vasten, sekä kaikkien pakollisten kieliversioiden olemassaolo. Suosittelen
tekemään validoinnista oman moduulinsa, joka on rakennettu suoraan PTV:n
JSON-skeemoista generoituna (esim. `ajv` + skeemat OpenAPI-dokumentista),
ei käsin ylläpidettynä sääntölistana — näin validointi pysyy ajan tasalla
PTV:n skeemamuutosten kanssa ilman manuaalista synkronointia.

### Tietosuoja (GDPR) ja kirkollinen konteksti

Koska organisaatio on seurakunta, osa PTV:hen kuvattavista palveluista
(esim. diakoniatyö, perheneuvonta, kriisiapu, rippikoulu, erityisryhmien
palvelut) voi epäsuorasti paljastaa tietoja, jotka liittyvät uskonnolliseen
vakaumukseen tai muihin arkaluonteisiin henkilötietoihin, vaikka itse PTV-sisältö on
julkista palvelutietoa eikä henkilötietoa. Silti audit-lokiin tallentuva
`prompt`-kenttä (käyttäjän vapaamuotoinen pyyntö AI:lle) **voi** sisältää
henkilötietoja, jos käyttäjä esim. liittää pyyntöönsä asiakastapauksen
kuvauksen. Suosittelen:

- audit-lokin `prompt`/`before_state`/`after_state`-kenttien säilytysajan
  määrittelyä etukäteen (tietosuojaseloste + minimointiperiaate)
- selkeää ohjeistusta käyttäjille, ettei AI-promptiin tule liittää
  yksittäisten henkilöiden tietoja
- harkintaa siitä, tarvitaanko näille lokikentille pääsyrajoitus myös
  Tenant Adminin sisällä (esim. vain tekninen pääkäyttäjä pääsee
  raakoihin prompteihin, muut näkevät vain tiivistelmän)

### Rakenteelliset tekniset täsmennykset

- **Retry/backoff ja idempotenssi**: koska tuleva kirjoitusrajapinta
  todennäköisesti tukee `contentId`-pohjaista PUT-päivitystä, PTV Client
  -kerroksen retry-logiikan pitää olla idempotentti (turvallinen ajaa
  uudelleen verkkovirheen jälkeen) – POST (luonti) sen sijaan ei ole
  itsestään idempotentti, joten sille tarvitaan oma
  idempotenssiavain/deduplikaatiostrategia jo suunnitteluvaiheessa.
- **OpenAPI-generointi**: koska PTV julkaisee viralliset OpenAPI 3.1
  -kuvaukset, PTV Client kannattaa generoida (tyypit + validointi)
  suoraan niistä (esim. `openapi-typescript` + `ajv`) sen sijaan että
  tyypit ylläpidettäisiin käsin — vähentää ylläpitotaakkaa merkittävästi,
  varsinkin kun kirjoitusskeemat vielä elävät (beta).
- **Health-endpointit**: PTV tarjoaa `/health/liveness` ja
  `/health/readiness` – näitä kannattaa käyttää MCP-palvelimen omassa
  taustatarkistuksessa PTV-yhteyden tilan monitorointiin per tenant/ympäristö.
- **Teknologiavalinta**: käyttäjän oma ohjeistus edellyttää Node.js + ESM:ää
  aina kun mahdollista. Suosittelen kirjaamaan tämän eksplisiittisesti myös
  toteutusohjeisiin: `"type": "module"`, TypeScript `"module": "NodeNext"`,
  ei `require()`-yhteensopivuustarvetta, koska projekti on greenfield.
  Fastify vs. NestJS -valinnasta suosittelen **Fastifya** ohueksi
  wrapperiksi kuvatun tavoitteen ("thin wrapper") kanssa – NestJS tuo
  huomattavasti enemmän omaa arkkitehtuuria ja boilerplatea kuin tämän
  kokoluokan palvelin tarvitsee.

---

# Alkuperäinen suunnitelma (täydennettynä)

## Tavoite

Rakentaa moniasiakasympäristöön (multi-tenant) soveltuva MCP-palvelin, joka
toimii ohuena välittäjänä (thin wrapper) Suomi.fi Palvelutietovarannon
(PTV) v12 -rajapinnan ja tekoälyagenttien välillä.

Ensimmäisen version tavoitteena on mahdollistaa:

- PTV-tietojen haku tekoälyagentin kautta
- muutosehdotusten tuottaminen tekoälyllä
- **hallittu vienti hyväksytyistä ehdotuksista** (API-kirjoitus vasta kun
  PTV julkaisee v12-kirjoitusrajapinnan, ks. yllä oleva aikataulu)
- organisaatiokohtainen käyttöoikeushallinta
- auditointi ja jäljitettävyys

MVP ei ole riippuvainen Microsoft Copilotista.

Copilot-, Entra ID- ja OIDC-integraatiot toteutetaan myöhemmissä vaiheissa.

---

# Perusperiaatteet

## 1. Multi-tenant SaaS

Järjestelmä tukee useita asiakasorganisaatioita.

Esimerkki:

- Riihimäen seurakunta
- Hämeenlinnan seurakunta
- Hausjärven seurakunta

Jokaisella organisaatiolla on:

- omat käyttäjänsä
- omat käyttöoikeutensa
- omat audit-lokinsa
- oma PTV API -avain
- omat ympäristönsä (testi / tuotanto)

Organisaatioiden tietoja ei koskaan saa sekoittaa keskenään.
**Tämä toteutetaan sekä sovellustason `tenant_id`-suodatuksella että
tietokantatason Row-Level Securityllä (ks. täydennykset yllä).**

---

## 2. PTV API-avain on organisaation omaisuus

Jokainen asiakas syöttää oman PTV API-avaimensa hallintaliittymään.

API-avain:

- salataan ennen tallennusta (envelope encryption, ks. yllä)
- sitä ei voi lukea käyttöliittymästä tallennuksen jälkeen
- sen voi korvata uudella
- sitä käytetään vain palvelimen sisäisesti

Käyttäjät eivät koskaan näe avaimen arvoa.

---

## 3. AI ei kirjoita suoraan

Kaikki muutokset ovat kaksivaiheisia.

Prosessi:

1. käyttäjä pyytää muutosta
2. AI muodostaa ehdotuksen
3. järjestelmä näyttää diffin
4. käyttäjä hyväksyy
5. järjestelmä päivittää PTV:n **(MVP-0:ssa: vie hyväksytyn sisällön
   manuaalisesti PTV:n hallintakäyttöliittymään vietäväksi; MVP-1/2:ssa:
   kirjoittaa suoraan v12-rajapinnan kautta, kun se on saatavilla)**

Ei koskaan:

```text
Prompt → Suora kirjoitus PTV:hen
```

---

# Arkkitehtuuri

```text
┌─────────────────────┐
│ Web UI              │
├─────────────────────┤
│ Tenant Management   │
│ User Management     │
│ API Key Management  │
│ Audit Logs          │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ MCP Server          │
├─────────────────────┤
│ Authentication      │
│ Authorization       │
│ Audit               │
│ Tenant Resolver     │
│ PTV Capability Gate │  ← uusi: tarkistaa onko kirjoitus mahdollista
│ PTV Tool Layer      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ PTV Client          │
├─────────────────────┤
│ Auth Adapter        │  ← uusi: apiKey / bearer, v11 / v12
│ Retry & Backoff     │
│ Schema Validation   │  ← generoitu PTV:n OpenAPI-skeemoista
└──────────┬──────────┘
           │
           ▼
      PTV API (v12 haku nyt / kirjoitus 10-2026→;
               v11 kirjoitus tuotannossa 04-2027 asti)
```

---

# Teknologiavalinnat

## Backend

- TypeScript
- Node.js (ESM, `"type": "module"`, `moduleResolution: "NodeNext"`)
- MCP SDK
- **Fastify** (kevyempi valinta "thin wrapper" -tavoitteeseen kuin NestJS)

## Tietokanta

- PostgreSQL (+ Row-Level Security tenant-eristykseen)

## Salaus

- AES-256-GCM, envelope encryption (per-tenant data key + ympäristökohtainen
  master-avain/KMS)

## Autentikointi

- JWT Access Token
- Refresh Token (rotaatio + denylist uloskirjautuessa)
- Argon2id-salasanahajautus

## Containerointi

- Docker
- Docker Compose

---

# Tietomalli

## User

```text
User
 ├─ id
 ├─ email
 ├─ name
 ├─ password_hash
 ├─ created_at
 └─ updated_at
```

---

## Tenant

```text
Tenant
 ├─ id
 ├─ name
 ├─ slug
 ├─ created_at
 └─ updated_at
```

---

## Membership

Käyttäjä voi kuulua useaan organisaatioon.

```text
Membership
 ├─ user_id
 ├─ tenant_id
 └─ role
```

Esimerkki:

```text
Juha
 ├─ Riihimäki (Admin)
 ├─ Hausjärvi (Editor)
 └─ Hämeenlinna (Viewer)
```

---

## TenantEnvironment

```text
TenantEnvironment
 ├─ id
 ├─ tenant_id
 ├─ environment        (test | production)
 ├─ encrypted_api_key
 ├─ encrypted_data_key   ← uusi (envelope encryption)
 └─ active
```

## PtvApiCapabilities (uusi)

```text
PtvApiCapabilities
 ├─ api_version         (v11 | v12)
 ├─ environment         (test | production)
 ├─ supports_read
 ├─ supports_write
 └─ updated_at
```

Ylläpidetään joko manuaalisesti (konfiguraationa) tai automaattisesti
tarkistamalla PTV:n julkaisemat OpenAPI-kuvaukset määräajoin.

---

# Käyttöoikeusmalli

## Reader

Saa

- hakea tietoja
- tehdä hakuja

Ei saa

- ehdottaa muutoksia
- julkaista

---

## Editor

Saa

- hakea tietoja
- luoda muutosehdotuksia
- tarkastella diffejä
- viedä hyväksytyn ehdotuksen manuaalista PTV-syöttöä varten (MVP-0)

Ei saa

- julkaista / kirjoittaa suoraan PTV:hen

---

## Publisher

Saa

- tehdä kaiken mitä Editor
- hyväksyä muutokset
- kirjoittaa PTV:hen **silloin kun `PtvApiCapabilities.supports_write` on
  tosi kyseiselle ympäristölle**

---

## Tenant Admin

Saa

- hallita käyttäjiä
- hallita API-avaimia
- hallita tenanttia
- tarkastella audit-lokeja
- julkaista muutoksia

---

# PTV-avainten hallinta

## Syöttäminen

Käyttäjä syöttää:

```text
PTV Test API Key
```

ja/tai

```text
PTV Production API Key
```

---

## Tallentaminen

Tallennetaan:

```text
encrypted_api_key   (envelope-salattu, per-tenant data key)
```

Ei koskaan:

```text
plain_text_api_key
```

---

## Näyttäminen

Tallennuksen jälkeen:

```text
**************
```

Avain voidaan ainoastaan korvata.

Sitä ei voi lukea takaisin käyttöliittymästä.

---

# Auditointi

Kaikki muutokset kirjataan.

## Audit Entry

```text
timestamp
tenant
user
action
resource_type
resource_id
before_state
after_state
prompt
result
```

**Täydennys:** lisää `ptv_api_version` ja `environment`-kentät, sekä
tietosuojaperiaatteiden mukainen säilytysaika ja pääsynhallinta
`prompt`/`before_state`/`after_state`-kentille (ks. GDPR-huomio yllä).

Esimerkki:

```text
2026-09-16 11:00

user:
Juha Itäleino

tenant:
Riihimäen seurakunta

action:
ProposeServiceChange   (ei "ApplyServiceChange", koska kirjoitus-API
                        ei ole vielä saatavilla — MVP-0:ssa tämä on
                        lopputila normaalille hyväksymisketjulle)

service:
Perheneuvonta

result:
ReadyForManualPublish
```

---

# MCP Työkalut

## Haku

```text
ptv_search_services
ptv_get_service

ptv_search_channels
ptv_get_channel

ptv_get_organisation
ptv_get_organisation_hierarchy   ← uusi, /organization/hierarchy/{contentId}

ptv_search_service_collections
ptv_get_service_collection

ptv_search_general_descriptions  ← uusi, "General description" -tyyppi
ptv_get_general_description

ptv_search_connections           ← uusi, service↔channel-liitokset
ptv_get_connection

ptv_list_codes                   ← uusi, koodistot (service-classes,
                                    ontology-terms, life-events,
                                    industrial-classes, target-groups,
                                    municipality/region/postal-codes,
                                    language/country-codes)
```

---

## Validointi

```text
ptv_validate_changes
```

Tarkistaa (tyyppikohtaisesti, palvelu-/kanavatyypin mukaan):

- pakolliset kentät per sisältötyyppi (3 palvelutyyppiä × 5 kanavatyyppiä)
- kieliversiot
- formaatit ja määrärajoitteet (esim. `ontologyTerms` ≤ 10,
  `serviceClasses` ≤ 4)
- kontrolloitujen koodistojen jäsenyys PTV:n koodisto-endpointteja vasten
- PTV-säännöt, generoituna suoraan PTV:n OpenAPI-skeemoista (ei
  käsinylläpidetty sääntölista)

---

## Muutosehdotukset

```text
ptv_propose_changes
```

Palauttaa:

- nykyinen tila
- muutosehdotus
- diff

Ei kirjoita mitään.

---

## Vienti / Julkaisu

```text
ptv_export_for_manual_publish   ← MVP-0: tuottaa PTV-UI:hin
                                   kopioitavan, kieliversioidun
                                   esityksen hyväksytystä sisällöstä

ptv_apply_changes               ← MVP-1/2: kirjoittaa muutoksen
                                   PTV:hen v12-kirjoitusrajapinnan
                                   kautta, kun PtvApiCapabilities
                                   sen sallii
```

`ptv_apply_changes` vaatii:

- Publisher-oikeuden
- onnistuneen validoinnin
- `PtvApiCapabilities.supports_write = true` kyseiselle
  tenant/environment-parille (muuten selkeä virhe, ei epämääräinen
  API-virhe)

---

# Tyypillinen käyttötapaus

## Palvelukuvauksen parantaminen

Käyttäjä:

> Tee tästä kuvauksesta selkokielisempi.

Agentti:

```text
ptv_get_service
```

↓

Muodostaa ehdotuksen

↓

```text
ptv_propose_changes
```

↓

Näyttää diffin

```diff
- Perheneuvonta tarjoaa...
+ Perheneuvonnasta saat...
```

↓

Käyttäjä hyväksyy

↓

```text
ptv_validate_changes
```

↓

```text
ptv_export_for_manual_publish   (MVP-0, kunnes kirjoitusrajapinta
                                  on saatavilla)
        tai
ptv_apply_changes                (MVP-1/2)
```

↓

Muutos kirjataan audit-lokiin.

---

# Tuleva Copilot-integraatio

Tämä toteutetaan MVP:n jälkeen.

Lisättävä kirjautumistapa:

```text
Microsoft Entra ID
```

Prosessi:

```text
Copilot User
        ↓
Entra Identity
        ↓
User Mapping
        ↓
Tenant Memberships
        ↓
MCP Authorization
```

Nykyinen käyttäjämalli säilyy muuttumattomana.

Ainoastaan uusi autentikointilähde lisätään.

---

# MVP-rajaus (tarkistettu)

## MVP-0 (rakennettavissa heti)

✅ käyttäjähallinta (+ lockout, sähköpostivahvistus, salasanan nollaus)

✅ tenant-hallinta (+ RLS-eristys)

✅ API-avainten hallinta (envelope encryption)

✅ JWT-autentikointi (+ refresh-token-rotaatio)

✅ audit-loki (+ GDPR-säilytyskäytäntö)

✅ PTV-haku (kaikki v12:n tarjoamat sisältötyypit ja koodistot)

✅ muutosehdotukset

✅ diff-näkymä

✅ validointi (tyyppitietoinen, PTV-skeemoista generoitu)

✅ **manuaalinen vienti** hyväksytystä ehdotuksesta PTV-UI:hin

✅ testi- ja tuotantoympäristöt (haussa; kirjoitus ei vielä kummassakaan)

Ei sisällä:

❌ suoraa kirjoitusta PTV:hen (tekninen este: v12-kirjoitusrajapinta ei
   ole vielä julkaistu missään ympäristössä)

❌ Microsoft Copilot -integraatiota

❌ Entra ID -kirjautumista

❌ automaattista julkaisemista

❌ työnkulkujen hyväksyntäkiertoa

❌ usean henkilön hyväksyntämallia

## MVP-1 (kun v12-kirjoitus avautuu testiympäristöön, arviolta 10/2026)

✅ `ptv_apply_changes` testiympäristöön

✅ Publisher-rooli aktivoituu testiympäristössä

(valinnainen, vaatii erillisen selvityksen) ⚙️ v11-kirjoitussovitin
tuotantoa varten, jos organisaatio tarvitsee kirjoitustukea ennen
04/2027:ää

## MVP-2 (kun v12-kirjoitus avautuu tuotantoon, arviolta 04/2027)

✅ `ptv_apply_changes` tuotantoympäristöön

✅ v11-sovitin (jos toteutettu) ajetaan alas

---

# Vaiheistus

## MVP-0

- käyttäjähallinta
- tenant-hallinta
- PTV-haku (v12)
- MCP-työkalut (haku, ehdotus, validointi, manuaalinen vienti)
- auditointi

## MVP-1 / MVP-2

- PTV-kirjoitus (v12, testi → tuotanto, PTV:n oman aikataulun mukaan)
- (valinnainen) v11-kirjoitussovitin siirtymäajaksi

## V2

- Entra ID
- OIDC
- SAML

## V3

- Microsoft Copilot
- Copilot Agents
- Copilot Studio

## V4

- hyväksyntätyönkulut
- kahden hyväksyjän malli
- automaattiset laaduntarkistukset
- sisältösuositukset tekoälyllä

---

# Avoimet kysymykset jatkoselvitykseen

1. Tarvitaanko v11-kirjoitussovitin siirtymäajaksi (10/2026–04/2027), vai
   riittääkö organisaatioille MVP-0:n manuaalinen vienti siihen asti?
2. Millainen autentikointi v12-kirjoitusrajapinnalla tulee olemaan
   (`x-api-key` vai `bearerAuth`/OAuth)? Selviää vasta kun PTV julkaisee
   kirjoitusendpointit testiympäristöön.
3. Tukeeko tuleva kirjoitusrajapinta erillistä luonnos/julkaisu-tilaa
   (kaksi API-kutsua) vai yhtä yhdistettyä kirjoitustoimintoa?
4. Mikä on PTV:n rajapinnan todellinen rate limit tuotannossa (ei
   dokumentoitu OpenAPI-kuvauksessa) – selvitettävä PTV:n tuesta tai
   API-avaimen hakuprosessin yhteydessä.
