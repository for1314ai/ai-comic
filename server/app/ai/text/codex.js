'use strict';

const BaseTextProtocol = require('./base');
const cli = require('../utils/codex-cli');

class CodexTextProtocol extends BaseTextProtocol {
  async chat(request) {
    return cli.execute({
      schema: {
        type: 'object', properties: { content: { type: 'string' } },
        required: ['content'], additionalProperties: false,
      },
      prompt: `你是漫画创作应用的文字生成器。只生成文字，不调用工具，不读取文件，不执行命令，不启动子代理。\n`
        + `根据下列消息完成创作，把回答放入输出结构的 content 字符串。`
        + (request.responseFormat === 'json_object'
          ? 'content 的值必须是有效 JSON 对象的字符串，不要 Markdown 代码围栏。\n'
          : 'content 的值为最终正文，不要解释过程。\n')
        + JSON.stringify(request.messages),
    });
  }
}

module.exports = CodexTextProtocol;
