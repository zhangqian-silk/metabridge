'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function reservePort() {
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  return port;
}

/** 起一个 server.js 子进程，返回 { child, output } */
function startBridge(t, configPath) {
  let output = '';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, MB_CONFIG_FILE: configPath, MB_LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', c => { output += c.toString(); });
  child.stderr.on('data', c => { output += c.toString(); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  return { child, output: () => output };
}

function waitForOutput(handle, pattern, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pattern.test(handle.output())) return resolve();
      if (handle.child.exitCode !== null) {
        return reject(new Error(`进程已退出（${handle.child.exitCode}），输出：\n${handle.output()}`));
      }
      if (Date.now() > deadline) return reject(new Error(`等待 ${pattern} 超时，输出：\n${handle.output()}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForExit(child) {
  return new Promise(resolve => child.on('exit', code => resolve(code)));
}

test('端口被占用时给出可执行的报错，而不是裸栈回溯', async t => {
  const port = await reservePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabridge-port-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const configPath = path.join(tempDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1',
    port,
    catalogTtlMs: 60_000,
    officialModels: { enabled: false },
    backends: [{
      name: 'prefixed-test',
      // 指向一个没人监听的端口：目录拉取会失败，但不影响 listen 本身
      base: 'http://127.0.0.1:9',
      prefix: 'ThirdParty/',
      auth: { type: 'none' },
      priority: 100,
      reasoning: 'full',
    }],
  }));

  // 第一个实例占住端口。"已就绪" 是 README 里教 agent 认的唯一成功标志
  const first = startBridge(t, configPath);
  await waitForOutput(first, /已就绪: http:\/\/127\.0\.0\.1:/);

  // 第二个实例撞端口
  const second = startBridge(t, configPath);
  const exitCode = await waitForExit(second.child);
  const out = second.output();

  assert.equal(exitCode, 1, `应以退出码 1 结束：\n${out}`);
  assert.match(out, new RegExp(`端口 127\\.0\\.0\\.1:${port} 已被占用`), out);
  assert.match(out, /占用者/, out);
  assert.match(out, /Codex 连的仍是那个旧实例/, out);
  assert.match(out, /systemctl --user restart metabridge|换端口/, out);

  // 不能再出现裸栈回溯：agent 从中读不出该做什么
  assert.doesNotMatch(out, /Unhandled 'error' event/, out);
  assert.doesNotMatch(out, /at Server\.setupListenHandle/, out);
  assert.doesNotMatch(out, /已就绪/, '撞端口的实例绝不能打出成功标志');
});
