import { createAppServer } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { server, stop } = await createAppServer(config);

server.listen(config.port, () => {
  console.log(`apps server for ${config.remoteName} (${config.publicUrl}) listening on :${config.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(`${signal}: shutting down`);
    stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
