"""Hardware-sized tier defaults.

When config.json names no models.tiers, the machine's memory picks a default
assignment from the hardware_defaults table (itself config data, keyed by
nominal gigabytes). Selection rounds down: a machine gets the largest class it
actually reaches, and one below the smallest class still gets the smallest as
a floor rather than nothing. Explicit models.tiers always wins upstream.
"""

import os

GB = 1024 ** 3


def total_memory_bytes():
    """Unified memory on this machine, from Metal if possible."""
    try:
        import mlx.core as mx
        size = mx.device_info().get("memory_size")
        if size:
            return int(size)
    except Exception:
        pass
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return 16 * GB


def memory_class(defaults, total_bytes):
    """The largest advertised class this machine reaches, in nominal GB."""
    classes = sorted(int(k) for k in defaults)
    nominal = total_bytes / GB
    chosen = classes[0]
    for cls in classes:
        if nominal + 0.5 >= cls:
            chosen = cls
    return chosen


def tiers_for(defaults, total_bytes=None, log=print):
    """The tier table for this machine's memory class, or None without a table."""
    if not defaults:
        return None
    total = total_memory_bytes() if total_bytes is None else total_bytes
    chosen = memory_class(defaults, total)
    log(f"[Inference] No models.tiers configured; "
        f"{total / GB:.1f} GB of memory takes the {chosen} GB defaults")
    return defaults.get(str(chosen)) or defaults.get(chosen)
