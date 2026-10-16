<p align="center">
  <img src="brand/social-preview.jpg" alt="Tutaj.eu.org by Lorem Ipsum" width="720" />
</p>

<p align="center">
  <b>Spójna platforma komunikacyjna.</b><br />
  <a href="https://o.tutaj.eu.org">o.tutaj.eu.org</a> · autor: <a href="https://tutaj.eu.org">Lorem Ipsum</a> · licencja kodu: <a href="LICENSE">AGPL-3.0</a>
</p>

> **Wersja wczesna (alpha).** Działa i jest testowana, ale interfejsy i konfiguracja mogą się jeszcze zmieniać.

# Tutaj

Wideorozmowy dla 2–4 osób – dla przyjaciół, rodziny i wspólnego grania. Wystarczy wymyślić nazwę pokoju i wysłać
link pozostałym. Bez kont i bez instalowania czegokolwiek: działa w przeglądarce, a dla graczy jest też aplikacja
na Windows.

Obraz i dźwięk płyną bezpośrednio między uczestnikami. Gdy przy 3–4 osobach łącza nie dają rady, rozmowa sama przechodzi przez serwer –
wtedy też zaszyfrowana tak, że serwer nie może jej odczytać.

## Co potrafi

- rozmowa wideo do 4 osób, udostępnianie ekranu, czat i przesyłanie plików
- reakcje, podnoszenie ręki, nagrywanie rozmowy
- hasło pokoju i gospodarz, który może wyciszyć lub usunąć uczestnika
- szyfrowanie end-to-end i kody bezpieczeństwa do porównania głosem
- dla graczy: profil „Gra” (dźwięk studyjny, obraz 1080p, kodowanie na karcie graficznej) i nakładka z kamerami nad grą
- obraz w obrazie w przeglądarce, interfejs po polsku i angielsku

Pełna lista: [wiki → Funkcje](https://github.com/kauczu/tutaj/wiki/Funkcje).

## Jak zacząć

### W przeglądarce

Wejdź na **[o.tutaj.eu.org](https://o.tutaj.eu.org)**, wpisz imię, dołącz do pokoju i wyślij link pozostałym
(w nowoczesnej przeglądarce, także na telefonie).

### Aplikacja na Windows

1. Pobierz `Tutaj-Setup-<wersja>.exe` z [najnowszego wydania](https://github.com/kauczu/tutaj/releases/latest).
2. Uruchom instalator. Windows pokaże okno **„System Windows ochronił ten komputer”** – instalator nie jest podpisany
   certyfikatem, więc Windows go nie zna. Kliknij **„Więcej informacji”**, a potem **„Uruchom mimo to”**.
3. Gotowe – nie są potrzebne uprawnienia administratora. Kolejne wersje aplikacja pobiera i instaluje sama
   (po Twojej zgodzie), już bez ostrzeżeń.

Aplikacja łączy się z o.tutaj.eu.org, ale można ją przełączyć na własny serwer albo na rozmowy w sieci lokalnej bez
internetu – zob. [wiki → Aplikacja desktopowa](https://github.com/kauczu/tutaj/wiki/Aplikacja-desktopowa).

### Własny serwer

Potrzebujesz:

- serwera VPS z Linuksem (Ubuntu 22.04+ lub Debian 12+, 2 GB RAM) i publicznym adresem IPv4,
- domeny (lub subdomeny) wskazującej na ten serwer.

Instalacja to dwa polecenia na serwerze – skrypt sam zainstaluje Dockera, uzyska certyfikat HTTPS i uruchomi wszystko,
co potrzebne:

```bash
git clone https://github.com/kauczu/tutaj.git ~/tutaj
cd ~/tutaj/deploy && sudo bash install.sh rozmowa.twoja-domena.pl
```

Aktualizacja do najnowszej wersji:

```bash
cd ~/tutaj/deploy && sudo ./update.sh
```

Instrukcja krok po kroku (DNS, zapora, serwer z innymi stronami, klucz właściciela):
**[deploy/README.md](deploy/README.md)**. Opcje dla zaawansowanych:
[wiki → Konfiguracja serwera](https://github.com/kauczu/tutaj/wiki/Konfiguracja-serwera).

## Dokumentacja

Szczegóły – jak działa jakość, nakładka na grę, szyfrowanie, architektura, uruchomienie ze źródeł i testy – są
w **[wiki](https://github.com/kauczu/tutaj/wiki)**.

## Licencja i marka

Kod: © 2026 Lorem Ipsum, [AGPL-3.0](LICENSE). Nazwa „Tutaj”, pseudonim „Lorem Ipsum”, logo, ikony i grafika tła
**nie są objęte licencją kodu** – wszelkie prawa zastrzeżone. Własna instancja lub fork musi mieć własną markę;
co dokładnie zmienić, opisuje [NOTICE.md](NOTICE.md).
