'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHECKPOINT_PREFIX,
  CHECKPOINT_SUFFIX,
  decodeSrCmp1,
  hasCompactionTrigger,
  materializeLatestCompaction,
} = require('../src/core/compaction');

function encodeSummary(summary) {
  const envelope = Buffer.from(
    JSON.stringify({ v: 1, summary }),
    'utf8'
  ).toString('base64');
  return `sr-cmp1:${envelope}`;
}

function userMessage(text) {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

test('decodeSrCmp1 decodes gateway checkpoint envelopes', () => {
  assert.equal(decodeSrCmp1(encodeSummary('# Checkpoint')), '# Checkpoint');
  assert.equal(decodeSrCmp1('opaque-fernet-value'), null);
  assert.equal(decodeSrCmp1('sr-cmp1:not-json'), null);
  assert.equal(
    decodeSrCmp1(`sr-cmp1:${Buffer.from('{}').toString('base64')}`),
    null
  );
});

test('hasCompactionTrigger only matches Responses compaction triggers', () => {
  assert.equal(hasCompactionTrigger(undefined), false);
  assert.equal(hasCompactionTrigger([userMessage('hello')]), false);
  assert.equal(
    hasCompactionTrigger([
      userMessage('hello'),
      { type: 'compaction_trigger' },
    ]),
    true
  );
});

test('Prefixed backend replay drops the old window and preserves only checkpoint plus new items', () => {
  const newUser = userMessage('latest real query');
  const toolOutput = {
    type: 'function_call_output',
    call_id: 'call_after_compaction',
    output: 'new output',
  };
  const result = materializeLatestCompaction([
    userMessage('stale user query one'),
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'stale answer' }],
    },
    userMessage('stale user query two'),
    {
      type: 'compaction',
      id: 'cmp_latest',
      encrypted_content: encodeSummary('# Context Checkpoint\nHistorical state'),
    },
    newUser,
    toolOutput,
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.compacted, true);
  assert.equal(result.compactionId, 'cmp_latest');
  assert.equal(result.droppedItems, 3);
  assert.equal(result.retainedItems, 2);
  assert.equal(result.input.length, 3);

  const checkpoint = result.input[0];
  assert.equal(checkpoint.type, 'message');
  assert.equal(checkpoint.role, 'assistant');
  assert.equal(checkpoint.content[0].type, 'output_text');
  assert.equal(
    checkpoint.content[0].text,
    `${CHECKPOINT_PREFIX}# Context Checkpoint\nHistorical state${CHECKPOINT_SUFFIX}`
  );

  assert.deepEqual(result.input[1], newUser);
  assert.deepEqual(result.input[2], toolOutput);
  assert.equal(
    result.input.some(item => item.role === 'user' &&
      item.content?.some?.(part => part.text === 'stale user query one')),
    false
  );
});

test('Prefixed backend replay uses the latest compaction and removes replay-only triggers', () => {
  const result = materializeLatestCompaction([
    userMessage('oldest'),
    {
      type: 'compaction',
      id: 'cmp_old',
      encrypted_content: encodeSummary('old checkpoint'),
    },
    userMessage('between checkpoints'),
    {
      type: 'compaction',
      id: 'cmp_new',
      encrypted_content: encodeSummary('new checkpoint'),
    },
    { type: 'compaction_trigger' },
    userMessage('current'),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.compactionId, 'cmp_new');
  assert.equal(result.input.length, 2);
  assert.match(result.input[0].content[0].text, /new checkpoint/);
  assert.doesNotMatch(result.input[0].content[0].text, /old checkpoint/);
  assert.deepEqual(result.input[1], userMessage('current'));
});

test('Prefixed backend replay fails closed for opaque or malformed compaction items', () => {
  for (const encryptedContent of [
    'opaque-official-compaction',
    'sr-cmp1:not-json',
  ]) {
    const result = materializeLatestCompaction([
      userMessage('old'),
      {
        type: 'compaction',
        id: 'cmp_opaque',
        encrypted_content: encryptedContent,
      },
      userMessage('new'),
    ]);

    assert.equal(result.ok, false);
    assert.equal(result.error.type, 'unsupported_compaction_format');
  }
});

test('input without compaction is returned unchanged', () => {
  const input = [userMessage('hello')];
  const result = materializeLatestCompaction(input);

  assert.equal(result.ok, true);
  assert.equal(result.compacted, false);
  assert.equal(result.input, input);
});
