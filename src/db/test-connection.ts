import { testConnection } from './connection';

/**
 * Test database connection script
 * Usage: npm run test:db or ts-node src/db/test-connection.ts
 */
async function main() {
  console.log('Testing database connection...');
  console.log('Connection string:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':****@')); // Hide password
  
  const connected = await testConnection();
  
  if (connected) {
    console.log('✅ Database connection successful!');
    process.exit(0);
  } else {
    console.error('❌ Database connection failed!');
    console.error('Please check your DATABASE_URL in .env file');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
