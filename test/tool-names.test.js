'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_TOOL_NAME,
  aliasFor,
  buildAliasMap,
  makeRespRewriter,
  rewriteRequestPayload,
  shortHash,
} = require('../tool-names');

const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const DOC_SCHEMAS = 'mcp__codex_apps__codex_document_control__get_document_tool_schemas'; // 66
const DOC_EXECUTE = 'mcp__codex_apps__codex_document_control__execute_document_command'; // 65
const PARENTAL = 'mcp__codex_apps__safety_settings__prepare_parental_control_update'; // 65
const SITES_CRED = 'mcp__codex_apps__sites__create_source_repository_write_credential'; // 65

function toolsOf(...names) {
  return names.map(name => ({ type: 'function', name, parameters: { type: 'object' } }));
}

test('不超限的名字原样返回', () => {
  const short = 'mcp__codex_apps__github__fetch_pr';
  assert.equal(aliasFor(short), short);
  assert.equal(aliasFor('a'.repeat(MAX_TOOL_NAME)), 'a'.repeat(MAX_TOOL_NAME));
});

test('超限的名字砍掉样板头部、动词保持完整', () => {
  assert.equal(aliasFor(DOC_SCHEMAS), 'codex_document_control__get_document_tool_schemas');
  assert.equal(aliasFor(DOC_EXECUTE), 'codex_document_control__execute_document_command');
  assert.equal(aliasFor(PARENTAL), 'safety_settings__prepare_parental_control_update');
  assert.equal(aliasFor(SITES_CRED), 'sites__create_source_repository_write_credential');
});

test('别名比原名短，且动词一字不差地保留', () => {
  for (const name of [DOC_SCHEMAS, DOC_EXECUTE, PARENTAL, SITES_CRED]) {
    const alias = aliasFor(name);
    const verb = name.split('__').pop();
    assert.ok(alias.length < name.length, `${alias} 应短于 ${name}`);
    assert.ok(alias.endsWith(verb), `${alias} 应以完整动词 ${verb} 结尾`);
    assert.ok(VALID_NAME.test(alias), `${alias} 应符合 function name 字符集`);
  }
});

test('任意长度的名字都被压到 64 以内且字符集合法', () => {
  const cases = [
    'a'.repeat(80), // 没有 __ 分隔
    `mcp__srv__${'b'.repeat(70)}`, // 单个动词段本身就超限
    `mcp__${'x'.repeat(200)}__${'y'.repeat(200)}`,
    `${'ns__'.repeat(30)}tool`,
  ];
  for (const name of cases) {
    const alias = aliasFor(name);
    assert.ok(alias.length <= MAX_TOOL_NAME, `${name.slice(0, 20)}… → ${alias.length} 字符`);
    assert.ok(VALID_NAME.test(alias), `${alias} 字符集非法`);
  }
});

test('两个长名塌成同一候选时，第二个自动升级到带区分度的形式', () => {
  const a = 'mcp__connA__shared_ns__do_something_extremely_long_operation_name_x';
  const b = 'mcp__connB__shared_ns__do_something_extremely_long_operation_name_x';
  const { fwd, rev } = buildAliasMap(toolsOf(a, b));

  assert.equal(fwd.size, 2);
  assert.notEqual(fwd.get(a), fwd.get(b));
  assert.equal(rev.size, 2, '反向映射不能因撞名而丢条目');
  assert.equal(rev.get(fwd.get(a)), a);
  assert.equal(rev.get(fwd.get(b)), b);
});

test('候选别名不会占用请求里已存在的短工具名', () => {
  const squatter = 'sites__create_source_repository_write_credential';
  const { fwd, rev } = buildAliasMap(toolsOf(SITES_CRED, squatter));

  assert.notEqual(fwd.get(SITES_CRED), squatter);
  assert.equal(fwd.has(squatter), false, '本身不超限的名字不该被改写');
  assert.equal(rev.get(fwd.get(SITES_CRED)), SITES_CRED);
});

test('别名幂等：对已经合规的别名再取一次别名不变', () => {
  const alias = aliasFor(DOC_SCHEMAS);
  assert.equal(aliasFor(alias), alias);
});

