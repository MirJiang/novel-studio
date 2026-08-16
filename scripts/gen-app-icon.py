"""生成 Novel Studio 正式应用图标：渐变圆角方底 + 白色打开的书本。"""
from PIL import Image, ImageDraw

S = 1024
SS = 4  # 超采样抗锯齿
W = S * SS

# ---------- 背景：对角渐变（亮蓝 → 靛紫） ----------
c1 = (32, 150, 255)   # 亮蓝
c2 = (110, 80, 250)   # 靛紫
small = Image.new("RGB", (64, 64))
sp = small.load()
for yy in range(64):
    for xx in range(64):
        t = (xx + yy) / 126.0
        sp[xx, yy] = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
grad = small.resize((W, W), Image.BICUBIC).convert("RGBA")

# 圆角蒙版
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W, W], radius=int(W * 0.22), fill=255)
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
img = Image.composite(grad, img, mask)
d = ImageDraw.Draw(img)


def P(x, y):
    return (x * W, y * W)


# ---------- 打开的书（封面在后，书页在前） ----------
cover = (198, 216, 248, 255)   # 淡蓝白：封面
page = (255, 255, 255, 255)    # 纯白：书页
linec = (176, 198, 240, 255)   # 页内横线

# 封面（比书页大一圈的同款剪影）
d.polygon(
    [P(0.155, 0.335), P(0.5, 0.415), P(0.845, 0.335),
     P(0.845, 0.705), P(0.5, 0.785), P(0.155, 0.705)],
    fill=cover,
)
# 左页 / 右页（中缝在 x=0.5，顶凹底凸）
d.polygon([P(0.20, 0.36), P(0.487, 0.435), P(0.487, 0.745), P(0.20, 0.665)], fill=page)
d.polygon([P(0.80, 0.36), P(0.513, 0.435), P(0.513, 0.745), P(0.80, 0.665)], fill=page)

# 页内横线（跟随书页轻微倾斜）
lw = int(W * 0.011)
for frac in (0.48, 0.545, 0.61):
    dy = W * 0.014
    # 左页三条
    d.rounded_rectangle(
        [P(0.25, frac + 0.014)[0], P(0, frac)[1], P(0.44, frac + 0.014)[0], P(0, frac)[1] + lw],
        radius=lw // 2, fill=linec,
    )
    # 右页三条
    d.rounded_rectangle(
        [P(0.56, frac + 0.014)[0], P(0, frac)[1], P(0.75, frac + 0.014)[0], P(0, frac)[1] + lw],
        radius=lw // 2, fill=linec,
    )

img = img.resize((S, S), Image.LANCZOS)
img.save("app-icon.png")
print("saved app-icon.png")
