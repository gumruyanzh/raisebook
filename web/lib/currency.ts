/**
 * Currencies for the CurrencyPicker (UX pass 1, P0-3). Every ISO 4217 code the browser knows
 * (`Intl.supportedValuesOf("currency")`), named by `Intl.DisplayNames`, with the narrow symbol
 * and a keyword table (countries, the currency's everyday name) for the common ones.
 * The API accepts any three capital letters; rounds keep amounts in whole units.
 */

import { zoneCountry } from "./tz";

export interface CurrencyOption {
  /** ISO 4217: `EUR`. */
  code: string;
  /** `Euro`. */
  name: string;
  /** Narrow symbol: `€`, `֏`; the code itself when there is none. */
  symbol: string;
  /** Search terms: countries, nicknames ("dram", "sterling"), the symbol. */
  keywords: string[];
}

/** Pinned under the current value and the guess, in this order. */
export const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "SGD", "INR", "CHF", "ILS", "JPY"] as const;

/** Search keywords for the ~40 currencies founders use most ("|"-separated). */
const KEYWORDS: Record<string, string> = {
  USD: "United States|USA|US|America|dollar|buck",
  EUR: "Europe|Eurozone|European Union|EU|Germany|France|Spain|Italy|Netherlands|Ireland|Portugal|Austria|Belgium|Finland|Greece|Estonia|Latvia|Lithuania|Croatia|Slovakia|Slovenia|Luxembourg|Malta|Cyprus",
  GBP: "United Kingdom|UK|Britain|Great Britain|England|Scotland|pound|sterling|quid",
  CAD: "Canada|Canadian dollar|loonie",
  AUD: "Australia|Aussie dollar",
  SGD: "Singapore",
  INR: "India|rupee|Rs",
  CHF: "Switzerland|Swiss|franc",
  ILS: "Israel|shekel|NIS",
  JPY: "Japan|yen",
  AMD: "Armenia|dram",
  NGN: "Nigeria|naira",
  BRL: "Brazil|real|reais",
  MXN: "Mexico|peso",
  SEK: "Sweden|krona",
  NOK: "Norway|krone",
  DKK: "Denmark|krone",
  PLN: "Poland|zloty|złoty",
  CZK: "Czechia|Czech Republic|koruna",
  HUF: "Hungary|forint",
  RON: "Romania|leu",
  TRY: "Turkey|Türkiye|lira",
  AED: "United Arab Emirates|UAE|Emirates|Dubai|Abu Dhabi|dirham",
  SAR: "Saudi Arabia|KSA|riyal",
  QAR: "Qatar|riyal",
  HKD: "Hong Kong",
  CNY: "China|yuan|renminbi|RMB",
  KRW: "South Korea|Korea|won",
  TWD: "Taiwan|NT dollar",
  NZD: "New Zealand|kiwi dollar",
  ZAR: "South Africa|rand",
  KES: "Kenya|shilling",
  EGP: "Egypt|Egyptian pound",
  IDR: "Indonesia|rupiah",
  MYR: "Malaysia|ringgit",
  THB: "Thailand|baht",
  VND: "Vietnam|dong",
  PHP: "Philippines|peso",
  PKR: "Pakistan|rupee",
  BDT: "Bangladesh|taka",
  UAH: "Ukraine|hryvnia",
  GEL: "Georgia|lari",
  KZT: "Kazakhstan|tenge",
  ARS: "Argentina|peso",
  CLP: "Chile|peso",
  COP: "Colombia|peso",
  GHS: "Ghana|cedi",
  MAD: "Morocco|dirham",
  RUB: "Russia|ruble|rouble",
  ISK: "Iceland|króna",
};

/** Order for ties: the common ones first, then the ones with keywords, then A–Z. */
const POPULAR = [
  ...COMMON_CURRENCIES,
  ...Object.keys(KEYWORDS).filter((c) => !(COMMON_CURRENCIES as readonly string[]).includes(c)),
];

