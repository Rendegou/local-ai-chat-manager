#!/usr/bin/env python3
"""生成应用图标（纯 Python，无第三方依赖），随后用 `npx tauri icon` 派生各尺寸。

设计：深色圆角方块 + 两条「对话气泡」横线 + 一个分支节点，呼应「会话 + Git 同步」。
"""

import struct
import zlib

SIZE = 512
BACKGROUND = (32, 34, 38)      # 深灰底
ACCENT = (94, 139, 240)        # 强调蓝
INK = (236, 239, 244)          # 前景文字色
OUT = "../app-icon.png"


def rounded_square_alpha(x, y, size, radius):
    """圆角矩形内部返回 1，外部返回 0（超采样在调用处做）。"""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx = x - cx
    dy = y - cy
    return 1 if dx * dx + dy * dy <= radius * radius else 0


def render():
    """渲染 512×512 图标（4× 超采样做抗锯齿）。"""
    scale = 4
    lines = []
    radius = SIZE * 0.22
    # 两条气泡横线 + 一个分支点
    bars = [
        (SIZE * 0.26, SIZE * 0.38, SIZE * 0.74, SIZE * 0.44),
        (SIZE * 0.26, SIZE * 0.56, SIZE * 0.62, SIZE * 0.62),
    ]
    dot_center = (SIZE * 0.70, SIZE * 0.66)
    dot_radius = SIZE * 0.075

    for y in range(SIZE):
        row = bytearray()
        row.append(0)  # filter type
        for x in range(SIZE):
            r = g = b = a = 0
            for sy in range(scale):
                for sx in range(scale):
                    px = x + (sx + 0.5) / scale
                    py = y + (sy + 0.5) / scale
                    if not rounded_square_alpha(px, py, SIZE, radius):
                        continue
                    color = BACKGROUND
                    for (x0, y0, x1, y1) in bars:
                        if x0 <= px <= x1 and y0 <= py <= y1:
                            color = ACCENT
                    if (px - dot_center[0]) ** 2 + (py - dot_center[1]) ** 2 <= dot_radius**2:
                        color = INK
                    r += color[0]
                    g += color[1]
                    b += color[2]
                    a += 255
            samples = scale * scale
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                # 颜色按覆盖的样本数平均，alpha 按覆盖率计算
                covered = a // 255
                row += bytes((r // covered, g // covered, b // covered, a // samples))
        lines.append(bytes(row))
    return b"".join(lines)


def write_png(path, raw):
    """把原始 RGBA 行数据写成 PNG。"""
    def chunk(tag, data):
        payload = tag + data
        return (
            struct.pack(">I", len(data))
            + payload
            + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as handle:
        handle.write(png)
    print(f"wrote {path} ({len(png)} bytes)")


if __name__ == "__main__":
    write_png(OUT, render())
