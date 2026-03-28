import { Zone, ZoneType } from "../types/config";

const ZONE_TYPE_ALIASES: Record<string, ZoneType> = {
  roof: "Roof",
  r: "Roof",
  eave: "Eave",
  e: "Eave",
  perimeter: "Perimeter",
  p: "Perimeter",
};

function resolveType(raw: string): ZoneType | null {
  return ZONE_TYPE_ALIASES[raw.toLowerCase().trim()] ?? null;
}

function defaultName(type: ZoneType, index: number): string {
  return `${type} Zone ${index}`;
}

/**
 * Expands type+count entries into individual zone objects with default names.
 * e.g. [{ type: "Roof", count: 2 }, { type: "Eave", count: 4 }]
 * → [Roof Zone 1, Roof Zone 2, Eave Zone 1, ..., Eave Zone 4]
 */
function expandCounts(counts: { type: ZoneType; count: number }[]): Zone[] {
  const zones: Zone[] = [];
  for (const { type, count } of counts) {
    for (let i = 1; i <= count; i++) {
      zones.push({ type, name: defaultName(type, i) });
    }
  }
  return zones;
}

/**
 * Parses freeform zone field text from the PM intake form.
 *
 * Handles:
 *   "2 Roof, 4 Eave"
 *   "6 zones 2 eave 2 roof"
 *   "2 Roof\n4 Eave"
 *   "Zone 1 Roof, Zone 2 Eave"
 *   "Zone 1 Roof - Garage, Zone 2 Eave - Patio"
 *   "1 Roof 2 Eave 1 Perimeter"
 *
 * Returns null if the string cannot be parsed.
 */
export function parseZoneField(raw: string): Zone[] | null {
  if (!raw?.trim()) return null;

  // Normalize: replace newlines with commas, collapse whitespace
  const normalized = raw.replace(/[\r\n]+/g, ", ").replace(/\s+/g, " ").trim();

  // Format C/D: "Zone N Type" or "Zone N Type - Name"
  // e.g. "Zone 1 Roof, Zone 2 Eave - Patio"
  const namedPattern =
    /zone\s+(\d+)\s+(roof|eave|perimeter|r|e|p)(?:\s*[-–]\s*([^,]+))?/gi;
  const namedMatches = [...normalized.matchAll(namedPattern)];
  if (namedMatches.length > 0) {
    const zones: Zone[] = [];
    for (const m of namedMatches) {
      const type = resolveType(m[2]);
      if (!type) return null;
      const name = m[3]?.trim() || defaultName(type, zones.filter((z) => z.type === type).length + 1);
      zones.push({ type, name });
    }
    return zones;
  }

  // Format A/B: type-count pairs, possibly with a leading total like "6 zones"
  // e.g. "2 Roof, 4 Eave" or "6 zones 2 eave 2 roof"
  const countPattern = /(\d+)\s+(roof|eave|perimeter|r|e|p)\b/gi;
  const countMatches = [...normalized.matchAll(countPattern)];
  if (countMatches.length > 0) {
    const counts: { type: ZoneType; count: number }[] = [];
    for (const m of countMatches) {
      const type = resolveType(m[2]);
      if (!type) return null;
      counts.push({ type, count: parseInt(m[1], 10) });
    }
    return expandCounts(counts);
  }

  return null;
}
