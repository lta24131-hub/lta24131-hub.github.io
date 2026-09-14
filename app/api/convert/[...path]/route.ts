import { env } from "cloudflare:workers";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type JobState = "uploading" | "queued" | "converting" | "ready" | "failed";

type ConversionJob = {
  id: string;
  fileName: string;
  size: number;
  state: JobState;
  progress: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  uploadId: string;
  clientToken?: string;
  callbackToken: string;
  sourceKey: string;
  resultKey: string;
  resultSize?: number;
};

type OidcJwk = JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
};

const PART_SIZE = 8 * 1024 * 1024;
const MAX_SOURCE_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_RESULT_SIZE = 300 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 2;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const TERMINAL_TTL_MS = 60 * 60 * 1000;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const CONVERT_TTL_MS = 55 * 60 * 1000;
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_AUDIENCE = "step-viewer-cloud-converter";
const GITHUB_REPOSITORY = "lta24131-hub/lta24131-hub.github.io";
const GITHUB_REPOSITORY_ID = "1369365692";
const GITHUB_OWNER_ID = "328964201";
const GITHUB_REF = "refs/heads/main";
const GITHUB_WORKFLOW_REF = `${GITHUB_REPOSITORY}/.github/workflows/convert-step.yml@${GITHUB_REF}`;
const GITHUB_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const ALLOWED_ORIGINS = new Set([
  "https://lta24131-hub.github.io",
  "https://step-viewer-offline-0914.design53648.chatgpt.site",
  "http://localhost:3000",
  "http://localhost:5173",
]);

let jwksCache: { expiresAt: number; keys: OidcJwk[] } | null = null;
let lastForcedJwksRefresh = 0;

function bucket() {
  if (!env.BUCKET) throw new Error("云端文件存储尚未配置。");
  return env.BUCKET;
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin");
  const ownOrigin = new URL(request.url).origin;
  const allowedOrigin = origin && (ALLOWED_ORIGINS.has(origin) || origin === ownOrigin) ? origin : ownOrigin;
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Conversion-Key, X-Task-Token",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function json(request: Request, value: unknown, status = 200) {
  return Response.json(value, { status, headers: corsHeaders(request) });
}

function cleanFileName(value: unknown) {
  const name = typeof value === "string" ? value.trim() : "model.step";
  return name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180) || "model.step";
}

function isValidId(value: string | undefined) {
  return Boolean(value && /^[0-9a-f-]{36}$/i.test(value));
}

function isBrowserAuthorized(request: Request) {
  const expected = env.CONVERSION_ACCESS_KEY;
  return Boolean(expected && request.headers.get("X-Conversion-Key") === expected);
}

function isTaskAuthorized(request: Request, job: ConversionJob) {
  const taskToken = request.headers.get("X-Task-Token");
  if (job.clientToken && taskToken === job.clientToken) return true;
  return isBrowserAuthorized(request);
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  return match?.[1] ?? "";
}

function isRunnerAuthorized(request: Request, job: ConversionJob) {
  const token = bearerToken(request);
  return Boolean(job.callbackToken && job.callbackToken.length >= 64 && token === job.callbackToken);
}

function decodeBase64Url(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid token");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function decodeJwtJson(value: string) {
  const decoded = new TextDecoder().decode(decodeBase64Url(value));
  return JSON.parse(decoded) as Record<string, unknown>;
}

