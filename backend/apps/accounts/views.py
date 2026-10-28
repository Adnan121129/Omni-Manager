from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.contrib.auth.tokens import default_token_generator
from django.db import transaction
from django.utils import timezone
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode
from django.views.decorators.csrf import ensure_csrf_cookie
from django.utils.decorators import method_decorator
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError
from apps.core.files import IMAGE_EXTENSIONS, file_download_response, validate_upload
from apps.core.notify import NOTIFICATION_KINDS, preference_for
from apps.core.permissions import InWorkspace, IsStaff, IsWorkspaceAdmin
from apps.core.tenancy import activate_membership, resolve_membership
from apps.core.views import EnforceCsrfMixin

from . import services
from .models import Invitation, Membership, Role, User
from .serializers import (
    AcceptInvitationSerializer,
    ChangePasswordSerializer,
    InvitationSerializer,
    InviteCreateSerializer,
    LoginSerializer,
    MemberSerializer,
    OrganizationSerializer,
    PasswordResetConfirmSerializer,
    ProfileSerializer,
    SignupSerializer,
)


def session_payload(request) -> dict:
    user = request.user
    membership = resolve_membership(request)
    workspaces = [
        {"id": m.organization_id, "name": m.organization.name, "role": m.role}
        for m in Membership.objects.filter(user=user, status=Membership.Status.ACTIVE).select_related("organization")
    ]
    data = {"user": ProfileSerializer(user).data, "workspaces": workspaces, "membership": None,
            "organization": None, "permissions": None}
    if membership is None:
        return data
    org = membership.organization
    data["membership"] = {
        "id": membership.id, "role": membership.role, "role_label": membership.get_role_display(),
        "title": membership.title,
        "client": {"id": membership.client_id, "name": membership.client.name} if membership.client_id else None,
    }
    if membership.is_client:
        data["organization"] = {"id": org.id, "name": org.name, "brand_color": org.brand_color,
                                "has_logo": bool(org.logo), "default_currency": org.default_currency,
                                "timezone": org.timezone}
    else:
        data["organization"] = OrganizationSerializer(org, context={"membership": membership}).data
    data["permissions"] = {
        "is_client": membership.is_client,
        "is_admin": membership.is_admin,
        "is_manager": membership.is_manager,
        "is_owner": membership.role == Role.OWNER,
        "billing": membership.has_billing_access,
        "manage_team": membership.is_admin,
        "approve_time": membership.is_manager,
        "reports": membership.is_manager,
    }
    return data


@method_decorator(ensure_csrf_cookie, name="dispatch")
class CsrfView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({"ok": True})


class SignupView(EnforceCsrfMixin, APIView):
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = SignupSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        with transaction.atomic():
            user = User.objects.create_user(email=data["email"], password=data["password"],
                                            full_name=data["full_name"], timezone=data["timezone"])
            services.create_workspace(owner=user, name=data["organization_name"], currency=data["currency"],
                                      tz=data["timezone"])
        login(request, user, backend="django.contrib.auth.backends.ModelBackend")
        return Response(session_payload(request), status=status.HTTP_201_CREATED)


class LoginView(EnforceCsrfMixin, APIView):
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = authenticate(request, email=serializer.validated_data["email"].lower(),
                            password=serializer.validated_data["password"])
        if user is None:
            raise BusinessRuleError("Invalid email or password.", code="invalid_credentials", status_code=400)
        if not user.is_active:
            raise BusinessRuleError("This account has been disabled.", code="account_disabled", status_code=403)
        login(request, user)
        return Response(session_payload(request))


class LogoutView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        logout(request)
        return Response({"ok": True})


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(session_payload(request))

    def patch(self, request):
        serializer = ProfileSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(session_payload(request))


class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "auth"

    def post(self, request):
        serializer = ChangePasswordSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        request.user.set_password(serializer.validated_data["new_password"])
        request.user.save(update_fields=["password"])
        update_session_auth_hash(request, request.user)
        return Response({"ok": True})


