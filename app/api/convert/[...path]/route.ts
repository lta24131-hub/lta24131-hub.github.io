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
  callbackToken: string;
  sourceKey: string;
  resultKey: string;
  resultSize?: number;
};

const MAX_SOURCE_SIZE = 2 * 1024 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  "https://lta24131-hub.github.io",
  "https://step-viewer-offline-0914.design53648.chatgpt.site",
  "http://localhost:3000",
  "http://localhost:5173",
]);

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
    "Access-Control-Allow-Headers": "Content-Type, X-Conversion-Key",
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

function isRunnerAuthorized(request: Request, job: ConversionJob) {
  const url = new URL(request.url);
  return url.searchParams.get("token") === job.callbackToken;
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
  await Promise.all([
    bucket().delete(job.sourceKey),
    bucket().delete(job.resultKey),
    bucket().delete(`jobs/${job.id}.json`),
  ]);
}

async function createTask(request: Request) {
  if (!isBrowserAuthorized(request)) return json(request, { error: "请输入正确的云端转换开通码。", code: "access_key" }, 401);
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

  const id = crypto.randomUUID();
  const sourceKey = `uploads/${id}/source.step`;
  const resultKey = `uploads/${id}/result.glb`;
  const multipart = await bucket().createMultipartUpload(sourceKey, {
    httpMetadata: { contentType: "application/step" },
    customMetadata: { fileName },
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
    callbackToken: crypto.randomUUID() + crypto.randomUUID(),
    sourceKey,
    resultKey,
  };
  await putJob(job);
  return json(request, { id, uploadId: multipart.uploadId, partSize: 8 * 1024 * 1024 });
}

async function uploadPart(request: Request, id: string, partText: string) {
  if (!isBrowserAuthorized(request)) return json(request, { error: "云端转换开通码无效。", code: "access_key" }, 401);
  const job = await getJob(id);
  if (!job) return json(request, { error: "转换任务不存在或已过期。" }, 404);
  const partNumber = Number(partText);
  const uploadId = new URL(request.url).searchParams.get("uploadId");
  if (job.state !== "uploading" || uploadId !== job.uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000 || !request.body) {
    return json(request, { error: "上传分块无效。" }, 400);
  }
  const multipart = bucket().resumeMultipartUpload(job.sourceKey, job.uploadId);
  const part = await multipart.uploadPart(partNumber, request.body);
  return json(request, { partNumber: part.partNumber, etag: part.etag });
}

async function completeUpload(request: Request, id: string) {
  if (!isBrowserAuthorized(request)) return json(request, { error: "云端转换开通码无效。", code: "access_key" }, 401);
  const job = await getJob(id);
  if (!job) return json(request, { error: "转换任务不存在或已过期。" }, 404);
  const input = await request.json().catch(() => null) as { uploadId?: string; parts?: Array<{ partNumber: number; etag: string }> } | null;
  if (job.state !== "uploading" || input?.uploadId !== job.uploadId || !Array.isArray(input.parts) || !input.parts.length) {
    return json(request, { error: "上传完成信息无效。" }, 400);
  }

  const ordered = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
  await bucket().resumeMultipartUpload(job.sourceKey, job.uploadId).complete(ordered);
  job.state = "queued";
  job.progress = 1;
  job.message = "已上传，正在排队转换";
  await putJob(job);

  const githubToken = env.GITHUB_ACTIONS_TOKEN;
  if (!githubToken) {
    job.state = "failed";
    job.message = "云端转换服务尚未开通，请稍后再试。";
    await putJob(job);
    return json(request, { error: job.message, code: "not_configured" }, 503);
  }

  const apiOrigin = new URL(request.url).origin;
  const dispatch = await fetch("https://api.github.com/repos/lta24131-hub/lta24131-hub.github.io/actions/workflows/convert-step.yml/dispatches", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "3d-step-viewer",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { task_id: job.id, callback_token: job.callbackToken, api_url: apiOrigin },
    }),
  });
  if (!dispatch.ok) {
    job.state = "failed";
    job.message = "云端转换任务启动失败，请稍后重试。";
    await putJob(job);
    return json(request, { error: job.message }, 502);
  }
  return json(request, { id: job.id, state: job.state });
}

async function taskStatus(request: Request, id: string) {
  if (!isBrowserAuthorized(request)) return json(request, { error: "云端转换开通码无效。", code: "access_key" }, 401);
  const job = await getJob(id);
  if (!job) return json(request, { error: "转换任务不存在或已过期。" }, 404);
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
  if (!job || !isRunnerAuthorized(request, job)) return json(request, { error: "无权访问。" }, 403);
  const source = await bucket().get(job.sourceKey);
  if (!source) return json(request, { error: "源文件不存在。" }, 404);
  return new Response(source.body, {
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/step",
      "Content-Length": String(source.size),
      "Content-Disposition": `attachment; filename="source.step"`,
    },
  });
}

async function runnerProgress(request: Request, id: string) {
  const job = await getJob(id);
  if (!job || !isRunnerAuthorized(request, job)) return json(request, { error: "无权访问。" }, 403);
  const input = await request.json().catch(() => ({})) as { progress?: number; message?: string };
  job.state = "converting";
  job.progress = Math.max(2, Math.min(98, Number(input.progress) || job.progress));
  job.message = typeof input.message === "string" ? input.message.slice(0, 100) : "正在云端转换";
  await putJob(job);
  return json(request, { ok: true });
}

async function runnerResult(request: Request, id: string) {
  const job = await getJob(id);
  if (!job || !isRunnerAuthorized(request, job) || !request.body) return json(request, { error: "无权访问。" }, 403);
  const length = Number(request.headers.get("Content-Length")) || undefined;
  await bucket().put(job.resultKey, request.body, {
    httpMetadata: { contentType: "model/gltf-binary", contentDisposition: `attachment; filename="${job.fileName.replace(/\.(step|stp)$/i, "")}-轻量版.glb"` },
    customMetadata: length ? { size: String(length) } : undefined,
  });
  const result = await bucket().head(job.resultKey);
  job.resultSize = result?.size;
  job.progress = 99;
  job.message = "轻量模型已生成";
  await putJob(job);
  return json(request, { ok: true });
}

async function runnerFinished(request: Request, id: string) {
  const job = await getJob(id);
  if (!job || !isRunnerAuthorized(request, job)) return json(request, { error: "无权访问。" }, 403);
  job.state = "ready";
  job.progress = 100;
  job.message = "转换完成，正在打开模型";
  await putJob(job);
  await bucket().delete(job.sourceKey);
  return json(request, { ok: true });
}

async function runnerFailed(request: Request, id: string) {
  const job = await getJob(id);
  if (!job || !isRunnerAuthorized(request, job)) return json(request, { error: "无权访问。" }, 403);
  const input = await request.json().catch(() => ({})) as { message?: string };
  job.state = "failed";
  job.progress = 0;
  job.message = typeof input.message === "string" ? input.message.slice(0, 160) : "云端转换失败，请稍后重试。";
  await putJob(job);
  await bucket().delete(job.sourceKey);
  return json(request, { ok: true });
}

async function browserResult(request: Request, id: string) {
  if (!isBrowserAuthorized(request)) return json(request, { error: "云端转换开通码无效。", code: "access_key" }, 401);
  const job = await getJob(id);
  if (!job || job.state !== "ready") return json(request, { error: "转换结果尚未准备好。" }, 404);
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
  if (!isBrowserAuthorized(request)) return json(request, { error: "云端转换开通码无效。", code: "access_key" }, 401);
  const job = await getJob(id);
  if (job) await removeTask(job);
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
