'use strict';

const assert = require('assert');
const {
  createTextProtocol,
  getSupportedTextProtocols,
} = require('../../../app/ai/registry');
const OpenAITextProtocol = require('../../../app/ai/text/openai');
const AnthropicTextProtocol = require('../../../app/ai/text/anthropic');

describe('test/app/ai/registry.test.js', () => {
  it('creates openai text protocol', () => {
    const protocol = createTextProtocol('openai', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
    assert(protocol instanceof OpenAITextProtocol);
  });

  it('creates anthropic text protocol', () => {
    const protocol = createTextProtocol('anthropic', {
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
    });
    assert(protocol instanceof AnthropicTextProtocol);
  });

  it('lists text protocols', () => {
    assert.deepStrictEqual(getSupportedTextProtocols().sort(), ['anthropic', 'codex', 'openai']);
  });

  it('rejects unknown text protocol', () => {
    assert.throws(
      () => createTextProtocol('foo', { apiKey: 'k', baseUrl: 'x', model: 'y' }),
      /不支持的文本协议/
    );
  });
});
