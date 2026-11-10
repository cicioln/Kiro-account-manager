// 缓存 usage 模拟器（可开关，替代 promptCacheTracker 的按账号模拟）
// 1. 前缀匹配：按 API Key + 模型存前缀哈希（换号不丢），收到请求即写入（并发可见），
//    每个消息结尾都是断点（不依赖 cache_control，三个接口通用）
// 2. 会话平滑：按会话累计 input / cache_read，让长期命中率趋近目标值
// 3. 成本兜底：本轮 credits × 每积分成本 × (1 + 盈利率) 必须 ≤ 下游按官方价 × 倍率算出的收费，
//    不够时把 cache_read 挪回普通 input（会拉低该轮命中率）
// 最终数字都按 Kiro 返回的 inputTokens 拆分，input + cache_creation + cache_read = 真实总量

import { createHash } from 'crypto'
import { estimateTokensFast } from './tokenCounter'
import { proxyLogger } from './logger'
import type { KiroUsage } from './types'

const PREFIX_TTL = 5 * 60 * 1000          // 前缀缓存 TTL，命中即续期
const SESSION_TTL = 60 * 60 * 1000        // 会话累计统计保留 1 小时
const PRUNE_INTERVAL = 60 * 1000
const MAX_PREFIXES_PER_SCOPE = 500
const MAX_SESSIONS = 5000
// 高并发模式：大量客户端共用一个 scope 时，500 条会被别的会话挤掉导致前缀失配
const HC_MAX_PREFIXES_PER_SCOPE = 20000
const HC_MAX_SESSIONS = 50000
const HC_TAIL_POINTS = 4                  // 只写 head（tools/system）+ 最后几个断点；下一轮追加消息后仍能匹配上一轮末尾
const MAX_RATIO = 0.95                    // 有前缀命中时单轮命中率上限
const COLD_MAX_RATIO = 0.6                // 无前缀命中（首轮/前缀变化）时单轮上限，后续轮次再补回

export const CACHE_SIM_DEFAULTS = {
  targetRatio: 0.8,
  creditCostUsd: 0.0015,
  profitMargin: 0.5,
  priceMultiplier: 1
}

export interface CacheSimSettings {
  targetRatio?: number
  creditCostUsd?: number
  profitMargin?: number
  priceMultiplier?: number
  /** 高并发模式：大容量 LRU 前缀表 + 只写首尾断点 */
  highConcurrency?: boolean
  /** 随机缓存写入区间（token）：writeMax > 0 时每次 Claude 请求的 cache_creation 在 [writeMin, writeMax] 内随机 */
  writeMin?: number
  writeMax?: number
  /** 命中率波动幅度（0~0.5）：每轮命中率在 会话平滑值 ± jitter 内随机，会话平滑在后续轮次把偏差补回 */
  jitter?: number
}

/** 解析随机写入区间；未设置或上限 ≤ 0 返回 undefined（走前缀匹配算出的写入量） */
export function resolveWriteRange(s: CacheSimSettings): { min: number; max: number } | undefined {
  const a = Number.isFinite(s.writeMin) ? Math.max(0, Math.round(s.writeMin as number)) : 0
  const b = Number.isFinite(s.writeMax) ? Math.max(0, Math.round(s.writeMax as number)) : 0
  if (b <= 0) return undefined
  return { min: Math.min(a, b), max: b }
}

interface ModelPrice {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

// Anthropic 官方价（美元 / 百万 token），new-api 默认按此价 × 倍率计费
export function getModelPrice(model: string): ModelPrice {
  const m = (model || '').toLowerCase()
  let input = 3
  let output = 15
  if (m.includes('opus')) {
    // opus-4 / 4.1 旧价；4.5 及以后新价
    if (/opus-4(?![.-]?[5-9])/.test(m)) { input = 15; output = 75 } else { input = 5; output = 25 }
  } else if (m.includes('haiku')) {
    if (/haiku-3|3-5-haiku|3\.5-haiku/.test(m)) { input = 0.8; output = 4 } else { input = 1; output = 5 }
  }
  return { input, output, cacheWrite: input * 1.25, cacheRead: input * 0.1 }
}

interface SessionStat {
  input: number
  read: number
  lastSeen: number
}

export interface CacheSimBeginOptions {
  format: 'claude' | 'openai'
  apiKeyId?: string
  model: string
  sessionHint?: string
  /** 消息之前的前缀段（tools、system），按顺序 */
  head: unknown[]
  messages: unknown[]
  settings: CacheSimSettings
}

export class CacheSimHandle {
  constructor(
    private readonly sim: CacheSimulator,
    private readonly opts: CacheSimBeginOptions,
    private readonly sessionKey: string,
    private readonly matchRatio: number,
    private readonly tailRatio: number
  ) {}

