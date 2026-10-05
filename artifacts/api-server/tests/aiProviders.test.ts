import assert from "node:assert/strict";
import { test } from "node:test";
import { submitAiJob, checkAiJob } from "../src/lib/aiProviders";
import { ObjectStorageService } from "../src/lib/objectStorage";

test("provider adapters use input media type and handle queue failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalRead = ObjectStorageService.prototype.getObjectEntityReadURL;
  const originalReplicate = process.env.REPLICATE_API_TOKEN;
  const originalFal = process.env.FAL_KEY;
  process.env.REPLICATE_API_TOKEN = "test-only-provider-fixture";
  process.env.FAL_KEY = "test-only-provider-fixture";
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  ObjectStorageService.prototype.getObjectEntityReadURL = async () => "https://storage.googleapis.com/test/input";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (url.endsWith("/status")) {
      return Response.json({ status: "COMPLETED", error: "Inference failed", error_type: "model_error" });
    }
    return Response.json({ id: "prediction-test", request_id: "request-test", status: "starting" });
  };
  try {
    for (const providerId of ["replicate", "fal"]) {
      for (const contentType of ["image/png", "video/mp4"]) {
        const result = await submitAiJob({
          providerId, model: providerId === "fal" ? "fal-ai/wan/image-to-video" : "wan-video/wan-2.2-i2v-fast",
          ownerId: "user_fixture", prompt: "Move gently", category: "video",
          inputFiles: ["/objects/uploads/user_fixture/input"],
          inputContentTypes: [contentType], settings: {},
        });
        assert.equal(result.status, "processing");
        const request = requests.at(-1)!;
        const body = providerId === "replicate" ? request.body.input as Record<string, unknown> : request.body;
        const field = contentType.startsWith("image") ? "image" : "video";
        assert.equal(body[providerId === "fal" ? `${field}_url` : field], "https://storage.googleapis.com/test/input");
        assert.equal(body.prompt, "Move gently");
      }
    }
    const failed = await checkAiJob({ providerId: "fal", model: "fal-ai/wan/image-to-video", providerJobId: "request-test" });
    assert.equal(failed.status, "failed");
    assert.equal(requests.at(-1)!.url, "https://queue.fal.run/fal-ai/wan/requests/request-test/status");
    await assert.rejects(() => submitAiJob({
      providerId: "replicate", model: "../invalid", ownerId: "user_fixture",
      prompt: "test", category: "photo", inputFiles: [], settings: {},
    }), /invalid/);
    await assert.rejects(() => submitAiJob({
      providerId: "replicate", model: "test/model", ownerId: "user_fixture",
      prompt: "test", category: "photo", inputFiles: ["/objects/uploads/another_user/input"], settings: {},
    }), /not accessible/);
  } finally {
    globalThis.fetch = originalFetch;
    ObjectStorageService.prototype.getObjectEntityReadURL = originalRead;
    if (originalReplicate === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = originalReplicate;
    if (originalFal === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = originalFal;
  }
});
