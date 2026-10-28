import type { MoneyAmount } from "./format";

export type Role = "owner" | "admin" | "project_manager" | "member" | "client";

export interface UserSummary {
  id: number;
  full_name: string;
  email: string;
  initials: string;
}

export interface Organization {
  id: number;
  name: string;
  slug?: string;
  default_currency: string;
  timezone: string;
  week_start?: number;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  tax_id?: string;
  brand_color: string;
  has_logo: boolean;
  invoice_prefix?: string;
  next_invoice_number?: number;
  default_payment_terms_days?: number;
  default_tax_rate?: string;
  tax_label?: string;
  invoice_footer?: string;
  allow_partial_payments?: boolean;
  default_bill_rate?: string;
  is_demo?: boolean;
}

export interface Permissions {
  is_client: boolean;
  is_admin: boolean;
  is_manager: boolean;
  is_owner: boolean;
  billing: boolean;
  manage_team: boolean;
  approve_time: boolean;
  reports: boolean;
}

export interface Session {
  user: { id: number; email: string; full_name: string; timezone: string; initials: string };
  workspaces: { id: number; name: string; role: Role }[];
  membership: { id: number; role: Role; role_label: string; title: string; client: { id: number; name: string } | null } | null;
  organization: Organization | null;
  permissions: Permissions | null;
}

export interface Client {
  id: number;
  name: string;
  contact_name: string;
  email: string;
  phone: string;
  website: string;
  industry: string;
  billing_email: string;
  tax_id: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  currency: string;
  payment_terms_days: number | null;
  status: "active" | "inactive" | "archived";
  notes: string;
  owner: number | null;
  owner_detail: UserSummary | null;
  active_projects: number;
  outstanding?: string | null;
  portal_users: number;
  created_at: string;
}

export type LeadStage = "new" | "contacted" | "qualified" | "proposal" | "won" | "lost";

export interface Lead {
  id: number;
  title: string;
  company: string;
  contact_name: string;
  email: string;
  phone: string;
  source: string;
  stage: LeadStage;
  value: string;
  currency: string;
  expected_close_date: string | null;
  next_follow_up: string | null;
  notes: string;
  owner: number | null;
  owner_detail: UserSummary | null;
  position: number;
  converted_client: number | null;
  converted_client_name: string | null;
  lost_reason: string;
  created_at: string;
}

export interface Interaction {
  id: number;
  client: number | null;
  lead: number | null;
  kind: "note" | "call" | "email" | "meeting";
  summary: string;
  occurred_at: string;
  follow_up_date: string | null;
  follow_up_done: boolean;
  author: UserSummary | null;
}

export interface HealthSignal {
  key: string;
  level: "ok" | "at_risk" | "critical";
  reason: string;
}

export interface Health {
  status: "healthy" | "at_risk" | "critical" | "closed";
  signals: HealthSignal[];
}

export interface Progress {
  percent: number;
  basis: string;
  tasks_total: number;
  tasks_done: number;
  tasks_overdue: number;
  milestones_total: number;
  milestones_done: number;
  milestones_overdue: number;
}

export interface Budget {
  currency: string;
  budget_period?: "project" | "month";
  hours_used?: string;
  hours_tracked: string;
  hours_billable: string;
  hours_non_billable?: string;
  hours_pending_approval?: string;
  hours_budget: string;
  hours_percent: string | null;
  billable_value?: string;
  billable_expenses?: string;
  fees_used?: string;
  fees_budget?: string;
  fees_percent?: string | null;
  fees_remaining?: string | null;
  used_percent?: string | null;
  alert_level?: number;
  expense_cost?: string;
  expenses_estimated?: string;
  expenses_percent?: string | null;
  labor_cost?: string;
  total_cost?: string;
  invoiced?: string;
  collected?: string;
  unbilled_approved_value?: string;
  revenue_basis?: string;
  revenue_basis_label?: string;
  estimated_margin?: string;
  estimated_margin_percent?: string | null;
  projected_fees_at_completion?: string | null;
}

export type ProjectStatus = "planning" | "active" | "on_hold" | "completed" | "cancelled";
export type Priority = "low" | "medium" | "high" | "urgent";

