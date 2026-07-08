import type { AppSettings, Language, ServerProfile, TerminalMessage } from "../shared/types";
import { normalizeHost } from "../shared/net";
import { getCookie, handleLogin, json } from "./auth";
import { createSshBridge } from "./sshBridge";
import {
  appendCommandHistory,
  clearSession,
  clearCommandHistory,
  disableTotp,
  enableTotp,
  getPendingTotpSecret,
  getSettings,
  isValidSession,
  listCommandHistory,
  listConnections,
  savePendingTotpSecret,
  saveConnections,
  saveSettings,
  type Env
} from "./storage";
import { createOtpAuthUrl, generateTotpSecret, verifyTotp } from "./totp";

const TEN_GB = 10 * 1024 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      await clearSession(env, getCookie(request, "tafeng_session"));
      return json({ ok: true }, 200, { "Set-Cookie": "tafeng_session=; Path=/; Max-Age=0" });
    }

    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) {
      const authorized = await isValidSession(env, getCookie(request, "tafeng_session"));
      if (!authorized) return json({ message: "未登录" }, 401);
    }

    if (url.pathname === "/api/auth/state") {
      return json({ authenticated: true, twoFactorRequired: false });
    }

    if (url.pathname === "/api/settings") {
      if (request.method === "GET") return json(await getSettings(env));
      if (request.method === "PUT") {
        const settings = await request.json<AppSettings>();
        const currentSettings = await getSettings(env);
        const nextSettings: AppSettings = {
          ...currentSettings,
          theme: settings.theme,
          language: settings.language
        };
        await saveSettings(env, nextSettings);
        return json(nextSettings);
      }
    }

    if (url.pathname === "/api/totp/setup" && request.method === "POST") {
      const secret = generateTotpSecret();
      await savePendingTotpSecret(env, secret);
      return json({ secret, otpauthUrl: createOtpAuthUrl(secret) });
    }

    if (url.pathname === "/api/totp/verify" && request.method === "POST") {
      const body = await request.json<{ code?: string }>();
      const pendingSecret = await getPendingTotpSecret(env);
      if (!(await verifyTotp(body.code, pendingSecret))) return json({ message: "验证码无效或已过期" }, 400);
      await enableTotp(env, pendingSecret!);
      return json(await getSettings(env));
    }

    if (url.pathname === "/api/totp/disable" && request.method === "POST") {
      await disableTotp(env);
      return json(await getSettings(env));
    }

    if (url.pathname === "/api/connections") {
      if (request.method === "GET") return json(await listConnections(env));
      if (request.method === "POST") return createConnection(request, env);
    }

    if (url.pathname.startsWith("/api/connections/")) {
      const id = url.pathname.split("/")[3];
      if (request.method === "PUT") return updateConnection(id, request, env);
      if (request.method === "DELETE") return deleteConnection(id, env);
    }

    if (url.pathname === "/api/command-history") {
      if (request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "200");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        return json(await listCommandHistory(env, limit, offset));
      }
      if (request.method === "DELETE") {
        await clearCommandHistory(env);
        return json({ ok: true });
      }
    }



    if (url.pathname === "/api/files/upload" && request.method === "POST") {
      const length = Number(request.headers.get("Content-Length") ?? "0");
      if (length > TEN_GB) return json({ message: "文件超过 10G 限制" }, 413);
      const key = `uploads/${crypto.randomUUID()}`;
      if (!request.body) return json({ message: "上传内容为空" }, 400);
      if (!env.TAFENG_FILES) return json({ message: "R2 绑定 TAFENG_FILES 未配置" }, 500);
      await env.TAFENG_FILES.put(key, request.body, { httpMetadata: { contentType: request.headers.get("Content-Type") ?? undefined } });
      return json({ key, maxSize: TEN_GB });
    }

    if (url.pathname === "/ws/terminal") {
      return handleTerminalSocket(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  }
};

async function createConnection(request: Request, env: Env) {
  const now = new Date().toISOString();
  const profile = await request.json<Omit<ServerProfile, "id" | "createdAt" | "updatedAt">>();
  const profiles = await listConnections(env);
  const next: ServerProfile = { ...profile, host: normalizeHost(profile.host), id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  await saveConnections(env, [next, ...profiles]);
  return json(next, 201);
}

async function updateConnection(id: string, request: Request, env: Env) {
  const patch = await request.json<Partial<ServerProfile>>();
  const profiles = await listConnections(env);
  const normalizedPatch = patch.host === undefined ? patch : { ...patch, host: normalizeHost(patch.host) };
  const next = profiles.map((profile) => (profile.id === id ? { ...profile, ...normalizedPatch, id, updatedAt: new Date().toISOString() } : profile));
  await saveConnections(env, next);
  return json(next.find((profile) => profile.id === id) ?? null);
}

async function deleteConnection(id: string, env: Env) {
  const profiles = await listConnections(env);
  await saveConnections(env, profiles.filter((profile) => profile.id !== id));
  return json({ ok: true });
}

async function handleTerminalSocket(request: Request, env: Env, _ctx: ExecutionContext) {
  if (request.headers.get("Upgrade") !== "websocket") return json({ message: "需要 WebSocket" }, 426);

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const url = new URL(request.url);
  const profileId = url.searchParams.get("profileId");
  const language = parseLanguage(url.searchParams.get("language"));
  const profile = (await listConnections(env)).find((item) => item.id === profileId);
  const bridge = createSshBridge(server, {
    profile,
    language,
    onCommand(command) {
      _ctx.waitUntil(
        appendCommandHistory(env, {
          command,
          profileId: profile?.id ?? null,
          profileName: profile?.name ?? "未命名 VPS",
          host: profile?.host ?? null,
          username: profile?.username ?? null
        })
      );
    }
  });

  server.addEventListener("message", (event) => {
    try {
      bridge.handleClientMessage(JSON.parse(String(event.data)) as TerminalMessage);
    } catch (error) {
      server.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "消息解析失败" }));
    }
  });
  server.addEventListener("close", () => bridge.close());
  server.addEventListener("error", () => bridge.close());

  return new Response(null, { status: 101, webSocket: client });
}

function parseLanguage(value: string | null): Language {
  return value === "en" ? "en" : "zh";
}
