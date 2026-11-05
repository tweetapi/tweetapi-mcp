#!/usr/bin/env python3
"""Scan repository text files for obvious committed secrets."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ALLOWED_PLACEHOLDERS = {
    "...",
    "YOUR_API_KEY",
    "your_tweetapi_key_here",
}
LITERAL_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(authToken|ct0|apiKey|api_key|secret|token)\b\s*[:=]\s*['\"]([^'\"]+)['\"]"
)
ENV_ASSIGNMENT_RE = re.compile(r"\bTWEETAPI_API_KEY\s*=\s*([^\s]+)")
OPENAI_KEY_RE = re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")
SKIP_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".ico",
    ".pdf",
    ".lock",
}
SKIP_DIRS = {".git", "node_modules", "dist", "build", ".next", "__pycache__"}


def fail(message: str) -> None:
    print(f"check-secrets: {message}", file=sys.stderr)
    raise SystemExit(1)


def tracked_and_untracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        text=True,
        capture_output=True,
        check=True,
    )
    files: list[Path] = []
    for line in result.stdout.splitlines():
        path = Path(line)
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        if path.is_file():
            files.append(path)
    return files


def is_allowed(value: str) -> bool:
    cleaned = value.strip().strip(",").strip('"').strip("'")
    if cleaned in ALLOWED_PLACEHOLDERS:
        return True
    if "YOUR_" in cleaned or cleaned.endswith("_here"):
        return True
    if set(cleaned) == {"."}:
        return True
    return False


def scan_file(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return []

    findings: list[str] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for match in LITERAL_ASSIGNMENT_RE.finditer(line):
            value = match.group(2)
            if not is_allowed(value):
                findings.append(f"{path}:{line_number}: possible secret literal: {match.group(0)}")

        for match in ENV_ASSIGNMENT_RE.finditer(line):
            value = match.group(1)
            if not is_allowed(value):
                findings.append(f"{path}:{line_number}: possible TweetAPI key: {match.group(0)}")

        for match in OPENAI_KEY_RE.finditer(line):
            findings.append(f"{path}:{line_number}: possible OpenAI key: {match.group(0)}")
    return findings


def main() -> None:
    findings: list[str] = []
    for path in tracked_and_untracked_files():
        findings.extend(scan_file(path))

    if findings:
        for finding in findings:
            print(finding, file=sys.stderr)
        fail("possible secrets found")

    print("No obvious secrets found")


if __name__ == "__main__":
    main()
