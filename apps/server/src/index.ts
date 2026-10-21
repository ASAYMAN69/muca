import { loadEnv } from './paths.js';
import { startServer } from './server.js';
import { formatDecision } from './ai/gateway.js';

loadEnv();

async function main(): Promise<void> {
  const server = await startServer();
  const { config, ai } = server;

  console.log('');
  console.log('  Muca — Amazon Developer Hackathon 2026 (Alexa+ track)');
  console.log('  ---------------------------------------------------');
  console.log(`  Frontend   http://localhost:${config.port}/`);
  console.log(`  REST API   http://localhost:${config.port}/api/v1`);
  console.log(`  MCP        ${config.mcp.publicUrl}`);
  console.log(`  Protocol   ${config.mcp.protocolVersion}`);

  // The gateway's decision, in one line. It never contains a key.
  console.log(
    `  ${formatDecision(config.ai.requested, {
      selected: ai.provider,
      model: ai.model,
      enabled: ai.enabled,
      probes: ai.probes,
    })}`,
  );

  if (!ai.enabled) {
    console.log(
      '             No usable AI provider — MCP, the tools and the demo mode still work.',
    );
  }

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
