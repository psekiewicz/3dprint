# Druk 3D na zamówienie

Sklepik z wydrukami 3D dla kolegów z klasy. Drukarki: **Prusa MINI+** i **Prusa MK4S z MMU3** (do 5 kolorów w jednym wydruku).

Strona jest pisana dla ludzi, którzy o druku 3D nie wiedzą nic: zamiast pliku STL wystarczy link albo opis.

## Co może kupujący (`/`)

Zakłada konto (imię i nazwisko, e-mail, hasło, kod klasy) i zamawia na jeden z czterech sposobów:

| Sposób | Co podaje | Koszt |
|---|---|---|
| Mam link | adres modelu z Printables, MakerWorld, Thingiverse… | sam wydruk |
| Znajdźcie mi model | opis tego, czego szuka | sam wydruk, szukanie gratis |
| Zaprojektujcie mi | opis rzeczy, której nie ma w internecie | wydruk + opłata za projekt |
| Mam plik | STL lub 3MF, z podglądem 3D i sprawdzeniem, czy się zmieści | sam wydruk |

Wybiera kolor (na MK4S do pięciu naraz, wtedy pisze, co ma być w którym), liczbę sztuk i wysyła. Potem dostaje mailem cenę i **musi ją potwierdzić** na stronie, zanim cokolwiek zostanie wydrukowane.

## Co może sprzedawca (`/admin.html`)

Zamówienie przechodzi przez kolejne etapy:

1. **Do wyceny**: sprawdzasz model (albo go szukasz i wklejasz link), tniesz w PrusaSlicer, wpisujesz czas druku i ewentualną opłatę za usługę.
2. **Czeka na potwierdzenie**: przycisk „Wyślij do potwierdzenia" wysyła kupującemu maila z modelem i ceną.
3. **Potwierdzone → Drukuje się → Do odbioru**: przy „Do odbioru" idzie drugi mail.
4. **Odebrane**: zaznaczasz też „zapłacone".

W panelu ustawiasz też kod klasy, filamenty ze stawkami i opisami, dostępne drukarki, cenę „od" za projekt, limit zamówień na osobę oraz konta sprzedawców i kupujących.

## Cena

**Cena = stawka filamentu (zł/min) × czas druku (min) + opłata za usługę**, ale nie mniej niż cena minimalna (domyślnie 5 zł, ustawiana w panelu).

Przy kilku kolorach liczy się najwyższa stawka z wybranych. Zamówienie zapamiętuje stawki z chwili złożenia, więc zmiana cennika nie rusza starych zamówień. Płatność odbywa się poza aplikacją (gotówka, BLIK).

## Dwie drukarki, dwóch właścicieli

Każdy filament jest przypisany do jednej drukarki (MINI+ albo MK4S) — ustawiasz to w panelu przy filamencie. Kupujący nie wybiera drukarki: wyznacza ją kolor. Kolory z różnych drukarek nie łączą się w jednym zamówieniu, a wiele kolorów naraz jest możliwe tylko na MK4S.

W panelu przy każdym zamówieniu widać drukarkę, a lista i sumy „do zapłaty / zapłacono" dają się przefiltrować po drukarce, więc każdy z Was widzi swoje.

## E-maile

Maile wychodzą z Twojej skrzynki przez SMTP. Potrzebne zmienne (wzór w `.env.example`):

| Zmienna | Przykład | Opis |
|---|---|---|
| `SMTP_HOST` | `ssl0.ovh.net` | serwer poczty wychodzącej (sprawdź w panelu dostawcy) |
| `SMTP_PORT` | `465` | 465 (SSL) albo 587 (STARTTLS) |
| `SMTP_USER` | `contact@pixelinventor.com` | login do skrzynki |
| `SMTP_PASS` | | hasło do skrzynki |
| `MAIL_FROM` | `Druk 3D <contact@pixelinventor.com>` | nadawca widoczny w mailu |
| `MAIL_REPLY_TO` | | opcjonalnie: dokąd idą odpowiedzi |
| `PUBLIC_URL` | `https://druk.pixelinventor.com` | adres strony do linku w mailu |

Bez tych ustawień wszystko działa, tylko maile nie wychodzą, a panel pokazuje o tym ostrzeżenie. Hasło do skrzynki trzymaj w pliku `.env` na serwerze, nigdy w repozytorium.

Adresy e-mail kupujących nie są weryfikowane: literówka przy rejestracji oznacza, że mail nie dojdzie. Adres widać w panelu przy koncie.

## Jak to jest zbudowane

| Część | Gdzie | Co robi |
|---|---|---|
| Serwer | `server/` | API, zapis zamówień (`data/db.json`) i plików (`data/uploads/`), wysyłka maili. Node.js; jedyna zależność to `nodemailer`. |
| Strona | główny katalog (`index.html`, `admin.html`, …) | Statyczne pliki HTML/JS, serwowane przez ten sam serwer. |

## Wersja pokazowa (bez serwera)

Na samym GitHub Pages aplikację można obejrzeć bez Raspberry Pi: na stronie logowania kliknij **Otwórz wersję pokazową** (a w panelu sprzedawcy wpisz hasło **`demo`**). Hasła kont nie są w niej sprawdzane. Dane zapisują się wtedy tylko w tej jednej przeglądarce — kupujący i sprzedawca widzą te same zamówienia wyłącznie na tym samym urządzeniu. Do przyjmowania prawdziwych zamówień potrzebny jest serwer.

## Uruchomienie na Raspberry Pi

