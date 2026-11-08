# Zasady pracy nad Tutaj

## Zasada fundamentalna: nie psuj tego, co działa

Przy dodawaniu nowych funkcji **nie przebudowuj i nie zmieniaj działającego, poprawnego kodu**. Istniejący kod zmienia
się tylko wtedy, gdy nowa funkcja w żaden sposób nie może poprawnie działać razem z nim.

Ta zasada ma pierwszeństwo przed wygodą, porządkami i upodobaniami co do stylu.

W praktyce:

- **Nowe funkcje dodawaj obok istniejących** — jako nowe moduły, opcje, zdarzenia czy punkty zaczepienia — zamiast
  przerabiać to, co już działa.
- **Gdy zmiana istniejącego kodu jest nieunikniona**, opisz w zmianie (commit, PR), co zmieniasz i dlaczego nowa
  funkcja nie może bez tego działać.
- **Naprawy błędów** są w porządku — błędny kod nie jest „działającym, poprawnym kodem” — ale rób je minimalnie,
  bez przebudowy przy okazji.
- **Bez refaktoryzacji „przy okazji”**: zmiana nazw, przenoszenie kodu czy porządki w działających częściach to osobna,
  świadoma decyzja, nie dodatek do nowej funkcji.

Dlaczego: Tutaj jest sprawdzany na prawdziwych urządzeniach (komputery, telefony, gry). Każda zmiana działającego
kodu to nowa runda testów i ryzyko błędów w miejscach, które wcześniej były sprawdzone.

## Pozostałe

- Język: interfejs, dokumentacja i opisy zmian po polsku (interfejs ma też wersję angielską — `packages/client/src/i18n`).
- Przed wysłaniem zmian: `npm run typecheck`, `npm test` i testy end-to-end (`npm run build && npm run test:e2e`).
  Szczegóły uruchamiania i testów: [wiki → Rozwój](https://github.com/kauczu/tutaj/wiki/Rozw%C3%B3j).
- Marka (nazwa, logo, grafiki) nie jest objęta licencją kodu — zob. [NOTICE.md](NOTICE.md).