/** Country (ISO 3166) → currency, for `guessCurrency`. Pairs packed as "CC:CUR". */
const COUNTRY_CURRENCY: Record<string, string> = Object.fromEntries(
  (
    "AD:EUR AE:AED AF:AFN AG:XCD AI:XCD AL:ALL AM:AMD AO:AOA AR:ARS AS:USD AT:EUR AU:AUD AW:AWG " +
    "AX:EUR AZ:AZN BA:BAM BB:BBD BD:BDT BE:EUR BF:XOF BG:BGN BH:BHD BI:BIF BJ:XOF BL:EUR BM:BMD " +
    "BN:BND BO:BOB BQ:USD BR:BRL BS:BSD BT:BTN BW:BWP BY:BYN BZ:BZD CA:CAD CC:AUD CD:CDF CF:XAF " +
    "CG:XAF CH:CHF CI:XOF CK:NZD CL:CLP CM:XAF CN:CNY CO:COP CR:CRC CU:CUP CV:CVE CW:ANG CX:AUD " +
    "CY:EUR CZ:CZK DE:EUR DJ:DJF DK:DKK DM:XCD DO:DOP DZ:DZD EC:USD EE:EUR EG:EGP EH:MAD ER:ERN " +
    "ES:EUR ET:ETB FI:EUR FJ:FJD FK:FKP FM:USD FO:DKK FR:EUR GA:XAF GB:GBP GD:XCD GE:GEL GF:EUR " +
    "GG:GBP GH:GHS GI:GIP GL:DKK GM:GMD GN:GNF GP:EUR GQ:XAF GR:EUR GT:GTQ GU:USD GW:XOF GY:GYD " +
    "HK:HKD HN:HNL HR:EUR HT:HTG HU:HUF ID:IDR IE:EUR IL:ILS IM:GBP IN:INR IO:USD IQ:IQD IR:IRR " +
    "IS:ISK IT:EUR JE:GBP JM:JMD JO:JOD JP:JPY KE:KES KG:KGS KH:KHR KI:AUD KM:KMF KN:XCD KP:KPW " +
    "KR:KRW KW:KWD KY:KYD KZ:KZT LA:LAK LB:LBP LC:XCD LI:CHF LK:LKR LR:LRD LS:LSL LT:EUR LU:EUR " +
    "LV:EUR LY:LYD MA:MAD MC:EUR MD:MDL ME:EUR MF:EUR MG:MGA MH:USD MK:MKD ML:XOF MM:MMK MN:MNT " +
    "MO:MOP MP:USD MQ:EUR MR:MRU MS:XCD MT:EUR MU:MUR MV:MVR MW:MWK MX:MXN MY:MYR MZ:MZN NA:NAD " +
    "NC:XPF NE:XOF NF:AUD NG:NGN NI:NIO NL:EUR NO:NOK NP:NPR NR:AUD NU:NZD NZ:NZD OM:OMR PA:PAB " +
    "PE:PEN PF:XPF PG:PGK PH:PHP PK:PKR PL:PLN PM:EUR PN:NZD PR:USD PS:ILS PT:EUR PW:USD PY:PYG " +
    "QA:QAR RE:EUR RO:RON RS:RSD RU:RUB RW:RWF SA:SAR SB:SBD SC:SCR SD:SDG SE:SEK SG:SGD SH:SHP " +
    "SI:EUR SJ:NOK SK:EUR SL:SLE SM:EUR SN:XOF SO:SOS SR:SRD SS:SSP ST:STN SV:USD SX:ANG SY:SYP " +
    "SZ:SZL TC:USD TD:XAF TF:EUR TG:XOF TH:THB TJ:TJS TK:NZD TL:USD TM:TMT TN:TND TO:TOP TR:TRY " +
    "TT:TTD TV:AUD TW:TWD TZ:TZS UA:UAH UG:UGX UM:USD US:USD UY:UYU UZ:UZS VA:EUR VC:XCD VE:VES " +
    "VG:USD VI:USD VN:VND VU:VUV WF:XPF WS:WST YE:YER YT:EUR ZA:ZAR ZM:ZMW ZW:ZWL"
  )
    .split(" ")
    .map((p) => p.split(":") as [string, string]),
);

const FALLBACK_CODES = [
  ...POPULAR,
  "ARS", "BGN", "CLP", "COP", "HRK", "ISK", "PEN", "QAR", "UYU",
];

function supportedCodes(): string[] {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const list = sv ? sv("currency") : [];
    if (list.length) return list;
  } catch {
    /* fall through */
  }
  return Array.from(new Set(FALLBACK_CODES));
}

/** Narrow symbol for a code (`NGN` → `₦`), or the code when the locale has none. */
export function narrowSymbol(code: string, locale = "en-US"): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    return part?.value ?? code;
  } catch {
    return code;
  }
}

/** English name (`Armenian Dram`), or the code. */
export function currencyName(code: string, locale = "en"): string {
  try {
    return new Intl.DisplayNames([locale], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const CACHE = new Map<string, CurrencyOption[]>();

/**
 * Every currency, most-used first, then A–Z by code. Names come from `locale` (English by
 * default, matching the rest of the app).
 */
export function currencyOptions(locale = "en"): CurrencyOption[] {
  const hit = CACHE.get(locale);
  if (hit) return hit;
  const codes = new Set(supportedCodes().map((c) => c.toUpperCase()));
  for (const c of POPULAR) codes.add(c);
  const ordered = [...POPULAR.filter((c) => codes.has(c)), ...[...codes].filter((c) => !POPULAR.includes(c)).sort()];
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames([locale], { type: "currency" });
  } catch {
    names = null;
  }
  const list = ordered.map((code) => {
    let name = code;
    try {
      name = names?.of(code) ?? code;
    } catch {
      name = code;
    }
    const symbol = narrowSymbol(code);
    const keywords = [name, ...(KEYWORDS[code]?.split("|") ?? [])];
    if (symbol !== code) keywords.push(symbol);
    return { code, name, symbol, keywords };
  });
  CACHE.set(locale, list);
  return list;
}

/** The option for one code, including codes the browser does not list. */
export function currencyOption(code: string): CurrencyOption {
  const c = code.toUpperCase();
  return (
    currencyOptions().find((o) => o.code === c) ?? { code: c, name: currencyName(c), symbol: narrowSymbol(c), keywords: [] }
  );
}

/** Currency used in a country (ISO 3166 alpha-2), if known. */
export function countryCurrency(country: string | null | undefined): string | null {
  return (country && COUNTRY_CURRENCY[country.toUpperCase()]) || null;
}

function localeRegion(locale: string | undefined): string | null {
  if (!locale) return null;
  try {
    const L = Intl.Locale as unknown as new (tag: string) => { region?: string; maximize(): { region?: string } };
    const loc = new L(locale);
    return loc.region ?? loc.maximize().region ?? null;
  } catch {
    const m = /[-_]([A-Za-z]{2})\b/.exec(locale);
    return m ? m[1]!.toUpperCase() : null;
  }
}

/**
 * Best guess for a founder's currency: the country of the timezone (`Asia/Yerevan` → AMD;
 * needs `loadZoneData()` for most zones), else the locale's region (`en-GB` → GBP), else USD.
 */
export function guessCurrency(opts: { timeZone?: string | null; locale?: string | null }): string {
  const byZone = opts.timeZone ? countryCurrency(zoneCountry(opts.timeZone)) : null;
  if (byZone) return byZone;
  return countryCurrency(localeRegion(opts.locale ?? undefined)) ?? "USD";
}
