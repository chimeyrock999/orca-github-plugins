#!/bin/sh
# Renders cover.html into the catalog cover (static PNG) and the README cover (animated WebP).
# Needs a headless Chromium (CHROME=...) and img2webp (brew install webp).
set -eu
cd "$(dirname "$0")"
chrome=${CHROME:?set CHROME to a headless Chromium, such as Playwright chrome-headless-shell}
page="file://$PWD/cover.html"
"$chrome" --headless --hide-scrollbars --window-size=1440,900 --virtual-time-budget=8000 \
  --screenshot=../../plugins/gh-focus/images/cover.png "$page#still" >/dev/null 2>&1
frames=$(mktemp -d)
# 75 frames, 80 ms apart: one 6 s loop.
seq 0 74 | xargs -P 8 -I{} sh -c '"$0" --headless --hide-scrollbars --window-size=1200,750 \
  --virtual-time-budget=6000 --user-data-dir="$(mktemp -d)" \
  --screenshot="$1/f$(printf %03d {}).png" "$2#t=$(( {} * 80 ))" >/dev/null 2>&1' "$chrome" "$frames" "$page"
img2webp -loop 0 -lossy -q 72 -m 4 -d 80 "$frames"/f*.png -o ../images/cover.webp >/dev/null
rm -r "$frames"
