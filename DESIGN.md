# Tab Mirror — dizajn (v1)

Cilj: Mac i Windows Chrome uvijek pokazuju iste prozore/tabove/grupe; glavni = uređaj koji korisnik stvarno koristi.
Prijenos: chrome.storage.sync (Google sync korisnika), bez servera. Kvote: 100 KB ukupno, 8 KB po stavci, 512 stavki,
120 zapisa/min, 1800/h (developer.chrome.com/docs/extensions/reference/api/storage, pročitano 30.10.2026).

## Model podataka
- Snapshot: {v:1, w:[{t:[{u,p?}], g:[{n,c,x}], tg:[idx|-1], a:activeIdx}]} — tabovi po redu, grupa = indeks u prozoru.
- Prenosi samo http(s): incognito, tip prozora ≠ normal, chrome://, chrome-extension://, file://, ftp:// se preskaču.
- Kodiranje: JSON → gzip (CompressionStream) → base64 → dijelovi ≤ 7800 znakova.
- PER-DEVICE SLOT: meta `m.<dev>` = {rev, base, ts, dev, name, n, h(sha-256)} + dijelovi `c.<dev>.<i>`.
  Svaki uređaj piše SAMO svoje ključeve → per-item last-write-wins Googlea ne može izmiješati dijelove dvaju uređaja.
  Čitač uzima slot s najvećim (rev, ts, dev) = Lamportov sat (rev = max viđenih + 1). Hash provjera prije primjene.
- Budžet slota: 5 dijelova × 7900 znakova po uređaju (~500 tabova); preveliko → greška u popupu, ne piše.
- Iznad ~95 KB briše se najstariji tuđi pretinac (nikad najnoviji); pretinac star 45 dana uvijek. Brisanje ide prije upisa.

## Vodstvo (lease) i petlje
- Uređaj smije objaviti samo ako: nije pauza · prošao je start grace (12 s nakon pokretanja, sync dohvaća) · nije u
  primjeni (applying + 1,5 s) · korisnik je prisutan: chrome.idle 'active' (60 s) I Chrome prozor ovog uređaja je fokusiran
  · uređaj je "inicijaliziran" (primijenio udaljeno stanje ili klik "Ovo je izvor").
- Promjena dok korisnik nije tu ne gubi se (v1.0.4): objava čeka u redu (`wait-present`), a kreće na povratak (fokus Chromea,
  `idle` active) ili s alarmom od 30 s; prije objave se preuzima što je u međuvremenu stiglo. Računalo bez korisnika i dalje ne objavljuje.
- Sadržajna zaštita: objavi samo ako se serijalizirano stanje razlikuje od zadnjeg poznatog zajedničkog (hash).
- Debounce 1,5 s (max 5 s), uklanjanje prozora 4 s; ograničivač 2,5 s između zapisa + satni budžet 1500.
- NIKAD prazno stanje (0 tabova) — ni pri gašenju zadnjeg prozora. Brisanje zajedničkog = zaseban gumb s potvrdom.

## Primjena (pratitelj)
- Okidač: storage.onChanged (sync) za tuđu metu, start (usklađivanje), novi prazan prozor, alarm 30 s. Primijeni ako newest.rev > lastAppliedRev i
  newest.dev ≠ ja (i nije pauza / auto-apply uključen).
