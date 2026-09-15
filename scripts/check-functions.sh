#!/usr/bin/env bash
# Type-check the Supabase Edge Function sources with Deno (they are excluded from `tsc --noEmit`: Deno
# globals, `npm:` specifiers, `.ts` import suffixes). `pnpm check:functions` — skips gracefully when
# `deno` is not on PATH (the Edge Runtime container executes the same sources on every served request).
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."
if ! command -v deno >/dev/null 2>&1; then
  echo "check-functions: deno is not on PATH — skipping (install: https://docs.deno.com/runtime/ or \`brew install deno\`)" >&2
  exit 0
fi
files=(supabase/functions/*/index.ts)
if [ ${#files[@]} -eq 0 ]; then
  echo "check-functions: no supabase/functions/*/index.ts found" >&2
  exit 1
fi
echo "check-functions: deno $(deno --version | head -1 | awk '{print $2}') → ${files[*]}"
deno check "${files[@]}"
