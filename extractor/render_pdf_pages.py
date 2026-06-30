#!/usr/bin/env python3
import base64
import json
import os
import sys
from typing import Dict, Any

import fitz


def render_pdf_pages(path: str, max_pages: int = 3, dpi: int = 180) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {
            "ok": False,
            "error": "file_not_found",
            "message": f"No such file: {path}",
            "pages": [],
        }

    if max_pages < 1:
        max_pages = 1

    try:
        doc = fitz.open(path)
    except Exception as exc:
        return {
            "ok": False,
            "error": "open_failed",
            "message": str(exc),
            "pages": [],
        }

    try:
        if doc.is_encrypted:
            unlocked = doc.authenticate("")
            if not unlocked:
                return {
                    "ok": False,
                    "error": "pdf_password_protected",
                    "message": "PDF is encrypted and requires password",
                    "pages": [],
                }

        total = min(len(doc), max_pages)
        pages = []
        for idx in range(total):
            page = doc[idx]
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            png_bytes = pix.tobytes("png")
            pages.append(base64.b64encode(png_bytes).decode("ascii"))

        return {
            "ok": True,
            "pages": pages,
            "pageCount": total,
        }
    finally:
        doc.close()


def main() -> None:
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "missing_arg",
                    "message": "Usage: render_pdf_pages.py <file_path> [max_pages] [dpi]",
                    "pages": [],
                }
            )
        )
        sys.exit(2)

    file_path = sys.argv[1]
    max_pages = int(sys.argv[2]) if len(sys.argv) >= 3 else 3
    dpi = int(sys.argv[3]) if len(sys.argv) >= 4 else 180

    result = render_pdf_pages(file_path, max_pages=max_pages, dpi=dpi)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
