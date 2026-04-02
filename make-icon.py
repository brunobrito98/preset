from PIL import Image, ImageDraw

size = 256
img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

purple = (101, 51, 168, 255)
gold = (248, 187, 17, 255)
bg_gold = (255, 215, 64, 48)

left = 72
top = 36
right = 202
bottom = 220
stroke = 10

# Pump body
draw.rounded_rectangle((left, top, right - 46, bottom - 32), radius=16, outline=purple, width=stroke)

# Window
draw.rectangle((left + 18, top + 22, right - 64, top + 76), fill=gold)

# Hose / nozzle
draw.line((right - 44, top + 44, right + 6, top + 44, right + 6, top + 122, right - 8, top + 138), fill=purple, width=stroke)
draw.line((right - 18, top + 148, right + 12, top + 168), fill=purple, width=stroke)

# Base / supports
draw.line((left - 18, bottom - 8, right - 22, bottom - 8), fill=purple, width=stroke)
draw.line((left + 12, bottom - 8, left + 24, bottom - 40), fill=purple, width=stroke)
draw.line((right - 72, bottom - 8, right - 72, bottom - 40), fill=purple, width=stroke)

# Top highlight
draw.rounded_rectangle((left - 6, top - 4, right - 44, top + 16), radius=8, fill=bg_gold)

img.save("horustech-icon.png")
img.save("horustech-icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