- Prije primjene: lokalno stanje u povijest (20 stanja u storage.local) → "Vrati prethodno".
- Planer (čista funkcija, testirana): prozori se sparuju po preklapanju URL-ova; tabovi po URL-u (prvo isti prozor) →
  premještanje, nedostajući se stvaraju neaktivni pa discard (bez učitavanja), višak sinkronih tabova se zatvara,
  nesinkroni (chrome://settings…) ostaju, prazni chrome://newtab se zatvaraju. Pinned prvi; grupe: ponovno koristi
  lokalnu grupu s najviše istih tabova, update naziv/boja/collapsed. Fokus se ne krade.
- Sukob: ako primljeni slot ima base < mog zadnjeg objavljenog rev-a (prepisan zastarjelim stanjem) → moje zadnje
  stanje u povijest s oznakom "prije sukoba" + značka "!".

## Pokretanje i zaštite dodane nakon pregleda (v1.0.1)
- Start Chromea (ili nova verzija proširenja): čeka se da se broj tabova smiri, pa usklađivanje sa zajedničkim stanjem
  (i vlastitim); dok to nije gotovo, objava je odgođena ('reconciling').
- 3-smjerna primjena: baza = adrese zadnjeg zajedničkog stanja koje uređaj zna; lokalni tab izvan baze se ne zatvara.
  Takav tab u grupi (v1.0.3, kept.js) ide uz zajedničke tabove svoje stare grupe (preimenovanje, nova boja, raspuštanje
  ga prate); grupa bez ijednog zajedničkog taba ostaje lokalna. Prije 1.0.3 ostajao je u staroj grupi → druga grupa
  istog imena koja se objavi na drugo računalo.
- Sačuvani tabovi se objavljuju (v1.0.4): nakon primjene sa sačuvanim tabom postignuto stanje nije zajedničko, pa ide u red
  za objavu; kad je korisnik tu, oba računala imaju isto. Zajednička grupa koje više nema ne ostaje zbog sačuvanog taba.
- Interna stranica (chrome://) u grupi prati grupu kao i sačuvani tab (v1.0.4), a sama se ne prenosi.
- Drugi prolaz grupa (`fresh`) samo na razliku tabova ili grupa, nikad zbog aktivnog taba (v1.0.4): interna stranica aktivna na
  drugom računalu daje cilj bez aktivnog taba, što je prije rušilo i iznova slagalo sve grupe pri svakoj primjeni.
- Sukob (v1.0.4): baza primjene je stanje na kojem je drugo računalo gradilo (`knownBases`, po `meta.base`), ne moja zadnja objava,
  pa se tabovi koje ono nije vidjelo čuvaju i objave. Obje strane zadržavaju dodane tabove; tab zatvoren na strani koja je izgubila
  može se vratiti (namjerno: bolje tab viška nego izgubljen). Stanje prije sukoba i dalje ide u povijest.
- Chromeova sinkronizacija spremljenih grupa: proširenje je ne može ugasiti (nema API-ja; `chrome.privacy` je ne pokriva), a ni pročitati.
  Zato pri nadogradnji jednom otvori uputu u postavkama (`#chrome-sync`), a dvije grupe istog imena u istom prozoru spaja prije svake
  objave koja smije krenuti (ne uz Pauzu) i nakon svake primjene (`kept.mergeDuplicateGroups`), bez obzira na uzrok; stanje prije toga je
  u povijesti. Grupe bez imena se ne diraju, a spojena grupa zadržava boju prve.
- Objava čeka novije tuđe stanje koje još nije primijenjeno (`remote-first`, najviše 60 s): inače bi ga pregazila zastarjelim rasporedom.
- Primjena koja padne (Chrome odbije izmjenu dok korisnik vuče tab) ponavlja se s alarmom, razmak 25 s, do 10 pokušaja; dok nije uspjela,
  računalo samo ne objavljuje (`apply-failed`), jer bi polovičan raspored drugome zatvorio tabove. Poruka u izborniku kaže što kliknuti
  („Preuzmi zadnje“); ručna radnja, novija tuđa objava i restart Chromea to prekidaju.
- Neaktivan tab u sparenom prozoru koji je sam promijenio adresu unutar iste domene nije nov: vraća se na zajedničku adresu, ne duplira se
  (ne pri pokretanju Chromea ni pri sukobu). Preusmjerenje na drugu domenu (SSO) se ne prepoznaje: tab ostaje sačuvan i objavi se.
- Lokalna grupa istog imena kao zajednička u istom prozoru spaja se s njom (prije 1.0.4 ostajala je odvojena, što bi uz objavu sačuvanih tabova
  dalo dvije grupe istog imena na oba računala).
- Preusmjerenje: session `origins` (tabId → adresa za koju je tab otvoren) — tab se sparuje po toj adresi.
  Od v1.0.2 se i objavljuje pod tom adresom (`origins.withOriginUrls`), pa stranica za prijavu ne prelazi na drugo računalo.
  Zapis `{k: izvorna, l: gdje je tab sletio, t}`; izvorna adresa vrijedi dok je tab na `l`. Izmjereno u Chromiumu
  (`webNavigation`): korisnikov klik i Tab Mirrorovo otvaranje imaju isti tip (`link`, + `server_redirect` kad poslužitelj
  preusmjeri), pa se prvo slijetanje prepoznaje po `l = null`, a ne po tipu. Poslije: `reload` (buđenje
  uspavanog taba) pomakne `l` (`client_redirect` ne — dobije ga i korisnikov klik na `location.replace`, izmjereno); navigacija neaktivnog taba (korisnik ga ne gleda, ne može kliknuti) i svaka u prvih 5 s
  nakon učitavanja je stranična (heuristika u origins.js: SAML obrazac, replaceState); ostalo je korisnikovo i briše
  vezu. Tab koji ne sleti 30 s (preuzimanje datoteke) više ne čeka slijetanje.
  Restart Chromea / ↻ proširenja briše sesiju i ID-jeve tabova → parovi [izvorna, preusmjerena] se trajno spremaju
  (`state.originPairs`, origin-store.js) i pri usklađivanju vrate vezu tabu na preusmjerenoj adresi (točno, pa ista stranica s
  drugim parametrima — nov jednokratni kod prijave); parovi koje nijedan tab ne preuzme odmah se brišu (ne posvajaju kasniji tab).
  Ostatak rizika: korisnikov klik dok primjena traje ili u prvih 5 s nakon učitavanja ne briše vezu (prenese se iduća navigacija);
  neaktivan tab koji sam promijeni adresu (npr. idući video) ostaje objavljen pod starom; veze se vraćaju samo pri prvom
  usklađivanju nakon pokretanja.
- Primjena prije usklađivanja (v1.0.2): dok `reconciled` nije true, svaka automatska primjena osim usklađivanja čeka
  (`decideApply` → 'wait'), jer bi otvorila tabove koje Chrome pri pokretanju zatim vrati još jednom.
- Primjena koja padne na pola sprema veze tabova otvorenih do pada; „Vrati“ iz povijesti prvo spremi trenutno stanje u povijest.
- Navigacija: preostali tab iste domene u sparenom prozoru dobije tabs.update(url) umjesto zatvori + otvori.
- tabs.create koji Chrome odbije se preskače (withoutTabs), primjena ne pada u krug; greška se vidi u izborniku.
- store.patch ide kroz jedan red (bez izgubljenih polja); sukob se prepoznaje i pri istoj reviziji.

## UI
- Popup: Glavni/Prati/Pauza, zadnja sinkronizacija, naziv uređaja; Preuzmi ovdje · Primijeni zadnje · Povijest (vrati) · Pauza.
- Options: naziv uređaja, auto-primjena, pauza, "Ovo je izvor", "Obriši zajednički raspored" (potvrda).

## Testovi
- node:test: serializer, codec (dijelovi, hash, kvota), grupe, lease/rev, suppression, zaštita praznog, planer.
- Simulacija: dva lažna Chromea + zajednički lažni sync → Mac promjene se zrcale na Win i obrnuto, bez petlje.
- E2E: dva prava Chromiuma (Puppeteer, --load-extension) + lažni Google sync; 13 scenarija. Playwright NE: zatvori kontekst
  kad Chrome uspava tab. Uspavljivanje odmah nakon tabs.create briše adresu → discard tek kad tab ima url (provjereno).
