from __future__ import annotations

import dataclasses
import hashlib
import pathlib


MIB = 1_048_576


class PgsoError(RuntimeError):
    pass


@dataclasses.dataclass(frozen=True)
class BuildIdentity:
    source_sha: str
    target: str
    host_arch: str
    zig_version: str
    llvm_version: str
    bitcode_sha256: str
    corpus_sha256: str
    update_channel: str
    generation_flags: tuple[str, ...]


@dataclasses.dataclass(frozen=True)
class ArtifactEvidence:
    size_bytes: int
    size_mib: float
    control_size_bytes: int
    control_size_mib: float
    headroom_mib: float


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def profile_evidence(
    path: pathlib.Path,
    *,
    merged_raw_profiles: int,
) -> dict[str, object]:
    if not path.is_file() or path.stat().st_size == 0:
        raise PgsoError(f"profile is missing or empty: {path}")
    if merged_raw_profiles <= 0:
        raise PgsoError("merged raw profile count must be positive")
    return {
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
        "merged_raw_profiles": merged_raw_profiles,
    }


def verify_identity(expected: BuildIdentity, actual: BuildIdentity) -> None:
    for field in dataclasses.fields(BuildIdentity):
        expected_value = getattr(expected, field.name)
        actual_value = getattr(actual, field.name)
        if expected_value != actual_value:
            raise PgsoError(
                f"identity mismatch: {field.name}: "
                f"expected {expected_value!r}, got {actual_value!r}"
            )


def bytes_to_mib(byte_count: int) -> float:
    return byte_count / MIB


def size_gate(byte_count: int, control_byte_count: int) -> ArtifactEvidence:
    """Accept a candidate only when it is no larger than its control.

    The absolute 7.800 MiB ceiling this replaced came from upstream fx and
    never bound: the last candidate was 5.12 MiB against an 8.37 MiB control.
    The control is the binary that ships if the candidate is rejected, so it is
    the only size the candidate has to beat. The absolute cap now lives in the
    per-pull-request `binary-size` job instead.
    """
    if byte_count <= 0:
        raise PgsoError("artifact is empty or has an invalid negative size")
    if control_byte_count <= 0:
        raise PgsoError("control is empty or has an invalid negative size")

    size_mib = bytes_to_mib(byte_count)
    control_size_mib = bytes_to_mib(control_byte_count)
    if byte_count > control_byte_count:
        raise PgsoError(
            f"candidate size {size_mib:.6f} MiB exceeds the "
            f"{control_size_mib:.6f} MiB control"
        )

    return ArtifactEvidence(
        size_bytes=byte_count,
        size_mib=size_mib,
        control_size_bytes=control_byte_count,
        control_size_mib=control_size_mib,
        headroom_mib=control_size_mib - size_mib,
    )


def require_empty_stderr(stage: str, stderr: str) -> None:
    if stderr:
        raise PgsoError(f"{stage} wrote unexpected stderr: {stderr}")
