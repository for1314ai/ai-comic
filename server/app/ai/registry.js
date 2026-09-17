// server/app/ai/registry.js
'use strict';

const OpenAITextProtocol = require('./text/openai');
const AnthropicTextProtocol = require('./text/anthropic');
const OpenAIImageProtocol = require('./image/openai');
const GrokImageProtocol = require('./image/grok');
const CodexTextProtocol = require('./text/codex');
const CodexImageProtocol = require('./image/codex');

const textProtocols = {
  openai: OpenAITextProtocol,
  anthropic: AnthropicTextProtocol,
  codex: CodexTextProtocol,
};

const imageProtocols = {
  openai: OpenAIImageProtocol,
  grok: GrokImageProtocol,
  codex: CodexImageProtocol,
};

function createTextProtocol(protocol, config) {
  const ProtocolClass = textProtocols[protocol];
  if (!ProtocolClass) {
    throw new Error(`不支持的文本协议: ${protocol}`);
  }
  return new ProtocolClass(config);
}

function createImageProtocol(protocol, config) {
  const ProtocolClass = imageProtocols[protocol];
  if (!ProtocolClass) {
    throw new Error(`不支持的图片协议: ${protocol}`);
  }
  return new ProtocolClass(config);
}

function getSupportedTextProtocols() {
  return Object.keys(textProtocols);
}

function getSupportedImageProtocols() {
  return Object.keys(imageProtocols);
}

module.exports = {
  createTextProtocol,
  createImageProtocol,
  getSupportedTextProtocols,
  getSupportedImageProtocols,
  textProtocols,
  imageProtocols,
};
