// server/app/service/ai-provider.js
const Service = require('egg').Service;
const {
  getSupportedTextProtocols,
  getSupportedImageProtocols,
} = require('../ai/registry');

class AiProviderService extends Service {
  get textProtocols() {
    return new Set(getSupportedTextProtocols());
  }

  get imageProtocols() {
    return new Set(getSupportedImageProtocols());
  }

  maskApiKey(apiKey) {
    if (!apiKey || typeof apiKey !== 'string') return '';
    if (apiKey.length <= 8) return '****';
    return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
  }

  parseExtra(extra) {
    if (!extra) return {};
    if (typeof extra === 'object') return extra;
    try {
      return JSON.parse(extra);
    } catch (_) {
      return {};
    }
  }

  toPublic(row, { includeBaseUrl = false } = {}) {
    if (!row) return null;
    const item = {
      id: row.id,
      type: row.type,
      name: row.name,
      protocol: row.protocol,
      model: row.model,
      enabled: !!row.enabled,
      isDefault: !!row.is_default,
      extra: this.parseExtra(row.extra),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      apiKeyMasked: this.maskApiKey(row.api_key),
    };
    if (includeBaseUrl) {
      item.baseUrl = row.base_url;
    }
    return item;
  }

  toRuntimeConfig(row) {
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      protocol: row.protocol,
      apiKey: row.api_key,
      baseUrl: row.base_url,
      model: row.model,
      enabled: !!row.enabled,
      isDefault: !!row.is_default,
      extra: this.parseExtra(row.extra),
    };
  }

  validatePayload(data, { isCreate = false } = {}) {
    const { type, name, protocol, baseUrl, model, apiKey, enabled, isDefault, extra } = data;

    if (!type || !['text', 'image'].includes(type)) {
      this.ctx.throw(400, 'type 必须为 text 或 image');
    }
    if (!name || !String(name).trim()) {
      this.ctx.throw(400, '请填写提供商名称');
    }
    if (!protocol) {
      this.ctx.throw(400, '请选择协议');
    }
    if (type === 'text' && !this.textProtocols.has(protocol)) {
      this.ctx.throw(400, `文本协议仅支持: ${[...this.textProtocols].join(', ')}`);
    }
    if (type === 'image' && !this.imageProtocols.has(protocol)) {
      this.ctx.throw(400, `图片协议仅支持: ${[...this.imageProtocols].join(', ')}`);
    }
    if (protocol !== 'codex' && (!baseUrl || !String(baseUrl).trim())) {
      this.ctx.throw(400, '请填写 API 地址');
    }
    if (protocol !== 'codex' && (!model || !String(model).trim())) {
      this.ctx.throw(400, '请填写模型名称');
    }
    if (protocol !== 'codex' && isCreate && (!apiKey || !String(apiKey).trim())) {
      this.ctx.throw(400, '请填写 API Key');
    }

    const isEnabled = enabled === undefined ? true : !!enabled;
    // 禁用项不得作为默认
    let nextIsDefault = !!isDefault;
    if (!isEnabled) {
      nextIsDefault = false;
    }

    return {
      type,
      name: String(name).trim(),
      protocol,
      baseUrl: protocol === 'codex' ? '' : String(baseUrl).trim().replace(/\/+$/, ''),
      model: protocol === 'codex' ? '' : String(model).trim(),
      apiKey: protocol === 'codex' ? '' : apiKey !== undefined && apiKey !== null ? String(apiKey) : undefined,
      enabled: isEnabled,
      isDefault: nextIsDefault,
      extra: extra && typeof extra === 'object' ? extra : {},
    };
  }

  listProviders({ type } = {}) {
    const db = this.app.db;
    let rows;
    if (type) {
      rows = db.prepare(
        `SELECT * FROM ai_configs
         WHERE user_id IS NULL AND type = ?
         ORDER BY is_default DESC, id ASC`
      ).all(type);
    } else {
      rows = db.prepare(
        `SELECT * FROM ai_configs
         WHERE user_id IS NULL AND type IN ('text', 'image')
         ORDER BY type ASC, is_default DESC, id ASC`
      ).all();
    }
    return rows.map(row => this.toPublic(row, { includeBaseUrl: true }));
  }

  listOptions(type) {
    if (!type || !['text', 'image'].includes(type)) {
      this.ctx.throw(400, 'type 必须为 text 或 image');
    }
    const rows = this.app.db.prepare(
      `SELECT id, name, protocol, model, is_default
       FROM ai_configs
       WHERE user_id IS NULL AND type = ? AND enabled = 1
       ORDER BY is_default DESC, id ASC`
    ).all(type);

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      model: row.model,
      isDefault: !!row.is_default,
    }));
  }

  getById(id) {
    const row = this.app.db.prepare(
      `SELECT * FROM ai_configs WHERE id = ? AND user_id IS NULL AND type IN ('text', 'image')`
    ).get(id);
    return row || null;
  }

  getPublicById(id) {
    const row = this.getById(id);
    if (!row) this.ctx.throw(404, '提供商不存在');
    return this.toPublic(row, { includeBaseUrl: true });
  }

  clearDefault(type) {
    this.app.db.prepare(
      `UPDATE ai_configs SET is_default = 0, updated_at = CURRENT_TIMESTAMP
       WHERE user_id IS NULL AND type = ?`
    ).run(type);
  }

  ensureDefaultExists(type) {
    const db = this.app.db;
    const currentDefault = db.prepare(
      `SELECT id FROM ai_configs
       WHERE user_id IS NULL AND type = ? AND is_default = 1 AND enabled = 1`
    ).get(type);
    if (currentDefault) return;

    // 清掉可能存在的「禁用默认」脏数据
    db.prepare(
      `UPDATE ai_configs SET is_default = 0, updated_at = CURRENT_TIMESTAMP
       WHERE user_id IS NULL AND type = ? AND is_default = 1`
    ).run(type);

    const fallback = db.prepare(
      `SELECT id FROM ai_configs
       WHERE user_id IS NULL AND type = ? AND enabled = 1
       ORDER BY id ASC LIMIT 1`
    ).get(type);
    if (fallback) {
      db.prepare(
        `UPDATE ai_configs SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(fallback.id);
    }
  }

  createProvider(data) {
    const payload = this.validatePayload(data, { isCreate: true });
    const db = this.app.db;

    const run = db.transaction(() => {
      const existingCount = db.prepare(
        `SELECT COUNT(*) AS count FROM ai_configs
         WHERE user_id IS NULL AND type = ?`
      ).get(payload.type).count;

      // 首个提供商若启用则自动默认；禁用的首个不设默认
      const shouldDefault =
        payload.enabled && (payload.isDefault || existingCount === 0);

      if (shouldDefault) {
        this.clearDefault(payload.type);
      }

      const result = db.prepare(
        `INSERT INTO ai_configs
          (user_id, type, name, protocol, provider, api_key, base_url, model, enabled, is_default, extra)
         VALUES (NULL, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`
      ).run(
        payload.type,
        payload.name,
        payload.protocol,
        payload.apiKey,
        payload.baseUrl,
        payload.model,
        payload.enabled ? 1 : 0,
        shouldDefault ? 1 : 0,
        JSON.stringify(payload.extra || {})
      );

      if (!shouldDefault) {
        this.ensureDefaultExists(payload.type);
      }

      return result.lastInsertRowid;
    });

    return this.getPublicById(run());
  }

  updateProvider(id, data) {
    const existing = this.getById(id);
    if (!existing) this.ctx.throw(404, '提供商不存在');

    const merged = {
      type: existing.type,
      name: data.name !== undefined ? data.name : existing.name,
      protocol: data.protocol !== undefined ? data.protocol : existing.protocol,
      baseUrl: data.baseUrl !== undefined ? data.baseUrl : existing.base_url,
      model: data.model !== undefined ? data.model : existing.model,
      apiKey: data.apiKey,
      enabled: data.enabled !== undefined ? data.enabled : !!existing.enabled,
      isDefault: data.isDefault !== undefined ? data.isDefault : !!existing.is_default,
      extra: data.extra !== undefined ? data.extra : this.parseExtra(existing.extra),
    };

    const payload = this.validatePayload(merged, { isCreate: false });
    const nextApiKey = payload.protocol === 'codex' ? '' : payload.apiKey && payload.apiKey.trim()
      ? payload.apiKey.trim()
      : existing.api_key;

    const db = this.app.db;
    db.transaction(() => {
      if (payload.isDefault && payload.enabled) {
        this.clearDefault(payload.type);
      }

      db.prepare(
        `UPDATE ai_configs SET
          name = ?, protocol = ?, provider = '', api_key = ?, base_url = ?, model = ?,
          enabled = ?, is_default = ?, extra = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(
        payload.name,
        payload.protocol,
        nextApiKey,
        payload.baseUrl,
        payload.model,
        payload.enabled ? 1 : 0,
        payload.isDefault && payload.enabled ? 1 : 0,
        JSON.stringify(payload.extra || {}),
        id
      );

      this.ensureDefaultExists(payload.type);
    })();

    return this.getPublicById(id);
  }

  setDefault(id) {
    const existing = this.getById(id);
    if (!existing) this.ctx.throw(404, '提供商不存在');
    if (!existing.enabled) this.ctx.throw(400, '无法将已禁用的提供商设为默认');

    const db = this.app.db;
    db.transaction(() => {
      this.clearDefault(existing.type);
      db.prepare(
        `UPDATE ai_configs SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(id);
    })();

    return this.getPublicById(id);
  }

  deleteProvider(id) {
    const existing = this.getById(id);
    if (!existing) this.ctx.throw(404, '提供商不存在');

    const db = this.app.db;
    db.transaction(() => {
      db.prepare('DELETE FROM ai_configs WHERE id = ?').run(id);
      this.ensureDefaultExists(existing.type);
    })();

    return { success: true };
  }

  /**
   * 解析运行时提供商（带密钥）
   * @param {'text'|'image'} type
   * @param {number|string|null} providerId
   */
  resolve(type, providerId = null) {
    if (!type || !['text', 'image'].includes(type)) {
      this.ctx.throw(400, 'type 必须为 text 或 image');
    }

    const db = this.app.db;
    let row = null;

    if (providerId !== null && providerId !== undefined && providerId !== '') {
      const id = parseInt(providerId, 10);
      if (Number.isNaN(id)) {
        this.ctx.throw(400, 'providerId 无效');
      }
      row = db.prepare(
        `SELECT * FROM ai_configs
         WHERE id = ? AND user_id IS NULL AND type = ?`
      ).get(id, type);
      if (!row) {
        this.ctx.throw(400, '指定的提供商不存在或不匹配当前功能类型');
      }
      if (!row.enabled) {
        this.ctx.throw(400, '指定的提供商已禁用');
      }
      return this.toRuntimeConfig(row);
    }

    row = db.prepare(
      `SELECT * FROM ai_configs
       WHERE user_id IS NULL AND type = ? AND is_default = 1 AND enabled = 1
       ORDER BY id ASC LIMIT 1`
    ).get(type);

    if (!row) {
      row = db.prepare(
        `SELECT * FROM ai_configs
         WHERE user_id IS NULL AND type = ? AND enabled = 1
         ORDER BY id ASC LIMIT 1`
      ).get(type);
      if (row) {
        this.ctx.logger.warn(`[ai-provider] type=${type} 无默认项，回退到 id=${row.id}`);
      }
    }

    if (!row) {
      this.ctx.throw(503, 'AI 服务未配置，请联系管理员在后台添加提供商');
    }

    return this.toRuntimeConfig(row);
  }
}

module.exports = AiProviderService;
