import { describe, expect, it } from "vitest";
import {
  classifyName,
  conformsTo,
  deriveConvention,
  GA4_RESERVED_EVENTS,
  isReservedEventName,
  toConvention,
} from "../src/pipeline/convention";

describe("classifyName", () => {
  it("detects snake, object_action, camel, kebab, single, other", () => {
    expect(classifyName("cta_click")).toBe("snake_object_action");
    expect(classifyName("user_signed_up_completed")).toBe("snake");
    expect(classifyName("ctaClick")).toBe("camel");
    expect(classifyName("cta-click")).toBe("kebab");
    expect(classifyName("signup")).toBe("single");
    expect(classifyName("Click Me!")).toBe("other");
    expect(classifyName("$pageview")).toBe("other");
  });
});

describe("deriveConvention", () => {
  it("derives object_action snake when two-token snake names dominate", () => {
    const c = deriveConvention(["cta_click", "form_submit", "user_signup", "page_view"], ["cta_text", "page_path"]);
    expect(c.style).toBe("object_action_snake");
    expect(c.isDefault).toBe(false);
    expect(c.confidence).toBeGreaterThanOrEqual(0.6);
    expect(c.propertyStyle).toBe("snake");
    expect(c.derivedFrom).toContain("object_action");
  });

  it("derives plain snake when longer snake names dominate", () => {
    const c = deriveConvention(["user_signed_up_completed", "account_upgraded_to_pro", "checkout_completed"], []);
    expect(c.style).toBe("snake");
    expect(c.isDefault).toBe(false);
  });

  it("derives camelCase when it dominates", () => {
    const c = deriveConvention(["ctaClick", "formSubmit", "userSignup"], ["ctaText"]);
    expect(c.style).toBe("camel");
    expect(c.propertyStyle).toBe("camel");
  });

  it("falls back to the default when nothing is discernible", () => {
    const c = deriveConvention(["page_view", "$pageview", "session_start"], []);
    expect(c.style).toBe("object_action_snake");
    expect(c.isDefault).toBe(true);
    expect(c.confidence).toBe(0);
    expect(c.derivedFrom).toContain("no custom event names");
  });

  it("falls back to the default when naming is mixed", () => {
    const c = deriveConvention(["cta_click", "formSubmit", "form-submit"], []);
    expect(c.style).toBe("object_action_snake");
    expect(c.isDefault).toBe(true);
  });

  it("excludes reserved auto-events from the tally and notes the GA4 lock", () => {
    expect(isReservedEventName("page_view")).toBe(true);
    expect(isReservedEventName("$pageview")).toBe(true);
    expect(isReservedEventName("cta_click")).toBe(false);
    expect(GA4_RESERVED_EVENTS.has("session_start")).toBe(true);
    const c = deriveConvention(["page_view", "page_view"], []);
    expect(c.isDefault).toBe(true);
    expect(c.ga4Note).toMatch(/terminology-locked/i);
  });
});

describe("conformsTo (enforcement)", () => {
  it("checks each style", () => {
    expect(conformsTo("cta_click", "object_action_snake")).toBe(true);
    expect(conformsTo("signup", "object_action_snake")).toBe(false);
    expect(conformsTo("signup", "snake")).toBe(true);
    expect(conformsTo("ctaClick", "camel")).toBe(true);
    expect(conformsTo("ctaclick", "camel")).toBe(false);
    expect(conformsTo("cta-click", "kebab")).toBe(true);
  });

  it("treats none_discernible as the default convention", () => {
    expect(conformsTo("cta_click", "none_discernible")).toBe(true);
    expect(conformsTo("CTA CLICK", "none_discernible")).toBe(false);
  });
});

describe("toConvention (mechanical rename)", () => {
  it("converts names into the convention style", () => {
    expect(toConvention("CTA_Click", "object_action_snake")).toBe("cta_click");
    expect(toConvention("formSubmit", "object_action_snake")).toBe("form_submit");
    expect(toConvention("cta click!", "object_action_snake")).toBe("cta_click");
    expect(toConvention("cta click", "camel")).toBe("ctaClick");
    expect(toConvention("ctaClick", "kebab")).toBe("cta-click");
  });

  it("returns single tokens joined as-is (the gate prefixes the object for add rows)", () => {
    expect(toConvention("signup", "object_action_snake")).toBe("signup");
    expect(conformsTo(toConvention("signup", "object_action_snake"), "object_action_snake")).toBe(false);
  });
});
