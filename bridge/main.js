import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from './server.js';

const home = process.env.GEO_BRIDGE_HOME || join(homedir(), '.geo-bridge');
const port = Number(process.env.GEO_BRIDGE_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('GEO_BRIDGE_PORT 必须为 1–65535');
const bridge = createBridge({ home, port, projectDir: dirname(dirname(fileURLToPath(import.meta.url))) });
try {
  await bridge.listen();
  console.error(`GEO bridge: http://127.0.0.1:${port} | Ctrl+C 停止服务`);
  console.log(JSON.stringify({ status: 'listening', endpoint: `http://127.0.0.1:${port}`, home }));
} catch (error) { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用；请检查已有 bridge 或设置 GEO_BRIDGE_PORT` : error.message); process.exit(1); }
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await bridge.close(); process.exit(0); });
