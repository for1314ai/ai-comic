'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const cli = require('../../../app/ai/utils/codex-cli');
const { createTextProtocol, createImageProtocol } = require('../../../app/ai/registry');
const AiProviderService = require('../../../app/service/ai-provider');
const setupCodex = require('../../../scripts/setup-codex');
const Database = require('better-sqlite3');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64');

describe('Codex CLI adapters', () => {
  let root;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'comic-codex-test-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('registers text and image adapters without model credentials', () => {
    assert.strictEqual(createTextProtocol('codex', {}).constructor.name, 'CodexTextProtocol');
    assert.strictEqual(createImageProtocol('codex', {}).constructor.name, 'CodexImageProtocol');
    const context = {
      textProtocols: new Set(['codex', 'openai']), imageProtocols: new Set(['codex']),
      ctx: { throw: (status, message) => { throw new Error(message); } },
    };
    const payload = AiProviderService.prototype.validatePayload.call(context, {
      type: 'text', name: 'Codex', protocol: 'codex',
    }, { isCreate: true });
    assert.strictEqual(payload.apiKey, '');
    assert.strictEqual(payload.model, '');
    assert.throws(() => AiProviderService.prototype.validatePayload.call(context, {
      type: 'text', name: 'OpenAI', protocol: 'openai',
    }, { isCreate: true }), /API 地址/);
  });

  it('passes user text through stdin, returns final content, and cleans job files', async () => {
    const prompt = 'a "quote"; $(touch should-not-exist)\n中文';
    const result = await cli.execute({ schema: {}, prompt }, {
      jobRoot: root,
      runProcess: async (args, input, options) => {
        assert.strictEqual(input, prompt);
        assert(!args.includes(prompt));
        assert(args.includes('--ignore-user-config'));
        assert(args.includes('--ephemeral'));
        assert(!args.includes('--model'));
        await fs.writeFile(path.join(options.cwd, 'response.json'), JSON.stringify({ content: '{"panels":[]}' }));
      },
    });
    assert.deepStrictEqual(result, { content: '{"panels":[]}' });
    assert.deepStrictEqual(await fs.readdir(root), []);
  });

  it('copies ordered references, attaches them to CLI, and returns actual PNG bytes', async () => {
    const source = path.join(root, 'source.png');
    await fs.writeFile(source, png);
    const result = await cli.execute({
      image: true, schema: {}, prompt: 'test',
      references: [{ type: 'path', path: source }, { type: 'base64', data: png.toString('base64') }],
    }, {
      jobRoot: root,
      runProcess: async (args, input, { cwd }) => {
        const attachments = args.flatMap((value, index) => value === '--image' ? [args[index + 1]] : []);
        assert.deepStrictEqual(attachments.map(file => path.basename(file)), ['reference-1.png', 'reference-2.png']);
        for (const file of attachments) assert((await fs.readFile(file)).equals(png));
        await fs.writeFile(path.join(cwd, 'response.json'), '{"success":true,"error":""}');
        await fs.writeFile(path.join(cwd, 'result.png'), png);
      },
    });
    assert(result.imageBuffer.equals(png));
    assert.deepStrictEqual(await fs.readdir(root), ['source.png']);
  });

  it('rejects success without a PNG, and never accepts an external output path', async () => {
    await assert.rejects(cli.execute({ image: true, schema: {}, prompt: 'test' }, {
      jobRoot: root,
      runProcess: async (args, input, { cwd }) => {
        await fs.writeFile(path.join(cwd, 'response.json'), '{"success":true,"image_path":"/etc/passwd"}');
      },
    }), /ENOENT/);
    assert.deepStrictEqual(await fs.readdir(root), []);
  });

  it('rejects symlink outputs and reports native image-tool failures', async () => {
    const source = path.join(root, 'source.png');
    await fs.writeFile(source, png);
    const link = path.join(root, 'link.png');
    await fs.symlink(source, link);
    await assert.rejects(cli.readPng(link), /无效/);
    await assert.rejects(cli.execute({ image: true, schema: {}, prompt: 'test' }, {
      jobRoot: root,
      runProcess: async (args, input, { cwd }) => {
        await fs.writeFile(path.join(cwd, 'response.json'), '{"success":false,"error":"生图工具不可用"}');
      },
    }), /生图工具不可用/);
  });

  it('serializes jobs and continues after an earlier failure', async () => {
    const order = [];
    const first = cli.execute({ schema: {}, prompt: 'first' }, {
      jobRoot: root,
      runProcess: async () => {
        order.push('first-start');
        await new Promise(resolve => setTimeout(resolve, 15));
        order.push('first-end');
        throw new Error('expected failure');
      },
    });
    const second = cli.execute({ schema: {}, prompt: 'second' }, {
      jobRoot: root,
      runProcess: async (args, input, { cwd }) => {
        order.push('second');
        await fs.writeFile(path.join(cwd, 'response.json'), '{"content":"ok"}');
      },
    });
    const results = await Promise.allSettled([first, second]);
    assert.strictEqual(results[0].status, 'rejected');
    assert.strictEqual(results[1].value.content, 'ok');
    assert.deepStrictEqual(order, ['first-start', 'first-end', 'second']);
  });

  it('handles missing CLI and terminates a timed-out child', async () => {
    await assert.rejects(cli.runProcess([], '', { cwd: root, binary: path.join(root, 'missing') }), /找不到 Codex CLI/);
    await assert.rejects(cli.runProcess(['-e', 'setInterval(() => {}, 1000)'], '', {
      cwd: root, binary: process.execPath, timeoutMs: 40,
    }), /超时/);
  });

  it('sets up defaults idempotently and preserves existing providers', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE ai_configs (
        id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, name TEXT, protocol TEXT,
        api_key TEXT, base_url TEXT, model TEXT, enabled INTEGER, is_default INTEGER)`);
      db.prepare("INSERT INTO ai_configs (type, protocol, api_key) VALUES ('text', 'openai', 'existing')").run();
      setupCodex(db);
      setupCodex(db);
      const rows = db.prepare('SELECT * FROM ai_configs ORDER BY id').all();
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].api_key, 'existing');
      assert.strictEqual(rows[1].protocol, 'codex');
      assert.strictEqual(rows[1].api_key, '');
      assert.strictEqual(rows[1].is_default, 1);
    } finally { db.close(); }
  });
});
