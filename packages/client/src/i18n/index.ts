// Interface language: Polish or English. Automatic from the system/browser language, or chosen
// in the lobby (stored per browser). Static HTML is translated through data-i18n attributes.
import { en } from './en';
import { pl, type Key } from './pl';

export type Lang = 'pl' | 'en';
export type LangPreference = Lang | 'auto';
export type { Key };

const STORE_KEY = 'tutaj:lang';
const dictionaries: Record<Lang, Record<Key, string>> = { pl, en };

export function languagePreference(): LangPreference {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === 'pl' || v === 'en' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function detect(): Lang {
  const pref = languagePreference();
  if (pref !== 'auto') return pref;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => l?.toLowerCase().startsWith('pl')) ? 'pl' : 'en';
}

/** The language of this page load (changing it reloads the page). */
export const lang: Lang = detect();
/** For number formatting (decimal comma in Polish). */
export const locale = lang === 'pl' ? 'pl-PL' : 'en-GB';
document.documentElement.lang = lang;

/** Translated text; `{name}` placeholders are filled from `params`. */
export function t(key: Key, params?: Record<string, string | number>): string {
  const text = dictionaries[lang][key] ?? pl[key] ?? key;
  return params ? text.replace(/\{(\w+)\}/g, (m, p: string) => (p in params ? String(params[p]) : m)) : text;
}

/** Stores the choice and reloads, so every part of the page is in the new language. */
export function setLanguagePreference(pref: LangPreference): void {
  try {
    if (pref === 'auto') localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, pref);
  } catch {
    /* private mode: only this page load */
  }
  location.reload();
}

/**
 * Translates static markup: data-i18n (text), data-i18n-title, data-i18n-placeholder,
 * data-i18n-aria-label — each holding a dictionary key.
 */
export function translateDocument(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n as Key);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle as Key);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    (el as HTMLInputElement).placeholder = t(el.dataset.i18nPlaceholder as Key);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel as Key));
}

/** A server error in the interface language (by its code; the server's own text otherwise). */
export function serverError(e: { code: string; message: string; minutes?: number }): string {
  const key = `error.${e.code}` as Key;
  return key in pl ? t(key, { minutes: e.minutes ?? 10 }) : e.message;
}
