#!/usr/bin/env python3
"""Build Kabanda's self-contained Izhevsk vector basemap from official sources.

Requires Python 3, curl, and the official go-pmtiles CLI v1.31.2. The regional
extraction uses HTTP range requests; it does not download the planet archive.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import zipfile


MAGIC = b"KBMAP001"
DAY = "20260923"
BOUNDS = [53.0, 56.7, 53.4, 57.0]
PLANET_URL = f"https://build.protomaps.com/{DAY}.pmtiles"
ASSET_COMMIT = "028c18f713baecad011301ff7a69acc39bcc2ae7"
ASSET_ZIP = f"basemaps-assets-{ASSET_COMMIT}.zip"
ASSET_URL = f"https://codeload.github.com/protomaps/basemaps-assets/zip/{ASSET_COMMIT}"
ASSET_SHA256 = "e942a417d94a12596842a20b53d6b785cbf6d47f2545e458538191ba6d74b305"
ICON_COMMIT = "92510779634f4a006c61ea70e50cb8c52c765a81"
ICON_LICENSE_URL = (
    f"https://raw.githubusercontent.com/tangrams/icons/{ICON_COMMIT}/LICENSE.md"
)
ICON_LICENSE_SHA256 = "46d0ca73c10d7366ef7bf3932d8508267096393ccc9ef3a41d1b1d1fe37023f1"
FONTSTACKS = ("Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic")
SPRITES = ("light.json", "light.png", "light@2x.json", "light@2x.png")
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / f"apps/pwa/src/features/offline-map/assets/izhevsk-{DAY}.kmap"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(url: str, destination: Path, expected_sha256: str) -> bytes:
    """Reuse verified downloads, with one bounded HTTPS request per asset source."""
    if not destination.exists():
        pending = destination.with_suffix(destination.suffix + ".partial")
        try:
            subprocess.run(
                [
                    "curl", "--fail", "--silent", "--show-error", "--location",
                    "--proto", "=https", "--max-time", "120", "--retry", "2",
                    "--max-filesize", "20000000", "--output", str(pending), url,
                ],
                check=True,
            )
            pending.replace(destination)
        finally:
            pending.unlink(missing_ok=True)
    data = destination.read_bytes()
    actual = sha256(data)
    if actual != expected_sha256:
        raise ValueError(f"Checksum mismatch for {destination}: {actual}")
    return data


def check_pmtiles(cli: str, path: Path) -> dict:
    subprocess.run([cli, "verify", str(path)], check=True)
    header = json.loads(subprocess.check_output([cli, "show", str(path), "--header-json"]))
    if (
        header.get("tile_type") != "mvt"
        or header.get("tile_compression") != "gzip"
        or header.get("minzoom") != 0
        or header.get("maxzoom") != 15
        or header.get("bounds") != BOUNDS
    ):
        raise ValueError(f"Unexpected regional PMTiles header: {header}")
    return header


def source_notice(tile_hash: str) -> bytes:
    return f"""# Kabanda offline basemap: Izhevsk

Basemap attribution: © OpenStreetMap contributors. Cartography/data processing:
Protomaps. Display attribution on the map, with these links:
https://www.openstreetmap.org/copyright
https://protomaps.com/

Data: Protomaps daily basemap {DAY}, v4.15.2, OpenStreetMap-derived ODbL Produced
Work. Upstream archive: {PLANET_URL}
Regional bounds (west,south,east,north): 53.00,56.70,53.40,57.00.
Native zoom levels: 0–15 inclusive. Higher map zooms reuse the vector geometry;
they do not contain additional source detail. This is a road-map basemap, not
satellite imagery, offline geocoding, or an offline routing engine.
Regional basemap.pmtiles SHA-256: {tile_hash}
Documentation: https://docs.protomaps.com/basemaps/downloads
Open Data Commons Open Database License: https://opendatacommons.org/licenses/odbl/1-0/

Font and sprite source:
https://github.com/protomaps/basemaps-assets/tree/{ASSET_COMMIT}
Three unmodified font stacks: Noto Sans Regular, Medium, Italic; all 256 PBF
Unicode blocks (0–65535). SIL Open Font License 1.1: licenses/Noto-OFL.txt.
Light v4 sprites, normal and retina resolution. Icons derived from tangrams/icons:
https://github.com/tangrams/icons/tree/{ICON_COMMIT}
MIT license: licenses/tangrams-icons-MIT.txt.
Asset generation code notice: licenses/protomaps-BSD-3-Clause.txt.
Unmodified upstream source notes: licenses/basemaps-assets-README.md.

