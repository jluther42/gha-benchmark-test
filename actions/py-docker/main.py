"""Benchmark task (identical logic to actions/ts/src/index.ts).

Used by both Python variants: the Docker action runs it inside the container,
and the composite action runs it after setup-python + pip install.
"""
import json
import os
import sys
import time

import requests


def get_input(name: str) -> str:
    # Docker actions get inputs as INPUT_<NAME>; the composite action sets the same vars.
    return os.environ.get(f"INPUT_{name.upper()}", "").strip()


def set_output(name: str, value: str) -> None:
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
        fh.write(f"{name}={value}\n")


def main() -> None:
    started = time.perf_counter()

    data_file = get_input("data_file")
    token = get_input("token")
    repo = os.environ.get("GITHUB_REPOSITORY", "")

    with open(data_file, encoding="utf-8") as fh:
        rows = json.load(fh)

    groups: dict[str, dict] = {}
    for r in rows:
        g = groups.setdefault(r["category"], {"count": 0, "sum": 0.0, "mean": 0.0})
        g["count"] += 1
        g["sum"] += r["amount"]
    for g in groups.values():
        g["sum"] = round(g["sum"], 2)
        g["mean"] = round(g["sum"] / g["count"], 2)
    top5 = [r["id"] for r in sorted(rows, key=lambda r: r["amount"], reverse=True)[:5]]

    stars = None
    if repo:
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "actions-lang-benchmark"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        res = requests.get(f"https://api.github.com/repos/{repo}", headers=headers, timeout=30)
        res.raise_for_status()
        stars = res.json()["stargazers_count"]

    summary = {"rows": len(rows), "groups": groups, "top5": top5, "stars": stars}
    work_ms = round((time.perf_counter() - started) * 1000)

    set_output("summary", json.dumps(summary, separators=(",", ":")))
    set_output("work_ms", str(work_ms))
    print(f"rows={len(rows)} groups={len(groups)} stars={stars} work_ms={work_ms}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # report like core.setFailed
        print(f"::error::{exc}")
        sys.exit(1)
