'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const server = path.resolve(__dirname, '..');
process.chdir(server);
process.env.EGG_SERVER_ENV = 'codex';

const login = spawnSync(process.env.CODEX_CLI_BINARY || 'codex', ['login', 'status'], { encoding: 'utf8' });
if (login.status !== 0 || !/Logged in using ChatGPT/i.test(login.stdout + login.stderr)) {
  console.error('请先在本机运行 codex login，并使用 ChatGPT 登录。');
  process.exit(1);
}

// Private local runtime state; never store or copy Codex credentials in this app.
const runtime = path.join(server, 'run');
fs.mkdirSync(runtime, { recursive: true });
const secretsFile = path.join(runtime, 'local-secrets.json');
if (!fs.existsSync(secretsFile)) {
  fs.writeFileSync(secretsFile, JSON.stringify({
    keys: crypto.randomBytes(32).toString('hex'), jwt: crypto.randomBytes(32).toString('hex'),
  }), { mode: 0o600, flag: 'wx' });
}
const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
process.env.EGG_KEYS = process.env.EGG_KEYS || secrets.keys;
process.env.JWT_SECRET = process.env.JWT_SECRET || secrets.jwt;

// The upstream service resolves style references from server/public; the
// frontend build ships them in app/public. Copy only missing bundled images.
const bundledStyles = path.join(server, 'app/public/images/styles');
if (fs.existsSync(bundledStyles)) {
  fs.cpSync(bundledStyles, path.join(server, 'public/images/styles'), {
    recursive: true, force: false,
  });
}

const db = require('../database/init');
require('./setup-codex')(db);
db.close();

console.log('AI 漫画（Codex CLI）：http://127.0.0.1:7001');
console.log('注册本地漫画账号后即可创作；无需填写模型配置。');
require('egg').startCluster({ baseDir: server, workers: 1, port: 7001 });