Reproduction: infra/maps/build_city_bundle.py, using official go-pmtiles v1.31.2.
The regional archive is extracted with HTTP range requests. No public raster tile
service is scraped or bulk downloaded. Serve this bundle from Kabanda's origin;
do not hotlink the Protomaps build endpoint from app sessions.
""".encode("utf-8")


def build_files(pmtiles: Path, asset_zip: Path, icon_license: bytes) -> dict[str, bytes]:
    tiles = pmtiles.read_bytes()
    if not tiles.startswith(b"PMTiles\x03"):
        raise ValueError("Expected PMTiles version 3")
    files = {"basemap.pmtiles": tiles, "README.md": source_notice(sha256(tiles))}
    prefix = f"basemaps-assets-{ASSET_COMMIT}/"
    with zipfile.ZipFile(asset_zip) as archive:
        # Read selected exact entries without extracting arbitrary archive paths.
        for font in FONTSTACKS:
            for start in range(0, 65536, 256):
                name = f"fonts/{font}/{start}-{start + 255}.pbf"
                files[name] = archive.read(prefix + name)
        for sprite in SPRITES:
            files[f"sprites/{sprite}"] = archive.read(prefix + f"sprites/v4/{sprite}")
        for logical, upstream in (
            ("licenses/Noto-OFL.txt", "fonts/OFL.txt"),
            ("licenses/protomaps-BSD-3-Clause.txt", "scripts/LICENSE.md"),
            ("licenses/basemaps-assets-README.md", "README.md"),
        ):
            files[logical] = archive.read(prefix + upstream)
    files["licenses/tangrams-icons-MIT.txt"] = icon_license
    return files


def write_bundle(files: dict[str, bytes], destination: Path) -> dict:
    entries = {}
    offset = 0
    for name in sorted(files):
        entries[name] = {"offset": offset, "length": len(files[name])}
        offset += len(files[name])
    header = json.dumps(
        {"version": 1, "files": entries}, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    destination.parent.mkdir(parents=True, exist_ok=True)
    pending = destination.with_suffix(destination.suffix + ".partial")
    try:
        with pending.open("wb") as output:
            output.write(MAGIC)
            output.write(struct.pack("<I", len(header)))
            output.write(header)
            for name in entries:
                output.write(files[name])
        # Verify every byte range before exposing the completed asset.
        packed = pending.read_bytes()
        parsed_length = struct.unpack("<I", packed[8:12])[0]
        parsed = json.loads(packed[12:12 + parsed_length])
        payload = 12 + parsed_length
        if packed[:8] != MAGIC or parsed != {"version": 1, "files": entries}:
            raise ValueError("Invalid bundle header")
        if len(packed) != payload + offset:
            raise ValueError("Invalid bundle size")
        for name, entry in parsed["files"].items():
            start = payload + entry["offset"]
            if packed[start:start + entry["length"]] != files[name]:
                raise ValueError(f"Bundle verification failed: {name}")
        pending.replace(destination)
    finally:
        pending.unlink(missing_ok=True)
    return {
        "path": str(destination), "bytes": len(packed), "sha256": sha256(packed),
        "files": len(entries), "headerBytes": len(header),
        "pmtilesBytes": len(files["basemap.pmtiles"]),
        "pmtilesSha256": sha256(files["basemap.pmtiles"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pmtiles-cli", default=shutil.which("pmtiles"))
    parser.add_argument("--pmtiles", type=Path, help="Reuse an already extracted city archive")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--cache-dir", type=Path, help="Reuse checksum-verified upstream assets")
    parser.add_argument("--remove-source", action="store_true", help="Remove --pmtiles only after successful packing")
    args = parser.parse_args()
    if not args.pmtiles_cli:
        parser.error("Install go-pmtiles v1.31.2 or supply --pmtiles-cli")
    if args.remove_source and not args.pmtiles:
        parser.error("--remove-source requires --pmtiles")
    with tempfile.TemporaryDirectory(prefix="kabanda-city-bundle-") as temporary:
        temporary_path = Path(temporary)
        cache = args.cache_dir or temporary_path
        cache.mkdir(parents=True, exist_ok=True)
        tiles = args.pmtiles or temporary_path / f"izhevsk-{DAY}.pmtiles"
        if not args.pmtiles:
            subprocess.run(
                [args.pmtiles_cli, "extract", PLANET_URL, str(tiles),
                 "--bbox=53.00,56.70,53.40,57.00", "--maxzoom=15", "--download-threads=4"],
                check=True,
            )
        pmtiles_header = check_pmtiles(args.pmtiles_cli, tiles)
        download(ASSET_URL, cache / ASSET_ZIP, ASSET_SHA256)
        icon_license = download(
            ICON_LICENSE_URL, cache / "tangrams-icons-LICENSE.md", ICON_LICENSE_SHA256
        )
        result = write_bundle(build_files(tiles, cache / ASSET_ZIP, icon_license), args.output)
        result["pmtilesHeader"] = pmtiles_header
        print(json.dumps(result, indent=2))
        if args.remove_source:
            tiles.unlink()


if __name__ == "__main__":
    main()
