#!/usr/bin/env python3
"""从清华 TUNA 镜像安装 MinGW-w64 工具链（无需管理员权限）。

本机原本没有 C 编译器与链接器，Rust 无法编译任何东西（连 proc-macro 都链接不了）。
本脚本只做一件事：解析 MSYS2 包依赖，下载并解包到指定前缀目录。

用法：
    python tools/install_mingw.py [目标目录，默认 C:/Users/<user>/tools/mingw64]
"""

import io
import json
import os
import subprocess
import sys
import tarfile
import urllib.request

MIRROR = "https://mirrors.tuna.tsinghua.edu.cn/msys2/mingw/mingw64"
ROOT_PACKAGES = ["mingw-w64-x86_64-gcc"]
# 用于解包 .pkg.tar.zst：Windows 自带的 bsdtar 支持 zstd
BSDTAR = r"C:\Windows\System32\tar.exe"


def fetch(url, dest):
    """下载文件（带简单重试）。"""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=120) as response, open(dest, "wb") as out:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
            return True
        except Exception as exc:  # noqa: BLE001 - 网络问题统一重试
            print(f"  重试 {attempt + 1}/3：{exc}")
    return False


def load_db(workdir):
    """下载并解析 MSYS2 包数据库。

    MSYS2 的 `.db` 是 **zstd 压缩的 tar**，Python 3.8 无法直接解压，
    因此先用 Windows 自带的 bsdtar 解包成目录，再逐个读取 `desc` 文件。
    """
    db_path = os.path.join(workdir, "mingw64.db")
    if not os.path.exists(db_path):
        print("下载包数据库 mingw64.db …")
        if not fetch(f"{MIRROR}/mingw64.db", db_path):
            raise SystemExit("包数据库下载失败")
    db_dir = os.path.join(workdir, "db")
    if not os.path.isdir(db_dir):
        os.makedirs(db_dir, exist_ok=True)
        result = subprocess.run(
            [BSDTAR, "-xf", db_path, "-C", db_dir], capture_output=True, text=True
        )
        if result.returncode != 0:
            raise SystemExit(f"包数据库解包失败：{result.stderr}")

    packages = {}
    for entry in os.listdir(db_dir):
        desc_path = os.path.join(db_dir, entry, "desc")
        if not os.path.isfile(desc_path):
            continue
        with io.open(desc_path, encoding="utf-8", errors="replace") as handle:
            data = handle.read()
        fields, key = {}, None
        for line in data.splitlines():
            if line.startswith("%") and line.endswith("%"):
                key = line[1:-1]
                fields.setdefault(key, [])
            elif key:
                fields[key].append(line)
        name = (fields.get("NAME") or [""])[0].strip()
        version = (fields.get("VERSION") or [""])[0].strip()
        filename = (fields.get("FILENAME") or [""])[0].strip()
        depends = []
        for dep in fields.get("DEPENDS", []):
            depends.extend(part.strip() for part in dep.split() if part.strip())
        if name and filename:
            packages[name] = {
                "version": version,
                "filename": filename,
                # 去掉版本约束，只保留包名
                "depends": [d.split("=")[0].split(">")[0].split("<")[0] for d in depends],
            }
    print(f"包数据库：{len(packages)} 个包")
    return packages


def resolve(packages, roots):
    """计算依赖闭包。"""
    needed, queue = set(), list(roots)
    while queue:
        name = queue.pop()
        if name in needed:
            continue
        info = packages.get(name)
        if info is None:
            print(f"  跳过未知依赖：{name}")
            continue
        needed.add(name)
        queue.extend(info["depends"])
    return sorted(needed)


def main():
    prefix = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.expanduser("~"), "tools", "mingw64"
    )
    workdir = os.path.join(prefix, "_pkgs")
    os.makedirs(workdir, exist_ok=True)
    packages = load_db(workdir)
    needed = resolve(packages, ROOT_PACKAGES)
    total = 0
    print(f"需要 {len(needed)} 个包，解包到 {prefix}")
    for name in needed:
        info = packages[name]
        archive = os.path.join(workdir, info["filename"])
        if not os.path.exists(archive):
            url = f"{MIRROR}/{info['filename']}"
            print(f"  下载 {info['filename']} ({info['version']})")
            if not fetch(url, archive):
                raise SystemExit(f"下载失败：{url}")
        total += os.path.getsize(archive)
        # 用 bsdtar 解包（支持 zstd），保持 MSYS2 的 mingw64/ 前缀结构
        result = subprocess.run(
            [BSDTAR, "-xf", archive, "-C", prefix], capture_output=True, text=True
        )
        if result.returncode != 0:
            raise SystemExit(f"解包失败 {info['filename']}: {result.stderr}")
    print(f"完成：{len(needed)} 个包，共 {total / 1024 / 1024:.1f} MB")
    print(f"工具链位置：{os.path.join(prefix, 'mingw64', 'bin')}")


if __name__ == "__main__":
    main()
