-- ============================================================================
-- AI CRM Backend Database Schema
-- Production-ready schema for AI outbound calling + CRM system
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CRM Projects Table
-- Normalized and CRM-managed projects (separate from raw scraped projects table)
-- ============================================================================
CREATE TABLE IF NOT EXISTS crm_projects (
    -- Primary key (internal)
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- External identifier (unique, used for idempotency)
    project_id VARCHAR(255) NOT NULL UNIQUE,
    
    -- Project details (aligned with HubSpot/CSV)
    name VARCHAR(500) NOT NULL,
    address VARCHAR(500),
    suburb VARCHAR(255),
    postcode VARCHAR(50),
    state VARCHAR(100),
    category VARCHAR(255),
    awarded_date DATE,
    distance DECIMAL(12, 4),
    budget VARCHAR(255),
    quotes_due_date DATE,
    country VARCHAR(100) DEFAULT 'AU',
    
    -- Call management
    last_contacted_at TIMESTAMP WITH TIME ZONE,
    next_call_eligible_at TIMESTAMP WITH TIME ZONE,
    call_suppressed BOOLEAN DEFAULT false,
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT crm_projects_project_id_key UNIQUE (project_id)
);

CREATE INDEX idx_crm_projects_project_id ON crm_projects(project_id);
CREATE INDEX idx_crm_projects_next_call_eligible_at ON crm_projects(next_call_eligible_at) WHERE call_suppressed = false;
CREATE INDEX idx_crm_projects_call_suppressed ON crm_projects(call_suppressed);