async function loadGithubJwks(force = false) {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;
  if (force && jwksCache && now - lastForcedJwksRefresh < 30_000) return jwksCache.keys;
  if (force) lastForcedJwksRefresh = now;

  const response = await fetch(GITHUB_JWKS_URL, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("identity provider unavailable");
  const body = await response.json() as { keys?: OidcJwk[] };
  if (!Array.isArray(body.keys) || !body.keys.length) throw new Error("invalid identity keys");
  jwksCache = { keys: body.keys, expiresAt: now + 60 * 60 * 1000 };
  return body.keys;
}

async function verifyGithubOidc(request: Request) {
  const token = bearerToken(request);
  if (!token || token.length > 16_384) return false;
  const segments = token.split(".");
  if (segments.length !== 3) return false;

  try {
    const header = decodeJwtJson(segments[0]);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return false;
    if (header.typ !== undefined && header.typ !== "JWT") return false;
    if (header.crit !== undefined || header.b64 === false || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) return false;

    let keys = await loadGithubJwks();
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      keys = await loadGithubJwks(true);
      jwk = keys.find((key) => key.kid === header.kid);
    }
    if (!jwk || jwk.kty !== "RSA" || jwk.alg !== "RS256" || jwk.use !== "sig") return false;
    if (jwk.key_ops && !jwk.key_ops.includes("verify")) return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(segments[2]),
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
    );
    if (!signatureValid) return false;

    const claims = decodeJwtJson(segments[1]);
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = Number(claims.iat);
    const notBefore = Number(claims.nbf);
    const expiresAt = Number(claims.exp);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(notBefore) || !Number.isFinite(expiresAt)) return false;
    if (expiresAt <= issuedAt || expiresAt < now - 30 || notBefore > now + 60 || issuedAt > now + 60 || now - issuedAt > 600) return false;
    if (claims.iss !== GITHUB_OIDC_ISSUER || claims.aud !== GITHUB_OIDC_AUDIENCE) return false;
    if (claims.repository !== GITHUB_REPOSITORY || String(claims.repository_id) !== GITHUB_REPOSITORY_ID) return false;
    if (String(claims.repository_owner_id) !== GITHUB_OWNER_ID || claims.ref !== GITHUB_REF || claims.ref_type !== "branch") return false;
    if (claims.workflow_ref !== GITHUB_WORKFLOW_REF) return false;
    if (claims.event_name !== "schedule" && claims.event_name !== "workflow_dispatch") return false;
    if (typeof claims.sub !== "string" || !claims.sub || typeof claims.jti !== "string" || !claims.jti) return false;
    return true;
  } catch {
    return false;
  }
}

async function getJob(id: string) {
  const object = await bucket().get(`jobs/${id}.json`);
  if (!object) return null;
  return JSON.parse(await object.text()) as ConversionJob;
}

