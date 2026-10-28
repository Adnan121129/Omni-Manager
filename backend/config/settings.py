"""
OmniManager Django settings.

All secrets and environment-specific values are read from environment
variables (optionally loaded from backend/.env). See .env.example at the
repository root for the documented list.
"""

import os
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent

# Precedence: real environment variables > backend/.env > repository-root .env.
# (load_dotenv never overrides a variable that is already set.)
load_dotenv(BASE_DIR / ".env")
load_dotenv(REPO_ROOT / ".env")


def env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name, default)


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_path(name: str, default: Path) -> Path:
    """A filesystem path; relative values are resolved from the repository root, not the working directory."""
    value = os.environ.get(name)
    if not value:
        return default
    path = Path(value).expanduser()
    return path if path.is_absolute() else REPO_ROOT / path


def env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in env(name, default).split(",") if item.strip()]


DEBUG = env_bool("DJANGO_DEBUG", False)

SECRET_KEY = env("DJANGO_SECRET_KEY")
if not SECRET_KEY:
    if DEBUG:
        # Development-only fallback so a fresh checkout can boot. Never used when DEBUG is off.
        SECRET_KEY = "dev-insecure-secret-key-change-me"
    else:
        raise RuntimeError("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is false.")

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver")
CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")

# Public URL of the React application, used for links in emails and payment redirects.
FRONTEND_URL = env("FRONTEND_URL", "http://localhost:5173").rstrip("/")

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "apps.accounts",
    "apps.core",
    "apps.crm",
    "apps.projects",
    "apps.timetracking",
    "apps.finance",
    "apps.documents",
    "apps.portal",
    "apps.reports",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"


def _database_from_url(url: str) -> dict:
    parsed = urlparse(url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("DATABASE_URL must use the postgres:// scheme.")
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": parsed.path.lstrip("/"),
        "USER": parsed.username or "",
        "PASSWORD": parsed.password or "",
        "HOST": parsed.hostname or "localhost",
        "PORT": str(parsed.port or 5432),
        "CONN_MAX_AGE": int(env("DATABASE_CONN_MAX_AGE", "60")),
        "ATOMIC_REQUESTS": False,
    }


DATABASE_URL = env("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL must be set (see .env.example).")
DATABASES = {"default": _database_from_url(DATABASE_URL)}

AUTH_USER_MODEL = "accounts.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "var" / "static"

# Uploaded files are never served from a public URL: every download goes through an
# authenticated API endpoint that checks tenant and record permissions.
MEDIA_ROOT = env_path("MEDIA_ROOT", BASE_DIR / "var" / "media")
MEDIA_URL = "/media-not-public/"
FILE_STORAGE_BACKEND = env("FILE_STORAGE_BACKEND", "django.core.files.storage.FileSystemStorage")
STORAGES = {
    "default": {"BACKEND": FILE_STORAGE_BACKEND, "OPTIONS": {}},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
if FILE_STORAGE_BACKEND.endswith("FileSystemStorage"):
    STORAGES["default"]["OPTIONS"] = {"location": str(MEDIA_ROOT)}

MAX_UPLOAD_SIZE_MB = int(env("MAX_UPLOAD_SIZE_MB", "15"))
DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- Sessions, CSRF & security headers -------------------------------------------------
SESSION_COOKIE_NAME = "om_session"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = int(env("SESSION_COOKIE_AGE", str(60 * 60 * 24 * 14)))
SESSION_COOKIE_SECURE = env_bool("SESSION_COOKIE_SECURE", not DEBUG)
CSRF_COOKIE_NAME = "om_csrftoken"
CSRF_COOKIE_HTTPONLY = False  # the SPA reads this cookie and echoes it in X-CSRFToken
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SECURE = env_bool("CSRF_COOKIE_SECURE", not DEBUG)
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
SECURE_REFERRER_POLICY = "same-origin"
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", True)
    SECURE_HSTS_SECONDS = int(env("SECURE_HSTS_SECONDS", "0"))

# --- Django REST Framework ---------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_PAGINATION_CLASS": "apps.core.pagination.StandardPagination",
    "PAGE_SIZE": 25,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": [
        "rest_framework.parsers.JSONParser",
        "rest_framework.parsers.MultiPartParser",
        "rest_framework.parsers.FormParser",
    ],
    "EXCEPTION_HANDLER": "apps.core.exceptions.api_exception_handler",
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.ScopedRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "auth": env("THROTTLE_AUTH", "20/min"),
        "password_reset": env("THROTTLE_PASSWORD_RESET", "5/min"),
        "payments": env("THROTTLE_PAYMENTS", "30/min"),
        "webhooks": env("THROTTLE_WEBHOOKS", "300/min"),
    },
    "COERCE_DECIMAL_TO_STRING": True,
    "DATETIME_FORMAT": "iso-8601",
}

CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}

# --- Email ------------------------------------------------------------------------------
EMAIL_BACKEND = env("EMAIL_BACKEND", "django.core.mail.backends.filebased.EmailBackend")
EMAIL_FILE_PATH = str(env_path("EMAIL_FILE_PATH", BASE_DIR / "var" / "mail"))
EMAIL_HOST = env("EMAIL_HOST", "localhost")
EMAIL_PORT = int(env("EMAIL_PORT", "25"))
EMAIL_HOST_USER = env("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", False)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", "OmniManager <no-reply@omnimanager.local>")

# --- Payments ----------------------------------------------------------------------------
# "sandbox" is a local, clearly labelled simulator that exercises the same signed-webhook
# verification path as a real provider. "stripe" uses Stripe Checkout (use test keys).
PAYMENT_PROVIDER = env("PAYMENT_PROVIDER", "sandbox")
SANDBOX_WEBHOOK_SECRET = env("SANDBOX_WEBHOOK_SECRET", "")
STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = env("STRIPE_WEBHOOK_SECRET", "")

# Password given to accounts created by `manage.py seed_demo` (demo fixtures only).
DEMO_PASSWORD = env("DEMO_PASSWORD", "Demo!2345")

# --- Logging -----------------------------------------------------------------------------
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {
        "redact": {"()": "apps.core.logging.RedactSecretsFilter"},
        "quiet": {"()": "apps.core.logging.QuietThirdPartyFilter"},
    },
    "formatters": {
        "plain": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"},
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "plain", "filters": ["quiet", "redact"]},
    },
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", "INFO")},
    "loggers": {
        "django.db.backends": {"level": "WARNING"},
        "fontTools": {"level": "WARNING"},
        "weasyprint": {"level": "ERROR"},
    },
}
