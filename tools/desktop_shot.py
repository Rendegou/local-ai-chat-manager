#!/usr/bin/env python3
"""真实桌面窗口截图（规格 §8 Phase 4：桌面端截图对比）。

浏览器截图（tools/ui_shot.mjs）覆盖排版与响应式，但真实窗口还有 WebView2、
系统 DPI 缩放、窗口最小宽度等差异，因此交付前用它再核验一遍。

要点：
- 线程级 DPI 感知（SetThreadDpiAwarenessContext）：否则 SetCursorPos 的坐标会被系统
  按虚拟化处理，点击落点全错（这是之前踩过的坑）；
- 目标尺寸按 **CSS 像素**给出，脚本按系统 DPI 换算成物理像素再设置窗口，
  这样 1440×900 就是 Web 端看到的 1440 CSS px；
- 截图用 PrintWindow(PW_RENDERFULLCONTENT)：被遮挡也能拿到内容，不依赖窗口置顶。

用法：
    python tools/desktop_shot.py --out .ui-shots/desktop
        [--sizes 1440x900,1180x800,900x700] [--exe target/release/local-ai-chat-manager.exe]
"""

import argparse
import ctypes
import io
import os
import struct
import subprocess
import sys
import time
import zlib
from ctypes import wintypes

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
shcore = ctypes.windll.shcore

# 线程级 DPI 感知（必须在任何坐标操作之前设置）
try:
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)
    user32.SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
except Exception:  # pragma: no cover - 老系统没有该 API 时退化为物理像素
    pass

PW_RENDERFULLCONTENT = 0x00000002
SWP_NOZORDER = 0x0004
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_SHOWWINDOW = 0x0040
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


def window_scale(hwnd):
    """窗口所在显示器的 DPI 缩放比（150% → 1.5）。

    必须用 GetDpiForWindow 而不是 GetDpiForSystem：WebView2 按**窗口所在显示器**的 DPI
    做缩放，用系统 DPI 会在多显示器或非 100% 缩放下算错 CSS 视口大小
    （踩过一次：按 1.0 换算，1440 的窗口实际只有约 975 CSS px，布局落到了更窄的断点）。
    """
    try:
        dpi = user32.GetDpiForWindow(hwnd)
        if dpi:
            return dpi / 96.0
    except Exception:
        pass
    try:
        return shcore.GetDpiForSystem() / 96.0
    except Exception:
        return 1.0


def find_window(process_name):
    """按进程名找到主窗口句柄。"""
    result = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value and user32.IsWindowVisible(hwnd):
            try:
                output = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid.value}", "/FO", "CSV", "/NH"],
                    capture_output=True, text=True, creationflags=0x08000000,
                ).stdout
            except Exception:
                output = ""
            if process_name.lower() in output.lower():
                result.append(hwnd)
                return False
        return True

    user32.EnumWindows(callback, 0)
    return result[0] if result else None


def set_client_size(hwnd, css_width, css_height, scale):
    """把客户区设置成给定的 CSS 尺寸（换算为物理像素，并补上窗口边框）。"""
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    client = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(client))
    frame_w = (rect.right - rect.left) - client.right
    frame_h = (rect.bottom - rect.top) - client.bottom
    width = int(round(css_width * scale)) + frame_w
    height = int(round(css_height * scale)) + frame_h
    user32.SetWindowPos(hwnd, 0, 0, 0, width, height, SWP_NOZORDER | SWP_SHOWWINDOW)
    time.sleep(0.6)
    return width, height


kernel32 = ctypes.windll.kernel32


def raise_window(hwnd):
    """把窗口真正带到最前，并确认「光标下就是它」。

    合成点击（mouse_event）交给光标位置最上层的窗口，所以必须先确保目标窗口在上面。
    SetForegroundWindow 对后台进程有限制，这里用 AttachThreadInput 绕过：
    把自己的线程挂到当前前台窗口的输入队列上，再设置前台窗口。
    返回是否成功（用 WindowFromPoint 验证，而不是假定）。
    """
    foreground = user32.GetForegroundWindow()
    if foreground != hwnd:
        target_thread = user32.GetWindowThreadProcessId(foreground, None)
        current_thread = kernel32.GetCurrentThreadId()
        user32.AttachThreadInput(current_thread, target_thread, True)
        user32.SetForegroundWindow(hwnd)
        user32.BringWindowToTop(hwnd)
        user32.AttachThreadInput(current_thread, target_thread, False)
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
    time.sleep(0.5)
    # 验证：光标移到窗口内后，最上层窗口是否就是它
    origin = wintypes.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    probe = wintypes.POINT(origin.x + 40, origin.y + 20)
    user32.SetCursorPos(probe.x, probe.y)
    time.sleep(0.2)
    return user32.WindowFromPoint(probe) == hwnd


