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
    "meter-storage.js",
    "meter-proxy.js",
    "meter-cli-launcher.js",
    "meter-context-unlock.js",
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
    {"name": "windows_amd64", "scripts": ["install.bat", "uninstall.bat", "scripts/cli-window-helper.exe"]},
    {"name": "windows_arm64", "scripts": ["install.bat", "uninstall.bat", "scripts/cli-window-helper.exe"]},
    {"name": "darwin_amd64", "scripts": ["install.sh", "uninstall.sh"]},
    {"name": "darwin_arm64", "scripts": ["install.sh", "uninstall.sh"]},
    {"name": "linux_amd64", "scripts": ["install.sh", "uninstall.sh"]},
    {"name": "linux_arm64", "scripts": ["install.sh", "uninstall.sh"]},
]

def ensure_windows_helper():
    helper_path = ROOT_DIR / "scripts" / "cli-window-helper.exe"
    cs_src = ROOT_DIR / "scripts" / "cli-window-helper.cs"
    if helper_path.exists() and helper_path.stat().st_size > 0:
        return True

    print("[Packaging] 缺少预编译的 scripts/cli-window-helper.exe，尝试调用系统 C# 编译器自动构建...")
    csc_candidates = [
        Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
        Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe")
    ]
    csc_exe = None
    for cand in csc_candidates:
        if cand.exists():
            csc_exe = str(cand)
            break

    if not csc_exe:
        import shutil
        csc_exe = shutil.which("csc")

    if csc_exe and cs_src.exists():
        import subprocess
        try:
            cmd = [
                csc_exe,
                "/nologo",
                "/target:exe",
                "/platform:anycpu",
                "/optimize+",
                f"/out:{helper_path}",
                str(cs_src)
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and helper_path.exists():
                print(f"[Packaging] scripts/cli-window-helper.exe 自动构建成功 ({helper_path.stat().st_size} bytes)")
                return True
            else:
                print(f"[Packaging Error] 编译失败: {res.stderr or res.stdout}")
        except Exception as e:
            print(f"[Packaging Error] 调用 csc 异常: {e}")

    raise RuntimeError(
        "缺少必需的 Windows 原生组件 scripts/cli-window-helper.exe，且无法自动编译！\n"
        "请先执行 C# 编译: csc /target:exe /platform:anycpu /optimize+ /out:scripts/cli-window-helper.exe scripts/cli-window-helper.cs\n"
        "拒绝打包功能残缺的发布包！"
    )

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
    return data.get("version", "0.8.1")

def build_releases():
    import subprocess
    ensure_windows_helper()
    print("[Packaging] Building latest meter-renderer.js from src/renderer/...")
    subprocess.run(["node", str(ROOT_DIR / "scripts" / "build-renderer.js")], check=True)
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
