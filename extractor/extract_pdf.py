#!/usr/bin/env python3
import hashlib
import json
import os
import sys
from typing import Dict, Any
from io import BytesIO

import fitz
import pytesseract
from PIL import Image


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()


def _safe_sample(text: str, size: int) -> str:
    text = (text or "").strip()
    if len(text) <= size:
        return text
    return text[:size]


def _first_heading(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    return lines[0][:180]


def extract_pdf(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {
            "ok": False,
            "error": "file_not_found",
            "message": f"No such file: {path}",
        }

    doc = fitz.open(path)
    try:
        if doc.is_encrypted:
            unlocked = doc.authenticate("")
            if not unlocked:
                return {
                    "ok": False,
                    "error": "pdf_password_protected",
                    "message": "PDF is encrypted and requires password",
                    "isEncrypted": True,
                }

        extracted_pages = []
        for page in doc:
            extracted_pages.append(page.get_text("text") or "")

        combined = "\n".join(extracted_pages).strip()
        mode = "text"

        # OCR fallback for scan-heavy PDFs.
        if not combined:
            mode = "ocr"
            ocr_pages = []
            ocr_max_pages = min(len(doc), 8)
            for idx in range(ocr_max_pages):
                page = doc[idx]
                pix = page.get_pixmap(dpi=220)
                image_bytes = pix.tobytes("png")
                image = Image.open(BytesIO(image_bytes))
                ocr_text = pytesseract.image_to_string(image)
                ocr_pages.append(ocr_text or "")
            combined = "\n".join(ocr_pages).strip()

        heading = _first_heading(combined)

        return {
            "ok": True,
            "isEncrypted": False,
            "extractionMode": mode,
            "heading": heading,
            "textSample": _safe_sample(combined, 2400),
            "fullTextSample": _safe_sample(combined, 16000),
            "textHash": _sha256(combined) if combined else None,
            "isEmpty": not bool(combined),
        }
    finally:
        doc.close()


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing_arg", "message": "Usage: extract_pdf.py <file_path>"}))
        sys.exit(2)

    result = extract_pdf(sys.argv[1])
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
