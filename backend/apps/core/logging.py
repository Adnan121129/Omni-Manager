import logging
import re

_SENSITIVE = re.compile(
    r"(?i)(password|secret|token|api[_-]?key|authorization|card[_-]?number|cvc)(\"?\s*[:=]\s*\"?)([^\s\",&]+)"
)


class RedactSecretsFilter(logging.Filter):
    """Masks obvious credential values before log records are emitted."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - malformed record, leave untouched
            return True
        redacted = _SENSITIVE.sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


class QuietThirdPartyFilter(logging.Filter):
    """Drops chatty sub-warning records from font subsetting during PDF rendering."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not (record.name.startswith("fontTools") and record.levelno < logging.WARNING)
