# Setup Guide

## Database Configuration (Aiven PostgreSQL)

### Step 1: Get Your Connection Details

From your Aiven dashboard, you have:
- **Host**: `pg-2297db80-michealpotts20-c7bc.d.aivencloud.com`
- **Port**: `11027`
- **User**: `avnadmin`
- **Password**: (from Aiven dashboard - click to reveal)
- **Database**: `defaultdb`
- **SSL Mode**: `require`

### Step 2: Create .env File

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Update the `DATABASE_URL` in `.env` with your actual password:
   ```env
   DATABASE_URL=postgresql://avnadmin:YOUR_ACTUAL_PASSWORD@pg-2297db80-michealpotts20-c7bc.d.aivencloud.com:11027/defaultdb?sslmode=require
   ```

   Replace `YOUR_ACTUAL_PASSWORD` with the password from your Aiven dashboard.

### Step 3: Optional - SSL Certificate (Recommended for Production)

If you want to use the CA certificate for additional security:

1. Download the CA certificate from Aiven dashboard (click "Show" next to "CA certificate")
2. Save it as `ca.pem` in the project root
3. Update `.env`:
   ```env
   DATABASE_SSL_CA_PATH=./ca.pem
   ```

### Step 4: Test Connection

Run the migration to test the connection and set up the database:

```bash
npm install
npm run migrate
```

This will:
- Test the database connection
- Create all required tables
- Set up indexes and triggers

### Step 5: Verify Setup

Start the server:

```bash
npm run dev
```

Check the health endpoint:

```bash
curl http://localhost:3000/health
```

You should see:
```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "..."
}
```

## Troubleshooting

### Connection Timeout

If you get connection timeouts:
- Check that your IP is whitelisted in Aiven (if IP restrictions are enabled)
- Verify the password is correct
- Check that the host and port are correct

### SSL Errors

If you get SSL errors:
- Ensure `sslmode=require` is in the connection string
- If using a CA certificate, verify the file path is correct
- For development, you can temporarily use `sslmode=prefer` (less secure)

### Database Not Found

If you get "database does not exist":
- Verify you're using `defaultdb` (the default Aiven database)
- Or create a new database in Aiven and update the connection string

## Next Steps

Once the database is connected:

1. **Ingest your first project**:
   ```bash
   curl -X POST http://localhost:3000/api/projects \
     -H "Content-Type: application/json" \
     -d '{
       "project_id": "test-001",
       "project_name": "Test Project",
       "priority_score": 10
     }'
   ```

2. **Create a contact**:
   ```bash
   curl -X POST http://localhost:3000/api/contacts \
     -H "Content-Type: application/json" \
     -d '{
       "name": "John Doe",
       "phone": "+1234567890",
       "email": "john@example.com"
     }'
   ```

3. **Check eligible calls**:
   ```bash
   curl http://localhost:3000/api/eligible-calls
   ```
