/**
 * Core type definitions for AI CRM Backend
 */

export interface Project {
  id?: string;
  project_id: string; // External ID (unique)
  project_name: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  country?: string;
  awarded_date?: string | Date;
  source_platform?: string;
  is_multi_package?: boolean;
  project_status?: string;
  painting_package_status?: string;
  priority_score?: number;
  last_contacted_at?: string | Date;
  next_call_eligible_at?: string | Date;
  call_suppressed?: boolean;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export interface Contact {
  id?: string;
  contact_id?: string; // External ID (optional)
  name: string;
  phone?: string;
  email?: string;
  global_role?: string;
  authority_level?: string;
  preferred_channel?: 'phone' | 'email' | 'sms';
  do_not_call?: boolean;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export interface ProjectContact {
  id?: string;
  project_id: string;
  contact_id: string;
  role_for_project?: string;
  role_confidence?: number;
  role_confirmed?: boolean;
  preferred_channel_project?: 'phone' | 'email' | 'sms';
  last_contacted_at?: string | Date;
  suppress_for_project?: boolean;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export interface CallSession {
  id?: string;
  call_session_id?: string; // External ID (optional, for idempotency)
  project_id: string;
  contact_id?: string;
  call_type: 'ai' | 'human';
  call_status: string;
  detected_role?: string;
  role_confidence?: number;
  outcome?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  escalated?: boolean;
  escalation_reason?: string;
  transcript?: string;
  recording_url?: string;
  started_at?: string | Date;
  ended_at?: string | Date;
  created_at?: string | Date;
}

export interface TerminalSession {
  id?: string;
  terminal_id?: string; // External ID (optional, for idempotency)
  scope: 'project' | 'contact' | 'global';
  project_id?: string;
  contact_id?: string;
  reason: string;
  created_by?: string;
  expires_at?: string | Date;
  override_allowed?: boolean;
  created_at?: string | Date;
  updated_at?: string | Date;
}

export interface EligibleCall {
  project_id: string;
  project_name: string;
  contact_id: string;
  contact_name: string;
  phone: string;
  role_for_project?: string;
  role_confidence?: number;
  preferred_channel?: string;
}

export interface IdempotencyKey {
  key: string;
  resource_type: string;
  resource_id: string;
  created_at: Date;
}
