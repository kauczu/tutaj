# Tutaj – prawa autorskie i marka

## Kod źródłowy – AGPL-3.0

Kod źródłowy Tutaj: © 2026 Lorem Ipsum ([tutaj.eu.org](https://tutaj.eu.org)), udostępniony na licencji
**GNU Affero General Public License v3.0** (`AGPL-3.0-only`) – pełna treść w pliku [LICENSE](LICENSE).

W skrócie: kod możesz używać, zmieniać i rozpowszechniać. Jeśli udostępniasz **zmodyfikowaną** wersję
innym ludziom – także jako usługę przez sieć (np. własny serwer z wideorozmowami) – musisz udostępnić im
jej kod źródłowy na tej samej licencji (§13 AGPL).

## Marka – nie jest objęta licencją kodu

Następujące elementy są marką autora i **nie są objęte AGPL**. Wszelkie prawa zastrzeżone:

- nazwy „Tutaj” i „Tutaj.eu.org”, pseudonim „Lorem Ipsum”,
- logo (`brand/logo.png`, `packages/client/public/logo.*`, `packages/desktop/logo.webp`),
- ikony aplikacji (`packages/client/public/icon.svg`, `packages/desktop/build/icon.*`),
- obrazy tła (`brand/background.jpg`, `packages/client/public/background*.webp`).

### Własna instancja lub fork

Kod możesz uruchomić na własnym serwerze i pod własną domeną (zob. [deploy/README.md](deploy/README.md)).
Jeśli udostępniasz ją publicznie albo rozwijasz fork, użyj **własnej marki**:

1. dane marki: `packages/client/src/brand.ts` (nazwa, opis, autor, adres repozytorium),
2. grafika: logo, ikony i tło (pliki wymienione wyżej),
3. aplikacja desktopowa: `packages/desktop/package.json` – pole `tutaj.defaultServer` (Twoja domena), `build.appId`,
   `build.productName`, `author`, `copyright`.

Możesz napisać, że Twój projekt jest „oparty na Tutaj” i podać link do oryginału. Nie przedstawiaj go jako
oficjalnej wersji Tutaj ani jako dzieła Lorem Ipsum.

---

*English summary:* the source code is © 2026 Lorem Ipsum and licensed under AGPL-3.0-only. The names
“Tutaj”/“Tutaj.eu.org”, the pseudonym “Lorem Ipsum”, the logo, app icons and background artwork are **not**
covered by the AGPL. All rights reserved. Forks and public instances must use their own branding (see the list above).
