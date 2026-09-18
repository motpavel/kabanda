export const ROUTE_CATALOG_PREVIEW_SIZE = 4

/** Presentation only: all permitted routes remain in the canonical response.
 * Do not mutate that response or invent a popularity/recommendation score. */
export function selectCatalogRoutes<T extends { id: string; createdAt: string }>(templates: readonly T[], expanded = false): T[] {
  const sorted = [...templates].sort((left, right) =>
    (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0) || left.id.localeCompare(right.id))
  return expanded ? sorted : sorted.slice(0, ROUTE_CATALOG_PREVIEW_SIZE)
}