def click(hwnd, css_x, css_y, scale):
    """在窗口客户区的给定 CSS 坐标点击（换算成物理屏幕坐标）。

    mouse_event 是合成输入，会交给**光标所在位置最上层**的窗口 ——
    所以点击前必须把目标窗口临时置顶，否则点会被别的窗口（例如编辑器）吃掉。
    """
    if not raise_window(hwnd):
        print("    （提示：无法把窗口置于最前，点击可能被其它窗口接收）")
    origin = wintypes.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    x = origin.x + int(round(css_x * scale))
    y = origin.y + int(round(css_y * scale))
    user32.SetCursorPos(x, y)
    time.sleep(0.2)
    user32.mouse_event(0x0002, 0, 0, 0, 0)  # 左键按下
    user32.mouse_event(0x0004, 0, 0, 0, 0)  # 左键抬起
    time.sleep(0.8)
    user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
    time.sleep(0.2)


def capture(hwnd, path):
    """用 PrintWindow 抓取窗口内容并写成 PNG。"""
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    width = rect.right - rect.left
    height = rect.bottom - rect.top

    window_dc = user32.GetWindowDC(hwnd)
    mem_dc = gdi32.CreateCompatibleDC(window_dc)
    bitmap = gdi32.CreateCompatibleBitmap(window_dc, width, height)
    gdi32.SelectObject(mem_dc, bitmap)
    user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)

    header = BITMAPINFOHEADER()
    header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    header.biWidth = width
    header.biHeight = -height  # 负数：自上而下
    header.biPlanes = 1
    header.biBitCount = 32
    header.biCompression = 0

    buffer_size = width * height * 4
    buffer = ctypes.create_string_buffer(buffer_size)
    gdi32.GetDIBits(mem_dc, bitmap, 0, height, buffer, ctypes.byref(header), 0)

    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(hwnd, window_dc)

    # BGRA → RGBA，并写入 PNG
    pixels = bytearray(buffer.raw)
    pixels[0::4], pixels[2::4] = pixels[2::4], pixels[0::4]
    raw = b"".join(
        b"\x00" + bytes(pixels[row * width * 4 : (row + 1) * width * 4]) for row in range(height)
    )

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    io.open(path, "wb").write(png)
    return width, height


def main():
    parser = argparse.ArgumentParser(description="真实桌面窗口截图")
    parser.add_argument("--out", default=".ui-shots/desktop")
    parser.add_argument("--sizes", default="1440x900,1180x800,900x700")
    # 可选：窄窗口下点开抽屉 / 进入两级视图的点击坐标（CSS 像素，可用浏览器量出同一布局的按钮中心）
    parser.add_argument("--drawer-at", default=None, help="筛选按钮坐标，例如 1054,26")
    parser.add_argument("--detail-at", default=None, help="会话行坐标，例如 450,151")
    parser.add_argument("--exe", default="target/release/local-ai-chat-manager.exe")
    args = parser.parse_args()

    exe = os.path.abspath(args.exe)
    if not os.path.isfile(exe):
        print(f"找不到可执行文件：{exe}")
        return 1

    process = subprocess.Popen([exe], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    hwnd = None
    for _ in range(40):
        time.sleep(0.5)
        hwnd = find_window("local-ai-chat-manager")
        if hwnd:
            break
    if not hwnd:
        process.terminate()
        print("未能找到应用窗口")
        return 1

    # 缩放比要在拿到窗口之后才能问（按窗口所在显示器）
    scale = window_scale(hwnd)
    print(f"窗口 DPI 缩放：{scale:.2f}")

    # 等首屏索引与渲染完成（真实内核会扫描演示数据）
    time.sleep(6)

    shots = []
    try:
        for size in args.sizes.split(","):
            css_w, css_h = (int(v) for v in size.split("x"))
            set_client_size(hwnd, css_w, css_h, scale)
            name = f"conversations-{size}.png"
            w, h = capture(hwnd, os.path.join(args.out, name))
            shots.append((name, w, h, css_w, css_h))
            print(f"  已截图 {name}（物理 {w}×{h} ≈ CSS {w/scale:.0f}×{h/scale:.0f}）")

            # 窄窗口：点开工具栏「筛选」抽屉并截图（验证抽屉不是浏览器专属）
            if args.drawer_at and css_w < 1280:
                x, y = (int(v) for v in args.drawer_at.split(","))
                click(hwnd, x, y, scale)
                time.sleep(0.9)
                name = f"drawer-{size}.png"
                w, h = capture(hwnd, os.path.join(args.out, name))
                shots.append((name, w, h, css_w, css_h))
                print(f"  已截图 {name}")
                # 关掉抽屉，避免影响后续尺寸
                click(hwnd, x, y, scale)
                time.sleep(0.6)

            # 两级视图：点一条会话，验证「列表 → 详情 → 返回」
            if args.detail_at and css_w < 1024:
                x, y = (int(v) for v in args.detail_at.split(","))
                click(hwnd, x, y, scale)
                time.sleep(0.9)
                name = f"detail-{size}.png"
                w, h = capture(hwnd, os.path.join(args.out, name))
                shots.append((name, w, h, css_w, css_h))
                print(f"  已截图 {name}")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except Exception:
            process.kill()

    print(f"共 {len(shots)} 张 → {os.path.abspath(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
