import type { ConventionStyle } from "../schemas/report";

/**
 * Naming-convention derivation and enforcement — pure and unit-tested.
 *
 * The dominant convention already present on the site is the editorial
 * standard the report grades against. If none is discernible, the default
 * is object_action snake_case for events and snake_case for properties.
 * GA4 is terminology-locked: its reserved auto-event vocabulary is never
 * renamed, and PostHog's platform events are $-prefixed and reserved.
 */

export const GA4_RESERVED_EVENTS = new Set([
  "page_view",
  "first_visit",
  "session_start",
  "engagement_time_msec",
  "scroll",
  "click",
  "video_start",
  "video_progress",
  "video_complete",
  "view_search_results",
  "file_download",
  "form_start",
  "form_submit",
  "login",
  "sign_up",
  "search",
  "select_content",
  "select_item",
  "select_promotion",
  "view_cart",
  "begin_checkout",
  "add_to_cart",
  "remove_from_cart",
  "view_item",
  "view_item_list",
  "view_promotion",
  "add_payment_info",
  "add_shipping_info",
  "generate_lead",
  "purchase",
  "refund",
  "add_to_wishlist",
  "exception",
]);

export const GA4_LOCK_NOTE =
  "GA4 is terminology-locked: its reserved auto-event names (page_view, session_start, scroll, form_submit, ...) and parameter names stay exactly as GA4 defines them. Renames in the tracking plan never apply to GA4 reserved events; GA4 custom event names may follow the site convention.";

export const DEFAULT_EVENT_STYLE: ConventionStyle = "object_action_snake";
export const DEFAULT_PROPERTY_STYLE: ConventionStyle = "snake";

export type NameFamily = "snake" | "snake_object_action" | "camel" | "kebab" | "single" | "other";

export function classifyName(name: string): NameFamily {
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(name)) {
    return name.split("_").length === 2 ? "snake_object_action" : "snake";
  }
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+$/.test(name)) return "camel";
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(name)) return "kebab";
  if (/^[a-z0-9]+$/.test(name)) return "single";
  return "other";
}

/** Reserved/platform auto names are excluded from convention tallies and never renamed. */
export function isReservedEventName(name: string): boolean {
  return name.startsWith("$") || GA4_RESERVED_EVENTS.has(name);
}

export interface DerivedConvention {
  style: ConventionStyle;
  eventPattern: string;
  propertyStyle: ConventionStyle;
  derivedFrom: string;
  confidence: number;
  isDefault: boolean;
  ga4Note: string;
}