  /** 用 Kiro 返回的真实 usage 计算最终的缓存拆分 */
  finish(usage: KiroUsage): KiroUsage {
    try {
      return this.sim.finish(this.opts, this.sessionKey, this.matchRatio, this.tailRatio, usage)
    } catch (error) {
      proxyLogger.warn('CacheSim', 'finish failed', error)
      return usage
    }
  }
}

export class CacheSimulator {
  private prefixes = new Map<string, Map<string, number>>()   // scope → hash → expiresAt
  private sessions = new Map<string, SessionStat>()
  private lastPrune = Date.now()
  private maxSessions = MAX_SESSIONS

  begin(opts: CacheSimBeginOptions): CacheSimHandle {
    const now = Date.now()
    const hc = opts.settings.highConcurrency === true
    this.maxSessions = hc ? HC_MAX_SESSIONS : MAX_SESSIONS
    this.pruneIfNeeded(now)

    const scope = `${opts.apiKeyId || 'anon'}:${opts.model}`
    const segments = [...opts.head.filter((s) => s !== undefined && s !== null), ...opts.messages]
    const hasher = createHash('sha256')
    const points: { hash: string; tokens: number }[] = []
    let total = 0
    let firstMessageHash = ''
    for (let i = 0; i < segments.length; i++) {
      // 去掉 cache_control：Claude Code 每轮会把断点挪到最新消息，留着会让旧前缀的哈希变掉
      const value = typeof segments[i] === 'string'
        ? (segments[i] as string)
        : JSON.stringify(segments[i], (k, v) => (k === 'cache_control' ? undefined : v))
      hasher.update(`${value.length}\0${value}\0`)
      total += estimateTokensFast(value)
      const hash = hasher.copy().digest('hex')
      points.push({ hash, tokens: total })
      if (i === segments.length - opts.messages.length) firstMessageHash = hash
    }

    let entries = this.prefixes.get(scope)
    if (!entries) {
      entries = new Map()
      this.prefixes.set(scope, entries)
    }

    // 从后往前找最长的未过期前缀；不算最后一段（本轮新消息）
    let matched = 0
    for (let i = points.length - 2; i >= 0; i--) {
      const exp = entries.get(points[i].hash)
      if (exp && exp >= now) {
        matched = points[i].tokens
        break
      }
    }
    // 立即写入（含最后一段），并发的同前缀请求也能命中
    if (hc) {
      // head 段保留，新会话共用 tools/system 也能命中；先删后写让 Map 插入顺序即 LRU 顺序
      const headCount = points.length - opts.messages.length
      for (let i = 0; i < points.length; i++) {
        if (i >= headCount && i < points.length - HC_TAIL_POINTS) continue
        entries.delete(points[i].hash)
        entries.set(points[i].hash, now + PREFIX_TTL)
      }
      for (const k of entries.keys()) {
        if (entries.size <= HC_MAX_PREFIXES_PER_SCOPE) break
        entries.delete(k)
      }
    } else {
      for (const p of points) entries.set(p.hash, now + PREFIX_TTL)
    }
    if (!hc && entries.size > MAX_PREFIXES_PER_SCOPE) {
      const sorted = [...entries.entries()].sort((a, b) => a[1] - b[1])
      for (const [k] of sorted.slice(0, entries.size - MAX_PREFIXES_PER_SCOPE)) entries.delete(k)
    }

    const lastSegTokens = points.length > 1 ? total - points[points.length - 2].tokens : total
    const matchRatio = total > 0 ? matched / total : 0
    const tailRatio = total > 0 ? lastSegTokens / total : 1
    const sessionKey = opts.sessionHint ? `${scope}:${opts.sessionHint}` : `${scope}:${firstMessageHash || 'none'}`
    return new CacheSimHandle(this, opts, sessionKey, matchRatio, tailRatio)
  }

