# Offline Izhevsk basemap

`build_city_bundle.py` creates the app's self-contained `KBMAP001` archive from
official Protomaps/OpenStreetMap vector map data and locally bundled font/sprite
assets. It does not scrape raster tiles or contact Yandex map endpoints.

## Rebuild

Install the official [go-pmtiles CLI v1.31.2](https://github.com/protomaps/go-pmtiles/releases/tag/v1.31.2)
and run from the repository root:

```sh
python3 infra/maps/build_city_bundle.py --pmtiles-cli /path/to/pmtiles
```

The script extracts only the city region, using HTTP range requests against
`https://build.protomaps.com/20260923.pmtiles`. The upstream planet file is not
downloaded. The regional archive contains about 11 MB of vector tiles, covering
longitude 53.00–53.40 and latitude 56.70–57.00, native zoom levels 0–15. MapLibre
can render these vectors at higher zooms without downloading new tile detail.
This package does not provide satellite imagery, offline address search, or
offline route calculation.

The official Protomaps service retains only recent daily builds and selected
version releases. To reproduce this exact release after its daily source expires,
reuse the archived regional PMTiles using `--pmtiles /path/to/izhevsk.pmtiles`.
The release bundle contains that complete file as `basemap.pmtiles`. To refresh
the map, intentionally select a new published build in the script, update the
source notice, regenerate the package, and update the runtime manifest digest.
Do not point app clients at the upstream planet URL.

`--cache-dir /path/to/cache` reuses checksum-verified downloaded asset sources.
`--remove-source` deletes an explicitly supplied `--pmtiles` file only after
packing and byte-for-byte verification succeed. It avoids including both the raw
archive and the bundle in app build outputs.

## Format

1. Eight ASCII bytes: `KBMAP001`.
2. Four bytes: unsigned little-endian length of the UTF-8 JSON header.
3. JSON header: `{"version":1,"files":{"path":{"offset":0,"length":123}}}`.
4. Concatenated file payloads. Entry offsets are relative to the beginning of this
   payload, **not** to the beginning of the whole bundle.

Entries are sorted by their logical path. There are no timestamps or random IDs
in the package. A fixed regional archive and the pinned asset sources produce
the same bytes. Each embedded resource is verified before the output is replaced
atomically. Font glyph and PMTiles payloads retain their upstream encoding.

Required files are `basemap.pmtiles`, all 256 Unicode blocks for each of Noto Sans
Regular, Medium, and Italic, and `sprites/light.{json,png}` plus their `@2x`
variants. The four license/source notice files and package `README.md` are also
embedded. The complete fonts avoid missing labels at low zooms, where regional
tile extraction includes some place names outside the exact city boundary.

## Sources and attribution

- [Protomaps downloads](https://docs.protomaps.com/basemaps/downloads):
  OpenStreetMap-derived basemap distributed as an ODbL Produced Work.
  Display `© OpenStreetMap contributors` with a link to
  <https://www.openstreetmap.org/copyright>, and identify Protomaps.
- [Protomaps basemap assets](https://github.com/protomaps/basemaps-assets/tree/028c18f713baecad011301ff7a69acc39bcc2ae7),
  pinned commit `028c18f713baecad011301ff7a69acc39bcc2ae7`: Noto fonts under SIL OFL
  1.1; generation code under BSD-3-Clause. The ZIP's SHA-256 is checked before use.
- [Mapzen/tangrams icons](https://github.com/tangrams/icons/tree/92510779634f4a006c61ea70e50cb8c52c765a81):
  MIT license notice retained for derived light sprites.
- [Official offline asset instructions](https://docs.protomaps.com/basemaps/maplibre):
  style, glyphs, and sprites all need local hosting in addition to map tiles.

The bundle is public base-map data and contains no raid, team, user, or location
history records. Store it separately from authenticated application data.