/** Derive the dominant convention from the observed custom event names and property keys. */
export function deriveConvention(eventNames: string[], propKeys: string[]): DerivedConvention {
  const custom = eventNames.filter((n) => !isReservedEventName(n));
  const ga4Note = GA4_LOCK_NOTE;

  if (custom.length === 0) {
    return {
      style: DEFAULT_EVENT_STYLE,
      eventPattern: patternFor(DEFAULT_EVENT_STYLE),
      propertyStyle: DEFAULT_PROPERTY_STYLE,
      derivedFrom:
        "no custom event names observed on the wire (only reserved auto-events); default convention applied",
      confidence: 0,
      isDefault: true,
      ga4Note,
    };
  }

  const families = tally(custom.map(classifyName));
  const familyOf = (f: NameFamily): number => (f === "single" ? families.snake_object_action + families.snake + families.single : (families[f] ?? 0));
  const total = custom.length;
  const snakeShare = (familyOf("snake") + familyOf("snake_object_action")) / total;
  const camelShare = familyOf("camel") / total;
  const kebabShare = familyOf("kebab") / total;

  let style: ConventionStyle;
  let derivedFrom: string;
  let confidence: number;
  if (snakeShare >= 0.6 && familyOf("snake_object_action") / Math.max(1, familyOf("snake") + familyOf("snake_object_action")) >= 0.5) {
    style = "object_action_snake";
    derivedFrom = `${familyOf("snake_object_action")} of ${familyOf("snake") + familyOf("snake_object_action")} snake_case names are two-token object_action names (e.g. cta_click)`;
    confidence = snakeShare;
  } else if (snakeShare >= 0.6) {
    style = "snake";
    derivedFrom = `${familyOf("snake") + familyOf("snake_object_action")} of ${total} custom names are snake_case`;
    confidence = snakeShare;
  } else if (camelShare >= 0.6) {
    style = "camel";
    derivedFrom = `${familyOf("camel")} of ${total} custom names are camelCase`;
    confidence = camelShare;
  } else if (kebabShare >= 0.6) {
    style = "kebab";
    derivedFrom = `${familyOf("kebab")} of ${total} custom names are kebab-case`;
    confidence = kebabShare;
  } else {
    return {
      style: DEFAULT_EVENT_STYLE,
      eventPattern: patternFor(DEFAULT_EVENT_STYLE),
      propertyStyle: DEFAULT_PROPERTY_STYLE,
      derivedFrom: `mixed naming (${total} custom names, no style above 60%); default convention applied`,
      confidence: 0,
      isDefault: true,
      ga4Note,
    };
  }

  // Property style: same tally over property keys (single-word keys count as snake).
  const propTotal = propKeys.length;
  const propFamilies = tally(propKeys.map(classifyName));
  let propertyStyle: ConventionStyle = DEFAULT_PROPERTY_STYLE;
  if (propTotal > 0) {
    const pSnake = ((propFamilies.snake ?? 0) + (propFamilies.snake_object_action ?? 0) + (propFamilies.single ?? 0)) / propTotal;
    const pCamel = (propFamilies.camel ?? 0) / propTotal;
    const pKebab = (propFamilies.kebab ?? 0) / propTotal;
    if (pSnake >= 0.6) propertyStyle = "snake";
    else if (pCamel >= 0.6) propertyStyle = "camel";
    else if (pKebab >= 0.6) propertyStyle = "kebab";
  }

  return {
    style,
    eventPattern: patternFor(style),
    propertyStyle,
    derivedFrom,
    confidence,
    isDefault: false,
    ga4Note,
  };
}

/** Does a (proposed) name conform to the convention style? none_discernible means the default. */
export function conformsTo(name: string, style: ConventionStyle): boolean {
  const s: ConventionStyle = style === "none_discernible" ? DEFAULT_EVENT_STYLE : style;
  switch (s) {
    case "object_action_snake":
      return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name);
    case "snake":
      return /^[a-z][a-z0-9_]*$/.test(name);
    case "camel":
      return /^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name);
    case "kebab":
      return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(name);
    default:
      return true;
  }
}

/** Mechanical rename into the convention style. May return the input unchanged (single token). */
export function toConvention(name: string, style: ConventionStyle): string {
  const s: ConventionStyle = style === "none_discernible" ? DEFAULT_EVENT_STYLE : style;
  if (s === "camel") {
    const tokens = tokenize(name);
    if (tokens.length === 0) return name;
    return tokens
      .map((t, i) => (i === 0 ? t.toLowerCase() : t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()))
      .join("");
  }
  const tokens = tokenize(name).map((t) => t.toLowerCase());
  if (tokens.length === 0) return name.toLowerCase();
  if (s === "kebab") return tokens.join("-");
  // snake / object_action_snake: a single token cannot become object_action mechanically.
  return tokens.join("_");
}

function tokenize(name: string): string[] {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return parts;
}

function tally(items: NameFamily[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

function patternFor(style: ConventionStyle): string {
  switch (style) {
    case "object_action_snake":
      return "object_action snake_case — two lowercase tokens joined by an underscore, e.g. cta_click, signup_completed";
    case "snake":
      return "snake_case — lowercase words joined by underscores, e.g. signup_completed";
    case "camel":
      return "camelCase — first word lowercase, following words capitalized, e.g. ctaClick";
    case "kebab":
      return "kebab-case — lowercase words joined by hyphens, e.g. cta-click";
    default:
      return patternFor(DEFAULT_EVENT_STYLE);
  }
}
