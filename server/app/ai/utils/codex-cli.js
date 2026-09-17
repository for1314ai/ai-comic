'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const JOB_ROOT = path.resolve(__dirname, '../../../run/codex-jobs');
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
let queue = Promise.resolve();

// One CLI run at a time, including image jobs, to avoid account-level bursts.
function enqueue(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

function runProcess(args, prompt, { cwd, timeoutMs = 600000, binary = process.env.CODEX_CLI_BINARY || 'codex' }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // This adapter deliberately uses the CLI's saved ChatGPT sign-in.
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
    const child = spawn(binary, args, {
      cwd, env, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    let killTimer;
    const signal = name => {
      try {
        if (process.platform === 'win32') child.kill(name);
        else process.kill(-child.pid, name);
      } catch (_) { /* process already exited */ }
    };
    const onExit = () => signal('SIGTERM');
    process.once('exit', onExit);
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), 3000);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener('exit', onExit);
    };
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-3000); });
    child.stdin.on('error', () => {}); // Early exit is reported by close/error.
    child.on('error', error => {
      cleanup();
      reject(new Error(error.code === 'ENOENT'
        ? '找不到 Codex CLI，请先安装并执行 codex login。'
        : `无法启动 Codex CLI：${error.message}`));
    });
    child.on('close', code => {
      cleanup();
      if (timedOut) return reject(new Error('Codex 生成超时，请缩短内容后重试。'));
      if (code !== 0) {
        const hint = /not logged|authentication|unauthorized|401/i.test(stderr)
          ? '请在运行服务的本机执行 codex login。'
          : /usage limit|rate limit|quota/i.test(stderr)
            ? '当前账户额度或速率受限，请稍后重试。'
            : '请检查本机 Codex 登录、网络和可用额度。';
        return reject(new Error(`Codex CLI 执行失败（${code}）。${hint}`));
      }
      resolve();
    });
    child.stdin.end(prompt);
  });
}

async function prepareReferences(references, directory) {
  const files = [];
  for (const [index, reference] of references.entries()) {
    let data;
    if (reference?.type === 'path') data = await fs.readFile(reference.path);
    else if (reference?.type === 'base64') {
      data = Buffer.from(reference.data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    } else throw new Error('Codex 参考图需要本地文件；请先上传远程图片。');
    if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('参考图为空或超过 50 MB。');
    const extension = data.subarray(0, 8).equals(PNG_SIGNATURE) ? 'png'
      : data[0] === 0xff && data[1] === 0xd8 ? 'jpg'
        : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
    if (!extension) throw new Error('Codex 参考图仅支持 PNG、JPEG、WebP。');
    const destination = path.join(directory, `reference-${index + 1}.${extension}`);
    await fs.writeFile(destination, data);
    files.push(destination);
  }
  return files;
}

function buildArgs(directory, referencePaths = []) {
  return [
    'exec', '--ignore-user-config', '--disable', 'multi_agent',
    '--enable', 'image_generation', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'workspace-write', '--output-schema', path.join(directory, 'schema.json'),
    '-o', path.join(directory, 'response.json'), '-C', directory,
    ...referencePaths.flatMap(file => ['--image', file]), '-',
  ];
}

async function readPng(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES) {
    throw new Error('Codex 返回的图片文件无效。');
  }
  const buffer = await fs.readFile(filename);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Codex 没有返回有效的 PNG 图片。');
  }
  return buffer;
}

function execute({ schema, prompt, references = [], image = false }, dependencies = {}) {
  return enqueue(async () => {
    const root = dependencies.jobRoot || JOB_ROOT;
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'job-'));
    try {
      await fs.writeFile(path.join(directory, 'schema.json'), JSON.stringify(schema));
      const referencePaths = await prepareReferences(references, directory);
      const assembledPrompt = typeof prompt === 'function' ? prompt(directory, referencePaths) : prompt;
      await (dependencies.runProcess || runProcess)(buildArgs(directory, referencePaths), assembledPrompt, { cwd: directory });
      const responsePath = path.join(directory, 'response.json');
      const responseStat = await fs.lstat(responsePath);
      if (!responseStat.isFile() || responseStat.isSymbolicLink() || responseStat.size > 2 * 1024 * 1024) {
        throw new Error('Codex 返回内容无效或过大。');
      }
      const result = JSON.parse(await fs.readFile(responsePath, 'utf8'));
      if (!image) {
        if (typeof result.content !== 'string' || !result.content.trim()) throw new Error('Codex 未返回文字内容。');
        return { content: result.content };
      }
      if (result.success !== true) throw new Error(result.error || 'Codex 生图失败；请确认内置生图工具可用。');
      // Never trust an arbitrary output path supplied by the model.
      return { imageBuffer: await readPng(path.join(directory, 'result.png')) };
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

module.exports = { execute, buildArgs, prepareReferences, readPng, runProcess };
