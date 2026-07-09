import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import { connect } from "cloudflare:sockets";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import { formatSshTarget, normalizeHost } from "../shared/net";
import type { Language, ProcessInfo, RemoteFile, ServerMetrics, ServerProfile, TerminalMessage } from "../shared/types";

export type SshBridge = {
  handleClientMessage(message: TerminalMessage): void;
  close(): void;
  sftpSession: SFTPWrapper | null;
};

type SshBridgeOptions = {
  profile?: ServerProfile;
  language: Language;
  onCommand?: (command: string) => void;
};

type ShellSize = {
  cols: number;
  rows: number;
};

export function createSshBridge(socket: WebSocket, options: SshBridgeOptions): SshBridge {
  const copy = options.language === "en" ? terminalCopy.en : terminalCopy.zh;
  const send = (message: TerminalMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  let conn: Client | null = null;
  let shell: ClientChannel | null = null;
  let sftpSession: SFTPWrapper | null = null;
  let tcpStream: CloudflareSocketDuplex | null = null;
  /**
   * Tracks the visible content of the current terminal line from shell output.
   * Includes prompt + command text (e.g. "root@host:~# systemctl status nginx").
   */
  let outputLine = "";
  /**
   * The detected prompt string. Captured from outputLine when the first user
   * input arrives after new shell output — at that point, whatever is on the
   * line is the prompt waiting for input.
   */
  let detectedPrompt = "";
  /** True when shell output arrived since the last user input — used for prompt detection. */
  let promptDirty = true;
  let shellSize: ShellSize = { cols: 80, rows: 24 };
  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  const uploadStreams = new Map<string, NodeJS.WritableStream>();
  let sshHandshakeStarted = false;
  let sshReady = false;
  let closeNotified = false;

  const MAX_READ_SIZE = 2 * 1024 * 1024;
  const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024;

  if (!options.profile) {
    send({ type: "error", message: copy.noProfile });
  } else {
    void openSshSession(options.profile);
  }

  async function openSshSession(profile: ServerProfile) {
    const host = normalizeHost(profile.host);
    send({ type: "output", data: `\r\n${copy.title}\r\n` });
    send({ type: "output", data: `${copy.selected}${profile.name} (${formatSshTarget(profile.username, host, profile.port)})\r\n` });
    send({ type: "output", data: `${copy.connecting}\r\n` });

    try {
      const tcpSocket = connect(createTcpAddress(host, profile.port));
      await tcpSocket.opened;
      tcpStream = new CloudflareSocketDuplex(tcpSocket);
      conn = new Client();
      sshHandshakeStarted = true;

      tcpSocket.closed.catch((error) => {
        if (!sshReady) {
          const message = error instanceof Error ? error.message : String(error);
          send({ type: "error", message: `${copy.tcpClosedBeforeReady}${message}` });
        }
      });

      conn
        .on("ready", () => {
          sshReady = true;
          send({ type: "output", data: `${copy.authenticated}\r\n` });
          conn?.shell(
            {
              term: "xterm-256color",
              cols: shellSize.cols,
              rows: shellSize.rows,
              width: shellSize.cols * 8,
              height: shellSize.rows * 16
            },
            (error, channel) => {
              if (error) {
                send({ type: "error", message: error.message });
                return;
              }
              shell = channel;
              channel.on("data", (data: Buffer | string) => {
                const text = data.toString();
                trackOutputLine(text);
                send({ type: "output", data: text });
              });
              channel.stderr.on("data", (data: Buffer | string) => send({ type: "output", data: data.toString() }));
              channel.on("close", () => {
                send({ type: "output", data: `\r\n${copy.sessionClosed}\r\n` });
                close();
              });
            }
          );
          conn?.sftp((err, sftp) => {
            if (err) return;
            sftpSession = sftp;
          });
          startMetricsCollection();
        })
        .on("banner", (message) => send({ type: "output", data: `${message}\r\n` }))
        .on("error", (error) => send({ type: "error", message: `${copy.connectFailed}${error.message}` }))
        .on("close", () => {
          if (!closeNotified) {
            closeNotified = true;
            send({ type: "output", data: `\r\n${copy.connectionClosed}\r\n` });
          }
        });

      conn.connect({
        host,
        port: profile.port,
        sock: tcpStream,
        username: profile.username,
        password: profile.credentialKind === "password" ? profile.password : undefined,
        privateKey: profile.credentialKind === "privateKey" ? profile.privateKey : undefined,
        passphrase: profile.credentialKind === "privateKey" ? profile.passphrase : undefined,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        // Workers nodejs_compat crypto doesn't fully support GCM auth tags or
        // ChaCha20-Poly1305, so restrict to CTR/CBC ciphers + HMAC MACs.
        algorithms: {
          cipher: [
            "aes128-ctr", "aes192-ctr", "aes256-ctr",
            "aes128-cbc", "aes256-cbc", "3des-cbc"
          ],
          hmac: [
            "hmac-sha2-256", "hmac-sha2-512",
            "hmac-sha1"
          ]
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : copy.unknownError;
      send({ type: "error", message: `${sshHandshakeStarted ? copy.connectFailed : copy.tcpConnectFailed}${message}` });
      close();
    }
  }

  /**
   * Tracks the visible content of the current line from shell output.
   * Handles \r (carriage return), \n (newline), and \b (backspace).
   * Strips ANSI escape sequences so only visible text is kept.
   */
  function trackOutputLine(text: string) {
    // Strip ANSI escape sequences (CSI, OSC, etc.)
    const clean = text.replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][AB012]|[>=<])/g, "");
    for (const char of clean) {
      if (char === "\n") {
        outputLine = "";
        // After a newline, the next output is likely a new prompt.
        // Mark dirty so the next user input captures it as the prompt.
        promptDirty = true;
      } else if (char === "\r") {
        outputLine = "";
      } else if (char === "\b") {
        outputLine = outputLine.slice(0, -1);
      } else {
        // Only keep printable characters
        if (char.charCodeAt(0) >= 32) {
          outputLine += char;
        }
      }
    }
  }

  /**
   * Extracts the command from the current outputLine by stripping the prompt.
   * outputLine contains "prompt + command" (e.g. "root@host:~# systemctl").
   * The prompt was detected when the first user input arrived after shell output.
   */
  function extractCommand(): string {
    const line = outputLine.trim();
    if (detectedPrompt && line.startsWith(detectedPrompt)) {
      return line.slice(detectedPrompt.length).trim();
    }
    // Fallback: try common prompt patterns ending with $, #, >, or %
    const promptMatch = line.match(/^.*?[#$%>]\s*/);
    if (promptMatch) {
      return line.slice(promptMatch[0].length).trim();
    }
    return line;
  }

  function handleInput(data: string) {
    if (!shell) return;
    // Detect prompt: when user starts typing after new shell output,
    // the current outputLine content is the prompt.
    if (promptDirty) {
      promptDirty = false;
      detectedPrompt = outputLine.trim();
    }
    shell?.write(data);
    if (data === "\r") {
      const command = extractCommand();
      outputLine = "";
      if (command) options.onCommand?.(command);
      return;
    }
    if (data === "\u0003") {
      outputLine = "";
      return;
    }
  }

  function handleResize(cols: number, rows: number) {
    shellSize = { cols, rows };
    shell?.setWindow(rows, cols, rows * 16, cols * 8);
  }

  // ── Metrics collection ──────────────────────────────────────────────

  const METRICS_CMD = [
    // CPU: read /proc/stat twice with 1s gap for delta
    `cat /proc/stat | head -1`,
    `sleep 1 && cat /proc/stat | head -1`,
    // Memory & swap from /proc/meminfo
    `cat /proc/meminfo`,
    // Disk usage of root partition
    `df -B1 / | tail -1`,
    // Top 8 processes by CPU
    `ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu --no-headers | head -8`
  ].join(" && echo '---SECTION---' && ");

  function startMetricsCollection() {
    collectMetrics();
    metricsTimer = setInterval(collectMetrics, 8000);
  }

  function collectMetrics() {
    if (!conn) return;
    conn.exec(METRICS_CMD, (err, channel) => {
      if (err) return;
      let output = "";
      channel.on("data", (data: Buffer | string) => { output += data.toString(); });
      channel.stderr.on("data", () => {});
      channel.on("close", () => {
        try {
          const result = parseMetrics(output);
          if (result) send({ type: "metrics", ...result });
        } catch {}
      });
    });
  }

  function parseMetrics(raw: string): { metrics: ServerMetrics; processes: ProcessInfo[] } | null {
    const sections = raw.split("---SECTION---").map(s => s.trim());
    if (sections.length < 5) return null;

    // CPU delta
    const cpuPercent = parseCpuDelta(sections[0], sections[1]);

    // Memory
    const meminfo = sections[2];
    const memory = parseMeminfo(meminfo, "MemTotal", "MemAvailable");
    const swap = parseMeminfo(meminfo, "SwapTotal", "SwapFree");

    // Disk
    const disk = parseDf(sections[3]);

    // Processes
    const processes = parseProcesses(sections[4]);

    return {
      metrics: { cpuPercent, memory, swap, disk, updatedAt: new Date().toISOString() },
      processes
    };
  }

  function parseCpuDelta(line1: string, line2: string): number {
    const parse = (line: string) => {
      const parts = line.replace(/^cpu\s+/, "").trim().split(/\s+/).map(Number);
      const idle = parts[3] + (parts[4] ?? 0); // idle + iowait
      const total = parts.reduce((a, b) => a + b, 0);
      return { idle, total };
    };
    try {
      const a = parse(line1);
      const b = parse(line2);
      const dTotal = b.total - a.total;
      const dIdle = b.idle - a.idle;
      if (dTotal === 0) return 0;
      return Math.round(((dTotal - dIdle) / dTotal) * 100);
    } catch {
      return 0;
    }
  }

  function parseMeminfo(raw: string, totalKey: string, freeKey: string) {
    const get = (key: string) => {
      const match = raw.match(new RegExp(`${key}:\\s+(\\d+)`));
      return match ? Number(match[1]) * 1024 : 0; // kB → bytes
    };
    const total = get(totalKey);
    const free = get(freeKey);
    const used = total - free;
    const totalGb = +(total / 1073741824).toFixed(1);
    const usedGb = +(used / 1073741824).toFixed(1);
    const percent = total > 0 ? Math.round((used / total) * 100) : 0;
    return { used: usedGb, total: totalGb, percent };
  }

  function parseDf(line: string) {
    const parts = line.trim().split(/\s+/);
    // df -B1 output: filesystem 1B-blocks used available use% mount
    const total = Number(parts[1]) || 0;
    const used = Number(parts[2]) || 0;
    const totalGb = +(total / 1073741824).toFixed(1);
    const usedGb = +(used / 1073741824).toFixed(1);
    const percent = total > 0 ? Math.round((used / total) * 100) : 0;
    return { used: usedGb, total: totalGb, percent };
  }

  function parseProcesses(raw: string): ProcessInfo[] {
    return raw.split("\n").filter(Boolean).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: Number(parts[0]),
        user: parts[1] ?? "",
        cpu: Number(parts[2]) || 0,
        memory: Number(parts[3]) || 0,
        command: parts.slice(4).join(" ")
      };
    });
  }

  // ── SFTP operations ─────────────────────────────────────────────────

  function handleSftpLs(requestId: string, path: string) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      sftpSession.readdir(path, (err, list) => {
        if (err) return send({ type: "sftp-error", requestId, message: err.message });
        const files: RemoteFile[] = list
          .map((item) => {
            const parentPath = path.replace(/\/$/, "");
            return {
              name: item.filename,
              path: `${parentPath}/${item.filename}`,
              size: item.attrs.size,
              type: (item.attrs.isDirectory() ? "directory" : "file") as RemoteFile["type"],
              modifiedAt: new Date(item.attrs.mtime * 1000).toISOString()
            };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        send({ type: "sftp-ls-result", requestId, files });
      });
    } catch (error) {
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "列目录失败" });
    }
  }

  function handleSftpRead(requestId: string, path: string) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      sftpSession.stat(path, (statErr, stats) => {
        if (statErr) return send({ type: "sftp-error", requestId, message: statErr.message });
        if (stats.size > MAX_READ_SIZE) {
          return send({ type: "sftp-error", requestId, message: "文件超过 2MB 限制，无法读取" });
        }
        sftpSession!.readFile(path, { encoding: "utf8" }, (err, content) => {
          if (err) return send({ type: "sftp-error", requestId, message: err.message });
          send({ type: "sftp-read-result", requestId, path, content: content as unknown as string });
        });
      });
    } catch (error) {
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "读取文件失败" });
    }
  }

  function handleSftpWrite(requestId: string, path: string, content: string) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      sftpSession.writeFile(path, content, { encoding: "utf8" }, (err) => {
        if (err) return send({ type: "sftp-error", requestId, message: err.message });
        send({ type: "sftp-write-result", requestId, ok: true });
      });
    } catch (error) {
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "写入文件失败" });
    }
  }

  function handleSftpUpload(requestId: string, path: string, chunk: string, offset: number, done: boolean) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      if (offset === 0) {
        const stream = sftpSession.createWriteStream(path);
        uploadStreams.set(requestId, stream);
        stream.on("error", (err: Error) => {
          send({ type: "sftp-error", requestId, message: err.message });
          uploadStreams.delete(requestId);
        });
      }
      const stream = uploadStreams.get(requestId);
      if (!stream) return send({ type: "sftp-error", requestId, message: "上传流未找到" });
      if (chunk) {
        const buf = Buffer.from(chunk, "base64");
        stream.write(buf);
      }
      if (done) {
        stream.end();
        uploadStreams.delete(requestId);
      }
      send({ type: "sftp-upload-progress", requestId, offset, done });
    } catch (error) {
      uploadStreams.delete(requestId);
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "上传失败" });
    }
  }

  function handleSftpDownload(requestId: string, path: string) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      sftpSession.stat(path, (statErr, stats) => {
        if (statErr) return send({ type: "sftp-error", requestId, message: statErr.message });
        if (stats.size > MAX_DOWNLOAD_SIZE) {
          return send({ type: "sftp-error", requestId, message: "文件超过 100MB 限制，无法下载" });
        }
        const stream = sftpSession!.createReadStream(path);
        stream.on("data", (data: Buffer) => {
          send({ type: "sftp-download-chunk", requestId, chunk: Buffer.from(data).toString("base64"), done: false });
        });
        stream.on("end", () => {
          send({ type: "sftp-download-chunk", requestId, chunk: "", done: true });
        });
        stream.on("error", (err: Error) => {
          send({ type: "sftp-error", requestId, message: err.message });
        });
      });
    } catch (error) {
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "下载失败" });
    }
  }

  function close() {
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    for (const stream of uploadStreams.values()) stream.end();
    uploadStreams.clear();
    sftpSession?.end();
    sftpSession = null;
    shell?.end();
    shell = null;
    conn?.end();
    conn = null;
    tcpStream?.destroy();
    tcpStream = null;
  }

  return {
    handleClientMessage(message) {
      if (message.type === "input") handleInput(message.data);
      if (message.type === "resize") handleResize(message.cols, message.rows);
      if (message.type === "sftp-ls") handleSftpLs(message.requestId, message.path);
      if (message.type === "sftp-read") handleSftpRead(message.requestId, message.path);
      if (message.type === "sftp-write") handleSftpWrite(message.requestId, message.path, message.content);
      if (message.type === "sftp-upload") handleSftpUpload(message.requestId, message.path, message.chunk, message.offset, message.done);
      if (message.type === "sftp-download") handleSftpDownload(message.requestId, message.path);
    },
    close,
    get sftpSession() { return sftpSession; }
  };
}

