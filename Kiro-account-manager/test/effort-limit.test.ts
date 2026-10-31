// 最高推理等级限制单元测试
// 运行：npx esbuild test/effort-limit.test.ts --bundle --platform=node --external:electron --outfile=out/effort-limit.test.cjs && node out/effort-limit.test.cjs
import assert from 'node:assert/strict'
import { planThinkingFields, ReasoningEffortLimitError, normalizeMaxReasoningEffort, type ThinkingConfig } from '../src/main/proxy/effortLimit'
import { openaiToKiro, claudeToKiro, responsesToOpenAIChat, kiroToOpenaiResponse, kiroToClaudeResponse, openAIChatToResponsesResponse } from '../src/main/proxy/translator'
import type { OpenAIChatRequest, ClaudeRequest, OpenAIResponsesRequest } from '../src/main/proxy/types'

const CLAUDE: ThinkingConfig = { schemaPath: 'output_config', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }
const GPT: ThinkingConfig = { schemaPath: 'reasoning', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] }
const NO_HIGH: ThinkingConfig = { schemaPath: 'output_config', efforts: ['low', 'medium', 'max'] }
const ONLY_MAX: ThinkingConfig = { schemaPath: 'output_config', efforts: ['max'] }

let passed = 0
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { console.error(`  FAIL ${name}`); throw e }
}
const eff = (cfg: ThinkingConfig | undefined, effort?: string, max?: string, thinking?: { type: string; budget_tokens?: number }): string | undefined =>
  planThinkingFields(cfg, thinking, effort, normalizeMaxReasoningEffort(max)).effectiveEffort

console.log('planThinkingFields')
test('unlimited + max → max', () => assert.equal(eff(CLAUDE, 'max'), 'max'))
for (const [req, want] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'high'], ['max', 'high']]) {
  test(`high cap + ${req} → ${want}`, () => assert.equal(eff(CLAUDE, req, 'high'), want))
}
test('high cap + none → none (no thinking enabled on Claude)', () => {
  const p = planThinkingFields(CLAUDE, undefined, 'none', 'high')
  assert.equal(p.fields, undefined)
})
test('high cap + none → reasoning.effort none on GPT (schema has none)', () => {
  assert.deepEqual(planThinkingFields(GPT, undefined, 'none', 'high').fields, { reasoning: { effort: 'none' } })
})
test('medium cap + high → medium', () => assert.equal(eff(CLAUDE, 'high', 'medium'), 'medium'))
test('low cap + max → low', () => assert.equal(eff(CLAUDE, 'max', 'low'), 'low'))
test('no effort, no thinking → unchanged (off)', () => {
  assert.equal(planThinkingFields(CLAUDE, undefined, undefined, 'high').fields, undefined)
  assert.equal(planThinkingFields(CLAUDE, undefined, undefined, undefined).fields, undefined)
})
test('adaptive thinking w/o effort → default high, capped by medium', () => {
  assert.equal(eff(CLAUDE, undefined, undefined, { type: 'adaptive' }), 'high')
  assert.equal(eff(CLAUDE, undefined, 'medium', { type: 'adaptive' }), 'medium')
})
test('budget_tokens 100k → xhigh, capped to high', () => {
  assert.equal(eff(CLAUDE, undefined, 'high', { type: 'enabled', budget_tokens: 100000 }), 'high')
})
test('model without high: high cap + max → medium (never rounds up to max)', () => {
  assert.equal(eff(NO_HIGH, 'max', 'high'), 'medium')
  assert.equal(eff(NO_HIGH, 'high', 'high'), 'medium')
  // 不限制时保持旧逻辑：不支持的等级兜底为模型最后一档
  assert.equal(eff(NO_HIGH, 'high'), 'max')
})
test('GPT model: high cap + max → high via reasoning.effort', () => {
  assert.deepEqual(planThinkingFields(GPT, undefined, 'max', 'high').fields, { reasoning: { effort: 'high' } })
})
test('model with no level within cap → throws (safe failure)', () => {
  assert.throws(() => planThinkingFields(ONLY_MAX, undefined, 'max', 'high'), ReasoningEffortLimitError)
})
test('no schema + cap → thinking not enabled (no unbounded default)', () => {
  assert.equal(planThinkingFields(undefined, undefined, 'max', 'high').fields, undefined)
  assert.deepEqual(planThinkingFields(undefined, undefined, 'max', undefined).fields, { thinking: { type: 'adaptive' } })
})
test('thinking disabled stays disabled', () => {
  assert.equal(planThinkingFields(CLAUDE, { type: 'disabled' }, 'max', 'high').fields, undefined)
  assert.equal(planThinkingFields(CLAUDE, { type: 'disabled' }, 'max', undefined).fields, undefined)
})
test('unknown effort, unlimited → legacy fallback (last level)', () => assert.equal(eff(CLAUDE, 'bogus'), 'max'))
test('unknown effort, high cap → never above high', () => assert.equal(eff(CLAUDE, 'bogus', 'high'), 'high'))
test('invalid config value → unlimited', () => assert.equal(normalizeMaxReasoningEffort('none'), undefined))

