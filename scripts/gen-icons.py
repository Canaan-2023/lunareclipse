# -*- coding: utf-8 -*-
"""LunarEclipse 应用图标生成器（月蚀角色图标版）

源图：`app/assets/brand/lunar-eclipse-icon.png`（2048/1024 方形，圆形角色画，圆外已透明）。
为什么改成从源图派生：旧版图标由本脚本用几何图元现画（弦月 + 蚀影），设计语言与
月蚀现在的立绘无关；0.53.11 起品牌视觉统一为白发紫瞳角色 + 黑猫，图标必须与立绘同源，
否则任务栏图标、窗口图标和登录页会各是一套脸。

输出：`app/build/icon-{16,24,32,48,64,128,256,512,1024}.png` + `app/build/icon.ico`
（ICO 内含 16~256 多尺寸；Windows 任务栏/资源管理器按 DPI 自选）。
"""
import os
from PIL import Image

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "brand", "lunar-eclipse-icon.png")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def build_icon():
    if not os.path.exists(SRC):
        raise SystemExit(f"缺少图标源图：{SRC}")
    os.makedirs(OUT_DIR, exist_ok=True)
    src = Image.open(SRC).convert("RGBA")
    if src.width != src.height:
        side = max(src.width, src.height)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.alpha_composite(src, ((side - src.width) // 2, (side - src.height) // 2))
        src = canvas

    png_paths = {}
    for size in PNG_SIZES:
        im = src if size == src.width else src.resize((size, size), Image.Resampling.LANCZOS)
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        im.save(path, "PNG", optimize=True)
        png_paths[size] = path

    ico_path = os.path.join(OUT_DIR, "icon.ico")
    # 以 256 为主图，PIL 会按 sizes 写入多帧；不要从 1024 直接存 ICO（部分 Windows 版本只读首帧）
    src.resize((256, 256), Image.Resampling.LANCZOS).save(
        ico_path, format="ICO", sizes=[(s, s) for s in ICO_SIZES]
    )
    return ico_path, png_paths


if __name__ == "__main__":
    ico, pngs = build_icon()
    print("ICO:", ico, os.path.getsize(ico))
    for s, p in sorted(pngs.items()):
        print(f"PNG-{s}:", p, os.path.getsize(p))
