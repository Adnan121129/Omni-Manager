from decimal import Decimal

from rest_framework import serializers

from apps.core.money import SUPPORTED_CURRENCIES
from apps.core.serializers import OrgPKField, UserSummarySerializer
from apps.crm.models import Client
from apps.projects.models import Project
from apps.projects.serializers import VisibleProjectField

from .models import (
    CheckoutSession,
    CreditNote,
    Expense,
    ExpenseCategory,
    Invoice,
    InvoiceLine,
    Payment,
    RecurringInvoiceSchedule,
)


class ExpenseCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = ExpenseCategory
        fields = ["id", "name", "is_active"]


class ExpenseSerializer(serializers.ModelSerializer):
    project = VisibleProjectField(required=False, allow_null=True)
    category = OrgPKField(queryset=ExpenseCategory.objects.all(), required=False, allow_null=True)
    user = UserSummarySerializer(read_only=True)
    approved_by_name = serializers.CharField(source="approved_by.full_name", read_only=True, default=None)
    project_detail = serializers.SerializerMethodField()
    category_name = serializers.CharField(source="category.name", read_only=True, default=None)
    client_name = serializers.CharField(source="client.name", read_only=True, default=None)
    has_receipt = serializers.SerializerMethodField()
    is_invoiced = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()
    billable_amount = serializers.DecimalField(max_digits=12, decimal_places=2, required=False, allow_null=True)
    currency = serializers.CharField(max_length=3, required=False)

    class Meta:
        model = Expense
        fields = ["id", "user", "project", "project_detail", "client", "client_name", "category", "category_name",
                  "vendor", "description", "date", "amount", "currency", "billable", "billable_amount", "status",
                  "submitted_at", "approved_at", "approved_by_name", "rejection_reason", "has_receipt",
                  "receipt_name", "is_invoiced", "can_edit", "created_at", "updated_at"]
        read_only_fields = ["id", "client", "status", "submitted_at", "approved_at", "rejection_reason",
                            "receipt_name", "created_at", "updated_at"]

    def get_project_detail(self, obj):
        if not obj.project_id:
            return None
        return {"id": obj.project_id, "code": obj.project.code, "name": obj.project.name}

    def get_has_receipt(self, obj):
        return bool(obj.receipt)

    def get_is_invoiced(self, obj):
        return obj.invoice_line_id is not None

    def get_can_edit(self, obj):
        request = self.context.get("request")
        return bool(request and obj.user_id == request.user.id and obj.status in Expense.EDITABLE_STATUSES)

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Amount must be greater than zero.")
        return value

    def validate_billable_amount(self, value):
        if value is not None and value < 0:
            raise serializers.ValidationError("Must be zero or more.")
        return value

    def validate_currency(self, value):
        value = value.upper()
        if value not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError("Unsupported currency.")
        return value


class InvoiceLineSerializer(serializers.ModelSerializer):
    project = OrgPKField(queryset=Project.objects.all(), required=False, allow_null=True)
    project_code = serializers.CharField(source="project.code", read_only=True, default=None)
    source_count = serializers.SerializerMethodField()

    class Meta:
        model = InvoiceLine
        fields = ["id", "kind", "project", "project_code", "description", "quantity", "unit", "unit_price", "amount",
                  "position", "source_count"]
        read_only_fields = ["id", "kind", "amount", "source_count"]

    def get_source_count(self, obj):
        if obj.kind == InvoiceLine.Kind.TIME:
            return obj.time_entries.count()
        if obj.kind == InvoiceLine.Kind.EXPENSE:
            return obj.expenses.count()
        if obj.kind == InvoiceLine.Kind.MILESTONE:
            return obj.milestones.count()
        return 0

    def validate_quantity(self, value):
        if value <= 0:
            raise serializers.ValidationError("Quantity must be greater than zero.")
        return value

    def validate_unit_price(self, value):
        if value < 0:
            raise serializers.ValidationError("Price cannot be negative.")
        return value


class PaymentSerializer(serializers.ModelSerializer):
    recorded_by_name = serializers.CharField(source="recorded_by.full_name", read_only=True, default=None)
    invoice_number = serializers.CharField(source="invoice.number", read_only=True)
    client_name = serializers.CharField(source="invoice.client.name", read_only=True)

    class Meta:
        model = Payment
        fields = ["id", "invoice", "invoice_number", "client_name", "amount", "currency", "method", "provider",
                  "provider_reference", "status", "received_at", "recorded_by_name", "note", "reversed_at",
                  "reversal_reason", "created_at"]


class CreditNoteSerializer(serializers.ModelSerializer):
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)

    class Meta:
        model = CreditNote
        fields = ["id", "number", "amount", "reason", "created_by_name", "created_at"]


class CheckoutSerializer(serializers.ModelSerializer):
    class Meta:
        model = CheckoutSession
        fields = ["id", "provider", "amount", "currency", "status", "failure_reason", "checkout_url", "created_at",
                  "completed_at"]


