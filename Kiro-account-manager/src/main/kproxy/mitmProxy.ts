// K-Proxy MITM 代理核心
import * as http from 'http'
import * as net from 'net'
import * as tls from 'tls'
import * as url from 'url'
import type { 
  KProxyConfig, 
  KProxyStats, 
  KProxyEvents,
  KProxyRequestInfo 
} from './types'
import { CertManager } from './certManager'

// Machine ID 正则匹配模式（64位十六进制）
const MACHINE_ID_REGEX = /[a-f0-9]{64}/gi
// 支持两种格式：KiroIDE-0.6.18-{machineId} 或 KiroIDE 0.6.18 {machineId}
const KIRO_UA_REGEX = /KiroIDE[-\s][\d.]+[-\s]([a-f0-9]{64})/i

/**
 * K-Proxy MITM 代理服务器
 */
export class MitmProxy {
  private server: http.Server | null = null
  private certManager: CertManager
  private config: KProxyConfig
  private stats: KProxyStats
  private events: KProxyEvents
  private tlsServers: Map<string, tls.Server> = new Map()
  /** 跟踪所有 CONNECT 隧道客户端连接，stop() 时强制销毁，避免 server.close() 等 Keep-Alive 超时 */
  private sockets = new Set<net.Socket>()

  constructor(certManager: CertManager, config: KProxyConfig, events: KProxyEvents = {}) {
    this.certManager = certManager
    this.config = config
    this.events = events
    this.stats = {
      totalRequests: 0,
      mitmRequests: 0,
      bypassRequests: 0,
      modifiedRequests: 0,
      startTime: 0,
      lastRequestTime: 0
    }
  }

