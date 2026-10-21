# -*- coding: utf-8 -*-
"""LunarEclipse 应用图标生成器（弦月蚀 · 圆构成版）

设计概念（保持简洁）：
- 透明背景，无金环、无星野、无外悬弧光
- 完整圆盘由「月亮亮面」与「蚀影」合体构成：
  - 白色月亮盘（略带径向明暗，微球面感）为底层，整体中心偏【右下】；
  - 深色蚀影圆从【左上】覆盖月亮盘（盖住左半与上下极区），
    右下方露出一道自然收尖的白色【标准弦月】（内外双弧，两端收尖）；
  - 黑白两色合起来恰好是一个【完整正圆】，「月亮 + 蚀影 = 一个圆」，
    盘面外轮廓以 mask 恒定为正圆、左右对称，仅亮面偏心右下。
- 盘缘一圈极细微亮环（大尺寸可见，缩小时淡出），深色背景下圆盘轮廓依然可辨
- 缩到 16px 依然可辨：右下白弦月 + 左上黑影

输出：多尺寸 PNG + build/icon.ico
"""
import os
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = SIZE * 4  # 4x 超采样抗锯齿
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
os.makedirs(OUT_DIR, exist_ok=True)

# ---- 颜色 ----
MOON_CORE = (255, 255, 255)    # 月亮亮面中心（纯白）
MOON_EDGE = (176, 186, 205)    # 月亮亮面边缘（冷灰白，受光衰减）
SHADOW_CORE = (7, 8, 13)       # 蚀影中心（近纯黑）
SHADOW_EDGE = (27, 32, 44)     # 蚀影边缘（极轻微提亮，避免浅底死黑）
RIM_LIGHT = (200, 212, 235)    # 盘缘微亮环（深色背景保轮廓）

# ---- 几何参数（1024 设计坐标）----
CX, CY = SIZE / 2, SIZE / 2
R_OUT = 430                    # 整体圆盘半径（mask，最终轮廓；恒定正圆左右对称）
R_MOON = 415                   # 白色月亮盘半径
MOON_DX, MOON_DY = 70, 70      # 月亮盘中心向右下偏移 → 亮面主体偏右下
R_SHADOW = 455                 # 蚀影圆半径（须大于月亮盘以盖住极区）
SHADOW_DX, SHADOW_DY = 160, 160  # 蚀影圆心相对月亮盘再向左上偏移 → 右下标准弦月
RIM_W = 4                      # 盘缘微亮环宽度


def build_icon():
    S = SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    def pt(v):
        return round(v * S / SIZE)

    cx, cy = pt(CX), pt(CY)

    # ---- 1. 白色月亮盘（径向渐变：中心纯白 → 边缘冷灰白；中心偏右下）----
    moon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mr = pt(R_MOON)
    mx = cx + pt(MOON_DX)
    my = cy + pt(MOON_DY)
    for r in range(mr, 0, -8):
        t = 1 - r / mr
        col = tuple(int(MOON_CORE[i] + (MOON_EDGE[i] - MOON_CORE[i]) * (t ** 1.6)) for i in range(3))
        ImageDraw.Draw(moon).ellipse(
            [mx - r, my - r, mx + r, my + r], fill=col + (255,))
    moon = moon.filter(ImageFilter.GaussianBlur(pt(0.9)))  # 轻微柔边（抗锯齿）

    # ---- 2. 深色蚀影圆（径向渐变，从左上覆盖月亮盘）----
    earth = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    er = pt(R_SHADOW)
    ex = mx - pt(SHADOW_DX)
    ey = my - pt(SHADOW_DY)
    for r in range(er, 0, -8):
        t = 1 - r / er
        col = tuple(int(SHADOW_CORE[i] + (SHADOW_EDGE[i] - SHADOW_CORE[i]) * (t ** 2)) for i in range(3))
        ImageDraw.Draw(earth).ellipse(
            [ex - r, ey - r, ex + r, ey + r], fill=col + (255,))
    earth = earth.filter(ImageFilter.GaussianBlur(pt(1.1)))  # 蚀影边缘轻微柔化

    img.alpha_composite(moon)
    img.alpha_composite(earth)

    # ---- 3. 圆盘 mask（黑白合体 → 完整正圆轮廓）----
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).ellipse(
        [cx - pt(R_OUT), cy - pt(R_OUT), cx + pt(R_OUT), cy + pt(R_OUT)], fill=255)
    img = Image.composite(img, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask)

    # ---- 4. 盘缘微亮环（大尺寸可见，缩小自动淡出）----
    rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    rim_mask = Image.new("L", (S, S), 0)
    rd = ImageDraw.Draw(rim_mask)
    rd.ellipse([cx - pt(R_OUT), cy - pt(R_OUT), cx + pt(R_OUT), cy + pt(R_OUT)], fill=255)
    rd.ellipse([cx - pt(R_OUT - RIM_W), cy - pt(R_OUT - RIM_W),
                cx + pt(R_OUT - RIM_W), cy + pt(R_OUT - RIM_W)], fill=0)
    rim_mask = rim_mask.filter(ImageFilter.GaussianBlur(pt(1.0)))
    rim.paste(RIM_LIGHT + (70,), (0, 0), rim_mask)
    img.alpha_composite(rim)

    # ---- 5. 弦月辉光：整体淡淡外溢（缩小时保留光感）----
    glow_mask = mask.filter(ImageFilter.GaussianBlur(pt(14)))
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    glow.paste((200, 215, 245, 22), (0, 0), glow_mask)
    img.alpha_composite(glow)

    # ---- 6. 压缩回目标尺寸 ----
    img = img.resize((SIZE, SIZE), Image.Resampling.LANCZOS)

    sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    png_paths = {}
    for s in sizes:
        im = img if s == SIZE else img.resize((s, s), Image.Resampling.LANCZOS)
        p = os.path.join(OUT_DIR, f"icon-{s}.png")
        im.save(p, "PNG")
        png_paths[s] = p

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_path = os.path.join(OUT_DIR, "icon.ico")
    img.save(ico_path, format="ICO", sizes=[(s, s) for s in ico_sizes])
    return ico_path, png_paths


if __name__ == "__main__":
    ico, pngs = build_icon()
    print("ICO:", ico, os.path.getsize(ico))
    for s, p in sorted(pngs.items()):
        print(f"PNG-{s}:", p, os.path.getsize(p))