class PasswordResetRequestView(EnforceCsrfMixin, APIView):
    permission_classes = [AllowAny]
    throttle_scope = "password_reset"

    def post(self, request):
        email = str(request.data.get("email", "")).strip().lower()
        user = User.objects.filter(email__iexact=email, is_active=True).first() if email else None
        if user is not None:
            services.send_password_reset(user)
        # Same response whether or not the account exists, to avoid account enumeration.
        return Response({"ok": True, "message": "If an account exists for that email, a reset link has been sent."})


class PasswordResetConfirmView(EnforceCsrfMixin, APIView):
    permission_classes = [AllowAny]
    throttle_scope = "password_reset"

    def post(self, request):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            uid = force_str(urlsafe_base64_decode(serializer.validated_data["uid"]))
            user = User.objects.get(pk=uid, is_active=True)
        except (User.DoesNotExist, ValueError, TypeError, OverflowError):
            user = None
        if user is None or not default_token_generator.check_token(user, serializer.validated_data["token"]):
            raise BusinessRuleError("This reset link is invalid or has expired.", code="invalid_token")
        from django.contrib.auth.password_validation import validate_password
        from django.core.exceptions import ValidationError as DjangoValidationError
        try:
            validate_password(serializer.validated_data["password"], user)
        except DjangoValidationError as exc:
            raise ValidationError({"password": list(exc.messages)})
        user.set_password(serializer.validated_data["password"])
        user.save(update_fields=["password"])
        return Response({"ok": True})


class SwitchWorkspaceView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        org_id = request.data.get("organization_id")
        membership = Membership.objects.select_related("organization", "user").filter(
            user=request.user, organization_id=org_id, status=Membership.Status.ACTIVE
        ).first()
        if membership is None:
            raise NotFound("Workspace not found.")
        activate_membership(request, membership)
        return Response(session_payload(request))


class CreateWorkspaceView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        name = str(request.data.get("name", "")).strip()
        if not name:
            raise ValidationError({"name": ["Workspace name is required."]})
        currency = request.data.get("currency") or "USD"
        org = services.create_workspace(owner=request.user, name=name[:150], currency=currency,
                                        tz=request.user.timezone)
        membership = Membership.objects.select_related("organization", "user").get(organization=org, user=request.user)
        activate_membership(request, membership)
        return Response(session_payload(request), status=status.HTTP_201_CREATED)


class InvitationLookupView(EnforceCsrfMixin, APIView):
    permission_classes = [AllowAny]
    throttle_scope = "auth"

    def get(self, request, token):
        invitation = Invitation.find_valid(token)
        if invitation is None:
            raise NotFound("This invitation is invalid, expired or has already been used.")
        return Response({
            "email": invitation.email,
            "organization": invitation.organization.name,
            "role": invitation.role,
            "role_label": invitation.get_role_display(),
            "account_exists": User.objects.filter(email__iexact=invitation.email).exists(),
        })

    def post(self, request, token):
        invitation = Invitation.find_valid(token)
        if invitation is None:
            raise NotFound("This invitation is invalid, expired or has already been used.")
        serializer = AcceptInvitationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        existing = User.objects.filter(email__iexact=invitation.email).first()
        if existing is not None:
            if not (request.user.is_authenticated and request.user.pk == existing.pk):
                password = serializer.validated_data.get("password")
                if not password or not existing.check_password(password):
                    raise BusinessRuleError("Sign in with your existing password to accept this invitation.",
                                            code="login_required")
            user = existing
        else:
            full_name = serializer.validated_data.get("full_name")
            password = serializer.validated_data.get("password")
            if not full_name or not password:
                raise ValidationError({"full_name": ["Required."], "password": ["Required."]})
            from django.contrib.auth.password_validation import validate_password
            from django.core.exceptions import ValidationError as DjangoValidationError
            try:
                validate_password(password, User(email=invitation.email, full_name=full_name))
            except DjangoValidationError as exc:
                raise ValidationError({"password": list(exc.messages)})
            user = User.objects.create_user(email=invitation.email, password=password, full_name=full_name)
        membership = services.accept_invitation(invitation=invitation, user=user)
        login(request, user, backend="django.contrib.auth.backends.ModelBackend")
        activate_membership(request, Membership.objects.select_related("organization", "user").get(pk=membership.pk))
        return Response(session_payload(request))


