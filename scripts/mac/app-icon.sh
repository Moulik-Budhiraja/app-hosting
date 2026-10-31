#!/usr/bin/env bash
# Writes an app's icon as a 256-pixel PNG, for its download page:
#
#   scripts/mac/app-icon.sh <App.app> <icon.png>
#
# Uses the .icns named by CFBundleIconFile when there is one, and otherwise asks
# AppKit to draw the asset catalog icon named by CFBundleIconName. Exits 1,
# writing nothing, when the app has no icon of its own, since the generic app
# icon would only stand in for one.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/mac/lib.sh
source "$here/lib.sh"

app=${1:?usage: app-icon.sh <App.app> <icon.png>}
out=${2:?usage: app-icon.sh <App.app> <icon.png>}
plist="$app/Contents/Info.plist"
[[ -f $plist ]] || die "$app isn't an app bundle"
size=256

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$plist" 2>/dev/null || true
}
icon_file=$(plist_value CFBundleIconFile)
icon_name=$(plist_value CFBundleIconName)

if [[ -n $icon_file ]]; then
  [[ $icon_file == *.icns ]] || icon_file+=.icns
  icns="$app/Contents/Resources/$icon_file"
  if [[ -f $icns ]] && sips -s format png -Z "$size" "$icns" --out "$out" >/dev/null 2>&1; then
    exit 0
  fi
fi

if [[ -n $icon_name ]]; then
  # Icons from Assets.car can't be read with sips, but AppKit draws them.
  if osascript -l JavaScript - "$app" "$out" "$size" >/dev/null <<'JS'
ObjC.import('AppKit');
function run(argv) {
  const [app, out, size] = [argv[0], argv[1], Number(argv[2])];
  const image = $.NSWorkspace.sharedWorkspace.iconForFile(app);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  rep.size = $.NSMakeSize(size, size);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.currentContext = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationCopy, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  if (!png.writeToFileAtomically(out, true)) throw new Error('could not write ' + out);
}
JS
  then
    exit 0
  fi
fi

note "$(basename "$app") has no icon of its own; its page will show its initial"
exit 1
