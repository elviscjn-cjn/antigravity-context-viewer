#!/usr/bin/env python3
"""
Cross-Platform Release Packager for Antigravity Context & Token Viewer
Builds OS-specific zip bundles and generates checksums.txt matching the standard GitHub Release asset layout.
"""

import os
import sys
import json
import zipfile
import hashlib
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT_DIR / "dist" / "release"

COMMON_FILES = [
    "cli.js",
    "install.js",
    "restore.js",
    "live-host.js",
    "local-api.js",
    "meter-main.js",
    "meter-core.js",
    "meter-renderer.js",
    "meter-collector.js",
    "attachment_scan.py",
    "asar-engine.js",
    "package.json",
    "README.md",
    "README.en.md",
    "README.ja.md",
    "README.ko.md",
    "README.es.md",
    "AGENTS.md",
    "LICENSE",
]

PLATFORMS = [
    {"name": "windows_amd64", "scripts": ["install.bat", "uninstall.bat"]},
    {"name": "windows_arm64", "scripts": ["install.bat", "uninstall.bat"]},
    {"name": "darwin_amd64", "scripts": ["install.sh", "uninstall.sh"]},
    {"name": "darwin_arm64", "scripts": ["install.sh", "uninstall.sh"]},
    {"name": "linux_amd64", "scripts": ["install.sh", "uninstall.sh"]},
    {"name": "linux_arm64", "scripts": ["install.sh", "uninstall.sh"]},
]

def sha256_file(filepath: Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()

def get_version() -> str:
    pkg_json = ROOT_DIR / "package.json"
    with open(pkg_json, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("version", "2.7.0")

def build_releases():
    version = get_version()
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    
    # Clean previous zip files in dist/release
    for old in DIST_DIR.glob("*.zip"):
        old.unlink()
    checksum_file = DIST_DIR / "checksums.txt"
    if checksum_file.exists():
        checksum_file.unlink()

    print(f"[Packaging] Antigravity Context Viewer v{version} for 6 target platforms...")
    created_packages = []

    for plat in PLATFORMS:
        plat_name = plat["name"]
        zip_filename = f"antigravity-context-viewer_{version}_{plat_name}.zip"
        zip_path = DIST_DIR / zip_filename
        
        file_list = COMMON_FILES + plat["scripts"]
        
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for rel in file_list:
                src_path = ROOT_DIR / rel
                if not src_path.exists():
                    print(f"[Warn] File not found: {rel}")
                    continue
                
                # Normalize line endings: CRLF for .bat, LF for .sh
                if rel.endswith(".sh"):
                    content = src_path.read_bytes().replace(b"\r\n", b"\n")
                    zinfo = zipfile.ZipInfo(rel)
                    zinfo.external_attr = 0o755 << 16  # rwxr-xr-x
                    zf.writestr(zinfo, content)
                elif rel.endswith(".bat"):
                    content = src_path.read_bytes()
                    zinfo = zipfile.ZipInfo(rel)
                    zf.writestr(zinfo, content)
                else:
                    zf.write(src_path, arcname=rel)
        
        size_kb = zip_path.stat().st_size / 1024
        print(f"  + Created {zip_filename} ({size_kb:.1f} KB)")
        created_packages.append(zip_path)

    # Generate checksums.txt
    print("[Checksums] Generating checksums.txt...")
    lines = []
    for pkg in created_packages:
        csum = sha256_file(pkg)
        lines.append(f"{csum}  {pkg.name}")
    
    checksum_content = "\n".join(lines) + "\n"
    checksum_file.write_text(checksum_content, encoding="utf-8")
    print(f"  + checksums.txt generated ({len(lines)} entries)\n")
    print("[Done] All release packages successfully built in:", DIST_DIR)

if __name__ == "__main__":
    build_releases()