export interface ProjectMember {
  id: number;
  user: UserSummary;
  role: string;
  bill_rate?: string | null;
}

export interface Project {
  id: number;
  code: string;
  name: string;
  description: string;
  client: number;
  client_name: string;
  manager: number | null;
  manager_detail: UserSummary | null;
  status: ProjectStatus;
  priority: Priority;
  start_date: string | null;
  deadline: string | null;
  completed_at: string | null;
  project_type: "fixed" | "hourly" | "retainer";
  currency: string;
  budget_amount?: string;
  budget_hours: string;
  estimated_expenses?: string;
  hourly_rate?: string | null;
  retainer_amount?: string;
  retainer_hours: string;
  billing_notes?: string;
  client_visible: boolean;
  color: string;
  can_manage: boolean;
  progress?: Progress;
  health?: Health;
  budget?: Budget;
  members?: ProjectMember[];
  retainer?: { month_start: string; hours_used: string; hours_included: string; percent: string | null } | null;
  completion_blockers?: {
    open_tasks: { id: number; title: string }[];
    open_tasks_count: number;
    open_milestones: { id: number; name: string }[];
    pending_deliverables: { id: number; title: string }[];
  } | null;
}

export type TaskStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Task {
  id: number;
  key: string;
  number: number;
  project: number;
  project_code: string;
  project_name: string;
  client_name: string;
  parent: number | null;
  milestone: number | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assignee: number | null;
  assignee_detail: UserSummary | null;
  created_by_detail: UserSummary | null;
  start_date: string | null;
  due_date: string | null;
  estimated_hours: string | null;
  billable: boolean;
  rate_override?: string | null;
  labels: number[];
  label_details: Label[];
  reference_url: string;
  position: number;
  completed_at: string | null;
  created_at: string;
  tracked_seconds: number;
  subtask_count: number;
  subtask_done: number;
  blocked_by: { id: number; title: string; status: TaskStatus }[];
  is_blocked: boolean;
  subtasks?: Task[];
  blocking?: { id: number; title: string; status: TaskStatus }[];
}

export interface Milestone {
  id: number;
  project: number;
  name: string;
  description: string;
  due_date: string | null;
  status: "pending" | "in_progress" | "completed";
  completed_at: string | null;
  /** Only returned to people who can manage the project. */
  amount?: string;
  client_visible: boolean;
  position: number;
  task_count: number;
  task_done: number;
  is_invoiced: boolean;
}

export interface Deliverable {
  id: number;
  project: number;
  milestone: number | null;
  milestone_name: string | null;
  title: string;
  description: string;
  status: "draft" | "pending_approval" | "approved" | "changes_requested";
  due_date: string | null;
  revision: number;
  submitted_at: string | null;
  submitted_by_detail: UserSummary | null;
  decided_at: string | null;
  decided_by_detail: UserSummary | null;
  decision_comment: string;
}

export interface ChangeRequest {
  id: number;
  project: number;
  project_code: string;
  currency: string;
  title: string;
  description: string;
  estimated_hours: string;
  estimated_cost: string;
  revised_deadline: string | null;
  status: "draft" | "pending_client" | "approved" | "rejected" | "applied";
  requested_by_detail: UserSummary | null;
  sent_at: string | null;
  decided_at: string | null;
  decided_by_detail: UserSummary | null;
  decision_comment: string;
  applied_at: string | null;
  /** Only returned to people who can manage the project. */
  applied_snapshot?: { before?: Record<string, string | null>; after?: Record<string, string | null> };
  created_at: string;
}

export type EntryStatus = "draft" | "submitted" | "approved" | "rejected";

export interface TimeEntry {
  id: number;
  user: UserSummary;
  project: number;
  project_detail: { id: number; code: string; name: string; client_id: number; client_name: string; color: string; currency: string };
  task: number | null;
  task_detail: { id: number; title: string; key: string } | null;
  description: string;
  date: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  elapsed_seconds: number;
  source: "timer" | "manual";
  timer_state: "running" | "paused" | "stopped";
  accumulated_seconds: number;
  segment_started_at: string | null;
  billable: boolean;
  bill_rate?: string;
  amount: string | null;
  status: EntryStatus;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  rejected_by_name: string | null;
  rejection_reason: string;
  is_invoiced: boolean;
  billing_status: "non_billable" | "invoiced" | "unbilled";
  can_edit: boolean;
}

