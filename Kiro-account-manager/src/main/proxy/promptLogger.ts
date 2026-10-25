// 用户提示词日志：把每个请求里「用户本轮输入的文本」按天写入 JSONL 文件
// 目录：<userData>/logs/prompts/prompts-YYYY-MM-DD.jsonl
//
// 只记录最后一条 user 消息里的文本：
//   - 跳过 tool_result / 图片 / 文档等非文本块（Claude Code 的工具回传轮次不会被记录）
//   - 去掉 Claude Code 注入的 <system-reminder> 片段
// 写入为异步串行追加，不阻塞请求处理
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

/** 单条提示词最大保存字符数，超出截断 */
const MAX_PROMPT_CHARS = 20_000
/** 日志文件保留天数 */
const RETENTION_DAYS = 30

export interface PromptLogEntry {
  path: string
  model?: string
  apiKeyId?: string
  apiKeyName?: string
  clientIP?: string
  sessionId?: string
  prompt: string
}

type AnyMessage = { role?: string; content?: unknown }

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: unknown }
    // Claude: text；OpenAI chat: text；Responses: input_text
    if ((b.type === 'text' || b.type === 'input_text') && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  return parts.join('\n')
}

/** 从消息数组中提取最后一条 user 消息的纯文本（已去除 system-reminder）；无文本返回空串 */
export function extractLatestUserPrompt(messages: AnyMessage[] | undefined): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    return textOfContent(m.content).replace(SYSTEM_REMINDER_RE, '').trim()
  }
  return ''
}

class PromptLogger {
  private dir: string | null = null
  private queue: Promise<void> = Promise.resolve()
  private lastCleanupDay = ''

  private getDir(): string {
    if (!this.dir) this.dir = path.join(app.getPath('userData'), 'logs', 'prompts')
    return this.dir
  }

  getLogDir(): string {
    const dir = this.getDir()
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  log(entry: PromptLogEntry): void {
    if (!entry.prompt) return
    const now = new Date()
    // 本地日期，按用户所在时区分文件
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const prompt = entry.prompt.length > MAX_PROMPT_CHARS
      ? entry.prompt.slice(0, MAX_PROMPT_CHARS) + `...[truncated ${entry.prompt.length - MAX_PROMPT_CHARS} chars]`
      : entry.prompt
    const line = JSON.stringify({
      time: now.toISOString(),
      apiKeyName: entry.apiKeyName,
      apiKeyId: entry.apiKeyId ? entry.apiKeyId.slice(0, 8) : undefined,
      clientIP: entry.clientIP,
      sessionId: entry.sessionId,
      path: entry.path,
      model: entry.model,
      prompt
    }) + '\n'

    // 串行追加，保证顺序且不会交错
    this.queue = this.queue.then(async () => {
      try {
        const dir = this.getDir()
        await fs.promises.mkdir(dir, { recursive: true })
        await fs.promises.appendFile(path.join(dir, `prompts-${day}.jsonl`), line, 'utf8')
        if (this.lastCleanupDay !== day) {
          this.lastCleanupDay = day
          await this.cleanup(dir)
        }
      } catch (error) {
        console.error('[PromptLogger] write failed:', error)
      }
    })
  }

  private async cleanup(dir: string): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000
    const files = await fs.promises.readdir(dir)
    for (const f of files) {
      if (!/^prompts-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue
      const full = path.join(dir, f)
      const stat = await fs.promises.stat(full)
      if (stat.mtimeMs < cutoff) await fs.promises.unlink(full)
    }
  }
}

export const promptLogger = new PromptLogger()