class WorkspaceSettingsView(APIView):
    def get_permissions(self):
        if self.request.method == "GET":
            return [IsStaff()]
        return [IsWorkspaceAdmin()]

    def get(self, request):
        return Response(OrganizationSerializer(request.org, context={"request": request}).data)

    def patch(self, request):
        serializer = OrganizationSerializer(request.org, data=request.data, partial=True, context={"request": request})
        serializer.is_valid(raise_exception=True)
        serializer.save()
        log_activity(organization=request.org, actor=request.user, verb="updated_settings", target=request.org,
                     fields=sorted(serializer.validated_data.keys()))
        return Response(serializer.data)


class WorkspaceLogoView(APIView):
    parser_classes = [MultiPartParser]

    def get_permissions(self):
        if self.request.method == "GET":
            return [InWorkspace()]
        return [IsWorkspaceAdmin()]

    def get(self, request):
        if not request.org.logo:
            raise NotFound()
        return file_download_response(request.org.logo, request.org.logo.name.rsplit("/", 1)[-1], inline=True)

    def post(self, request):
        upload = request.FILES.get("file")
        validate_upload(upload, allowed=IMAGE_EXTENSIONS)
        request.org.logo.save(f"org_{request.org.pk}_logo_{upload.name}"[-80:], upload, save=True)
        return Response(OrganizationSerializer(request.org, context={"request": request}).data)

    def delete(self, request):
        if request.org.logo:
            request.org.logo.delete(save=True)
        return Response(status=status.HTTP_204_NO_CONTENT)


class NotificationPreferencesView(APIView):
    permission_classes = [InWorkspace]

    def get(self, request):
        return Response([
            {"kind": kind, "label": label, **preference_for(request.membership, kind)}
            for kind, (label, _) in NOTIFICATION_KINDS.items()
        ])

    def put(self, request):
        prefs = request.membership.notification_prefs or {}
        for item in request.data if isinstance(request.data, list) else []:
            kind = item.get("kind")
            if kind in NOTIFICATION_KINDS:
                prefs[kind] = {"in_app": bool(item.get("in_app", True)), "email": bool(item.get("email", False))}
        request.membership.notification_prefs = prefs
        request.membership.save(update_fields=["notification_prefs"])
        return self.get(request)


class MemberViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin, viewsets.GenericViewSet):
    serializer_class = MemberSerializer

    def get_permissions(self):
        if self.action in ("list", "retrieve"):
            return [IsStaff()]
        return [IsWorkspaceAdmin()]

    def get_queryset(self):
        qs = Membership.objects.filter(organization=self.request.org).select_related("user", "client")
        role = self.request.query_params.get("role")
        if role == "staff":
            qs = qs.exclude(role=Role.CLIENT)
        elif role:
            qs = qs.filter(role=role)
        if self.request.query_params.get("status"):
            qs = qs.filter(status=self.request.query_params["status"])
        if self.request.query_params.get("client"):
            qs = qs.filter(client_id=self.request.query_params["client"])
        return qs.order_by("user__full_name")

    def perform_update(self, serializer):
        target = serializer.instance
        actor = self.request.membership
        new_role = serializer.validated_data.get("role", target.role)
        if target.role == Role.OWNER and actor.role != Role.OWNER:
            raise PermissionDenied("Only owners can change another owner's membership.")
        if new_role == Role.OWNER and actor.role != Role.OWNER:
            raise PermissionDenied("Only owners can grant the owner role.")
        if target.role == Role.CLIENT and new_role != Role.CLIENT:
            raise BusinessRuleError("Client portal accounts cannot be converted to internal roles.")
        if target.role == Role.OWNER and new_role != Role.OWNER:
            services.assert_not_last_owner(target)
        financial = {"cost_rate", "default_bill_rate", "can_manage_billing"} & set(serializer.validated_data)
        if financial and not actor.has_billing_access:
            raise PermissionDenied("Billing access is required to change rates.")
        extra = {}
        if new_role == Role.ADMIN and target.role != Role.ADMIN and not actor.has_billing_access:
            # A promotion by someone without billing access never carries billing access with it.
            extra["can_manage_billing"] = False
        serializer.save(**extra)
        log_activity(organization=self.request.org, actor=self.request.user, verb="updated_member",
                     target_type="membership", target_id=target.pk, target_label=target.user.full_name,
                     fields=sorted(serializer.validated_data.keys()))

    @action(detail=True, methods=["post"])
    def deactivate(self, request, pk=None):
        target = self.get_object()
        if target.user_id == request.user.id:
            raise BusinessRuleError("You cannot deactivate your own membership.")
        if target.role == Role.OWNER and request.membership.role != Role.OWNER:
            raise PermissionDenied("Only owners can deactivate an owner.")
        services.assert_not_last_owner(target)
        target.status = Membership.Status.DEACTIVATED
        target.deactivated_at = timezone.now()
        target.save(update_fields=["status", "deactivated_at"])
        log_activity(organization=request.org, actor=request.user, verb="deactivated_member", target_type="membership",
                     target_id=target.pk, target_label=target.user.full_name)
        return Response(self.get_serializer(target).data)

    @action(detail=True, methods=["post"])
    def reactivate(self, request, pk=None):
        target = self.get_object()
        actor = request.membership
        if target.role == Role.OWNER and actor.role != Role.OWNER:
            raise PermissionDenied("Only owners can reactivate an owner.")
        target.status = Membership.Status.ACTIVE
        target.deactivated_at = None
        fields = ["status", "deactivated_at"]
        if target.role == Role.ADMIN and target.can_manage_billing and not actor.has_billing_access:
            # Reactivation by someone without billing access does not restore billing access.
            target.can_manage_billing = False
            fields.append("can_manage_billing")
        target.save(update_fields=fields)
        log_activity(organization=request.org, actor=request.user, verb="reactivated_member", target_type="membership",
                     target_id=target.pk, target_label=target.user.full_name)
        return Response(self.get_serializer(target).data)


class InvitationViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, viewsets.GenericViewSet):
    serializer_class = InvitationSerializer

    def get_permissions(self):
        if self.action == "create" and self.request.data.get("role") == Role.CLIENT:
            from apps.core.permissions import IsManager
            return [IsManager()]
        return [IsWorkspaceAdmin()]

    def get_queryset(self):
        qs = Invitation.objects.filter(organization=self.request.org).select_related("client", "invited_by")
        if self.request.query_params.get("pending"):
            qs = qs.pending()
        return qs.order_by("-created_at")

    def create(self, request, *args, **kwargs):
        from apps.crm.models import Client

        serializer = InviteCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        client = None
        if data.get("client"):
            client = Client.objects.filter(organization=request.org, pk=data["client"]).first()
            if client is None:
                raise ValidationError({"client": ["Client not found."]})
        if data["role"] != Role.CLIENT and client is not None:
            raise ValidationError({"client": ["Only client portal invitations may reference a client."]})
        invitation, raw = services.invite_member(organization=request.org, email=data["email"], role=data["role"],
                                                 invited_by=request.user, client=client)
        payload = InvitationSerializer(invitation).data
        from django.conf import settings
        if settings.DEBUG:
            # Convenience for local development: the link is also written to the dev mailbox.
            payload["dev_accept_url"] = f"{settings.FRONTEND_URL}/accept-invite?token={raw}"
        return Response(payload, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def revoke(self, request, pk=None):
        invitation = self.get_object()
        if invitation.status != "pending":
            raise BusinessRuleError("Only pending invitations can be revoked.")
        invitation.revoked_at = timezone.now()
        invitation.save(update_fields=["revoked_at"])
        return Response(InvitationSerializer(invitation).data)