async function putJob(job: ConversionJob) {
  job.updatedAt = Date.now();
  await bucket().put(`jobs/${job.id}.json`, JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function removeTask(job: ConversionJob) {
  if (job.state === "uploading" && job.uploadId) {
    try {
      await bucket().resumeMultipartUpload(job.sourceKey, job.uploadId).abort();
    } catch {
      // The upload may already be complete; object deletion below is still required.
    }
  }
  await Promise.all([
    bucket().delete(job.sourceKey),
    bucket().delete(job.resultKey),
    bucket().delete(`jobs/${job.id}.json`),
  ]);
}

async function listJobs() {
  const listed = await bucket().list({ prefix: "jobs/", limit: 1000 });
  const jobs = await Promise.all(listed.objects.map(async (object) => {
    const stored = await bucket().get(object.key);
    if (!stored) return null;
    try {
      return JSON.parse(await stored.text()) as ConversionJob;
    } catch {
      await bucket().delete(object.key);
      return null;
    }
  }));
  return jobs.filter((job): job is ConversionJob => Boolean(job));
}

async function cleanupJobs() {
  const now = Date.now();
  const jobs = await listJobs();
  const remaining: ConversionJob[] = [];

  for (const job of jobs) {
    const age = now - job.createdAt;
    const idle = now - job.updatedAt;
    const terminalExpired = (job.state === "ready" || job.state === "failed") && idle > TERMINAL_TTL_MS;
    const uploadExpired = job.state === "uploading" && idle > UPLOAD_TTL_MS;
    if (!Number.isFinite(age) || age > JOB_TTL_MS || terminalExpired || uploadExpired) {
      await removeTask(job);
      continue;
    }
    if (job.state === "converting" && idle > CONVERT_TTL_MS) {
      job.state = "failed";
      job.progress = 0;
      job.message = "云端转换超时，请重新选择文件再试。";
      job.callbackToken = "";
      await Promise.all([bucket().delete(job.sourceKey), bucket().delete(job.resultKey)]);
      await putJob(job);
    }
    remaining.push(job);
  }
  return remaining;
}

async function createTask(request: Request) {
  if (!isBrowserAuthorized(request)) {
    return json(request, { error: "这台设备尚未启用云端快速处理，请用专用链接重新打开网站。", code: "access_key" }, 401);
  }
  const input = await request.json().catch(() => null) as { fileName?: unknown; size?: unknown } | null;
  const fileName = cleanFileName(input?.fileName);
  const size = Number(input?.size);
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (!Number.isFinite(size) || size <= 0 || size > MAX_SOURCE_SIZE) {
    return json(request, { error: "文件大小无效或超过 2 GB。" }, 400);
  }
  if (extension !== "step" && extension !== "stp") {
    return json(request, { error: "云端快速处理目前只用于 STEP / STP 文件。" }, 400);
  }

  const existingJobs = await cleanupJobs();
  const activeCount = existingJobs.filter((job) => job.state === "uploading" || job.state === "queued" || job.state === "converting").length;
  if (activeCount >= MAX_ACTIVE_JOBS) {
    return json(request, { error: "已有模型正在处理，请等待完成后再上传下一个。" }, 429);
  }

  const id = crypto.randomUUID();
  const sourceKey = `uploads/${id}/source.step`;
  const resultKey = `uploads/${id}/result.glb`;
  const multipart = await bucket().createMultipartUpload(sourceKey, {
    httpMetadata: { contentType: "application/step" },
    customMetadata: { fileName, declaredSize: String(size) },
  });
  const now = Date.now();
  const job: ConversionJob = {
    id,
    fileName,
    size,
    state: "uploading",
    progress: 0,
    message: "正在上传图纸",
    createdAt: now,
    updatedAt: now,
    uploadId: multipart.uploadId,
    clientToken: crypto.randomUUID() + crypto.randomUUID(),
    callbackToken: crypto.randomUUID() + crypto.randomUUID(),
    sourceKey,
    resultKey,
  };
  await putJob(job);
  return json(request, { id, uploadId: multipart.uploadId, partSize: PART_SIZE, taskToken: job.clientToken });
}

async function uploadPart(request: Request, id: string, partText: string) {
  const job = await getJob(id);
  if (!job) return json(request, { error: "转换任务不存在或已过期。" }, 404);
  if (!isTaskAuthorized(request, job)) return json(request, { error: "转换任务权限无效。", code: "task_key" }, 401);
  const partNumber = Number(partText);
  const uploadId = new URL(request.url).searchParams.get("uploadId");
  const partCount = Math.ceil(job.size / PART_SIZE);
  const expectedLength = partNumber === partCount ? job.size - (partCount - 1) * PART_SIZE : PART_SIZE;
  const contentLength = Number(request.headers.get("Content-Length"));
  if (
    job.state !== "uploading" ||
    uploadId !== job.uploadId ||
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > partCount ||
    !request.body ||
    !Number.isFinite(contentLength) ||
    contentLength !== expectedLength
  ) {
    return json(request, { error: "上传分块无效。" }, 400);
  }
  const multipart = bucket().resumeMultipartUpload(job.sourceKey, job.uploadId);
  const part = await multipart.uploadPart(partNumber, request.body);
  return json(request, { partNumber: part.partNumber, etag: part.etag });
}

async function completeUpload(request: Request, id: string) {
  const job = await getJob(id);
  if (!job) return json(request, { error: "转换任务不存在或已过期。" }, 404);
  if (!isTaskAuthorized(request, job)) return json(request, { error: "转换任务权限无效。", code: "task_key" }, 401);
  const input = await request.json().catch(() => null) as { uploadId?: string; parts?: Array<{ partNumber: number; etag: string }> } | null;
  const partCount = Math.ceil(job.size / PART_SIZE);
  if (job.state !== "uploading" || input?.uploadId !== job.uploadId || !Array.isArray(input.parts) || input.parts.length !== partCount) {
    return json(request, { error: "上传完成信息无效。" }, 400);
  }

  const ordered = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
  const partsValid = ordered.every((part, index) => part.partNumber === index + 1 && typeof part.etag === "string" && part.etag.length > 0 && part.etag.length < 200);
  if (!partsValid) return json(request, { error: "上传分块清单无效。" }, 400);

  await bucket().resumeMultipartUpload(job.sourceKey, job.uploadId).complete(ordered);
  const source = await bucket().head(job.sourceKey);
  if (!source || source.size !== job.size || source.size > MAX_SOURCE_SIZE) {
    await removeTask(job);
    return json(request, { error: "上传文件不完整，请重新选择文件。" }, 400);
  }

  job.state = "queued";
  job.progress = 1;
  job.message = "已上传，等待云端转换（通常 5 分钟内开始）";
  await putJob(job);
  return json(request, { id: job.id, state: job.state });
}

async function claimTask(request: Request) {
  if (!(await verifyGithubOidc(request))) return json(request, { error: "无权访问。" }, 401);
  const jobs = await cleanupJobs();
  const queued = jobs
    .filter((job) => job.state === "queued")
    .sort((left, right) => left.createdAt - right.createdAt)[0];
  if (!queued) return json(request, { task: null });

  const latest = await getJob(queued.id);
  if (!latest || latest.state !== "queued") return json(request, { task: null });
  latest.state = "converting";
  latest.progress = 2;
  latest.message = "云端已领取任务，正在准备转换";
  await putJob(latest);
  return json(request, {
    id: latest.id,
    callbackToken: latest.callbackToken,
    apiOrigin: new URL(request.url).origin,
  });
}

async function taskStatus(request: Request, id: string) {
  const job = await getJob(id);
  if (!job) return json(request, { error: "转换任务不存在或已过期。" }, 404);
  if (!isTaskAuthorized(request, job)) return json(request, { error: "转换任务权限无效。", code: "task_key" }, 401);
  if (Date.now() - job.createdAt > JOB_TTL_MS) {
    await removeTask(job);
    return json(request, { error: "转换任务已过期，请重新上传。" }, 410);
  }
  return json(request, {
    id: job.id,
    fileName: job.fileName,
    size: job.size,
    state: job.state,
    progress: job.progress,
    message: job.message,
    resultSize: job.resultSize,
  });
}

async function runnerSource(request: Request, id: string) {
  const job = await getJob(id);
  if (!job || job.state !== "converting" || !isRunnerAuthorized(request, job)) return json(request, { error: "无权访问。" }, 403);
  const source = await bucket().get(job.sourceKey);
  if (!source) return json(request, { error: "源文件不存在。" }, 404);
  return new Response(source.body, {
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/step",
      "Content-Length": String(source.size),
      "Content-Disposition": "attachment; filename=\"source.step\"",
    },
  });
}

async function runnerProgress(request: Request, id: string) {
  const job = await getJob(id);
  if (!job || job.state !== "converting" || !isRunnerAuthorized(request, job)) return json(request, { error: "无权访问。" }, 403);
  const input = await request.json().catch(() => ({})) as { progress?: number; message?: string };
  job.progress = Math.max(2, Math.min(98, Number(input.progress) || job.progress));
  job.message = typeof input.message === "string" ? input.message.slice(0, 100) : "正在云端转换";
  await putJob(job);
  return json(request, { ok: true });
}

async function runnerResult(request: Request, id: string) {
  const job = await getJob(id);
  if (!job || job.state !== "converting" || !isRunnerAuthorized(request, job) || !request.body) return json(request, { error: "无权访问。" }, 403);
  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_RESULT_SIZE) {
    return json(request, { error: "轻量模型文件大小无效。" }, 400);
  }
  await bucket().put(job.resultKey, request.body, {
    httpMetadata: { contentType: "model/gltf-binary", contentDisposition: `attachment; filename="${job.fileName.replace(/\.(step|stp)$/i, "")}-轻量版.glb"` },
    customMetadata: { size: String(length) },
  });
  const result = await bucket().head(job.resultKey);
  if (!result || result.size !== length) {
    await bucket().delete(job.resultKey);
    return json(request, { error: "轻量模型上传不完整。" }, 400);
  }
  job.resultSize = result.size;
  job.progress = 99;
  job.message = "轻量模型已生成";
  await putJob(job);
  return json(request, { ok: true });
}

