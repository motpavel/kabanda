import archiveUrl from './assets/izhevsk-20260923.kmap?url'
import type { CityArchiveSpec } from './archive-store'

// Rebuilt with infra/maps/build_city_bundle.py; tiles, glyphs and sprites form
// one verified, atomic package. It is not duplicated in the service-worker cache.
export const IZHEVSK_ARCHIVE: CityArchiveSpec = {
  version: 'izhevsk-20260923-v1',
  url: archiveUrl,
  bytes: 22422245,
  sha256: '625592bd516f3d24ff79d62d66d23e248d43561106ef56c26692152383902f97',
}
