#!/usr/bin/env bash
# Apply the audio-trap patches to the SDL2 port inside the local emsdk cache.
#
# The emscripten SDL2 port's audio permissions code has two crash hazards we
# hit while a remote connect rolls back to the main menu ("integer divide by
# zero" in HandleAudioProcess):
#   1. FeedAudioDevice divides by a frame length computed from the device
#      spec, which is 0 when callbacks fire against an already-closed device.
#   2. The autoplay-blocked silence_timer callback and the zone onaudioprocess
#      handler can still dispatch into wasm after SDL_CloseAudioDevice.
#
# The patched file is vendored at game/engine/cmake/patches/SDL_emscriptenaudio.c
# — re-run this script any time emsdk is installed, updated, or its cache is
# cleared, and BEFORE building the client (make client / game/build-client.sh).
#
# Usage: game/apply-emsdk-sdl-patch.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
EMSDK_DIR="${Q3JS_EMSDK_DIR:-$ROOT_DIR/tools/emsdk}"
TARGET="$EMSDK_DIR/upstream/emscripten/cache/ports/sdl2/SDL-release-2.32.10/src/audio/emscripten/SDL_emscriptenaudio.c"
PATCHED="$ROOT_DIR/game/engine/cmake/patches/SDL_emscriptenaudio.c"

if [[ ! -f "$TARGET" ]]; then
  echo "SDL2 port not installed at expected path:" >&2
  echo "  $TARGET" >&2
  echo "Run 'emcc --version' once (or any emcc build) so the SDL2 port cache" >&2
  echo "exists, then re-run this script." >&2
  exit 1
fi

if cmp -s "$TARGET" "$PATCHED"; then
  echo "SDL port already patched."
  exit 0
fi

# Remove the stale built library + cache build object so emcc rebuilds the
# audio code from the patched source at the next link.
built_dir="$(find "$EMSDK_DIR/upstream/emscripten/cache" -maxdepth 4 -type d -name 'sdl2*' ! -path '*cache/ports*' 2>/dev/null | head -1 || true)"
libpath="$(find "$EMSDK_DIR/upstream/emscripten/cache" -name 'libSDL2.a' 2>/dev/null | head -1 || true)"
[[ -n "$libpath" ]] && rm -f "${libpath}.cache_build" 2>/dev/null || true
[[ -n "$libpath" ]] && rm -f "$libpath" && echo "removed stale $libpath"

cp "$PATCHED" "$TARGET"
echo "patched $TARGET"

echo "NOTE: Since this patch lives inside the emsdk cache, rerun this script"
echo "after updating emsdk or rebuilding your cache."
