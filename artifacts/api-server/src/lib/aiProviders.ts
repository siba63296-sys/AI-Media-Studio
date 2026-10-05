import { ObjectStorageService } from "./objectStorage";

const objectStorage = new ObjectStorageService();

export class AiProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderError";
  }
}

export type ProviderResult = {
  providerJobId: string;
  status: "processing" | "completed" | "failed";
  outputUrls: string[];
};

function getProviderKey(providerId: string): string | undefined {
  if (providerId === "replicate") return process.env.REPLICATE_API_TOKEN?.trim() || undefined;
  if (providerId === "fal") return process.env.FAL_KEY?.trim() || undefined;
  return undefined;
}

export function isProviderKeyConfigured(providerId: string): boolean {
  return Boolean(getProviderKey(providerId));
}

function safeModel(model: string): string {
  if (
    model.length > 180 ||
    !/^[a-zA-Z0-9._/-]+(?::[a-zA-Z0-9._-]+)?$/.test(model) ||
    model.split("/").includes("..")
  ) {
    throw new AiProviderError("The configured model identifier is invalid.");
  }
  return model;
}

function outputUrls(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item): item is string => typeof item === "string")
    .filter((item) => item.length < 4096);
}

async function inputUrls(
  ownerId: string,
  paths: string[],
): Promise<string[]> {
  const prefix = `/objects/uploads/${ownerId}/`;
  return Promise.all(
    paths.map(async (path) => {
      if (
        !path.startsWith(prefix) ||
        path.split("/").includes("..") ||
        path.length > 500
      ) {
        throw new AiProviderError("One of the selected files is not accessible.");
      }
      return objectStorage.getObjectEntityReadURL(path);
    }),
  );
}

function collectOutput(data: Record<string, unknown>): string[] {
  const result = outputUrls(data.output);
  if (result.length) return result;

  const images = data.images;
  if (Array.isArray(images)) {
    return images.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (typeof item === "object" && item && "url" in item) {
        return outputUrls((item as { url?: unknown }).url);
      }
      return [];
    });
  }

  const video = data.video;
  if (typeof video === "object" && video && "url" in video) {
    return outputUrls((video as { url?: unknown }).url);
  }
  return [];
}

export async function submitAiJob({
  providerId,
  model: rawModel,
  ownerId,
  prompt,
  category,
  inputFiles,
  settings,
}: {
  providerId: string;
  model: string;
  ownerId: string;
  prompt: string;
  category: "photo" | "video";
  inputFiles: string[];
  settings: Record<string, unknown>;
}): Promise<ProviderResult> {
  const model = safeModel(rawModel);
  const apiKey = getProviderKey(providerId);
  if (!apiKey) {
    throw new AiProviderError(
      "AI provider is not configured. Please contact the administrator.",
    );
  }
  const signedInputs = await inputUrls(ownerId, inputFiles);
  const mediaKey = category === "video" ? "video" : "image";
  const input: Record<string, unknown> = {
    ...settings,
    prompt,
  };
  if (signedInputs.length === 1) input[mediaKey] = signedInputs[0];
  if (signedInputs.length > 1) input[`${mediaKey}_inputs`] = signedInputs;

  if (providerId === "replicate") {
    const [modelPath, version] = model.split(":");
    const url = version
      ? "https://api.replicate.com/v1/predictions"
      : `https://api.replicate.com/v1/models/${modelPath}/predictions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Prefer: "wait=0",
      },
      body: JSON.stringify({
        ...(version ? { version } : {}),
        input,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new AiProviderError(
        `The AI provider could not accept this request (HTTP ${response.status}).`,
      );
    }
    const data = (await response.json()) as Record<string, unknown>;
    const status =
      data.status === "succeeded"
        ? "completed"
        : data.status === "failed" || data.status === "canceled"
          ? "failed"
          : "processing";
    return {
      providerJobId: String(data.id ?? ""),
      status,
      outputUrls: collectOutput(data),
    };
  }

  if (providerId === "fal") {
    const response = await fetch(`https://queue.fal.run/${model}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...settings,
        prompt,
        ...(signedInputs.length === 1
          ? { [category === "video" ? "video_url" : "image_url"]: signedInputs[0] }
          : signedInputs.length > 1
            ? { image_urls: signedInputs }
            : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new AiProviderError(
        `The AI provider could not accept this request (HTTP ${response.status}).`,
      );
    }
    const data = (await response.json()) as Record<string, unknown>;
    const providerJobId = String(data.request_id ?? "");
    if (!providerJobId) {
      throw new AiProviderError("The provider returned an invalid job response.");
    }
    return {
      providerJobId,
      status: "processing",
      outputUrls: [],
    };
  }

  throw new AiProviderError(
    "This AI provider does not have an active server adapter.",
  );
}

