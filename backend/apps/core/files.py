"""Upload validation and safe download responses."""

import mimetypes
import os

from django.conf import settings
from django.http import FileResponse
from rest_framework.exceptions import ValidationError

ALLOWED_EXTENSIONS = {
    ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".txt", ".csv", ".md",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip", ".fig", ".sketch",
}
RECEIPT_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}

# Magic-byte signatures for types where a mismatch would indicate a disguised file.
_SIGNATURES = {
    ".pdf": [b"%PDF"],
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".gif": [b"GIF87a", b"GIF89a"],
    ".webp": [b"RIFF"],
    ".zip": [b"PK\x03\x04", b"PK\x05\x06"],
    ".docx": [b"PK\x03\x04"],
    ".xlsx": [b"PK\x03\x04"],
    ".pptx": [b"PK\x03\x04"],
}


def validate_upload(upload, *, allowed: set[str] = ALLOWED_EXTENSIONS, field: str = "file") -> str:
    """Validates size, extension and leading bytes. Returns the sanitised original filename."""
    if upload is None:
        raise ValidationError({field: ["A file is required."]})
    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    if upload.size > max_bytes:
        raise ValidationError({field: [f"Files must be {settings.MAX_UPLOAD_SIZE_MB} MB or smaller."]})
    if upload.size == 0:
        raise ValidationError({field: ["The file is empty."]})
    name = os.path.basename(upload.name or "file").replace("\x00", "")[:200]
    ext = os.path.splitext(name)[1].lower()
    if ext not in allowed:
        raise ValidationError({field: [f"File type '{ext or 'unknown'}' is not allowed."]})
    signatures = _SIGNATURES.get(ext)
    if signatures:
        head = upload.read(16)
        upload.seek(0)
        if not any(head.startswith(sig) for sig in signatures):
            raise ValidationError({field: ["The file content does not match its extension."]})
    return name


def guess_content_type(filename: str) -> str:
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"


def file_download_response(field_file, filename: str, *, inline: bool = False) -> FileResponse:
    content_type = guess_content_type(filename)
    # Only PDFs and raster images may be rendered inline; everything else downloads.
    can_inline = inline and (content_type == "application/pdf" or content_type.startswith("image/")) \
        and content_type != "image/svg+xml"
    response = FileResponse(field_file.open("rb"), as_attachment=not can_inline, filename=filename,
                            content_type=content_type)
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
    response["Cache-Control"] = "private, no-store"
    return response
