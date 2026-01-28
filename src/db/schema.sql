-- ============================================================================
-- AI CRM Backend Database Schema
-- Production-ready schema for AI outbound calling + CRM system
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Projects Table
-- Source of truth for all projects from scraped data
-- ============================================================================
CREATE TABLE IF NOT EXISTS projects (
    -- Primary key (internal)
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- External identifier (unique, used for idempotency)
    project_id VARCHAR(255) NOT NULL UNIQUE,
    
    -- Project details
    project_name VARCHAR(500) NOT NULL,
    
    -- Address fields
    address_line1 VARCHAR(500),
    address_line2 VARCHAR(500),
    city VARCHAR(255),
    state VARCHAR(100),
    zip_code VARCHAR(50),
    country VARCHAR(100) DEFAULT 'US',
    
    -- Project metadata
    awarded_date DATE,
    source_platform VARCHAR(255),
    is_multi_package BOOLEAN DEFAULT false,
    project_status VARCHAR(100),
    painting_package_status VARCHAR(100),
    priority_score INTEGER DEFAULT 0,
    
    -- Call management
    last_contacted_at TIMESTAMP WITH TIME ZONE,
    next_call_eligible_at TIMESTAMP WITH TIME ZONE,
    call_suppressed BOOLEAN DEFAULT false,
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Indexes for performance
    CONSTRAINT projects_project_id_key UNIQUE (project_id)
);

CREATE INDEX idx_projects_project_id ON projects(project_id);
CREATE INDEX idx_projects_next_call_eligible_at ON projects(next_call_eligible_at) WHERE call_suppressed = false;
CREATE INDEX idx_projects_call_suppressed ON projects(call_suppressed);
CREATE INDEX idx_projects_priority_score ON projects(priority_score DESC);

-- ============================================================================
-- Contacts Table
-- Source of truth for all contacts
-- ============================================================================
CREATE TABLE IF NOT EXISTS contacts (
    -- Primary key (internal)
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- External identifier (nullable, used when available from source)
    contact_id VARCHAR(255),
    
    -- Contact details
    name VARCHAR(500) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    
    -- Contact preferences and metadata
    global_role VARCHAR(100),
    authority_level VARCHAR(100),
    preferred_channel VARCHAR(50), -- 'phone', 'email', 'sms'
    do_not_call BOOLEAN DEFAULT false,
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    
    -- Natural key for deduplication (phone or email)
    -- Note: We'll use application-level logic for phone/email dedupe
);

-- Unique index for contact_id (only when not null)
CREATE UNIQUE INDEX idx_contacts_contact_id_unique ON contacts(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_contacts_contact_id ON contacts(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_contacts_phone ON contacts(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_contacts_email ON contacts(email) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_do_not_call ON contacts(do_not_call);

-- ============================================================================
-- ProjectContact Junction Table
-- Associates contacts with projects and their roles
-- ============================================================================
CREATE TABLE IF NOT EXISTS project_contacts (
    -- Primary key (internal)
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Foreign keys
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    
    -- Role information
    role_for_project VARCHAR(100),
    role_confidence DECIMAL(3, 2), -- 0.00 to 1.00
    role_confirmed BOOLEAN DEFAULT false,
    
    -- Project-specific preferences
    preferred_channel_project VARCHAR(50),
    last_contacted_at TIMESTAMP WITH TIME ZONE,
    suppress_for_project BOOLEAN DEFAULT false,
    
    -- Audit fields
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Ensure one contact-project relationship per combination
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
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
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
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
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
CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_project_contacts_updated_at BEFORE UPDATE ON project_contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_terminal_sessions_updated_at BEFORE UPDATE ON terminal_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
