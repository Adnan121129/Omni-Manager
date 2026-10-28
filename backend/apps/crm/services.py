from django.db import transaction
from django.utils import timezone

from apps.core.activity import log_activity
from apps.core.exceptions import BusinessRuleError

from .models import Client, Interaction, Lead


def find_duplicate_client(lead: Lead) -> Client | None:
    qs = Client.objects.filter(organization_id=lead.organization_id).exclude(status=Client.Status.ARCHIVED)
    match = qs.filter(name__iexact=lead.company.strip()).first()
    if match is None and lead.email:
        match = qs.filter(email__iexact=lead.email).first()
    return match


@transaction.atomic
def convert_lead(*, lead: Lead, actor, existing_client: Client | None = None) -> Client:
    """
    Converts a lead into a client. If a matching client already exists (same company name or
    email) it is linked instead of creating a duplicate. Lead interactions are attached to the
    client so the relationship history stays in one timeline.
    """
    lead = Lead.objects.select_for_update(of=("self",)).get(pk=lead.pk)
    if lead.converted_client_id:
        raise BusinessRuleError("This lead has already been converted.", code="already_converted")
    if lead.stage == Lead.Stage.LOST:
        raise BusinessRuleError("Lost leads cannot be converted. Reopen the lead first.")

    client = existing_client or find_duplicate_client(lead)
    created = client is None
    if created:
        client = Client.objects.create(
            organization_id=lead.organization_id, name=lead.company.strip(), contact_name=lead.contact_name,
            email=lead.email, phone=lead.phone, currency=lead.currency, owner=lead.owner or actor,
            notes=lead.notes,
        )
    lead.converted_client = client
    lead.converted_at = timezone.now()
    lead.stage = Lead.Stage.WON
    lead.save(update_fields=["converted_client", "converted_at", "stage", "updated_at"])
    Interaction.objects.filter(lead=lead, client__isnull=True).update(client=client)
    log_activity(organization=lead.organization, actor=actor, verb="converted_lead", target=lead, client=client,
                 created_client=created)
    if created:
        log_activity(organization=lead.organization, actor=actor, verb="created", target=client, source="lead")
    return client


def portal_users(client: Client):
    """Active client-portal accounts linked to this client."""
    from apps.accounts.models import Membership, Role

    return [m.user for m in Membership.objects.filter(organization_id=client.organization_id, client=client,
                                                       role=Role.CLIENT, status=Membership.Status.ACTIVE)
            .select_related("user")]
