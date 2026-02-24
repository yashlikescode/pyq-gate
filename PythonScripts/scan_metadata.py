"""
scan_metadata.py
----------------
Scan GATE papers folder and produce lightweight JSON metadata for the
static frontend.

Actual on-disk layout (as observed):
  <root> / <group_dir> / <SUBJECT> / <SUBJECT> / <files…>
  e.g.   QPs GATE 2007 to 2025 / CS / CS / CS2024.pdf

Year is NOT a separate folder — it is embedded in the filename, e.g.:
  CS2024.pdf    → year 2024, part None
  CS1-2017.pdf  → year 2017, part 1
  EE2-2021.pdf  → year 2021, part 2

Usage:
    python scan_metadata.py --root <root_folder> [--out metadata] [--site-root .]

Arguments:
  --root        Root folder containing the group dirs (e.g. GATE_2027-2025_Question_Papers)
  --out         Output metadata directory (default: metadata)
  --site-root   Root of the static site; rel_paths in JSON are relative to this
                (default: current working directory)

Output:
  <out>/index.json             – subjects list (id, name, fullName, years, meta)
  <out>/subject_<id>.json      – per-subject paper entries
"""

from pathlib import Path
import argparse
import json
import mimetypes
import re

# ── Full name map for GATE subjects ──────────────────────────────────────────
FULL_NAMES: dict[str, str] = {
    "AE":    "Aerospace Engineering",
    "AG":    "Agricultural Engineering",
    "AR":    "Architecture and Planning",
    "BM":    "Biomedical Engineering",
    "BT":    "Biotechnology",
    "CE":    "Civil Engineering",
    "CH":    "Chemical Engineering",
    "CS":    "Computer Science and Information Technology",
    "CY":    "Chemistry",
    "DA":    "Data Science and Artificial Intelligence",
    "EC":    "Electronics and Communication Engineering",
    "EE":    "Electrical Engineering",
    "ES":    "Environmental Science and Engineering",
    "EY":    "Ecology and Evolution",
    "GE":    "Geomatics Engineering",
    "GG":    "Geology and Geophysics",
    "IN":    "Instrumentation Engineering",
    "MA":    "Mathematics",
    "ME":    "Mechanical Engineering",
    "MN":    "Mining Engineering",
    "MT":    "Metallurgical Engineering",
    "NM":    "Naval Architecture and Marine Engineering",
    "PE":    "Petroleum Engineering",
    "PH":    "Physics",
    "PI":    "Production and Industrial Engineering",
    "ST":    "Statistics",
    "TF":    "Textile Engineering and Fibre Science",
    "XE":    "Engineering Sciences",
    "XH-C1": "Humanities & Social Sciences – Economics",
    "XH-C2": "Humanities & Social Sciences – English",
    "XH-C3": "Humanities & Social Sciences – Linguistics",
    "XH-C4": "Humanities & Social Sciences – Philosophy",
    "XH-C5": "Humanities & Social Sciences – Psychology",
    "XH-C6": "Humanities & Social Sciences – Sociology",
    "XL":    "Life Sciences",
}

# Regex: extracts optional part number and 4-digit year from a filename
# Matches patterns like: CS2024, CS1-2017, EE2-2021, XH-C12024
_YEAR_RE = re.compile(r'(?:(\d+)-)?(\d{4})(?:\D|$)')


def slugify(name: str) -> str:
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s)
    return s.strip("_")


def parse_year_part(filename: str):
    """Return (year_str, part_int_or_None) parsed from a filename, or (None, None)."""
    stem = Path(filename).stem
    m = _YEAR_RE.search(stem)
    if not m:
        return None, None
    part = int(m.group(1)) if m.group(1) else None
    year = m.group(2)
    return year, part


def detect_type(filename: str) -> str:
    n = filename.lower()
    key_words = ["key", "answer", "solution", "ans", "soln"]
    for kw in key_words:
        if kw in n:
            return "key"
    return "paper"


def make_rel(base: Path, p: Path) -> str:
    """Return a forward-slash path relative to base (for use as a URL path)."""
    return p.relative_to(base).as_posix()