  finish(opts: CacheSimBeginOptions, sessionKey: string, matchRatio: number, tailRatio: number, usage: KiroUsage): KiroUsage {
    const total = Math.max(0, Math.round(usage.inputTokens || 0))
    if (total === 0) return usage

    const s = opts.settings
    const target = clamp(s.targetRatio ?? CACHE_SIM_DEFAULTS.targetRatio, 0, MAX_RATIO)
    const creditCost = Math.max(0, s.creditCostUsd ?? CACHE_SIM_DEFAULTS.creditCostUsd)
    const margin = Math.max(0, s.profitMargin ?? CACHE_SIM_DEFAULTS.profitMargin)
    const multiplier = Math.max(0, s.priceMultiplier ?? CACHE_SIM_DEFAULTS.priceMultiplier)

    // 目标 0%：完全不报缓存（与不支持缓存的上游一致），避免出现"只写入不读取"
    // 但配置了随机写入区间时仍按区间报写入（用户显式要求）
    if (target <= 0) {
      const range = opts.format === 'claude' ? resolveWriteRange(s) : undefined
      if (range) {
        const write = Math.min(total, range.min + Math.floor(Math.random() * (range.max - range.min + 1)))
        proxyLogger.info('CacheSim', `total=${total} target=0 random write=${write} input=${total - write}`)
        return { ...usage, inputTokens: total, cacheReadTokens: 0, cacheWriteTokens: write }
      }
      proxyLogger.info('CacheSim', `total=${total} target=0, no cache reported`)
      return { ...usage, inputTokens: total, cacheReadTokens: 0, cacheWriteTokens: 0 }
    }

    // 会话平滑：本轮命中率 = 让会话累计命中率回到目标值所需的值
    const now = Date.now()
    const stat = this.sessions.get(sessionKey) || { input: 0, read: 0, lastSeen: now }
    const desired = (target * (stat.input + total) - stat.read) / total
    // 命中率波动：在平滑值上叠加 ±jitter 的随机偏移；偏差计入会话累计，下一轮平滑会反向补回
    const jitter = clamp(s.jitter ?? 0, 0, 0.5)
    const jittered = jitter > 0 ? desired + (Math.random() * 2 - 1) * jitter : desired
    const ratio = clamp(jittered, 0, matchRatio > 0 ? MAX_RATIO : Math.min(COLD_MAX_RATIO, target))

    let read = Math.round(total * ratio)
    const remainder = total - read
    const tail = Math.min(remainder, Math.max(1, Math.round(total * tailRatio)))
    // cache_creation 只算前缀匹配没命中的新内容（不含最新一条消息）；
    // 已缓存过、但本轮被平滑/兜底压掉的前缀算普通 input，不能重复报写入（写入按 1.25 倍计费，会多收）
    // OpenAI 格式没有 cache_creation 概念
    const fresh = Math.round(total * (1 - matchRatio)) - tail
    let write = opts.format === 'claude' ? clamp(fresh, 0, remainder - tail) : 0
    let uncached = remainder - write

    // 随机写入区间：cache_creation 在区间内随机跳动；先从 cache_read 挪，不够再占用普通 input，
    // 请求总量小于随机值时封顶为总量。写入单价高于 input / cache_read，只会提高下游收费，不影响成本兜底
    const range = opts.format === 'claude' ? resolveWriteRange(s) : undefined
    if (range) {
      write = Math.min(total, range.min + Math.floor(Math.random() * (range.max - range.min + 1)))
      const fromRead = Math.min(read, write)
      read -= fromRead
      uncached = total - write - read
    }

    // 成本兜底
    const credits = usage.credits || 0
    let cost = 0
    let revenue = 0
    if (credits > 0 && creditCost > 0 && multiplier > 0) {
      const p = getModelPrice(opts.model)
      const out = usage.outputTokens || 0
      cost = credits * creditCost
      const required = cost * (1 + margin)
      const calc = (r: number, u: number): number =>
        multiplier * (u * p.input + write * p.cacheWrite + r * p.cacheRead + out * p.output) / 1e6
      revenue = calc(read, uncached)
      if (revenue < required) {
        const perToken = multiplier * (p.input - p.cacheRead) / 1e6
        const moved = Math.min(read, Math.ceil((required - revenue) / perToken))
        read -= moved
        uncached += moved
        revenue = calc(read, uncached)
        if (revenue < required) {
          proxyLogger.warn('CacheSim', `cache_read=0 still below floor: revenue $${revenue.toFixed(5)} < required $${required.toFixed(5)} (credits=${credits}, model=${opts.model})`)
        }
      }
    }

    stat.input += total
    stat.read += read
    stat.lastSeen = now
    this.sessions.set(sessionKey, stat)

    proxyLogger.info('CacheSim', `total=${total} read=${read} write=${write} input=${uncached} ratio=${(read / total * 100).toFixed(1)}% session=${(stat.read / stat.input * 100).toFixed(1)}% match=${(matchRatio * 100).toFixed(0)}%${cost > 0 ? ` cost=$${cost.toFixed(5)} revenue=$${revenue.toFixed(5)}` : ''}`)

    return { ...usage, inputTokens: total, cacheReadTokens: read, cacheWriteTokens: write }
  }

  clear(): number {
    let count = this.sessions.size
    for (const entries of this.prefixes.values()) count += entries.size
    this.prefixes.clear()
    this.sessions.clear()
    return count
  }

  private pruneIfNeeded(now: number): void {
    if (now - this.lastPrune < PRUNE_INTERVAL) return
    this.lastPrune = now
    for (const [scope, entries] of this.prefixes) {
      for (const [hash, exp] of entries) if (exp < now) entries.delete(hash)
      if (entries.size === 0) this.prefixes.delete(scope)
    }
    for (const [key, stat] of this.sessions) if (now - stat.lastSeen > SESSION_TTL) this.sessions.delete(key)
    if (this.sessions.size > this.maxSessions) {
      const sorted = [...this.sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      for (const [key] of sorted.slice(0, this.sessions.size - this.maxSessions)) this.sessions.delete(key)
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, v))
}

export const cacheSimulator = new CacheSimulator()