Potrzebny jest Node.js 18 lub nowszy (`node -v`). Na Raspberry Pi OS: `sudo apt install nodejs`.

```bash
git clone https://github.com/psekiewicz/3dprint.git
cd 3dprint
npm install --omit=dev
node server/server.js
```

Przy pierwszym uruchomieniu serwer wypisze **hasło sprzedawcy** i **kod klasy** — zapisz je. Oba można potem zmienić w panelu sprzedawcy. Zapomniane hasło ustawisz na nowo, uruchamiając serwer raz z `ADMIN_PASSWORD=nowehaslo node server/server.js`.

Aplikacja działa pod adresem `http://<adres-ip-raspberry>:3000` dla wszystkich w tej samej sieci.

### Automatyczny start

```bash
sudo cp deploy/druk3d.service /etc/systemd/system/
sudo systemctl enable --now druk3d
journalctl -u druk3d    # tu widać hasło z pierwszego uruchomienia
```

Plik usługi zakłada użytkownika `pi` i katalog `/home/pi/3dprint` — popraw go, jeśli masz inaczej.

### Uruchomienie w Dockerze (np. na serwerze VPS)

```bash
git clone https://github.com/psekiewicz/3dprint.git && cd 3dprint
cp .env.example .env && nano .env    # skrzynka pocztowa i adres strony
docker compose up -d --build
docker compose logs druk3d    # hasło sprzedawcy i kod klasy z pierwszego uruchomienia
```

Aplikacja słucha wtedy na `127.0.0.1:3000` tego serwera. Do internetu wystawia ją reverse proxy z HTTPS, przekierowując subdomenę na ten port — gotowa konfiguracja dla nginx jest w `deploy/nginx-druk3d.conf`. Dane leżą w wolumenie `druk3d-data` i przetrwają aktualizację: `git pull && docker compose up -d --build`.

### Ustawienia serwera (zmienne środowiskowe)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` | `3000` | Port serwera |
| `DATA_DIR` | `./data` | Katalog z bazą i plikami modeli |
| `ADMIN_PASSWORD` | — | Ustawia przy starcie hasło konta sprzedawcy `admin` |
| `TRUST_PROXY` | — | `1`, gdy serwer stoi za reverse proxy (blokada błędnych logowań liczy wtedy prawdziwe adresy z `X-Forwarded-For`) |
| `ALLOWED_ORIGIN` | `*` | Adres strony, która może korzystać z API (np. `https://psekiewicz.github.io`) |

**Kopia zapasowa:** wystarczy skopiować katalog `data/`.

## Strona na GitHub Pages (opcjonalnie)

Przydatne, gdy koledzy mają zamawiać także spoza sieci, w której stoi Raspberry Pi.

1. W repozytorium: **Settings → Pages → Deploy from a branch**, gałąź `main`, katalog `/ (root)`.
2. Wystaw Raspberry Pi pod publicznym adresem **HTTPS**, np. przez Cloudflare Tunnel albo Tailscale Funnel. Strona z GitHub Pages działa po HTTPS, więc przeglądarka zablokuje połączenie ze zwykłym `http://192.168…`.
3. Wpisz ten adres w `config.js`:
   ```js
   window.API_URL = 'https://twoj-adres-serwera';
   ```
4. Uruchom serwer z `ALLOWED_ORIGIN=https://psekiewicz.github.io`.

Jeśli aplikacja ma działać tylko w jednej sieci, ten krok można pominąć — wystarczy adres Raspberry Pi.

## Sprzedawcy

Każdy sprzedawca ma własny login i hasło do panelu (`/admin.html`). Pierwsze konto ma login **`admin`** i hasło wypisane przy pierwszym uruchomieniu. Kolejnych sprzedawców dodajesz w panelu, w sekcji „Sprzedawcy". Przy zamówieniu widać, kto je ostatnio obsługiwał.

Sprzedawcy są równorzędni: każdy może dodać lub usunąć innego, ale hasło zmienia tylko sobie. Gdy wszyscy zapomną haseł, uruchom serwer raz ze zmienną `ADMIN_PASSWORD` — ustawi hasło konta `admin` (i odtworzy je, jeśli zostało usunięte).

## Konta i bezpieczeństwo

- Każdy kupujący zakłada konto z własnym hasłem; kod klasy jest potrzebny tylko przy rejestracji. Zamówienia są przypisane do konta, więc nikt nie zamówi ani nie anuluje niczego w cudzym imieniu.
- Hasła są przechowywane wyłącznie jako skróty (scrypt). Zapomniane hasło sprzedawca zastępuje nowym w panelu, w sekcji „Konta kupujących".
- Ktoś, kto zna kod klasy, może założyć konto na cudze imię, zanim zrobi to właściciel. Wtedy usuń takie konto w panelu — prawdziwa osoba założy je ponownie.
- Po 5 błędnych hasłach z jednego adresu logowanie jest blokowane na minutę.
- Limit aktywnych zamówień liczy się na konto.
- Bez HTTPS (np. `http://192.168…` w sieci lokalnej) hasła lecą przez sieć otwartym tekstem — kolejny powód, by nie używać tu hasła z innych serwisów.

## Dobrze wiedzieć

- Wymiary liczone są w przeglądarce przy założeniu, że model jest w milimetrach.
- Podgląd 3D korzysta z biblioteki [three.js](https://threejs.org) (licencja MIT), a krój pisma to Bricolage Grotesque (licencja OFL). Oba są dołączone w `vendor/`.
- Kupujący widzi w kolejce cudze zamówienia tylko z nazwą, kolorem i statusem: bez linków, uwag i cen.
