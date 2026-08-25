import content from "./researchContent.json";

/** Locale tag used by the research portal (two-letter form). */
export type ResearchLocale = "zh" | "en";

type Copy = {
  en: string;
  zh: string;
};

/**
 * Extracts a locale-specific surface from a bilingual copy record.
 *
 * Each top-level key in the record maps to `{ en, zh }` pairs; the returned
 * object has the same keys but each value is the string for the requested
 * locale.
 *
 * @param copy - The bilingual copy record.
 * @param locale - Which locale to extract.
 * @returns A shallow record with the same keys, resolved to one locale.
 */
export const researchCopy = <T extends Record<string, Copy>>(copy: T, locale: ResearchLocale) => {
  return Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, value[locale]])) as {
    [K in keyof T]: string;
  };
};

/** Destructured content blocks from the research content JSON. */
export const { portalCopy, researchSections, protocolSteps, documentationSections } = content;