export interface Expense {
  id: number;
  user: UserSummary;
  project: number | null;
  project_detail: { id: number; code: string; name: string } | null;
  client: number | null;
  client_name: string | null;
  category: number | null;
  category_name: string | null;
  vendor: string;
  description: string;
  date: string;
  amount: string;
  currency: string;
  billable: boolean;
  billable_amount: string;
  status: EntryStatus;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  rejection_reason: string;
  has_receipt: boolean;
  receipt_name: string;
  is_invoiced: boolean;
  can_edit: boolean;
}

export type InvoiceStatus = "draft" | "sent" | "partially_paid" | "paid" | "credited" | "void" | "overdue";

export interface InvoiceLine {
  id: number;
  kind: "time" | "expense" | "milestone" | "service";
  project: number | null;
  project_code: string | null;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  amount: string;
  position: number;
  source_count: number;
}

export interface Payment {
  id: number;
  invoice: number;
  invoice_number: string;
  client_name: string;
  amount: string;
  currency: string;
  method: string;
  provider: string;
  provider_reference: string;
  status: "succeeded" | "reversed";
  received_at: string;
  recorded_by_name: string | null;
  note: string;
  reversed_at: string | null;
  reversal_reason: string;
}

export interface Invoice {
  id: number;
  number: string;
  client: number;
  client_name: string;
  status: Exclude<InvoiceStatus, "overdue">;
  display_status: InvoiceStatus;
  is_overdue: boolean;
  currency: string;
  issue_date: string;
  due_date: string;
  payment_terms: string;
  notes: string;
  discount_type: "none" | "percent" | "amount";
  discount_value: string;
  tax_rate: string;
  tax_label: string;
  subtotal: string;
  discount_amount: string;
  tax_amount: string;
  total: string;
  amount_paid: string;
  amount_credited: string;
  amount_due: string;
  allow_online_payment: boolean;
  sent_at: string | null;
  viewed_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string;
  created_by_name: string | null;
  recurring_schedule: number | null;
  project_codes: string[];
  lines?: InvoiceLine[];
  payments?: Payment[];
  credit_notes?: { id: number; number: string; amount: string; reason: string; created_by_name: string | null; created_at: string }[];
  checkouts?: { id: number; provider: string; amount: string; currency: string; status: string; failure_reason: string; created_at: string }[];
  client_detail?: { id: number; name: string; email: string; address: string };
  activity?: Activity[];
}

export interface Activity {
  id: number;
  actor: UserSummary | null;
  verb: string;
  target_type: string;
  target_id: number | null;
  target_label: string;
  project: number | null;
  client: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  is_read: boolean;
  created_at: string;
}

export interface Comment {
  id: number;
  author: UserSummary | null;
  author_is_client: boolean;
  body: string;
  client_visible: boolean;
  created_at: string;
}

export interface Attachment {
  id: number;
  original_name: string;
  content_type_header: string;
  size: number;
  client_visible: boolean;
  uploaded_by: UserSummary | null;
  created_at: string;
  download_url: string;
}

export interface Member {
  id: number;
  user: UserSummary;
  role: Role;
  status: "active" | "deactivated";
  client: number | null;
  client_name: string | null;
  title: string;
  weekly_capacity_hours: string;
  working_days: number[];
  default_bill_rate?: string | null;
  cost_rate?: string;
  can_manage_billing: boolean;
  joined_at: string;
}

export interface DocumentRecord {
  id: number;
  kind: "contract" | "proposal";
  title: string;
  client: number;
  client_name: string;
  project: number | null;
  project_code: string | null;
  template: number | null;
  body: string;
  scope: string;
  pricing_items: { description: string; quantity: string; unit_price: string }[];
  total_amount: string;
  currency: string;
  payment_terms: string;
  milestones_summary: string;
  expires_at: string | null;
  status: "draft" | "sent" | "viewed" | "signed" | "declined" | "expired";
  current_version: number;
  signer: number | null;
  signer_name: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  decline_reason: string;
  created_by_name: string | null;
  created_at: string;
}

export type { MoneyAmount };
