"""Consistent API error envelope: {"error": {"code", "message", "fields"}}."""

from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.core.exceptions import ValidationError as DjangoValidationError
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler


class BusinessRuleError(exceptions.APIException):
    """A request that is well-formed but violates a workflow or data-integrity rule."""

    status_code = status.HTTP_400_BAD_REQUEST
    default_code = "business_rule"
    default_detail = "This action is not allowed."

    def __init__(self, message: str, code: str | None = None, status_code: int | None = None, extra=None):
        super().__init__(detail=message, code=code or self.default_code)
        if status_code:
            self.status_code = status_code
        self.extra = extra or {}


class ConflictError(BusinessRuleError):
    status_code = status.HTTP_409_CONFLICT
    default_code = "conflict"


def _flatten(detail):
    if isinstance(detail, list):
        return " ".join(str(item) for item in detail)
    return str(detail)


def api_exception_handler(exc, context):
    if isinstance(exc, DjangoValidationError):
        exc = exceptions.ValidationError(
            exc.message_dict if hasattr(exc, "message_dict") else {"non_field_errors": exc.messages}
        )
    elif isinstance(exc, Http404):
        exc = exceptions.NotFound()
    elif isinstance(exc, DjangoPermissionDenied):
        exc = exceptions.PermissionDenied()

    response = exception_handler(exc, context)
    if response is None:
        return None

    code = getattr(exc, "default_code", "error")
    if hasattr(exc, "get_codes"):
        codes = exc.get_codes()
        if isinstance(codes, str):
            code = codes

    fields = {}
    message = ""
    if isinstance(exc, exceptions.ValidationError):
        code = "validation_error"
        data = response.data
        if isinstance(data, dict):
            for key, value in data.items():
                if key in ("non_field_errors", "detail"):
                    message = _flatten(value)
                else:
                    fields[key] = value if isinstance(value, (list, dict)) else [str(value)]
        else:
            message = _flatten(data)
        if not message:
            message = "Please correct the highlighted fields." if fields else "Invalid request."
    else:
        detail = response.data.get("detail") if isinstance(response.data, dict) else response.data
        message = _flatten(detail) if detail is not None else "Request failed."

    body = {"error": {"code": code, "message": message, "fields": fields}}
    extra = getattr(exc, "extra", None)
    if extra:
        body["error"]["details"] = extra
    new_response = Response(body, status=response.status_code)
    for header in ("Retry-After", "WWW-Authenticate"):
        if header in response:
            new_response[header] = response[header]
    return new_response
