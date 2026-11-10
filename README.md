# Zamówienia druku 3D

Prosty sklepik z wydrukami 3D dla kolegów z klasy, na drukarki **Prusa MINI+** i **Prusa MK4S**.

**Kupujący** (`/`): podaje imię i nazwisko oraz kod klasy, wgrywa plik STL lub 3MF, widzi podgląd 3D i informację, czy model mieści się w drukarce, wybiera drukarkę i filament, a potem śledzi w kolejce status, cenę i to, czy zamówienie jest opłacone.

**Sprzedawca** (`/admin.html`): pobiera pliki, wpisuje czas druku (z niego wylicza się cena), zmienia statusy, oznacza zapłatę, pisze wiadomość do kupującego oraz ustawia kod klasy, filamenty ze stawkami, dostępne drukarki i limit zamówień na osobę.

## Cena

**Cena = stawka filamentu (zł/min) × czas druku (min).**

Stawkę każdego filamentu ustawiasz w panelu. Czas druku wpisujesz przy zamówieniu po pocięciu modelu w PrusaSlicer — cena wylicza się sama i od razu widzi ją kupujący. Zamówienie zapamiętuje stawkę z chwili złożenia, więc późniejsza zmiana cennika nie zmienia starych zamówień. Płatność odbywa się poza aplikacją (gotówka, BLIK); w panelu tylko zaznaczasz „zapłacone".

## Jak to jest zbudowane

| Część | Gdzie | Co robi |
|---|---|---|
| Serwer | `server/server.js` | API, zapis zamówień (`data/db.json`) i plików (`data/uploads/`). Czysty Node.js, bez instalowania paczek. |
| Strona | główny katalog (`index.html`, `admin.html`, …) | Statyczne pliki HTML/JS. Serwuje je Raspberry Pi; można je też wystawić na GitHub Pages. |

GitHub Pages hostuje tylko statyczne strony — nie przyjmie plików ani nie zapamięta zamówień — dlatego dane zawsze trzyma Raspberry Pi.

## Wersja pokazowa (bez serwera)

Na samym GitHub Pages aplikację można obejrzeć bez Raspberry Pi: wpisz kod klasy **`demo`** (a w panelu sprzedawcy hasło **`demo`**). Dane zapisują się wtedy tylko w tej jednej przeglądarce — kupujący i sprzedawca widzą te same zamówienia wyłącznie na tym samym urządzeniu. Do przyjmowania prawdziwych zamówień potrzebny jest serwer.

## Uruchomienie na Raspberry Pi

Potrzebny jest Node.js 18 lub nowszy (`node -v`). Na Raspberry Pi OS: `sudo apt install nodejs`.

```bash
git clone https://github.com/psekiewicz/3dprint.git
cd 3dprint
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

### Ustawienia serwera (zmienne środowiskowe)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` | `3000` | Port serwera |
| `DATA_DIR` | `./data` | Katalog z bazą i plikami modeli |
| `ADMIN_PASSWORD` | — | Ustawia hasło sprzedawcy przy starcie |
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

## Dobrze wiedzieć

- Limit zamówień liczy się po imieniu i nazwisku, więc kupujący może go obejść, wpisując inne dane — to zabezpieczenie „na uczciwość", nie przed sabotażem.
- Zamówienie anulować może tylko kupujący na urządzeniu, z którego je złożył, i tylko dopóki ma status „Oczekuje".
- Wymiary liczone są w przeglądarce przy założeniu, że model jest w milimetrach.
- Podgląd 3D korzysta z biblioteki [three.js](https://threejs.org) (licencja MIT), dołączonej w `vendor/`, więc działa też bez internetu.
