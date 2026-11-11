import { locale, translateUi } from "./i18n";
import catalog from "../electron/ocr-models.json";

export type ScanLanguage = keyof typeof catalog.languages;
export const SCAN_LANGUAGES = (Object.keys(catalog.languages) as ScanLanguage[]).map(id => ({
  id, ...catalog.languages[id],
}));

export function scanLanguagesFrom(value: string | null): ScanLanguage[] {
  const languages = (value ?? "").split("+").filter((id): id is ScanLanguage => Object.hasOwn(catalog.languages, id));
  return languages.length ? [...new Set(languages)] : ["eng"];
}

/** Keep language names searchable in the interface language and in their native spelling. */
export function scanLanguageName(id: ScanLanguage): string {
  if (locale() !== "es") return catalog.languages[id].name;
  const special = {
    aze_cyrl: "Azerbaijani (Cyrillic)", chi_sim_vert: "Chinese (Simplified, vertical)", chi_sim: "Chinese (Simplified)",
    chi_tra_vert: "Chinese (Traditional, vertical)", chi_tra: "Chinese (Traditional)", frk: "German (Fraktur)",
    jpn_vert: "Japanese (vertical)", kor_vert: "Korean (vertical)", lao: "Lao", kat_old: "Old Georgian",
    ita_old: "Old Italian", spa_old: "Old Spanish", srp_latn: "Serbian (Latin)", uzb_cyrl: "Uzbek (Cyrillic)",
  } as const;
  const name = id in special ? translateUi(special[id as keyof typeof special])
    : new Intl.DisplayNames(["es"], { type: "language" }).of(id) ?? catalog.languages[id].name;
  return name.charAt(0).toLocaleUpperCase("es") + name.slice(1);
}