export async function checkAiJob({
  providerId,
  model: rawModel,
  providerJobId,
}: {
  providerId: string;
  model: string;
  providerJobId: string;
}): Promise<ProviderResult> {
  const model = safeModel(rawModel);
  const apiKey = getProviderKey(providerId);
  if (!apiKey) {
    throw new AiProviderError(
      "AI provider is not configured. Please contact the administrator.",
    );
  }

  if (providerId === "replicate") {
    const response = await fetch(
      `https://api.replicate.com/v1/predictions/${encodeURIComponent(providerJobId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new AiProviderError(
        `The AI provider status check failed (HTTP ${response.status}).`,
      );
    }
    const data = (await response.json()) as Record<string, unknown>;
    const status =
      data.status === "succeeded"
        ? "completed"
        : data.status === "failed" || data.status === "canceled"
          ? "failed"
          : "processing";
    return {
      providerJobId,
      status,
      outputUrls: collectOutput(data),
    };
  }

  if (providerId === "fal") {
    const statusResponse = await fetch(
      `https://queue.fal.run/${model}/requests/${encodeURIComponent(providerJobId)}/status`,
      {
        headers: { Authorization: `Key ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!statusResponse.ok) {
      throw new AiProviderError(
        `The AI provider status check failed (HTTP ${statusResponse.status}).`,
      );
    }
    const statusData = (await statusResponse.json()) as Record<string, unknown>;
    const rawStatus = String(statusData.status ?? "").toUpperCase();
    if (rawStatus === "FAILED") {
      return { providerJobId, status: "failed", outputUrls: [] };
    }
    if (rawStatus !== "COMPLETED") {
      return { providerJobId, status: "processing", outputUrls: [] };
    }

    const resultResponse = await fetch(
      `https://queue.fal.run/${model}/requests/${encodeURIComponent(providerJobId)}`,
      {
        headers: { Authorization: `Key ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!resultResponse.ok) {
      throw new AiProviderError(
        `The AI provider result check failed (HTTP ${resultResponse.status}).`,
      );
    }
    const result = (await resultResponse.json()) as Record<string, unknown>;
    return {
      providerJobId,
      status: "completed",
      outputUrls: collectOutput(result),
    };
  }

  throw new AiProviderError(
    "This AI provider does not have an active server adapter.",
  );
}

export async function storeProviderOutputs({
  providerId,
  ownerId,
  urls,
}: {
  providerId: string;
  ownerId: string;
  urls: string[];
}): Promise<Array<{ path: string; contentType: string; size: number }>> {
  const allowedHost =
    providerId === "replicate"
      ? (host: string) =>
          host === "replicate.delivery" || host.endsWith(".replicate.delivery")
      : providerId === "fal"
        ? (host: string) => host === "fal.media" || host.endsWith(".fal.media")
        : () => false;
  const stored: Array<{ path: string; contentType: string; size: number }> = [];

  for (const rawUrl of urls.slice(0, 5)) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !allowedHost(url.hostname)) continue;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) continue;
    const contentType =
      response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? "";
    if (
      ![
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/avif",
        "video/mp4",
        "video/quicktime",
        "video/webm",
      ].includes(contentType)
    ) {
      continue;
    }
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > 50 * 1024 * 1024) continue;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) continue;
    const path = await objectStorage.savePrivateObject({
      ownerId,
      contentType,
      bytes,
    });
    stored.push({ path, contentType, size: bytes.length });
  }
  return stored;
}