def find_file_dirs(root: Path):
    """
    Yield (subject_name, files_dir) pairs by walking the double-nested structure:
      <root>/<any_group>/<SUBJECT>/<SUBJECT>/
    If the inner double-name directory exists, yield it; otherwise yield the
    outer subject_dir itself (fallback for flat layouts).
    """
    for group_dir in sorted(root.iterdir()):
        if not group_dir.is_dir():
            continue
        for subject_dir in sorted(group_dir.iterdir()):
            if not subject_dir.is_dir():
                continue
            subject_name = subject_dir.name
            # Check for double-nested directory (e.g. CS/CS/)
            inner = subject_dir / subject_name
            if inner.is_dir():
                yield subject_name, inner
            else:
                yield subject_name, subject_dir


def scan(root: Path, out: Path, site_root: Path) -> None:
    root = root.resolve()
    out = out.resolve()
    site_root = site_root.resolve()
    out.mkdir(parents=True, exist_ok=True)

    subjects: dict[str, dict] = {}

    for subject_name, files_dir in find_file_dirs(root):
        subject_id = slugify(subject_name)

        subject_entry = subjects.setdefault(subject_id, {
            "id": subject_id,
            "name": subject_name,
            "years": [],
            "papers": [],
        })

        for f in sorted(files_dir.iterdir()):
            if f.is_dir():
                continue

            ext = f.suffix.lower()
            if ext not in (".pdf", ".jpg", ".jpeg", ".png"):
                continue

            year, part = parse_year_part(f.name)
            if year is None:
                print(f"  [warn] cannot parse year from: {f.name} — skipping")
                continue

            if year not in subject_entry["years"]:
                subject_entry["years"].append(year)

            mime, _ = mimetypes.guess_type(str(f))
            mime = mime or "application/octet-stream"
            fsize = f.stat().st_size
            ptype = detect_type(f.name)

            # thumbnail: same stem + .png/.jpg, or thumbs/<stem>.png
            thumb = None
            for cand in [f.with_suffix('.png'), f.with_suffix('.jpg'),
                         files_dir / "thumbs" / (f.stem + '.png')]:
                if cand.exists() and cand != f:
                    thumb = make_rel(site_root, cand)
                    break

            entry = {
                "year": year,
                "type": ptype,
                "rel_path": make_rel(site_root, f),
                "size": fsize,
                "mime": mime,
            }
            if part is not None:
                entry["part"] = part
            if thumb:
                entry["thumb_rel_path"] = thumb

            subject_entry["papers"].append(entry)

        # sort years descending (newest first)
        subject_entry["years"].sort(reverse=True)
        # sort papers by year desc, part asc
        subject_entry["papers"].sort(
            key=lambda p: (-int(p["year"]), p.get("part") or 0)
        )

    # write per-subject json files
    index_subjects = []
    for sid, data in sorted(subjects.items()):
        fname = f"subject_{sid}.json"
        (out / fname).write_text(json.dumps(data, indent=2, ensure_ascii=False))
        sname = data["name"]
        index_subjects.append({
            "id": sid,
            "name": sname,
            "fullName": FULL_NAMES.get(sname, sname),
            "years": data["years"],
            "paperCount": len(data["papers"]),
            "meta": fname,
        })

    index = {"subjects": index_subjects}
    (out / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False))
    total_papers = sum(s["paperCount"] for s in index_subjects)
    print(f"Wrote {len(index_subjects)} subjects, {total_papers} papers → {out}")


def main():
    p = argparse.ArgumentParser(
        description="Scan GATE question-paper folders and emit metadata JSON files"
    )
    p.add_argument("--root", required=True,
                   help="Root folder (e.g. GATE_2027-2025_Question_Papers)")
    p.add_argument("--out", default="metadata",
                   help="Output metadata directory (default: metadata)")
    p.add_argument("--site-root", default=".",
                   help="Static-site root; rel_paths are relative to this (default: .)")
    args = p.parse_args()

    scan(Path(args.root), Path(args.out), Path(args.site_root))


if __name__ == "__main__":
    main()
