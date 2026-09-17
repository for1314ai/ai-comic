'use strict';

function setupCodex(db) {
  db.transaction(() => {
    for (const type of ['text', 'image']) {
      const existing = db.prepare('SELECT id FROM ai_configs WHERE user_id IS NULL AND type = ?').get(type);
      if (existing) continue; // Never overwrite an existing provider configuration.
      db.prepare(`INSERT INTO ai_configs
        (user_id, type, name, protocol, api_key, base_url, model, enabled, is_default)
        VALUES (NULL, ?, ?, 'codex', '', '', '', 1, 1)`)
        .run(type, type === 'text' ? 'Codex 文字（本机登录）' : 'Codex 生图（本机登录）');
    }
  })();
}

if (require.main === module) {
  const db = require('../database/init');
  setupCodex(db);
  db.close();
  console.log('已为未配置模型的类别启用 Codex CLI，无需 API Key。');
}

module.exports = setupCodex;