test('同一份 tools 列表重复构建得到同一套映射', () => {
  const first = buildAliasMap(toolsOf(DOC_SCHEMAS, DOC_EXECUTE, PARENTAL));
  const second = buildAliasMap(toolsOf(DOC_SCHEMAS, DOC_EXECUTE, PARENTAL));
  assert.deepEqual([...first.fwd], [...second.fwd]);
});

test('没有超限工具名时映射为空，改写是 no-op', () => {
  const payload = { tools: toolsOf('mcp__codex_apps__github__fetch_pr') };
  const { fwd, rev } = buildAliasMap(payload.tools);

  assert.equal(fwd.size, 0);
  assert.equal(makeRespRewriter(rev), null);
  rewriteRequestPayload(payload, fwd);
  assert.equal(payload.tools[0].name, 'mcp__codex_apps__github__fetch_pr');
});

test('tools 缺失或非数组时安全返回空映射', () => {
  for (const tools of [undefined, null, 'nope', {}]) {
    const { fwd } = buildAliasMap(tools);
    assert.equal(fwd.size, 0);
  }
});

test('改写覆盖 tools、嵌套 tools、tool_choice 两种形状与 input 历史', () => {
  const payload = {
    tools: [
      { type: 'function', name: DOC_SCHEMAS },
      { type: 'function', function: { name: DOC_EXECUTE } },
      { type: 'namespace', name: 'grp', tools: [{ type: 'function', name: PARENTAL }] },
    ],
    tool_choice: { type: 'function', name: DOC_SCHEMAS },
    input: [
      { type: 'function_call', name: DOC_EXECUTE, call_id: 'c1', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  };
  const { fwd } = buildAliasMap(payload.tools);
  rewriteRequestPayload(payload, fwd);

  assert.equal(payload.tools[0].name, fwd.get(DOC_SCHEMAS));
  assert.equal(payload.tools[1].function.name, fwd.get(DOC_EXECUTE));
  assert.equal(payload.tools[2].tools[0].name, fwd.get(PARENTAL));
  assert.equal(payload.tool_choice.name, fwd.get(DOC_SCHEMAS));
  assert.equal(payload.input[0].name, fwd.get(DOC_EXECUTE));

  for (const name of [DOC_SCHEMAS, DOC_EXECUTE, PARENTAL]) {
    assert.ok(!JSON.stringify(payload).includes(name), `${name} 不该残留在请求里`);
  }
});

test('ChatCompletions 形状的 tool_choice 也会被改写', () => {
  const payload = {
    tools: [{ type: 'function', function: { name: DOC_SCHEMAS } }],
    tool_choice: { type: 'function', function: { name: DOC_SCHEMAS } },
  };
  const { fwd } = buildAliasMap(payload.tools);
  rewriteRequestPayload(payload, fwd);
  assert.equal(payload.tool_choice.function.name, fwd.get(DOC_SCHEMAS));
});

test('响应侧把别名还原成原名：SSE 与 JSON 两条路径', () => {
  const { fwd, rev } = buildAliasMap(toolsOf(DOC_SCHEMAS));
  const alias = fwd.get(DOC_SCHEMAS);
  const rewrite = makeRespRewriter(rev);

  const sse = [
    `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', name: alias, call_id: 'c1' } })}`,
    'data: [DONE]',
    '',
  ].join('\n');
  const outSse = rewrite(sse);
  assert.ok(outSse.includes(DOC_SCHEMAS), '别名应被还原成原名');
  assert.ok(outSse.includes('data: [DONE]'), '非 JSON 行应原样透传');

  const json = JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: alias } }] } }] });
  assert.ok(rewrite(json).includes(DOC_SCHEMAS));
});

test('响应体不是 JSON 时原样返回，不抛异常', () => {
  const { rev } = buildAliasMap(toolsOf(DOC_SCHEMAS));
  const rewrite = makeRespRewriter(rev);
  assert.equal(rewrite('not json at all'), 'not json at all');
});

test('短哈希定长、字符集合法、且对同一输入稳定', () => {
  const h1 = shortHash(DOC_SCHEMAS);
  assert.equal(h1.length, 5);
  assert.equal(h1, shortHash(DOC_SCHEMAS));
  assert.notEqual(h1, shortHash(DOC_EXECUTE));
  assert.match(h1, /^[0-9a-z]{5}$/);
});