function createTcpAddress(host: string, port: number) {
  if (isIpv6Literal(host)) return `tcp://[${host}]:${port}`;
  return { hostname: host, port };
}

function isIpv6Literal(value: string): boolean {
  return value.includes(":") && !value.includes("/");
}

class CloudflareSocketDuplex extends Duplex {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private destroyedByClose = false;

  constructor(private readonly tcpSocket: ReturnType<typeof connect>) {
    super();
    this.reader = tcpSocket.readable.getReader();
    this.writer = tcpSocket.writable.getWriter();
    void this.pump();
  }

  _read() {
    // Data is pushed by pump().
  }

  _write(chunk: Buffer | Uint8Array | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : new Uint8Array(chunk);
    this.writer.write(bytes).then(() => callback(), callback);
  }

  _final(callback: (error?: Error | null) => void) {
    this.writer.close().then(() => callback(), callback);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.destroyedByClose = true;
    Promise.allSettled([this.reader.cancel(), this.writer.abort(error ?? undefined)])
      .then(() => this.tcpSocket.close())
      .then(() => callback(error))
      .catch((closeError) => callback(closeError instanceof Error ? closeError : error));
  }

  private async pump() {
    try {
      while (!this.destroyedByClose) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.push(Buffer.from(value));
      }
      this.push(null);
    } catch (error) {
      if (!this.destroyedByClose) this.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

const terminalCopy = {
  zh: {
    title: "踏风 Tafeng WebSSH",
    selected: "已选择连接：",
    connecting: "正在建立真实 SSH 会话...",
    authenticated: "SSH 认证成功，正在打开终端...",
    sessionClosed: "SSH 会话已关闭",
    connectionClosed: "SSH 连接已断开",
    connectFailed: "连接失败：",
    tcpConnectFailed: "TCP 连接失败：",
    tcpClosedBeforeReady: "TCP 已连接但 SSH 握手前断开：",
    noProfile: "没有找到要连接的 VPS 配置",
    unknownError: "未知错误"
  },
  en: {
    title: "Tafeng WebSSH",
    selected: "Selected connection: ",
    connecting: "Opening a real SSH session...",
    authenticated: "SSH authentication succeeded, opening terminal...",
    sessionClosed: "SSH session closed",
    connectionClosed: "SSH connection closed",
    connectFailed: "Connection failed: ",
    tcpConnectFailed: "TCP connection failed: ",
    tcpClosedBeforeReady: "TCP connected but closed before SSH handshake: ",
    noProfile: "No VPS profile was found for this connection",
    unknownError: "Unknown error"
  }
} as const;