async function runnerFinished(request: Request, id: string) {
  const job = await getJob(id);
  if (!job || job.state !== "converting" || !isRunnerAuthorized(request, job)) return json(request, { error: "无权访问。" }, 403);
  const result = await bucket().head(job.resultKey);
  if (!result || !result.size) return json(request, { error: "轻量模型尚未上传。" }, 409);
  job.state = "ready";
  job.progress = 100;
  job.message = "转换完成，正在打开模型";
  job.callbackToken = "";
  await putJob(job);
  await bucket().delete(job.sourceKey);
  return json(request, { ok: true });
}

async function runnerFailed(request: Request, id: string) {
  const job = await getJob(id);
  if (!job || job.state !== "converting" || !isRunnerAuthorized(request, job)) return json(request, { error: "无权访问。" }, 403);
  const input = await request.json().catch(() => ({})) as { message?: string };
  job.state = "failed";
  job.progress = 0;
  job.message = typeof input.message === "string" ? input.message.slice(0, 160) : "云端转换失败，请稍后重试。";
  job.callbackToken = "";
  await Promise.all([bucket().delete(job.sourceKey), bucket().delete(job.resultKey)]);
  await putJob(job);
  return json(request, { ok: true });
}

async function browserResult(request: Request, id: string) {
  const job = await getJob(id);
  if (!job) return json(request, { error: "转换任务不存在或已过期。" }, 404);
  if (!isTaskAuthorized(request, job)) return json(request, { error: "转换任务权限无效。", code: "task_key" }, 401);
  if (job.state !== "ready") return json(request, { error: "转换结果尚未准备好。" }, 404);
  const result = await bucket().get(job.resultKey);
  if (!result) return json(request, { error: "转换结果已过期，请重新上传。" }, 404);
  return new Response(result.body, {
    headers: {
      ...corsHeaders(request),
      "Content-Type": "model/gltf-binary",
      "Content-Length": String(result.size),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(job.fileName.replace(/\.(step|stp)$/i, ""))}-light.glb"`,
    },
  });
}

