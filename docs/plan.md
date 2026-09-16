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
kirjoitustie on vanha **v11-rajapinta**, joka on nyt analysoitu erikseen
(ks. [`docs/ptv-v11-notes.md`](./ptv-v11-notes.md)) – sillä on eri
autentikointimalli (OAuth2, v12:n staattisen API-avaimen sijaan) mutta
saman datan/tyyppimallin kuin v12:n beta-kirjoitusskeemat.

Tästä seuraa suoraan: **MVP:n rajaus ja vaiheistus on kirjoitettava
uusiksi** (ks. [uusi vaiheistus](#tarkistettu-vaiheistus)). Koska sekä v11
että tuleva v12 – ja joskus v13 – ovat väistämättä osa saman palvelimen
elinkaarta, päädyttiin rakentamaan koko PTV-integraatio
**sovitinpatternina** (ks.
[PTV-sovitinkerros](#ptv-sovitinkerros-usean-rajapintaversion-v11-v12-tulevat-tuki))
sen sijaan että "julkaisu PTV:hen API:n kautta" odotettaisiin kokonaan
v12:n aikatauluun.

### 3. Kirjoitusskeemat ovat jo nähtävissä OpenAPI-dokumentissa – hyödynnä niitä suunnittelussa

Vaikka polkuja ei ole, `components/schemas`-osiossa on jo valmiina tulevien
kirjoitusoperaatioiden pyyntömallit: `PostServiceRequest`, `PutServiceRequest`,
`PostEServiceChannelRequest`, `PostServiceLocationChannelRequest`,
`PostPrintableFormChannelRequest`, `PostTelephoneChannelRequest`,
`PostWebPageChannelRequest` (ja vastaavat `Put*`-versiot). Näitä kannattaa
käyttää jo nyt sisäisen domain-mallin ja validointilogiikan pohjana, jotta
kun v12-kirjoitusrajapinta avautuu testiympäristöön (~10/2026),
`PtvV12Adapter` on suurelta osin valmis.

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
pelkkää staattista API-avainta** – tästä ei ole vielä varmuutta v12:n
osalta, mutta v11 vahvistaa saman ilmiön jo nyt (OAuth2, ks. yllä). Tämä on
juuri se syy, miksi koko PTV-integraatio rakennetaan sovitinpatternina:
kukin sovitin (`PtvV11Adapter`, `PtvV12Adapter`, …) kapseloi oman
autentikointimallinsa `PtvAdapter`-rajapinnan taakse, eikä kovakoodaa
pelkkää staattista avainta koko sovellukseen.

Kummankaan version rajapinta ei dokumentoi rate limitejä (ei
`429`-vastauksia eikä `X-RateLimit-*`-otsakkeita kummassakaan
spesifikaatiossa) – niitä pitää silti *olettaa* olevan tuotannossa, ja
jokaisen sovittimen retry-logiikan pitää olla yleiskäyttöinen
(exponential backoff + jitter, kunnioittaen `Retry-After`-otsaketta jos
sellainen joskus tulee) sen sijaan, että nojataan dokumentoituun rajaan.

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
✅ PTV-sovitinkerros (`PtvAdapter`) rakennetaan **v11- ja v12-sovittimet
   rinnakkain alusta asti**, ei v12 ensin ja v11 jälkikäteen paikattuna
   (ks. edellä [PTV-sovitinkerros](#ptv-sovitinkerros-usean-rajapintaversion-v11-v12-tulevat-tuki))
✅ PTV-haku (v11 ja v12, molemmat samaan domain-malliin: service,
   service-channel, organization, general-description, service-collection,
   connection, koodistot)
✅ AI-avusteiset **muutosehdotukset** (`ptv_propose_changes`) ja diff-näkymä
✅ `ptv_validate_changes` **paikallisena** (skeemavalidointi molempien
   versioiden skeemoja vasten + PTV:n dokumentoituja sääntöjä vasten), ilman
   että mitään lähetetään PTV:hen
✅ **Vientitoiminto ilman API-kirjoitusta**: hyväksytty ehdotus viedään
   muodossa, joka on helppo kopioida PTV:n omaan hallintakäyttöliittymään
   (esim. kieliversioittain jäsennelty teksti / JSON-esikatselu), ja
   merkitään audit-lokiin tilaan `ReadyForManualPublish`
⚠️ **suora kirjoitus PTV:hen on mahdollinen jo MVP-0:ssa v11-sovittimen
   kautta**, JOS Phase 1:n v11-selvitys (ks.
   [`docs/ptv-v11-notes.md`](./ptv-v11-notes.md)) päätyy "go"-tulokseen –
   v11:n OAuth2-mallin todellinen käytettävyys palvelinkäytössä on vielä
   varmistamatta. Jos selvitys päätyy "no-go":hon, v11-sovitin toimii
   pelkästään lukusovittimena ja tuotanto-organisaatiot käyttävät
   manuaalista vientiä siihen asti kunnes v12-kirjoitus julkaistaan.

Tämä tuottaa jo itsenäisesti arvokkaan tuotteen riippumatta siitä, miten
v11-selvitys päättyy — sovitinpatternin ansiosta kirjoitustuen
avautuminen/sulkeutuminen on konfiguraatiokysymys, ei arkkitehtuurimuutos.

### MVP-1 (arviolta 10/2026 →, kun v12-kirjoitus avautuu testiin)

✅ `PtvV12Adapter`:iin toteutetaan kirjoitusoperaatiot (aiemmin runkona/
   "ei vielä käytössä" -tilassa), aluksi vain `environment = test`
✅ Publisher-rooli pääsee kirjoittamaan **testiympäristöön** v12:n kautta
✅ Tuotantoympäristö pysyy joko MVP-0-tilassa (manuaalinen vienti) tai
   v11-sovittimen varassa, riippuen siitä ajetaanko v11-sovitin
   tuotannossa

### MVP-2 (arviolta 04/2027 →, kun v12-kirjoitus avautuu tuotantoon)

✅ `PtvV12Adapter`:in kirjoitustuki sallitaan myös `environment = production`
✅ v11-sovittimen käytöstäpoisto ajetaan edellä kuvatun **yleisen
   sovitin-runbookin** mukaisesti (siirtymäikkuna, tenantti kerrallaan
   migrointi, koodin poisto) – sama runbook, jota käytetään joskus
   myöhemmin myös v12:n käytöstäpoistoon, kun PTV julkaisee v13:n

Tämä aikataulu on syytä pitää **konfiguraationa (`PtvAdapterConfig`), ei
koodiin kovakoodattuna oletuksena**.

### PTV-sovitinkerros: usean rajapintaversion (v11, v12, tulevat) tuki

**Päätös laajennettu katselmoinnin aikana**: koska PTV:llä on jo nyt kaksi
rinnakkaista rajapintaversiota (v11 tuotannon kirjoitustie, v12 tuleva
pääasiallinen rajapinta) ja historiallinen kuvio — v12 korvaa v11:n samalla
tavalla kuin joskus tulevaisuudessa jokin v13 korvaa v12:n — ei ole
mielekästä rakentaa palvelinta "v12-keskeiseksi ja v11 tarvittaessa
päälle liimattuna". Sen sijaan koko PTV-integraatio rakennetaan
**sovitinpatternina (ports & adapters / hexagonal)** alusta asti:

- **`PtvAdapter`-rajapinta** (TypeScript-interface): yksi yhteinen
  sopimus haku- ja kirjoitusoperaatioille (`searchServices`, `getService`,
  `searchChannels`, `getChannel`, `getOrganisation` (+hierarchy),
  `searchServiceCollections`, `searchGeneralDescriptions`,
  `getConnectionsFor(entity)`, `listCodes`, `applyServiceChange`, …) sekä
  `getCapabilities()`, joka kertoo mitä kyseinen sovitin tosiasiassa tukee
  (haku, kirjoitus, luonnosnäkyvyys, jne.)
- **Yhteinen sisäinen domain-malli**: MCP-työkalut, diff-moottori ja
  validointi operoivat *aina* tämän yhden sisäisen mallin päällä
  (`DomainService`, `DomainServiceChannel` × 5 alatyyppiä,
  `DomainOrganization`, `DomainGeneralDescription`,
  `DomainServiceCollection`, `DomainConnection`, koodistot) – eivät koskaan
  suoraan PTV:n versiokohtaista "wire"-muotoa. Jokainen versiosovitin
  (`PtvV11Adapter`, `PtvV12Adapter`, tuleva `PtvV13Adapter`) vastaa oman
  wire-muotonsa kääntämisestä domain-malliksi ja takaisin.
- **Versiokohtaiset erikoisuudet pysyvät sovittimen sisällä**, eivät vuoda
  muualle sovellukseen: esim. v11:n delete-flag-kartoitus PUT-päivityksissä
  (ks. [`docs/ptv-v11-notes.md`](./ptv-v11-notes.md)), v11:n upotetut
  connection-tiedot (ei omaa GET-endpointtia), v11:n OAuth2-autentikointi,
  v12:n `oneOf`-tyyppiskeemat ja `x-api-key`-autentikointi.
- **`PtvAdapterConfig`** (korvaa/yleistää aiemman `PtvApiCapabilities`-idean)
  ohjaa mikä sovitin valitaan per tenant + ympäristö + operaatio:

```text
PtvAdapterConfig
 ├─ tenant_id
 ├─ environment          (test | production)
 ├─ api_version           (vapaa merkkijono: "v11" | "v12" | tuleva "v13" – EI enum,
 │                         jotta uuden version lisääminen ei vaadi skeemamuutosta)
 ├─ auth_mode             (api_key | oauth2 | tuleva …)
 ├─ supports_read
 ├─ supports_write
 ├─ supports_draft_read   (esim. v11:n rajoitetut /active-endpointit)
 └─ updated_at
```

  `ptv_apply_changes` (ja muut työkalut) kysyvät sovitinrekisteriltä
  (`PtvAdapterRegistry`) oikean sovittimen tälle tenant/environment-parille;
  jos mikään aktiivinen sovitin ei tue pyydettyä operaatiota, palautetaan
  selkeä virhe ("PTV v12 -kirjoitusrajapinta ei ole vielä käytössä
  tuotantoympäristössä, arvioitu saatavuus 04/2027") sen sijaan että
  yritettäisiin kutsua olematonta endpointtia.
- **Yhteinen "contract test" -sarja**: samat testitapaukset (haku palauttaa
  odotetun muotoista dataa, get-by-id pyöristyy oikein, `getCapabilities()`
  raportoi oikein) ajetaan jokaista sovitinta vastaan. Tämä on ainoa tapa
  varmistaa, että kaikki sovittimet käyttäytyvät MCP-työkalujen näkökulmasta
  samalla tavalla, vaikka niiden sisäinen toteutus poikkeaisi täysin
  toisistaan.
- **Sovittimen elinkaari on dokumentoitu toistettavana ajona (runbook)**,
  ei kertaluonteisena erikoistapauksena:
  1. *Käyttöönotto*: toteuta `PtvAdapter`-rajapinta, aja contract-testit
     läpi, ota käyttöön yhdellä pilottitenantilla, laajenna.
  2. *Käytöstäpoisto*: aja vanha ja uusi sovitin rinnakkain siirtymäajan,
     migroi tenantit yksi kerrallaan `PtvAdapterConfig`-rivin kautta,
     poista vanhan sovittimen koodi ja konfiguraatioarvot vasta kun yksikään
     rivi ei enää osoita siihen.

  Tämä sama prosessi käytetään v11:n käytöstäpoistoon (kun v12-kirjoitus on
  vakaa tuotannossa) **ja** myöhemmin v12:n käytöstäpoistoon, kun PTV
  joskus julkaisee v13:n – suunnittelutyötä ei tarvitse tehdä uudestaan,
  vain ajaa sama runbook uudelleen.

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

- **Retry/backoff ja idempotenssi**: koska sekä v11 että tuleva
  v12-kirjoitusrajapinta tukevat `id`-pohjaista PUT-päivitystä, jokaisen
  sovittimen retry-logiikan pitää olla idempotentti (turvallinen ajaa
  uudelleen verkkovirheen jälkeen) – POST (luonti) sen sijaan ei ole
  itsestään idempotentti, joten sille tarvitaan oma
  idempotenssiavain/deduplikaatiostrategia jo suunnitteluvaiheessa. Tämä
  logiikka kannattaa toteuttaa kerran yhteisessä sovitinpohjassa, josta
  sekä `PtvV11Adapter` että `PtvV12Adapter` perivät sen.
- **OpenAPI/Swagger-generointi per sovitin**: koska PTV julkaisee
  koneluettavat kuvaukset molemmista versioista (v12: OpenAPI 3.1
  `openapi.json`, v11: OpenAPI 3.0 `swagger.json`), kunkin sovittimen
  wire-tyypit ja validointi generoidaan suoraan niistä (esim.
  `openapi-typescript` + `ajv`) sen sijaan että tyypit ylläpidettäisiin
  käsin — vähentää ylläpitotaakkaa merkittävästi, varsinkin kun v12:n
  kirjoitusskeemat vielä elävät (beta) ja v11:n skeemat sisältävät
  versiointikerrostumia (esim. `V9VmOpenApiServiceIn`-tyyppinen nimeäminen
  v11:n sisällä).
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
(PTV) rajapintojen ja tekoälyagenttien välillä — **sovitinkerroksen kautta,
joka tukee useaa PTV-rajapintaversiota (v11, v12, tulevat) rinnakkain**.

Ensimmäisen version tavoitteena on mahdollistaa:

- PTV-tietojen haku tekoälyagentin kautta
- muutosehdotusten tuottaminen tekoälyllä
- **hallittu vienti hyväksytyistä ehdotuksista** (API-kirjoitus jo MVP-0:ssa
  v11-sovittimen kautta, jos sen OAuth-selvitys onnistuu; muuten kun PTV
  julkaisee v12-kirjoitusrajapinnan, ks. yllä oleva aikataulu)
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
│ PTV Adapter Registry│  ← valitsee oikean sovittimen per tenant/env/operaatio
│ PTV Tool Layer      │     (domain-mallin päällä, versioagnostinen)
└──────────┬──────────┘
           │
           ▼
┌─────────────────────────────────────────────┐
│ PTV Adapter Layer (ports & adapters)         │
├───────────────────────┬───────────────────────┤
│ PtvV11Adapter          │ PtvV12Adapter          │  ← tuleva PtvV13Adapter jne.
│  - OAuth2 auth         │  - x-api-key auth      │     samaan rajapintaan
│  - delete-flag mapping │  - oneOf-tyyppiskeemat │
│  - upotetut connectionit│ - retry/backoff       │
├───────────────────────┴───────────────────────┤
│ Yhteinen: Domain-malli, Schema Validation      │
│ (generoitu kunkin version omasta OpenAPI/      │
│  Swagger-kuvauksesta), Retry/backoff-runko      │
└──────────┬──────────────────────┬─────────────┘
           │                      │
           ▼                      ▼
      PTV API v11            PTV API v12
 (haku+kirjoitus nyt,    (haku nyt; kirjoitus
  poistuu 04/2027)        10/2026→ testi, 04/2027→ tuotanto)
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
 ├─ environment              (test | production)
 ├─ encrypted_credentials    ← polymorfinen, JSON, muoto riippuu api_versionista
 │                             (v12: {apiKey}; v11: OAuth2-clientin tiedot/token-tila)
 ├─ encrypted_data_key       (envelope encryption)
 └─ active
```

## PtvAdapterConfig (uusi, korvaa aiemman "PtvApiCapabilities"-idean)

```text
PtvAdapterConfig
 ├─ tenant_id
 ├─ environment         (test | production)
 ├─ api_version         (vapaa merkkijono: "v11" | "v12" | tuleva "v13" …)
 ├─ auth_mode           (api_key | oauth2 | tuleva …)
 ├─ supports_read
 ├─ supports_write
 ├─ supports_draft_read
 └─ updated_at
```

Ylläpidetään joko manuaalisesti (konfiguraationa) tai automaattisesti
tarkistamalla PTV:n julkaisemat OpenAPI-kuvaukset määräajoin. `api_version`
on tarkoituksella merkkijono eikä enum, jotta uuden PTV-version (esim.
tuleva v13) lisääminen on konfiguraatio- ja sovitintoteutustyötä, ei
tietokantaskeeman muutos.

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
- kirjoittaa PTV:hen **silloin kun jokin aktiivinen sovitin
  (`PtvAdapterConfig.supports_write`) tukee sitä kyseiselle
  tenant/ympäristö-parille** — voi olla v11 tai v12, riippumatta siitä
  kumpi

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

ptv_apply_changes               ← kirjoittaa muutoksen PTV:hen
                                   PtvAdapterRegistryn valitseman
                                   sovittimen (v11 tai v12) kautta,
                                   sen mukaan kumpi tukee kirjoitusta
                                   kyseiselle tenant/environment-parille
```

`ptv_apply_changes` vaatii:

- Publisher-oikeuden
- onnistuneen validoinnin
- että jokin `PtvAdapterConfig`-rivi kertoo `supports_write = true`
  kyseiselle tenant/environment-parille (muuten selkeä virhe, ei
  epämääräinen API-virhe) — toteutuu jo MVP-0:ssa, jos v11-sovitin läpäisi
  selvityksen, muutoin vasta MVP-1/2:ssa v12:n kautta

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

✅ PTV-sovitinkerros: `PtvV11Adapter` ja `PtvV12Adapter` rakennettuna
   yhteistä `PtvAdapter`-rajapintaa vasten, molemmat haku-kykyisiä

✅ muutosehdotukset

✅ diff-näkymä (toimii yhteisen domain-mallin päällä, versioriippumaton)

✅ validointi (tyyppitietoinen, kummankin version omista skeemoista
   generoitu)

✅ **manuaalinen vienti** hyväksytystä ehdotuksesta PTV-UI:hin

✅ testi- ja tuotantoympäristöt

⚠️ **suora kirjoitus PTV:hen tuotantoon v11-sovittimen kautta** —
   sisältyy MVP-0:aan, jos ja vain jos Phase 1:n v11-selvitys (OAuth2:n
   todellinen käytettävyys palvelinkäytössä) päätyy "go"-tulokseen; muuten
   jää MVP-1/2:een asti

Ei sisällä:

❌ Microsoft Copilot -integraatiota

❌ Entra ID -kirjautumista

❌ automaattista julkaisemista

❌ työnkulkujen hyväksyntäkiertoa

❌ usean henkilön hyväksyntämallia

## MVP-1 (kun v12-kirjoitus avautuu testiympäristöön, arviolta 10/2026)

✅ `PtvV12Adapter`:iin toteutetaan kirjoitusoperaatiot, aluksi
   testiympäristöön

✅ Publisher-rooli aktivoituu testiympäristössä v12:n kautta

## MVP-2 (kun v12-kirjoitus avautuu tuotantoon, arviolta 04/2027)

✅ `PtvV12Adapter`:in kirjoitustuki laajenee tuotantoon

✅ v11-sovittimen käytöstäpoisto ajetaan yleisen sovitin-runbookin
   mukaisesti (jos v11-sovitin oli otettu tuotantokäyttöön)

---

# Vaiheistus

## MVP-0

- käyttäjähallinta
- tenant-hallinta
- PTV-sovitinkerros: v11- ja v12-sovittimet rinnakkain (`PtvAdapter`-rajapinta,
  yhteinen domain-malli), v11:n kirjoitustuki selvityksen tuloksen mukaan
- MCP-työkalut (haku, ehdotus, validointi, manuaalinen vienti, ja
  mahdollisesti suora kirjoitus v11:n kautta)
- auditointi

## MVP-1 / MVP-2

- `PtvV12Adapter`:in kirjoitustuki (testi → tuotanto, PTV:n oman aikataulun
  mukaan)
- v11-sovittimen käytöstäpoisto yleisen runbookin mukaisesti, kun v12 on
  vakaa tuotannossa

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

1. **Mikä on v11:n todellinen käytettävä OAuth2-grant-tyyppi**
   palveluhallinta.suomi.fi:tä vasten? Spesifikaatio ilmoittaa `implicit`-
   flown’n, jonka scope-nimi (`dataEventRecords`) vaikuttaa
   IdentityServer4:n oletusesimerkiltä — tämä pitää varmistaa
   rekisteröimällä oikea asiakas ennen kuin `PtvV11Adapter`-kirjoitustukea
   rakennetaan (ks. [`docs/ptv-v11-notes.md`](./ptv-v11-notes.md)). Jos
   grant vaatii aidosti ihmisen selaimessa, v11-kirjoitussovitin ei sovi
   automaattiseen taustapalveluun ja MVP-0:n manuaalinen vienti jää
   ainoaksi tuotantotieksi 04/2027:ään asti.
2. Millainen autentikointi v12-kirjoitusrajapinnalla tulee olemaan
   (`x-api-key` vai `bearerAuth`/OAuth)? Selviää vasta kun PTV julkaisee
   kirjoitusendpointit testiympäristöön.
3. Tukeeko tuleva kirjoitusrajapinta erillistä luonnos/julkaisu-tilaa
   (kaksi API-kutsua) vai yhtä yhdistettyä kirjoitustoimintoa? v11:ssä
   vastaava tila on olemassa (`publishingStatus`-kenttä), joten sama
   malli on todennäköinen myös v12:ssa.
4. Mikä on PTV:n rajapinnan todellinen rate limit tuotannossa (ei
   dokumentoitu kummassakaan versiossa) – selvitettävä PTV:n tuesta tai
   API-avaimen/OAuth-clientin hakuprosessin yhteydessä.
5. v11:n PUT-päivitys vaatii eksplisiittiset `deleteX`-liput kentän
   tyhjentämiseen (ks. `docs/ptv-v11-notes.md`) — käyttäytyykö v12:n
   lopullinen kirjoitusrajapinta samoin, vai onko se täysi korvaus
   (full-replace) PUT:lla? Selviää vasta kun v12:n kirjoitusskeemat
   julkaistaan lopullisina.