class InvoiceSerializer(serializers.ModelSerializer):
    client = OrgPKField(queryset=Client.objects.all())
    client_name = serializers.CharField(source="client.name", read_only=True)
    display_status = serializers.CharField(read_only=True)
    is_overdue = serializers.BooleanField(read_only=True)
    created_by_name = serializers.CharField(source="created_by.full_name", read_only=True, default=None)
    project_codes = serializers.SerializerMethodField()

    class Meta:
        model = Invoice
        fields = ["id", "number", "client", "client_name", "status", "display_status", "is_overdue", "currency",
                  "issue_date", "due_date", "payment_terms", "notes", "discount_type", "discount_value", "tax_rate",
                  "tax_label", "subtotal", "discount_amount", "tax_amount", "total", "amount_paid", "amount_credited",
                  "amount_due", "allow_online_payment", "sent_at", "viewed_at", "paid_at", "voided_at", "void_reason",
                  "created_by_name", "recurring_schedule", "project_codes", "created_at", "updated_at"]
        read_only_fields = ["id", "number", "status", "subtotal", "discount_amount", "tax_amount", "total",
                            "amount_paid", "amount_credited", "amount_due", "sent_at", "viewed_at", "paid_at",
                            "voided_at", "void_reason", "recurring_schedule", "created_at", "updated_at"]

    def get_project_codes(self, obj):
        codes = getattr(obj, "_project_codes", None)
        if codes is None:
            codes = sorted({line.project.code for line in obj.lines.all() if line.project_id})
        return codes

    def validate_currency(self, value):
        value = value.upper()
        if value not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError("Unsupported currency.")
        if self.instance and self.instance.lines.exists() and value != self.instance.currency:
            raise serializers.ValidationError("Currency cannot change once the invoice has lines.")
        return value

    def validate_tax_rate(self, value):
        if value < 0 or value > 100:
            raise serializers.ValidationError("Tax rate must be between 0 and 100.")
        return value

    def validate_discount_value(self, value):
        if value < 0:
            raise serializers.ValidationError("Discount cannot be negative.")
        return value

    def validate(self, attrs):
        issue = attrs.get("issue_date", getattr(self.instance, "issue_date", None))
        due = attrs.get("due_date", getattr(self.instance, "due_date", None))
        if issue and due and due < issue:
            raise serializers.ValidationError({"due_date": ["Due date cannot be before the issue date."]})
        if attrs.get("discount_type") == Invoice.DiscountType.PERCENT and attrs.get("discount_value", Decimal(0)) > 100:
            raise serializers.ValidationError({"discount_value": ["Percentage discounts cannot exceed 100%."]})
        if self.instance is not None and "client" in attrs and attrs["client"].pk != self.instance.client_id \
                and self.instance.lines.exclude(kind=InvoiceLine.Kind.SERVICE).exists():
            raise serializers.ValidationError({"client": ["Remove work-based lines before changing the client."]})
        return attrs


class ManualLineSerializer(serializers.Serializer):
    description = serializers.CharField(max_length=500)
    quantity = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    unit = serializers.CharField(max_length=20, required=False, allow_blank=True, default="")
    unit_price = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0"))
    project = OrgPKField(queryset=Project.objects.all(), required=False, allow_null=True)


class GenerateInvoiceSerializer(serializers.Serializer):
    client = OrgPKField(queryset=Client.objects.all())
    projects = serializers.ListField(child=serializers.IntegerField(), min_length=1)
    include_time = serializers.BooleanField(default=True)
    include_expenses = serializers.BooleanField(default=True)
    milestones = serializers.ListField(child=serializers.IntegerField(), required=False, default=list)
    date_from = serializers.DateField(required=False, allow_null=True)
    date_to = serializers.DateField(required=False, allow_null=True)
    grouping = serializers.ChoiceField(choices=["task", "person", "project", "entry"], default="task")
    due_date = serializers.DateField(required=False, allow_null=True)
    notes = serializers.CharField(required=False, allow_blank=True, default="")
    idempotency_key = serializers.CharField(max_length=80, required=False, allow_blank=True)


class RecurringScheduleSerializer(serializers.ModelSerializer):
    client = OrgPKField(queryset=Client.objects.all())
    project = OrgPKField(queryset=Project.objects.all(), required=False, allow_null=True)
    client_name = serializers.CharField(source="client.name", read_only=True)
    project_code = serializers.CharField(source="project.code", read_only=True, default=None)
    invoice_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = RecurringInvoiceSchedule
        fields = ["id", "client", "client_name", "project", "project_code", "name", "frequency", "start_date",
                  "next_run_date", "end_date", "is_active", "currency", "line_items", "tax_rate", "discount_type",
                  "discount_value", "payment_terms_days", "notes", "auto_send", "last_generated_at", "invoice_count",
                  "created_at"]
        read_only_fields = ["id", "next_run_date", "last_generated_at", "created_at"]

    def validate_line_items(self, value):
        from .recurring import validate_line_items
        from apps.core.exceptions import BusinessRuleError
        try:
            return validate_line_items(value)
        except BusinessRuleError as exc:
            raise serializers.ValidationError(str(exc.detail))

    def validate_currency(self, value):
        value = value.upper()
        if value not in SUPPORTED_CURRENCIES:
            raise serializers.ValidationError("Unsupported currency.")
        return value

    def validate(self, attrs):
        project = attrs.get("project", getattr(self.instance, "project", None))
        client = attrs.get("client", getattr(self.instance, "client", None))
        if project is not None and project.client_id != client.pk:
            raise serializers.ValidationError({"project": ["The project must belong to the selected client."]})
        start = attrs.get("start_date", getattr(self.instance, "start_date", None))
        end = attrs.get("end_date", getattr(self.instance, "end_date", None))
        if start and end and end < start:
            raise serializers.ValidationError({"end_date": ["End date must be after the start date."]})
        return attrs
