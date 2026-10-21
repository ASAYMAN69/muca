import { loadEnv } from './paths.js';
import { startServer } from './server.js';

loadEnv();

async function main(): Promise<void> {
  const server = await startServer();
  const { config } = server;

  console.log('');
  console.log('  Muca — Amazon Developer Hackathon 2026 (Alexa+ track)');
  console.log('  ---------------------------------------------------');
  console.log(`  Frontend   http://localhost:${config.port}/`);
  console.log(`  REST API   http://localhost:${config.port}/api/v1`);
  console.log(`  MCP        ${config.mcp.publicUrl}`);
  console.log(`  Protocol   ${config.mcp.protocolVersion}`);
  console.log(
    `  AI         ${config.ai.enabled ? `${config.ai.model} (${config.ai.baseUrl})` : 'not configured — set OPENAI_API_KEY'}`,
  );
  console.log('');

  const shutdown = async (signal: string) => {
    console.log(`\n  ${signal} received, shutting down.`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start Muca:', error);
  process.exit(1);
});
