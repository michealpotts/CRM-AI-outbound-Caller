# AI CRM Backend

Production-ready backend for an AI outbound calling + CRM system.

## Overview

This backend serves as the source of truth for:
- Projects (from scraped data)
- Contacts
- Call sessions (append-only log)
- Eligibility and suppression logic
- Terminal states

HubSpot is used as a CRM UI and reporting layer, synced via one-way upsert operations.

## Architecture

### Database Schema

The system uses PostgreSQL with the following core tables:

- **projects**: Source of truth for all projects
- **contacts**: Source of truth for all contacts
- **project_contacts**: Junction table for project-contact associations
- **call_sessions**: Append-only log of all call attempts
- **terminal_sessions**: Terminal states that prevent calling

See `src/db/schema.sql` for the complete schema.

### Idempotency Strategy

All write operations are idempotent to ensure safe retries and data consistency:

#### Projects
- **Key**: `project_id` (external, unique)
- **Strategy**: Upsert by `project_id` - if exists, update; if not, insert
- **Use case**: Safe to ingest the same project data multiple times

#### Contacts
- **Primary Key**: `contact_id` (external, if available)
- **Natural Keys**: `phone` or `email` for deduplication
- **Strategy**: 
  1. If `contact_id` provided and exists, update that contact
  2. If `contact_id` not provided or doesn't exist:
     - Check for existing contact by phone (if provided)
     - Check for existing contact by email (if provided)
     - If match found, update that contact
     - If no match, create new contact
- **Use case**: Prevents duplicate contacts from multiple data sources

#### Call Sessions
- **Key**: `call_session_id` (external, optional)
- **Strategy**: If `call_session_id` provided and exists, return existing session
- **Use case**: Safe to retry call session creation

#### Terminal Sessions
- **Key**: `terminal_id` (external, optional)
- **Strategy**: If `terminal_id` provided and exists, return existing session
- **Use case**: Safe to retry terminal state creation

### Call Eligibility Logic

The `CallEligibilityService` enforces eligibility rules:

1. **Suppression Flags**:
   - `project.call_suppressed`
   - `contact.do_not_call`
   - `project_contact.suppress_for_project`

2. **Cooldown Periods**:
   - `project.next_call_eligible_at` must be in the past
   - Default: 24 hours between calls

3. **Terminal Sessions**:
   - Never allow calling when an active terminal session exists
   - Terminal sessions can be project-scoped, contact-scoped, or global

4. **Call Frequency Limits (Fatigue)**:
   - Max 3 calls per day per project/contact
   - Max 10 calls per week per project/contact

### HubSpot Integration

One-way sync: **Backend → HubSpot**

- **Projects** → HubSpot Deals (using `project_id` as external ID)
- **Contacts** → HubSpot Contacts (using `contact_id`, phone, or email for deduplication)
- **Project-Contact associations** → Deal-Contact associations
- **Call outcomes** → Deal notes/activities
- **Terminal states** → Custom properties

All HubSpot operations are idempotent using external IDs.

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL 12+
- HubSpot API key (optional, for sync)

### Installation

```bash
npm install
```

### Database Setup

1. Create a PostgreSQL database:
```sql
CREATE DATABASE ai_crm_db;
```

2. Update `.env` with your database connection:
```
DATABASE_URL=postgresql://user:password@localhost:5432/ai_crm_db
```

3. Run migrations:
```bash
npm run migrate
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/ai_crm_db

# HubSpot (optional)
HUBSPOT_API_KEY=your_hubspot_api_key_here
HUBSPOT_PORTAL_ID=your_portal_id_here

# Server
PORT=3000
NODE_ENV=development
```

## Running

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

## API Endpoints

### Projects

- `POST /api/projects` - Ingest normalized project (idempotent)
- `GET /api/projects/:project_id` - Get project by external ID
- `PATCH /api/projects/:project_id/suppression` - Update suppression status

### Contacts

- `POST /api/contacts` - Upsert contact (idempotent with deduplication)
- `GET /api/contacts/:contact_id` - Get contact by ID

### Call Sessions

- `POST /api/call-sessions` - Create call session (idempotent)
- `PATCH /api/call-sessions/:session_id` - Update call session
- `GET /api/call-sessions/:session_id` - Get call session
- `GET /api/call-sessions/project/:project_id` - Get all sessions for a project

### Terminal Sessions

- `POST /api/terminal-sessions` - Create terminal session (idempotent)
- `GET /api/terminal-sessions/:session_id` - Get terminal session
- `DELETE /api/terminal-sessions/:session_id` - Remove terminal session (if override_allowed)

### Eligible Calls

- `GET /api/eligible-calls` - Fetch eligible calls for outbound calling
- `GET /api/eligible-calls/check/project/:project_id` - Check project eligibility
- `GET /api/eligible-calls/check/contact/:contact_id` - Check contact eligibility
- `GET /api/eligible-calls/check/project/:project_id/contact/:contact_id` - Check project-contact eligibility

## Project Structure

```
src/
├── db/
│   ├── schema.sql              # Database schema
│   ├── connection.ts           # Database connection pool
│   ├── migrate.ts              # Migration runner
│   └── migrations/             # Migration files
├── services/
│   ├── ProjectService.ts       # Project operations
│   ├── ContactService.ts       # Contact operations
│   ├── ProjectContactService.ts # Project-contact associations
│   ├── CallSessionService.ts   # Call session management
│   ├── CallEligibilityService.ts # Eligibility logic
│   ├── TerminalService.ts      # Terminal state management
│   └── HubSpotSyncService.ts   # HubSpot integration
├── routes/
│   ├── projects.ts             # Project endpoints
│   ├── contacts.ts             # Contact endpoints
│   ├── call-sessions.ts        # Call session endpoints
│   ├── terminal-sessions.ts    # Terminal session endpoints
│   └── eligible-calls.ts       # Eligibility endpoints
├── types/
│   └── index.ts                # TypeScript type definitions
└── index.ts                    # Express app entry point
```

## Design Principles

1. **Clarity**: Clear separation of concerns, well-documented code
2. **Safety**: Idempotent operations, validation, error handling
3. **Auditability**: Append-only call sessions, timestamps on all records
4. **Performance**: Indexed queries, connection pooling, efficient eligibility checks

## Next Steps

- [ ] Add authentication/authorization
- [ ] Add rate limiting
- [ ] Add request logging
- [ ] Add monitoring/alerting
- [ ] Implement AI calling logic integration
- [ ] Add batch sync jobs for HubSpot
- [ ] Add webhook handlers for HubSpot events

## License

ISC
