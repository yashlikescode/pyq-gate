"""
unzip_recursive.py
------------------
Recursively extracts a ZIP file (and any ZIPs found inside it),
preserving the original folder tree.

Usage:
    python unzip_recursive.py <path_to_zip> [output_dir]

If output_dir is omitted, extraction happens next to the zip file.
"""

import zipfile
import sys
from pathlib import Path


def recursive_unzip(zip_path: Path, dest_dir: Path) -> None:
    """
    Extract zip_path into dest_dir, then recurse into any .zip files
    found among the extracted contents.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)

    print(f"Extracting: {zip_path}  →  {dest_dir}")

    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(dest_dir)

    # Walk the extracted tree and recurse into any nested zips
    for item in sorted(dest_dir.rglob("*.zip")):
        # Extract next to the inner zip (same directory, folder named after zip stem)
        inner_dest = item.parent / item.stem
        recursive_unzip(item, inner_dest)
        # Remove the inner zip after extraction so it's not processed again on re-runs
        item.unlink()


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python unzip_recursive.py <path_to_zip> [output_dir]")
        sys.exit(1)

    zip_path = Path(sys.argv[1]).resolve()

    if not zip_path.exists():
        print(f"Error: file not found: {zip_path}")
        sys.exit(1)

    if not zipfile.is_zipfile(zip_path):
        print(f"Error: not a valid ZIP file: {zip_path}")
        sys.exit(1)

    # Default output dir: sibling folder named after the zip stem
    if len(sys.argv) >= 3:
        dest_dir = Path(sys.argv[2]).resolve()
    else:
        dest_dir = zip_path.parent / zip_path.stem

    recursive_unzip(zip_path, dest_dir)
    print(f"\nDone. All contents extracted to: {dest_dir}")


if __name__ == "__main__":
    main()
