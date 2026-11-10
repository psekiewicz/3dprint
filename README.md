# Zamówienia druku 3D dla klasy

Prosta aplikacja, w której uczniowie zamawiają wydruki 3D na drukarkach **Prusa MINI+** i **Prusa MK4S**, a nauczyciel prowadzi kolejkę.

**Uczeń** (`/`): podaje imię i nazwisko oraz kod klasy, wgrywa plik STL lub 3MF, widzi podgląd 3D i informację, czy model mieści się w drukarce, wybiera drukarkę i filament, a potem śledzi status w kolejce.

**Nauczyciel** (`/admin.html`): pobiera pliki, zmienia statusy, przypisuje drukarkę, pisze wiadomość do ucznia oraz ustawia kod klasy, listę filamentów, dostępne drukarki i limit zamówień na ucznia.

## Jak to jest zbudowane

| Część | Gdzie | Co robi |
|---|---|---|
| Serwer | `server/server.js` | API, zapis zamówień (`data/db.json`) i plików (`data/uploads/`). Czysty Node.js, bez instalowania paczek. |
| Strona | główny katalog (`index.html`, `admin.html`, …) | Statyczne pliki HTML/JS. Serwuje je Raspberry Pi; można je też wystawić na GitHub Pages. |

GitHub Pages hostuje tylko statyczne strony — nie przyjmie plików ani nie zapamięta zamówień — dlatego dane zawsze trzyma Raspberry Pi.

## Uruchomienie na Raspberry Pi

Potrzebny jest Node.js 18 lub nowszy (`node -v`). Na Raspberry Pi OS: `sudo apt install nodejs`.

```bash
git clone https://github.com/psekiewicz/3dprint.git
cd 3dprint
node server/server.js
```

Przy pierwszym uruchomieniu serwer wypisze **hasło nauczyciela** i **kod klasy** — zapisz je. Oba można potem zmienić w panelu nauczyciela. Zapomniane hasło ustawisz na nowo, uruchamiając serwer raz z `ADMIN_PASSWORD=nowehaslo node server/server.js`.

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
| `ADMIN_PASSWORD` | — | Ustawia hasło nauczyciela przy starcie |
| `ALLOWED_ORIGIN` | `*` | Adres strony, która może korzystać z API (np. `https://psekiewicz.github.io`) |

**Kopia zapasowa:** wystarczy skopiować katalog `data/`.

## Strona na GitHub Pages (opcjonalnie)

Przydatne, gdy uczniowie mają zamawiać także spoza sieci szkolnej.

1. W repozytorium: **Settings → Pages → Deploy from a branch**, gałąź `main`, katalog `/ (root)`.
2. Wystaw Raspberry Pi pod publicznym adresem **HTTPS**, np. przez Cloudflare Tunnel albo Tailscale Funnel. Strona z GitHub Pages działa po HTTPS, więc przeglądarka zablokuje połączenie ze zwykłym `http://192.168…`.
3. Wpisz ten adres w `config.js`:
   ```js
   window.API_URL = 'https://twoj-adres-serwera';
   ```
4. Uruchom serwer z `ALLOWED_ORIGIN=https://psekiewicz.github.io`.

Jeśli aplikacja ma działać tylko w szkole, ten krok można pominąć — wystarczy adres Raspberry Pi.

## Dobrze wiedzieć

- Limit zamówień liczy się po imieniu i nazwisku, więc uczeń może go obejść, wpisując inne dane — to zabezpieczenie „na uczciwość", nie przed sabotażem.
- Zamówienie anulować może tylko uczeń na urządzeniu, z którego je złożył, i tylko dopóki ma status „Oczekuje".
- Wymiary liczone są w przeglądarce przy założeniu, że model jest w milimetrach.
- Podgląd 3D korzysta z biblioteki [three.js](https://threejs.org) (licencja MIT), dołączonej w `vendor/`, więc działa też bez internetu.
