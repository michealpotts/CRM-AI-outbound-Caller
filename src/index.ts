import express from 'express';
import dotenv from 'dotenv';
import { testConnection } from './db/connection';

// Import routes
import projectsRouter from './routes/projects';
import contactsRouter from './routes/contacts';
import callSessionsRouter from './routes/call-sessions';
import terminalSessionsRouter from './routes/terminal-sessions';
import eligibleCallsRouter from './routes/eligible-calls';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', async (req, res) => {
  const dbConnected = await testConnection();
  res.status(dbConnected ? 200 : 503).json({
    status: dbConnected ? 'healthy' : 'unhealthy',
    database: dbConnected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use('/api/projects', projectsRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/call-sessions', callSessionsRouter);
app.use('/api/terminal-sessions', terminalSessionsRouter);
app.use('/api/eligible-calls', eligibleCallsRouter);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'AI CRM Backend API',
    version: '1.0.0',
    endpoints: {
      projects: '/api/projects',
      contacts: '/api/contacts',
      callSessions: '/api/call-sessions',
      terminalSessions: '/api/terminal-sessions',
      eligibleCalls: '/api/eligible-calls',
    },
  });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
