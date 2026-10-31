// 推理等级（effort）解析与「最高推理等级」限制
// requestedEffort：客户端原始请求值（只读，不改写请求对象）
// effectiveEffort：经模型 schema 与最高等级限制后实际发给 Kiro 的值（仅内部日志使用，不回传下游）

/** 模型 thinking 能力元数据（由 proxyServer 从模型缓存中查询后传入） */
export interface ThinkingConfig {
  schemaPath: 'output_config' | 'reasoning'
  efforts: string[]
  defaultEffort?: string
}

/** 可配置的最高推理等级（none 是关闭推理的特殊值，不是强度等级，不在此列） */
export const MAX_REASONING_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type MaxReasoningEffort = typeof MAX_REASONING_EFFORT_LEVELS[number]

/** 强度排序；不在表中的值（none / 未知值）不参与上限比较 */
const EFFORT_RANK: Record<string, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }

/** 配置值校验：非法值视为不限制 */
export function normalizeMaxReasoningEffort(value: unknown): MaxReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined
  const lower = value.toLowerCase()
  return (MAX_REASONING_EFFORT_LEVELS as readonly string[]).includes(lower) ? lower as MaxReasoningEffort : undefined
}

/** 模型没有任何不超过上限的等级时抛出（安全失败：不发送超限等级，也不靠省略 effort 字段碰运气） */
export class ReasoningEffortLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReasoningEffortLimitError'
  }
}

export interface ThinkingPlan {
  /** 客户端原始请求等级 */
  requestedEffort?: string
  /** 实际发送给 Kiro 的等级（未发送 effort 时为 undefined） */
  effectiveEffort?: string
  /** Kiro additionalModelRequestFields */
  fields?: Record<string, unknown>
  /** 因最高等级限制而改变了结果（降档或关闭推理），仅用于内部日志 */
  limited?: boolean
}

/**
 * 有上限时选择实际等级：目标 = min(请求等级, 上限)，取模型支持的、不超过目标的最高等级；
 * 若请求等级低于模型所有可用等级，取不超过上限的最低等级；仍没有则抛错。
 */
function capEffort(effort: string, efforts: string[], maxEffort: MaxReasoningEffort): string {
  const limit = EFFORT_RANK[maxEffort]
  const rank = EFFORT_RANK[effort]
  if (rank !== undefined && rank <= limit && efforts.includes(effort)) return effort
  const target = rank !== undefined ? Math.min(rank, limit) : limit
  const ranked = efforts.filter(e => EFFORT_RANK[e] !== undefined && EFFORT_RANK[e] <= limit)
    .sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b])
  const best = [...ranked].reverse().find(e => EFFORT_RANK[e] <= target) ?? ranked[0]
  if (!best) {
    throw new ReasoningEffortLimitError(
      `Model supports no reasoning effort within the configured maximum (${maxEffort}); supported: ${efforts.join(', ')}`
    )
  }
  return best
}

function buildFields(schemaPath: ThinkingConfig['schemaPath'], effort: string): Record<string, unknown> {
  switch (schemaPath) {
    case 'output_config':
      return {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort }
      }
    case 'reasoning':
      return { reasoning: { effort } }
    default:
      return { thinking: { type: 'adaptive' } }
  }
}

/**
 * 将客户端 effort / thinking 参数 + 模型 schema path 映射为 Kiro additionalModelRequestFields。
 * 官方 Kiro IDE 的 kr() 函数逻辑：
 *   output_config → { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort } }
 *   reasoning     → { reasoning: { effort } }
 * maxEffort 未设置时与旧逻辑完全一致；设置后实际等级不超过 maxEffort。
 */
export function planThinkingFields(
  thinkingConfig: ThinkingConfig | undefined,
  clientThinking?: { type: string; budget_tokens?: number; display?: string },
  clientReasoningEffort?: string,
  maxEffort?: MaxReasoningEffort
): ThinkingPlan {
  const requestedEffort = clientReasoningEffort
  // 客户端明确关闭 thinking
  if (clientThinking?.type === 'disabled') return { requestedEffort }

  // 有上限时 none 保持 none：模型 schema 声明了 none 才透传，否则不启用推理（旧逻辑会把 none 兜底成最高档）
  if (maxEffort && clientReasoningEffort?.toLowerCase() === 'none') {
    if (thinkingConfig?.efforts.includes('none')) {
      return { requestedEffort, effectiveEffort: 'none', fields: buildFields(thinkingConfig.schemaPath, 'none') }
    }
    return { requestedEffort }
  }

  // 没有模型元数据时，回退到旧逻辑：仅传 { thinking: { type: 'adaptive' } }
  if (!thinkingConfig) {
    const wants = (clientThinking && clientThinking.type !== 'disabled') || clientReasoningEffort
    if (!wants) return { requestedEffort }
    // 有上限时无法确认上游默认等级不超限 → 不开启推理（宁可降为无推理也不发送可能超限的请求）
    if (maxEffort) return { requestedEffort, limited: true }
    return { requestedEffort, fields: { thinking: { type: 'adaptive' } } }
  }

  // 客户端没请求 thinking 也没请求 reasoning_effort → 不启用
  const wantsThinking = !!(clientThinking && clientThinking.type !== 'disabled') || !!clientReasoningEffort
  if (!wantsThinking) return { requestedEffort }

  // 映射 effort level（直接使用客户端值，不做强制转换）
  const mapEffort = (input: string): string => input.toLowerCase()

  let effort: string
  if (clientReasoningEffort) {
    effort = mapEffort(clientReasoningEffort)
  } else if (clientThinking?.type === 'enabled' && clientThinking.budget_tokens) {
    // budget_tokens 粗略映射到 effort level
    const b = clientThinking.budget_tokens
    if (b <= 4000) effort = 'low'
    else if (b <= 16000) effort = 'medium'
    else if (b <= 64000) effort = 'high'
    else effort = 'xhigh'
  } else {
    effort = thinkingConfig.defaultEffort || 'high'
  }

  let limited = false
  if (maxEffort && EFFORT_RANK[effort] !== undefined) {
    // 最高推理等级限制：已知等级直接在模型支持的等级里向下取，避免旧兜底先升到最高档
    const capped = capEffort(effort, thinkingConfig.efforts, maxEffort)
    limited = EFFORT_RANK[capped] < EFFORT_RANK[effort]
    effort = capped
  } else {
    // 确保 effort 在可用范围内，否则取最接近的
    if (!thinkingConfig.efforts.includes(effort)) {
      effort = thinkingConfig.efforts[thinkingConfig.efforts.length - 1] || 'high'
    }
    // 未知等级沿用旧兜底后，仍必须受上限约束
    if (maxEffort) {
      const capped = capEffort(effort, thinkingConfig.efforts, maxEffort)
      limited = capped !== effort
      effort = capped
    }
  }

  return { requestedEffort, effectiveEffort: effort, fields: buildFields(thinkingConfig.schemaPath, effort), limited }
}
