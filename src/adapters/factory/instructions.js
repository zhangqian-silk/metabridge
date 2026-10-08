'use strict';

// Reference: pi-provider-factory router.ts, commit 300c1c0.
// Opt-in compatibility conversion, NOT preservation of instruction priority.
function validateInstructionMode(mode = 'preserve') {
  if (!['preserve', 'fold_system_into_user', 'factory_prefix'].includes(mode)) {
    throw new Error('invalid Factory instruction mode');
  }
  return mode;
}

function instructionText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(part =>
    part && ['text', 'input_text'].includes(part.type) && typeof part.text === 'string')) {
    return content.map(part => part.text).filter(text => text.length > 0).join('\n\n');
  }
  // Never silently drop an unfamiliar privileged-content representation.
  throw new Error('unsupported Factory instruction content');
}

function transformFactoryInstructions(protocol, body, mode = 'preserve') {
  validateInstructionMode(mode);
  if (mode === 'preserve') return body;
  if (!['responses', 'messages', 'chat'].includes(protocol)) {
    throw new Error('unsupported Factory instruction protocol');
  }
  if (mode === 'factory_prefix') return prefixFactoryInstructions(protocol, body);
  const result = { ...body };
  const field = protocol === 'responses' ? 'input' : 'messages';
  const texts = [];
  if (protocol !== 'chat') {
    const systemField = protocol === 'responses' ? 'instructions' : 'system';
    texts.push(instructionText(body[systemField]));
    delete result[systemField];
  }
  const source = protocol === 'responses' && typeof body.input === 'string'
    ? [{ role: 'user', content: body.input }] : body[field] ?? [];
  if (!Array.isArray(source)) throw new Error('unsupported Factory message list');
  const messages = [];
  for (const message of source) {
    if (['system', 'developer'].includes(message?.role)) {
      texts.push(instructionText(message.content));
    } else {
      messages.push(message);
    }
  }
  const text = texts.filter(value => value.length > 0).join('\n\n');
  if (text) {
    const preamble = `<system>\n${text}\n</system>\n\n`;
    const first = messages[0];
    if (first?.role === 'user') {
      let content;
      if (typeof first.content === 'string') content = preamble + first.content;
      else if (Array.isArray(first.content)) content = [
        { type: protocol === 'responses' ? 'input_text' : 'text', text: preamble }, ...first.content,
      ];
      else throw new Error('unsupported Factory user content');
      messages[0] = { ...first, content };
    } else {
      // Prepend instead of moving existing assistant/tool turns.
      messages.unshift({ role: 'user', content: preamble });
    }
  }
  result[field] = messages;
  return result;
}

const FACTORY_PREFIX = 'You are Droid, an AI software engineering agent built by Factory.';
function prefixFactoryInstructions(protocol, body) {
  const preamble = FACTORY_PREFIX + '\n\n';
  function prefix(content) {
    if (typeof content === 'string') {
      return content.startsWith(FACTORY_PREFIX) ? content : preamble + content;
    }
    if (content === undefined || content === null) return preamble;
    instructionText(content); // Validate without discarding cache-control or other text metadata.
    if (content[0]?.text.startsWith(FACTORY_PREFIX)) return content;
    return [{ type: 'text', text: preamble }, ...content];
  }
  if (protocol === 'responses') {
    if (body.instructions !== undefined && typeof body.instructions !== 'string') {
      throw new Error('unsupported Factory instruction content');
    }
    return { ...body, instructions: prefix(body.instructions) };
  }
  if (protocol === 'messages') return { ...body, system: prefix(body.system) };
  if (!Array.isArray(body.messages)) throw new Error('unsupported Factory message list');
  const messages = [...body.messages];
  const index = messages.findIndex(message => message?.role === 'system');
  if (index === -1) messages.unshift({ role: 'system', content: preamble });
  else messages[index] = { ...messages[index], content: prefix(messages[index].content) };
  return { ...body, messages };
}

module.exports = { validateInstructionMode, transformFactoryInstructions };
