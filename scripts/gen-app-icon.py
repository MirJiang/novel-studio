"""生成 Novel Studio 应用图标：纯色墨青圆角方底 + 扁平白色书本（负空间页线）。

不用渐变/不用紫蓝——克制、扁平，像系统原生应用图标。
生成根目录 app-icon.png（pnpm tauri icon 的源图）和 src/assets/app-icon.png（标题栏品牌图）。
"""
from PIL import Image, ImageDraw

S = 1024
SS = 4  # 超采样抗锯齿
W = S * SS

BG = (11, 110, 99)       # 墨青（应用主色）
COVER = (8, 84, 75)      # 深一档墨青：封面剪影（扁平层次感）
PAGE = (250, 252, 251)   # 书页白

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, W, W], radius=int(W * 0.22), fill=BG + (255,))


def P(x, y):
    return (x * W, y * W)


# ---------- 打开的书 ----------
# 封面剪影（比书页大一圈，深一档纯色）
d.polygon(
    [P(0.155, 0.335), P(0.5, 0.415), P(0.845, 0.335),
     P(0.845, 0.705), P(0.5, 0.785), P(0.155, 0.705)],
    fill=COVER + (255,),
)
# 左页 / 右页（纯白扁平）
d.polygon([P(0.20, 0.36), P(0.487, 0.435), P(0.487, 0.745), P(0.20, 0.665)], fill=PAGE + (255,))
d.polygon([P(0.80, 0.36), P(0.513, 0.435), P(0.513, 0.745), P(0.80, 0.665)], fill=PAGE + (255,))

# 页内横线：负空间（用底色切出书页上的行线）
lw = int(W * 0.013)
for frac in (0.475, 0.54, 0.605):
    dy = W * 0.014
    # 左页三条
    d.rounded_rectangle(
        [P(0.255, frac + 0.014)[0], P(0, frac)[1], P(0.435, frac + 0.014)[0], P(0, frac)[1] + lw],
        radius=lw // 2, fill=BG + (255,),
    )
    # 右页三条
    d.rounded_rectangle(
        [P(0.565, frac + 0.014)[0], P(0, frac)[1], P(0.745, frac + 0.014)[0], P(0, frac)[1] + lw],
        radius=lw // 2, fill=BG + (255,),
    )

img = img.resize((S, S), Image.LANCZOS)
img.save("app-icon.png")
img.save("src/assets/app-icon.png")
print("saved app-icon.png & src/assets/app-icon.png")
