// 宿主机上的 TCP 中继：把 0.0.0.0:17890 转发到本机代理 127.0.0.1:7890。
// 用途：colima 虚拟机里的 Docker 容器要访问被墙的 binance.com，而本机 Clash 只监听 127.0.0.1。
// 启动：node scripts/host-proxy-relay.mjs &      （改端口：RELAY_PORT / PROXY_PORT）
import net from 'node:net';

const LISTEN = Number(process.env.RELAY_PORT || 17890);
const TARGET_HOST = process.env.PROXY_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.PROXY_PORT || 7890);

const srv = net.createServer((client) => {
  const up = net.connect(TARGET_PORT, TARGET_HOST);
  const close = () => { client.destroy(); up.destroy(); };
  client.on('error', close); up.on('error', close);
  client.on('close', close); up.on('close', close);
  client.pipe(up); up.pipe(client);
});

srv.on('error', (e) => { console.error(`[relay] ${e.message}`); process.exit(1); });
srv.listen(LISTEN, '0.0.0.0', () => console.log(`[relay] 0.0.0.0:${LISTEN} -> ${TARGET_HOST}:${TARGET_PORT}`));