  /**
   * 启动代理服务器
   */
  async start(): Promise<void> {
    if (this.server) {
      console.log('[MitmProxy] Server already running')
      return
    }

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleHttpRequest(req, res)
      })
      this.server = srv
      let listening = false

      // 处理 CONNECT 请求（HTTPS 隧道）
      srv.on('connect', (req, clientSocket: net.Socket, head) => {
        this.handleConnect(req, clientSocket, head)
      })

      srv.on('error', (error: NodeJS.ErrnoException) => {
        // listen 失败时复位 this.server，否则 isRunning() 误报运行中、后续 start() 直接返回
        if (!listening && this.server === srv) {
          this.server = null
        }
        if (error.code === 'EADDRINUSE') {
          console.error(`[MitmProxy] Port ${this.config.port} is already in use`)
          reject(new Error(`Port ${this.config.port} is already in use`))
        } else {
          console.error('[MitmProxy] Server error:', error)
          this.events.onError?.(error)
          reject(error)
        }
      })

      srv.listen(this.config.port, this.config.host, () => {
        listening = true
        console.log(`[MitmProxy] Started on ${this.config.host}:${this.config.port}`)
        this.stats.startTime = Date.now()
        this.events.onStatusChange?.(true, this.config.port)
        resolve()
      })
    })
  }

  /**
   * 停止代理服务器
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    // 关闭所有 TLS 服务器
    for (const [_host, tlsServer] of this.tlsServers) {
      try { tlsServer.close() } catch { /* ignore */ }
    }
    this.tlsServers.clear()

    // 强制销毁所有活跃隧道连接：否则 server.close() 会等 Keep-Alive 连接自然超时（~60s）
    for (const sock of this.sockets) {
      try { sock.destroy() } catch { /* ignore */ }
    }
    this.sockets.clear()

    const srv = this.server
    this.server = null
    return new Promise((resolve) => {
      const finish = (): void => {
        console.log('[MitmProxy] Stopped')
        this.events.onStatusChange?.(false, this.config.port)
        resolve()
      }
      srv.close(() => finish())
      // 双保险：1 秒后无论 close 回调是否触发都 resolve
      setTimeout(finish, 1000)
    })
  }

  /**
   * 处理 HTTP 请求
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.stats.totalRequests++
    this.stats.lastRequestTime = Date.now()

    const targetUrl = url.parse(req.url || '')
    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: targetUrl.path,
      method: req.method,
      headers: req.headers
    }

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (error) => {
      console.error('[MitmProxy] HTTP proxy error:', error)
      // 响应头已发出时不能再 writeHead（会抛 ERR_HTTP_HEADERS_SENT 导致主进程崩溃），直接断开
      if (!res.headersSent) {
        res.writeHead(502)
        res.end('Bad Gateway')
      } else {
        res.destroy()
      }
    })
    req.on('error', () => proxyReq.destroy())
    res.on('error', () => proxyReq.destroy())

    req.pipe(proxyReq)
  }

  /**
   * 处理 CONNECT 请求（HTTPS 隧道）
   */
  private handleConnect(
    req: http.IncomingMessage, 
    clientSocket: net.Socket, 
    head: Buffer
  ): void {
    // 跟踪隧道连接，stop() 时强制断开
    this.sockets.add(clientSocket)
    clientSocket.once('close', () => this.sockets.delete(clientSocket))
    this.stats.totalRequests++
    this.stats.lastRequestTime = Date.now()

    const [hostname, portStr] = (req.url || '').split(':')
    const port = parseInt(portStr, 10) || 443

    // 检查是否需要 MITM
    const shouldMitm = this.shouldMitm(hostname)

    if (shouldMitm) {
      this.stats.mitmRequests++
      this.handleMitmConnect(hostname, port, clientSocket, head)
    } else {
      this.stats.bypassRequests++
      this.handleDirectConnect(hostname, port, clientSocket, head)
    }
  }

  /**
   * 检查域名是否需要 MITM
   */
  private shouldMitm(hostname: string): boolean {
    for (const domain of this.config.mitmDomains) {
      if (hostname.includes(domain)) {
        if (this.config.logRequests) {
          console.log(`[MitmProxy] MITM: ${hostname} matches ${domain}`)
        }
        return true
      }
    }
    if (this.config.logRequests) {
      console.log(`[MitmProxy] Bypass: ${hostname}`)
    }
    return false
  }

  /**
   * 直接转发连接（不解密）
   */
  private handleDirectConnect(
    hostname: string, 
    port: number, 
    clientSocket: net.Socket, 
    head: Buffer
  ): void {
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      serverSocket.write(head)
      serverSocket.pipe(clientSocket)
      clientSocket.pipe(serverSocket)
    })

    serverSocket.on('error', (error) => {
      console.error(`[MitmProxy] Direct connect error to ${hostname}:${port}:`, error.message)
      clientSocket.end()
    })

    clientSocket.on('error', (error) => {
      console.error(`[MitmProxy] Client socket error:`, error.message)
      serverSocket.end()
    })
  }

  /**
   * MITM 拦截连接
   */
  private handleMitmConnect(
    hostname: string, 
    port: number, 
    clientSocket: net.Socket, 
    _head: Buffer
  ): void {
    try {
      // 为目标域名生成证书
      const { cert, key } = this.certManager.generateCertForHost(hostname)

      // 创建 TLS 连接选项
      const tlsOptions = {
        key,
        cert
      }

      // 通知客户端连接已建立
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

      // 创建 TLS 连接
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        ...tlsOptions,
        isServer: true
      })

      // 处理 TLS 错误
      tlsSocket.on('error', (error) => {
        console.error(`[MitmProxy] TLS error for ${hostname}:`, error.message)
        clientSocket.end()
      })

      // 处理解密后的请求
      this.handleDecryptedConnection(tlsSocket, hostname, port)
    } catch (error) {
      console.error(`[MitmProxy] MITM setup error for ${hostname}:`, error)
      clientSocket.end()
    }
  }

  /**
   * 处理解密后的 HTTPS 连接
   * 每个 TLS 连接只处理一个请求：转发时强制 Connection: close，上游响应结束后关闭客户端连接，
   * 客户端会为下一个请求重新建连（避免 keep-alive 后续请求被丢弃或绕过 Machine ID 替换）。
   * 头部/请求体全程按 Buffer 处理，避免 UTF-8 解码破坏多字节字符或二进制内容。
   */
  private handleDecryptedConnection(
    clientSocket: tls.TLSSocket,
    hostname: string,
    port: number
  ): void {
    const MAX_HEADER_BYTES = 64 * 1024
    let headerBuf: Buffer = Buffer.alloc(0)
    // headers: 等待请求头；body: 按 Content-Length 收集请求体；stream: chunked 等无长度请求体直接流式转发；done: 已转发，忽略后续数据
    let state: 'headers' | 'body' | 'stream' | 'done' = 'headers'
    let finalHeaders = ''
    let contentLength = 0
    const bodyChunks: Buffer[] = []
    let bodyLen = 0
    let streamWrite: ((chunk: Buffer) => void) | null = null

    const tryFinishBody = (): void => {
      if (bodyLen < contentLength) return
      state = 'done'
      // 超出 Content-Length 的部分属于下一个请求，Connection: close 下直接丢弃（客户端会重连）
      const body = Buffer.concat(bodyChunks).subarray(0, contentLength)
      bodyChunks.length = 0
      const modifiedBody = this.modifyBody(body)
      let headers = finalHeaders
      if (modifiedBody !== body) {
        // body 被修改，按实际字节数重算 Content-Length
        headers = this.setHeader(headers, 'content-length', String(modifiedBody.length))
      }
      this.forwardRequest(headers, modifiedBody, hostname, port, clientSocket, false)
    }

    clientSocket.on('data', (chunk: Buffer) => {
      if (state === 'headers') {
        headerBuf = Buffer.concat([headerBuf, chunk])
        const headerEnd = headerBuf.indexOf('\r\n\r\n')
        if (headerEnd === -1) {
          if (headerBuf.length > MAX_HEADER_BYTES) {
            console.error(`[MitmProxy] Request headers too large for ${hostname}`)
            clientSocket.destroy()
          }
          return
        }
        // 头部按 latin1 解码，字节一一对应，写回时不改变原始字节
        const headers = headerBuf.subarray(0, headerEnd).toString('latin1')
        const rest = headerBuf.subarray(headerEnd + 4)
        headerBuf = Buffer.alloc(0)

        // 解析并修改请求头
        const { modified, newHeaders, info } = this.modifyHeaders(headers, hostname)
        // 强制短连接：去掉原有的连接管理头，追加 Connection: close
        finalHeaders = this.forceConnectionClose(newHeaders)

        // 记录请求
        this.events.onRequest?.(info)
        this.events.onMitmIntercept?.(hostname, modified)

        const isChunked = /^transfer-encoding:[^\r\n]*chunked/im.test(headers)
        const clMatch = headers.match(/^content-length:\s*(\d+)\s*$/im)

        if (isChunked) {
          // 无法预知长度的请求体：不做 body 替换，后续字节原样流式转发
          state = 'stream'
          streamWrite = this.forwardRequest(finalHeaders, rest, hostname, port, clientSocket, true)
          return
        }

        // 无 Content-Length 且非 chunked：按 HTTP/1.1 视为无请求体，多余字节属于流水线请求，丢弃（Connection: close 下客户端会重连）
        contentLength = clMatch ? parseInt(clMatch[1], 10) : 0
        if (contentLength > rest.length && /^expect:\s*100-continue\s*$/im.test(finalHeaders)) {
          // 需先缓冲完整请求体再转发：代为应答 100 Continue，并去掉 Expect 头，避免客户端一直等待
          finalHeaders = finalHeaders
            .split('\r\n')
            .filter((line, idx) => idx === 0 || !/^expect\s*:/i.test(line))
            .join('\r\n')
          clientSocket.write('HTTP/1.1 100 Continue\r\n\r\n')
        }
        state = 'body'
        if (rest.length > 0) {
          bodyChunks.push(rest)
          bodyLen += rest.length
        }
        tryFinishBody()
      } else if (state === 'body') {
        bodyChunks.push(chunk)
        bodyLen += chunk.length
        tryFinishBody()
      } else if (state === 'stream') {
        streamWrite?.(chunk)
      }
      // done: Connection: close 模式下忽略后续数据
    })

    clientSocket.on('error', (error) => {
      console.error(`[MitmProxy] Decrypted connection error:`, error.message)
    })
  }

  /**
   * 去掉 Connection / Proxy-Connection / Keep-Alive 头并追加 Connection: close
   */
  private forceConnectionClose(headers: string): string {
    const lines = headers.split('\r\n').filter((line, idx) => {
      if (idx === 0) return true
      return !/^(connection|proxy-connection|keep-alive)\s*:/i.test(line)
    })
    lines.push('Connection: close')
    return lines.join('\r\n')
  }

  /**
   * 设置（替换或追加）请求头
   */
  private setHeader(headers: string, name: string, value: string): string {
    const re = new RegExp(`^${name}\\s*:.*$`, 'im')
    if (re.test(headers)) {
      return headers.replace(re, `${name}: ${value}`)
    }
    return `${headers}\r\n${name}: ${value}`
  }

  /**
   * 替换请求体中的 Machine ID
   */
  private modifyBody(bodyBuf: Buffer): Buffer {
    const targetDeviceId = this.config.deviceId
    if (!targetDeviceId || bodyBuf.length === 0) return bodyBuf
    // 按 latin1 处理：字节一一对应，十六进制 ID 为 ASCII，替换不会破坏其他字节
    const body = bodyBuf.toString('latin1')
    // 只在 body 中包含 64 位十六进制时才替换（避免误伤无关内容）
    MACHINE_ID_REGEX.lastIndex = 0
    if (!MACHINE_ID_REGEX.test(body)) {
      MACHINE_ID_REGEX.lastIndex = 0
      return bodyBuf
    }
    MACHINE_ID_REGEX.lastIndex = 0
    const result = body.replace(MACHINE_ID_REGEX, (match) => {
      // 不替换已经是目标 ID 的
      if (match.toLowerCase() === targetDeviceId.toLowerCase()) return match
      if (this.config.logRequests) {
        console.log(`[MitmProxy] Replaced Machine ID in body: ${match.substring(0, 16)}... -> ${targetDeviceId.substring(0, 16)}...`)
      }
      return targetDeviceId
    })
    MACHINE_ID_REGEX.lastIndex = 0
    return result === body ? bodyBuf : Buffer.from(result, 'latin1')
  }

  /**
   * 修改请求头（替换 Machine ID）
   */
  private modifyHeaders(
    headers: string, 
    hostname: string
  ): { modified: boolean; newHeaders: string; info: KProxyRequestInfo } {
    const lines = headers.split('\r\n')
    const firstLine = lines[0]
    const [method, path] = firstLine.split(' ')
    
    let modified = false
    let originalDeviceId: string | undefined
    let newDeviceId: string | undefined
    const targetDeviceId = this.config.deviceId

    const info: KProxyRequestInfo = {
      timestamp: Date.now(),
      method: method || 'UNKNOWN',
      host: hostname,
      path: path || '/',
      isMitm: true,
      deviceIdReplaced: false
    }

    if (!targetDeviceId) {
      return { modified: false, newHeaders: headers, info }
    }

    const modifiedLines = lines.map((line) => {
      const lowerLine = line.toLowerCase()
      
      // 检查 user-agent 和 x-amz-user-agent
      if (lowerLine.startsWith('user-agent:') || lowerLine.startsWith('x-amz-user-agent:')) {
        const match = line.match(KIRO_UA_REGEX)
        if (match) {
          originalDeviceId = match[1]
          const newLine = line.replace(MACHINE_ID_REGEX, targetDeviceId)
          if (newLine !== line) {
            modified = true
            newDeviceId = targetDeviceId
            if (this.config.logRequests) {
              console.log(`[MitmProxy] Replaced Machine ID in ${line.split(':')[0]}`)
              console.log(`  Original: ${originalDeviceId?.substring(0, 16)}...`)
              console.log(`  New: ${targetDeviceId.substring(0, 16)}...`)
            }
            return newLine
          }
        }
      }
      return line
    })

    if (modified) {
      this.stats.modifiedRequests++
      info.deviceIdReplaced = true
      info.originalDeviceId = originalDeviceId
      info.newDeviceId = newDeviceId
    }

    return { 
      modified, 
      newHeaders: modifiedLines.join('\r\n'),
      info 
    }
  }

  /**
   * 转发请求到目标服务器
   * streaming=true 时返回的写入函数用于继续转发后续请求体分片（chunked 等）
   */
  private forwardRequest(
    headers: string,
    initialBody: Buffer,
    hostname: string,
    port: number,
    clientSocket: tls.TLSSocket,
    streaming: boolean
  ): (chunk: Buffer) => void {
    const startTime = Date.now()

    // 握手完成前到达的 body 分片要先缓存，否则会被丢弃导致上游收到不完整请求体。
    let connected = false
    const pending: Buffer[] = []

    // 连接到目标服务器
    const serverSocket = tls.connect({
      host: hostname,
      port,
      servername: hostname,
      rejectUnauthorized: true
    }, () => {
      connected = true
      // 发送修改后的请求头（latin1 保持原始字节）
      serverSocket.write(Buffer.from(headers + '\r\n\r\n', 'latin1'))
      // 发送已接收的请求体
      if (initialBody.length > 0) {
        serverSocket.write(initialBody)
      }
      // 冲刷握手期间缓存的 body 分片
      for (const chunk of pending) serverSocket.write(chunk)
      pending.length = 0
    })
    // 跟踪上游连接，stop() 时一并销毁
    this.sockets.add(serverSocket)

    let settled = false
    const writeBody = (chunk: Buffer): void => {
      if (!streaming || serverSocket.destroyed) return
      if (connected) serverSocket.write(chunk)
      else pending.push(chunk)
    }

    // 将响应转发回客户端
    serverSocket.on('data', (chunk: Buffer) => {
      if (!clientSocket.destroyed) clientSocket.write(chunk)
    })

    serverSocket.on('end', () => {
      if (!settled) {
        settled = true
        const duration = Date.now() - startTime
        this.events.onResponse?.({
          timestamp: Date.now(),
          host: hostname,
          statusCode: 200,
          duration
        })
      }
      clientSocket.end()
    })

    serverSocket.on('error', (error) => {
      if (!settled) {
        settled = true
        console.error(`[MitmProxy] Server connection error to ${hostname}:`, error.message)
      }
      clientSocket.end()
    })

    serverSocket.once('close', () => {
      this.sockets.delete(serverSocket)
      // 上游关闭（Connection: close）后关闭客户端，客户端下个请求会重新建连
      if (!clientSocket.destroyed) clientSocket.end()
    })

    clientSocket.on('end', () => {
      // 流式模式下客户端半关闭表示请求体结束；非流式模式请求已完整发出，等待上游响应即可
      if (streaming) serverSocket.end()
    })

    // 客户端异常或被销毁（含 stop()）时释放上游连接
    clientSocket.once('error', () => {
      serverSocket.destroy()
    })
    clientSocket.once('close', () => {
      serverSocket.destroy()
    })

    return writeBody
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<KProxyConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * 获取配置
   */
  getConfig(): KProxyConfig {
    return { ...this.config }
  }

  /**
   * 获取统计信息
   */
  getStats(): KProxyStats {
    return { ...this.stats }
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      mitmRequests: 0,
      bypassRequests: 0,
      modifiedRequests: 0,
      startTime: this.stats.startTime,
      lastRequestTime: 0
    }
  }

  /**
   * 检查是否运行中
   */
  isRunning(): boolean {
    return this.server !== null
  }
}