async function deleteTask(request: Request, id: string) {
  const job = await getJob(id);
  if (!job) return json(request, { ok: true });
  if (!isTaskAuthorized(request, job)) return json(request, { error: "转换任务权限无效。", code: "task_key" }, 401);
  await removeTask(job);
  return json(request, { ok: true });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [action, id] = (await context.params).path ?? [];
    if (action === "create" && !id) return await createTask(request);
    if (action === "claim" && !id) return await claimTask(request);
    if (!isValidId(id)) return json(request, { error: "无效的转换任务。" }, 400);
    if (action === "complete") return await completeUpload(request, id!);
    if (action === "progress") return await runnerProgress(request, id!);
    if (action === "finished") return await runnerFinished(request, id!);
    if (action === "failed") return await runnerFailed(request, id!);
    return json(request, { error: "接口不存在。" }, 404);
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : "云端处理出现错误。" }, 500);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const [action, id, part] = (await context.params).path ?? [];
    if (!isValidId(id)) return json(request, { error: "无效的转换任务。" }, 400);
    if (action === "upload" && part) return await uploadPart(request, id!, part);
    if (action === "result") return await runnerResult(request, id!);
    return json(request, { error: "接口不存在。" }, 404);
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : "云端处理出现错误。" }, 500);
  }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const [action, id] = (await context.params).path ?? [];
    if (!isValidId(id)) return json(request, { error: "无效的转换任务。" }, 400);
    if (action === "status") return await taskStatus(request, id!);
    if (action === "source") return await runnerSource(request, id!);
    if (action === "result") return await browserResult(request, id!);
    return json(request, { error: "接口不存在。" }, 404);
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : "云端处理出现错误。" }, 500);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const [action, id] = (await context.params).path ?? [];
    if (action !== "task" || !isValidId(id)) return json(request, { error: "无效的转换任务。" }, 400);
    return await deleteTask(request, id!);
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : "云端处理出现错误。" }, 500);
  }
}