-- ============================================================================
-- Contacts Table
-- Source of truth for all contacts (aligned with HubSpot/CSV)
-- ============================================================================
CREATE TABLE IF NOT EXISTS contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contact_id VARCHAR(255),
    name VARCHAR(500) NOT NULL,
    email VARCHAR(255),
    companyname VARCHAR(500),
    phonenumber VARCHAR(50),
    global_role VARCHAR(100),
    authority_level VARCHAR(100),
    preferred_channel VARCHAR(50),
    do_not_call BOOLEAN DEFAULT false,
    last_ai_contact TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_contacts_contact_id_unique ON contacts(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_contacts_contact_id ON contacts(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_contacts_phonenumber ON contacts(phonenumber) WHERE phonenumber IS NOT NULL;
CREATE INDEX idx_contacts_email ON contacts(email) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_do_not_call ON contacts(do_not_call);

-- ============================================================================
-- ProjectContact Junction Table
-- project_id = crm_projects.project_id (external), contact_id = contacts.contact_id (external)
-- ============================================================================
CREATE TABLE IF NOT EXISTS project_contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id VARCHAR(255) NOT NULL REFERENCES crm_projects(project_id) ON DELETE CASCADE,
    contact_id VARCHAR(255) NOT NULL,
    role_for_project VARCHAR(100),
    role_confidence DECIMAL(3, 2),
    est_start_date DATE,
    est_end_date DATE,
    role_confirmed BOOLEAN DEFAULT false,
    preferred_channel_project VARCHAR(50),
    last_contacted_at TIMESTAMP WITH TIME ZONE,
    suppress_for_project BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_contacts_unique UNIQUE (project_id, contact_id)
);

CREATE INDEX idx_project_contacts_project_id ON project_contacts(project_id);
CREATE INDEX idx_project_contacts_contact_id ON project_contacts(contact_id);
CREATE INDEX idx_project_contacts_role_confirmed ON project_contacts(role_confirmed);

-- ============================================================================
-- CallSessions Table
-- Append-only log of all call attempts and outcomes
-- ============================================================================
CREATE TABLE IF NOT EXISTS call_sessions (
    -- Primary key (internal)
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- External identifier (optional, for idempotency)
    call_session_id VARCHAR(255),
    
    -- Foreign keys
    project_id UUID NOT NULL REFERENCES crm_projects(id) ON DELETE RESTRICT,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    
    -- Call metadata
    call_type VARCHAR(50) NOT NULL, -- 'ai' or 'human'
    call_status VARCHAR(100) NOT NULL, -- 'initiated', 'completed', 'failed', 'no_answer', etc.
    
    -- Role detection
    detected_role VARCHAR(100),
    role_confidence DECIMAL(3, 2),
    
    -- Call outcomes
    outcome VARCHAR(100), -- 'interested', 'not_interested', 'callback_requested', etc.
    sentiment VARCHAR(50), -- 'positive', 'neutral', 'negative'
    escalated BOOLEAN DEFAULT false,
    escalation_reason TEXT,
    
    -- Call artifacts
    transcript TEXT,
    recording_url VARCHAR(1000),
    
    -- Timestamps
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE,
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Unique index for call_session_id (only when not null)
CREATE UNIQUE INDEX idx_call_sessions_call_session_id_unique ON call_sessions(call_session_id) WHERE call_session_id IS NOT NULL;
CREATE INDEX idx_call_sessions_project_id ON call_sessions(project_id);
CREATE INDEX idx_call_sessions_contact_id ON call_sessions(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_call_sessions_ended_at ON call_sessions(ended_at);
CREATE INDEX idx_call_sessions_call_type ON call_sessions(call_type);
CREATE INDEX idx_call_sessions_call_status ON call_sessions(call_status);

-- ============================================================================
-- TerminalSessions Table
-- Tracks terminal states that prevent calling (suppressions, opt-outs, etc.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS terminal_sessions (
    -- Primary key (internal)
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- External identifier (optional, for idempotency)
    terminal_id VARCHAR(255),
    
    -- Scope: what this terminal session applies to
    scope VARCHAR(50) NOT NULL, -- 'project', 'contact', 'global'
    project_id UUID REFERENCES crm_projects(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
    
    -- Terminal state details
    reason VARCHAR(500) NOT NULL, -- 'opt_out', 'do_not_call', 'project_completed', etc.
    created_by VARCHAR(255), -- 'system', 'user', 'contact', etc.
    
    -- Expiration (NULL = permanent)
    expires_at TIMESTAMP WITH TIME ZONE,
    
    -- Override permission (can system override this terminal state?)
    override_allowed BOOLEAN DEFAULT false,
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Validation: scope must match provided IDs
    CONSTRAINT terminal_sessions_scope_check CHECK (
        (scope = 'project' AND project_id IS NOT NULL AND contact_id IS NULL) OR
        (scope = 'contact' AND contact_id IS NOT NULL AND project_id IS NULL) OR
        (scope = 'global' AND project_id IS NULL AND contact_id IS NULL)
    )
);

-- Unique index for terminal_id (only when not null)
CREATE UNIQUE INDEX idx_terminal_sessions_terminal_id_unique ON terminal_sessions(terminal_id) WHERE terminal_id IS NOT NULL;
CREATE INDEX idx_terminal_sessions_scope ON terminal_sessions(scope);
CREATE INDEX idx_terminal_sessions_project_id ON terminal_sessions(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_terminal_sessions_contact_id ON terminal_sessions(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_terminal_sessions_expires_at ON terminal_sessions(expires_at) WHERE expires_at IS NOT NULL;
-- Note: Cannot use CURRENT_TIMESTAMP in index predicate, so we index expires_at and scope separately
-- Active sessions can be queried with: WHERE expires_at IS NULL OR expires_at > NOW()
CREATE INDEX idx_terminal_sessions_expires_scope ON terminal_sessions(expires_at, scope);

-- ============================================================================
-- Trigger Functions
-- Auto-update updated_at timestamps
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers to tables with updated_at
CREATE TRIGGER update_crm_projects_updated_at BEFORE UPDATE ON crm_projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_project_contacts_updated_at BEFORE UPDATE ON project_contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_terminal_sessions_updated_at BEFORE UPDATE ON terminal_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
