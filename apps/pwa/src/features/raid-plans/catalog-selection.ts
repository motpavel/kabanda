export const ROUTE_CATALOG_PREVIEW_SIZE = 4

/** Presentation only: preserve the established chronological catalog order.
 * Expanding exposes the remaining permitted routes without mutating the response
 * or inventing a recommendation score. Newly created routes stay after older ones. */
export function selectCatalogRoutes<T extends { id: string; createdAt: string }>(templates: readonly T[], expanded = false): T[] {
  const sorted = [...templates].sort((left, right) =>
    (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0) || left.id.localeCompare(right.id))
  return expanded ? sorted : sorted.slice(0, ROUTE_CATALOG_PREVIEW_SIZE)
}
