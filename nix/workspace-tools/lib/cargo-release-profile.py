"""Print a Cargo workspace's `[profile.release]` as Buck `rust_profile.*` config.

Unspecified values follow Cargo's release defaults, including the implicit
`strip = "debuginfo"` Cargo applies when debuginfo is off (Cargo >= 1.77,
https://github.com/rust-lang/cargo/issues/16670). Static native libraries
linked into the product otherwise keep their own DWARF.
"""

import sys
import tomllib

DEBUG_OFF = (False, 0, "none")


def toggle(value):
    return "yes" if value else "no"


def resolve_debug(debug):
    if isinstance(debug, bool):
        return "2" if debug else "0"
    return str(debug)


def resolve_strip(profile, debug):
    if "strip" not in profile:
        return "debuginfo" if debug in DEBUG_OFF else "none"
    strip = profile["strip"]
    if isinstance(strip, bool):
        return "symbols" if strip else "none"
    return str(strip)


with open(sys.argv[1], "rb") as manifest:
    profile = tomllib.load(manifest).get("profile", {}).get("release", {})

debug = profile.get("debug", False)
lto = profile.get("lto", False)
settings = {
    "opt_level": str(profile.get("opt-level", 3)),
    "debug": resolve_debug(debug),
    "lto": ("fat" if lto else "local") if isinstance(lto, bool) else str(lto),
    "codegen_units": str(profile.get("codegen-units", 16)),
    "panic": str(profile.get("panic", "unwind")),
    "strip": resolve_strip(profile, debug),
    "debug_assertions": toggle(profile.get("debug-assertions", False)),
    "overflow_checks": toggle(profile.get("overflow-checks", False)),
}
for name, value in settings.items():
    print(f"rust_profile.{name}={value}")
