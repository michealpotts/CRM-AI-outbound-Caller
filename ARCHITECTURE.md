# Architecture Overview

## System Design

This backend is designed as the **source of truth** for all core business data, with HubSpot serving as a read-only reporting and UI layer.

### Data Flow

```
Raw Scraped Data → Backend (Normalize & Dedupe) → PostgreSQL
                                           ↓
                                    HubSpot (Sync)
```

### Core Principles

1. **Idempotency**: All write operations can be safely retried
2. **Append-Only**: Call sessions are never deleted, only created
3. **Auditability**: All records have timestamps, call history is preserved
4. **Safety**: Terminal sessions and suppression flags prevent unwanted calls

## Database Design

### Tables

#### `projects`
- **Primary Key**: `id` (UUID, internal)
- **Unique Key**: `project_id` (external, for idempotency)
- Stores all project information from scraped data
- Tracks call eligibility and suppression

#### `contacts`
- **Primary Key**: `id` (UUID, internal)
- **Unique Keys**: 
  - `contact_id` (external, if available)
  - Natural keys: `phone`, `email` (for deduplication)
- Stores contact information
- Tracks global preferences (do_not_call, preferred_channel)

#### `project_contacts`
- **Primary Key**: `id` (UUID, internal)
- **Unique Key**: `(project_id, contact_id)` (composite)
- Junction table linking projects to contacts
- Stores project-specific role information
- Tracks project-specific suppression

#### `call_sessions`
- **Primary Key**: `id` (UUID, internal)
- **Unique Key**: `call_session_id` (external, optional, for idempotency)
- **Append-Only**: Never deleted, only created
- Stores all call attempts and outcomes
- Foreign keys to `projects` and `contacts`

#### `terminal_sessions`
- **Primary Key**: `id` (UUID, internal)
- **Unique Key**: `terminal_id` (external, optional, for idempotency)
- Stores terminal states that prevent calling
- Can be project-scoped, contact-scoped, or global
- Can expire (temporary) or be permanent

## Idempotency Implementation

### Projects
```typescript
// Strategy: Upsert by external project_id
if (project exists by project_id) {
  update existing project
} else {
  create new project
}
```

### Contacts
```typescript
// Strategy: Multi-level deduplication
if (contact_id provided && exists) {
  update by contact_id
} else if (phone provided && exists) {
  update by phone
} else if (email provided && exists) {
  update by email
} else {
  create new contact
}
```

### Call Sessions
```typescript
// Strategy: Check external call_session_id
if (call_session_id provided && exists) {
  return existing session
} else {
  create new session
}
```

## Call Eligibility Logic

The `CallEligibilityService` enforces a multi-layer eligibility check:

1. **Suppression Flags** (fastest check)
   - `project.call_suppressed`
   - `contact.do_not_call`
   - `project_contact.suppress_for_project`

2. **Terminal Sessions** (critical check)
   - Never allow calling if active terminal session exists
   - Checked at project, contact, and global levels

3. **Cooldown Periods**
   - `project.next_call_eligible_at` must be in the past
   - Default: 24 hours between calls

4. **Call Frequency Limits** (fatigue prevention)
   - Max 3 calls per day per project/contact
   - Max 10 calls per week per project/contact

### Eligibility Query Flow

```
GET /api/eligible-calls
  ↓
CallEligibilityService.getEligibleCalls()
  ↓
SQL Query (filters by suppression flags, cooldowns)
  ↓
Filter by terminal sessions (application-level)
  ↓
Filter by call frequency limits
  ↓
Return eligible project-contact pairs
```

## HubSpot Integration

### Sync Strategy

**One-Way**: Backend → HubSpot (upsert-only)

- **Projects** → HubSpot Deals
  - Uses `project_id` as external ID for idempotency
  - Maps project status to deal stage
  - Syncs custom properties

- **Contacts** → HubSpot Contacts
  - Uses `contact_id`, phone, or email for deduplication
  - Syncs contact preferences

- **Project-Contact Associations** → Deal-Contact Associations
  - Links contacts to deals in HubSpot

- **Call Sessions** → Deal Notes/Activities
  - Creates notes with call outcomes
  - Links to deals

- **Terminal Sessions** → Custom Properties
  - Updates deal/contact properties with terminal state

### Sync Timing

Currently, sync happens on-demand when data is created/updated. For production, consider:

- Batch sync jobs (scheduled)
- Webhook handlers for HubSpot events (if two-way sync needed)
- Queue-based async processing

## API Design

### RESTful Endpoints

All endpoints follow REST conventions:
- `POST` for creation (idempotent)
- `GET` for retrieval
- `PATCH` for partial updates
- `DELETE` for removal (where applicable)

### Response Format

```json
{
  "success": true,
  "data": { ... },
  "error": "...",  // only on error
  "details": [...] // validation errors
}
```

### Error Handling

- **400**: Validation errors (Zod schema validation)
- **404**: Resource not found
- **500**: Internal server error

## Security Considerations

⚠️ **Not Yet Implemented** (Future Work):

- Authentication/Authorization
- Rate limiting
- Input sanitization (beyond Zod validation)
- SQL injection prevention (using parameterized queries)
- CORS configuration
- Request logging/auditing

## Performance Considerations

### Database Indexes

- All foreign keys are indexed
- `project_id` (external) is indexed
- `next_call_eligible_at` is indexed (for eligibility queries)
- `call_suppressed` is indexed
- Composite indexes on junction tables

### Connection Pooling

- PostgreSQL connection pool (max 20 connections)
- Idle timeout: 30 seconds
- Connection timeout: 2 seconds

### Query Optimization

- Eligibility queries use indexed columns
- Terminal session checks use indexed lookups
- Call frequency checks use date-indexed queries

## Scalability

### Current Limitations

- Single database instance
- Synchronous HubSpot sync
- In-memory eligibility filtering

### Future Improvements

- Read replicas for eligibility queries
- Async queue for HubSpot sync
- Caching layer for eligibility checks
- Horizontal scaling with load balancer

## Monitoring & Observability

⚠️ **Not Yet Implemented** (Future Work):

- Request/response logging
- Error tracking (Sentry, etc.)
- Performance metrics (response times, query times)
- Database connection pool monitoring
- HubSpot sync success/failure tracking
