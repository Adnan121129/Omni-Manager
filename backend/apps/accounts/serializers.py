import zoneinfo

from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

from apps.core.money import SUPPORTED_CURRENCIES

from .models import Invitation, Membership, Organization, Role, User

TIMEZONES = sorted(zoneinfo.available_timezones())


def validate_tz(value: str) -> str:
    if value not in zoneinfo.available_timezones():
        raise serializers.ValidationError("Unknown timezone.")
    return value


class SignupSerializer(serializers.Serializer):
    full_name = serializers.CharField(max_length=150)
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True, min_length=8)
    organization_name = serializers.CharField(max_length=150)
    currency = serializers.ChoiceField(choices=SUPPORTED_CURRENCIES, default="USD")
    timezone = serializers.CharField(default="UTC", validators=[validate_tz])

    def validate_email(self, value):
        value = value.lower()
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("An account with this email already exists.")
        return value

    def validate(self, attrs):
        validate_password(attrs["password"], User(email=attrs["email"], full_name=attrs["full_name"]))
        return attrs


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)


class ProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["id", "email", "full_name", "timezone", "initials"]
        read_only_fields = ["id", "email", "initials"]

    initials = serializers.CharField(read_only=True)

    def validate_timezone(self, value):
        return validate_tz(value)


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True, min_length=8)

    def validate(self, attrs):
        user = self.context["request"].user
        if not user.check_password(attrs["current_password"]):
            raise serializers.ValidationError({"current_password": ["Current password is incorrect."]})
        validate_password(attrs["new_password"], user)
        return attrs


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()
    password = serializers.CharField(write_only=True, min_length=8)


class OrganizationSerializer(serializers.ModelSerializer):
    has_logo = serializers.SerializerMethodField()

    class Meta:
        model = Organization
        fields = ["id", "name", "slug", "default_currency", "timezone", "week_start", "email", "phone", "website",
                  "address", "tax_id", "brand_color", "has_logo", "invoice_prefix", "next_invoice_number",
                  "default_payment_terms_days", "default_tax_rate", "tax_label", "invoice_footer",
                  "allow_partial_payments", "default_bill_rate", "is_demo", "created_at"]
        read_only_fields = ["id", "slug", "is_demo", "created_at", "has_logo"]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get("request")
        membership = self.context.get("membership") or getattr(request, "membership", None)
        # The default billing rate is financial data: only managers and billing users see it.
        if membership is None or not (membership.is_manager or membership.has_billing_access):
            data.pop("default_bill_rate", None)
        return data

    def get_has_logo(self, obj):
        return bool(obj.logo)

    def validate_timezone(self, value):
        return validate_tz(value)

    def validate_default_currency(self, value):
        if value not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError("Unsupported currency.")
        return value

    def validate_brand_color(self, value):
        import re
        if not re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
            raise serializers.ValidationError("Use a hex colour such as #4F46E5.")
        return value.upper()

    def validate_default_tax_rate(self, value):
        if value < 0 or value > 100:
            raise serializers.ValidationError("Tax rate must be between 0 and 100.")
        return value


class MembershipSummarySerializer(serializers.ModelSerializer):
    organization = serializers.SerializerMethodField()

    class Meta:
        model = Membership
        fields = ["id", "role", "organization"]

    def get_organization(self, obj):
        return {"id": obj.organization_id, "name": obj.organization.name, "slug": obj.organization.slug}


class MemberSerializer(serializers.ModelSerializer):
    user = serializers.SerializerMethodField()
    client_name = serializers.CharField(source="client.name", read_only=True, default=None)

    class Meta:
        model = Membership
        fields = ["id", "user", "role", "status", "client", "client_name", "title", "weekly_capacity_hours",
                  "working_days", "default_bill_rate", "cost_rate", "can_manage_billing", "joined_at",
                  "deactivated_at"]
        read_only_fields = ["id", "user", "status", "client", "client_name", "joined_at", "deactivated_at"]

    def get_user(self, obj):
        return {"id": obj.user_id, "full_name": obj.user.full_name, "email": obj.user.email,
                "initials": obj.user.initials}

    def validate_role(self, value):
        if value == Role.CLIENT:
            raise serializers.ValidationError("Use the client portal invitation flow for client accounts.")
        return value

    def validate_working_days(self, value):
        if not isinstance(value, list) or any(not isinstance(d, int) or d < 0 or d > 6 for d in value):
            raise serializers.ValidationError("Working days must be weekday numbers 0-6.")
        return sorted(set(value))

    def validate_weekly_capacity_hours(self, value):
        if value < 0 or value > 100:
            raise serializers.ValidationError("Capacity must be between 0 and 100 hours.")
        return value

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get("request")
        membership = getattr(request, "membership", None)
        # Rates are financial data - only visible to billing-enabled admins.
        if membership is None or not membership.has_billing_access:
            data.pop("cost_rate", None)
            data.pop("default_bill_rate", None)
        return data


class InvitationSerializer(serializers.ModelSerializer):
    status = serializers.CharField(read_only=True)
    client_name = serializers.CharField(source="client.name", read_only=True, default=None)
    invited_by_name = serializers.CharField(source="invited_by.full_name", read_only=True, default=None)

    class Meta:
        model = Invitation
        fields = ["id", "email", "role", "client", "client_name", "status", "invited_by_name", "created_at",
                  "expires_at", "accepted_at"]
        read_only_fields = fields


class InviteCreateSerializer(serializers.Serializer):
    email = serializers.EmailField()
    role = serializers.ChoiceField(choices=[Role.ADMIN, Role.PROJECT_MANAGER, Role.MEMBER, Role.CLIENT])
    client = serializers.IntegerField(required=False, allow_null=True)


class AcceptInvitationSerializer(serializers.Serializer):
    full_name = serializers.CharField(max_length=150, required=False)
    password = serializers.CharField(write_only=True, required=False, min_length=8)
