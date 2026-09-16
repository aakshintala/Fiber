"""Emit a `size -m` style segment and section report for a Mach-O binary.

Reads the load commands directly so the report can be produced on any host.
`size -m` is only available on macOS, and `llvm-size --format=darwin` is not a
drop-in: it prints `Section (__TEXT, __text): N`, which `binary_size.py` cannot
parse. The output here is the subset of `size -m` that parser consumes, so the
two are interchangeable.
"""

from __future__ import annotations

import argparse
import pathlib
import struct
import sys
from collections.abc import Sequence

MH_MAGIC_64 = 0xFEEDFACF
FAT_MAGICS = {0xCAFEBABE, 0xBEBAFECA, 0xCAFEBABF, 0xBFBACAFE}
LC_SEGMENT_64 = 0x19

MACHO_HEADER_SIZE = 32
SEGMENT_COMMAND_SIZE = 72
SECTION_SIZE = 80

CPU_TYPES = {0x0100000C: "arm64", 0x01000007: "x86_64"}


class MachoError(Exception):
    """The file is not a Mach-O binary this script can read."""


def _unpack(fmt: str, data: bytes, offset: int, what: str):
    try:
        return struct.unpack_from(fmt, data, offset)
    except struct.error as error:
        raise MachoError(f"truncated Mach-O while reading {what}") from error


def sections_report(data: bytes) -> str:
    (magic,) = _unpack("<I", data, 0, "magic")
    if magic in FAT_MAGICS:
        raise MachoError(
            "universal (fat) binaries are not supported; extract a single "
            "architecture first"
        )
    if magic != MH_MAGIC_64:
        raise MachoError(f"not a 64-bit little-endian Mach-O: magic {magic:#010x}")

    (ncmds,) = _unpack("<I", data, 16, "load command count")
    lines: list[str] = []
    offset = MACHO_HEADER_SIZE
    for index in range(ncmds):
        cmd, cmdsize = _unpack("<II", data, offset, f"load command {index}")
        if cmdsize < 8:
            raise MachoError(f"load command {index} has invalid size {cmdsize}")
        if cmd == LC_SEGMENT_64:
            if cmdsize < SEGMENT_COMMAND_SIZE:
                raise MachoError(
                    f"segment command {index} is {cmdsize} bytes, "
                    f"expected at least {SEGMENT_COMMAND_SIZE}"
                )
            name = data[offset + 8 : offset + 24].rstrip(b"\0").decode("ascii")
            (vmsize,) = _unpack("<Q", data, offset + 32, f"{name} vmsize")
            (nsects,) = _unpack("<I", data, offset + 64, f"{name} section count")
            lines.append(f"Segment {name}: {vmsize}")
            section_offset = offset + SEGMENT_COMMAND_SIZE
            for _ in range(nsects):
                sect = data[section_offset : section_offset + 16]
                sect_name = sect.rstrip(b"\0").decode("ascii")
                (size,) = _unpack(
                    "<Q", data, section_offset + 40, f"{name} section size"
                )
                lines.append(f"\tSection {sect_name}: {size}")
                section_offset += SECTION_SIZE
        offset += cmdsize

    if not lines:
        raise MachoError("Mach-O contains no LC_SEGMENT_64 load commands")
    return "\n".join(lines) + "\n"


def architecture(data: bytes) -> str:
    (cputype,) = _unpack("<i", data, 4, "cpu type")
    return CPU_TYPES.get(cputype & 0xFFFFFFFF, f"unknown({cputype & 0xFFFFFFFF:#x})")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("binary", type=pathlib.Path)
    parser.add_argument(
        "--expect-arch",
        help="fail unless the Mach-O cpu type matches, e.g. arm64",
    )
    args = parser.parse_args(argv)

    if not args.binary.is_file():
        raise SystemExit(f"binary does not exist: {args.binary}")
    data = args.binary.read_bytes()
    try:
        if args.expect_arch:
            found = architecture(data)
            if found != args.expect_arch:
                raise MachoError(
                    f"expected {args.expect_arch} Mach-O, found {found}"
                )
        sys.stdout.write(sections_report(data))
    except MachoError as error:
        raise SystemExit(f"{args.binary}: {error}") from error
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