console.log('protocols')
const chatReq = (effort?: string): OpenAIChatRequest => ({ model: 'claude-opus-4.7', messages: [{ role: 'user', content: 'hi' }], ...(effort ? { reasoning_effort: effort } : {}) })

test('OpenAI Chat: max → high upstream, request untouched', () => {
  const req = chatReq('max')
  const payload = openaiToKiro(req, undefined, undefined, { config: CLAUDE, maxEffort: 'high' })
  assert.deepEqual(payload.additionalModelRequestFields, { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } })
  assert.equal(req.reasoning_effort, 'max')
})
test('OpenAI Chat: unlimited identical to legacy ThinkingConfig call', () => {
  const a = openaiToKiro(chatReq('max'), undefined, undefined, CLAUDE).additionalModelRequestFields
  const b = openaiToKiro(chatReq('max'), undefined, undefined, { config: CLAUDE }).additionalModelRequestFields
  assert.deepEqual(a, b)
  assert.deepEqual((a as { output_config: unknown }).output_config, { effort: 'max' })
})
test('OpenAI Responses: reasoning.effort max → high upstream (GPT reasoning path)', () => {
  const rreq: OpenAIResponsesRequest = { model: 'gpt-5', input: 'hi', reasoning: { effort: 'max' } }
  const chat = responsesToOpenAIChat(rreq)
  assert.equal(chat.reasoning_effort, 'max')
  const payload = openaiToKiro(chat, undefined, undefined, { config: GPT, maxEffort: 'high' })
  assert.deepEqual(payload.additionalModelRequestFields, { reasoning: { effort: 'high' } })
  assert.deepEqual(rreq.reasoning, { effort: 'max' })
})
test('OpenAI Responses: reasoning.effort none → no reasoning_effort', () => {
  assert.equal(responsesToOpenAIChat({ model: 'gpt-5', input: 'hi', reasoning: { effort: 'none' } }).reasoning_effort, undefined)
})
test('Anthropic Messages: output_config.effort max → high upstream, request untouched', () => {
  const req: ClaudeRequest = { model: 'claude-opus-4.7', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'max' } }
  const payload = claudeToKiro(req, undefined, undefined, { config: CLAUDE, maxEffort: 'high' })
  assert.deepEqual((payload.additionalModelRequestFields as { output_config: unknown }).output_config, { effort: 'high' })
  assert.equal(req.output_config?.effort, 'max')
})
test('Anthropic Messages: thinking disabled + effort max → no fields', () => {
  const req: ClaudeRequest = { model: 'claude-opus-4.7', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'disabled' }, output_config: { effort: 'max' } }
  assert.equal(claudeToKiro(req, undefined, undefined, { config: CLAUDE, maxEffort: 'high' }).additionalModelRequestFields, undefined)
})
test('onPlan reports requested vs effective (internal only)', () => {
  let plan: { requestedEffort?: string; effectiveEffort?: string } | undefined
  openaiToKiro(chatReq('max'), undefined, undefined, { config: CLAUDE, maxEffort: 'high', onPlan: p => { plan = p } })
  assert.equal(plan?.requestedEffort, 'max')
  assert.equal(plan?.effectiveEffort, 'high')
})

console.log('response isolation')
const usage = { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 } as never
const scan = (obj: unknown): void => {
  const s = JSON.stringify(obj)
  assert.ok(!/effective_effort|effectiveEffort|output_config|"effort"/.test(s), `effort leaked: ${s}`)
}
test('OpenAI / Responses / Claude non-stream responses carry no effort fields', () => {
  const oai = kiroToOpenaiResponse('hello', [], usage, 'claude-opus-4.7')
  scan(oai)
  scan(openAIChatToResponsesResponse(oai))
  scan(kiroToClaudeResponse('hello', [], usage, 'claude-opus-4.7'))
})

console.log(`\n${passed} passed`)
