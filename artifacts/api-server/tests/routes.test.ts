import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import { db, pool, usersTable, generationsTable, aiToolsTable, aiProvidersTable, creditsTable, creditTransactionsTable } from "@workspace/db";
import {
  GetDashboardResponse, GetToolsResponse, GetGenerationsResponse,
  GetAdminOverviewResponse, GetAdminProvidersResponse,
} from "@workspace/api-zod";
import router from "../src/routes";
import { ObjectStorageService } from "../src/lib/objectStorage";

// Clerk identity fixtures are confined to this isolated test server. The
// running application still uses clerkMiddleware to verify every session.
const userId = `user_test_${randomUUID().replaceAll("-", "")}`;
const adminId = `user_test_${randomUUID().replaceAll("-", "")}`;
const originalAdmins = process.env.ADMIN_CLERK_USER_IDS;
const originalClerkUserIds = process.env.CLERK_USER_IDS;
let server: Server;
let baseUrl: string;
let creationId: string;
let uploadedPath: string | undefined;

async function request(path: string, identity?: string, init?: RequestInit) {
  return fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      ...(identity ? { "x-test-identity": identity } : {}),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

before(async () => {
  delete process.env.CLERK_USER_IDS;
  process.env.ADMIN_CLERK_USER_IDS = adminId;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      auth: Object.assign(() => ({
        userId: req.get("x-test-identity") ?? null,
        sessionId: "session_test",
        tokenType: "session_token",
      }), { [Symbol.for("@clerk/express.auth")]: true }),
      log: { error() {}, warn() {}, info() {} },
    });
    next();
  });
  app.use("/api", router);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  for (const identity of [userId, adminId]) {
    const response = await request("/dashboard", identity);
    assert.equal(response.status, 200, await response.text());
  }
  const [creation] = await db.insert(generationsTable).values({
    clerkId: userId, toolId: "text-to-image", category: "photo",
    prompt: "API regression fixture", status: "completed", creditsUsed: 0,
  }).returning({ id: generationsTable.id });
  creationId = creation.id;
});

after(async () => {
  try {
    if (uploadedPath) {
      const file = await new ObjectStorageService().getObjectEntityFile(uploadedPath);
      await file.delete({ ignoreNotFound: true });
    }
    // All fixtures use unique IDs; cascading deletes cannot affect app users.
    await db.delete(usersTable).where(inArray(usersTable.clerkId, [userId, adminId]));
  } finally {
    if (originalAdmins === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
    else process.env.ADMIN_CLERK_USER_IDS = originalAdmins;
    if (originalClerkUserIds === undefined) delete process.env.CLERK_USER_IDS;
    else process.env.CLERK_USER_IDS = originalClerkUserIds;
    if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await pool.end();
  }
});

test("public catalog routes are mounted and return valid persisted tools", async () => {
  const response = await request("/tools");
  assert.equal(response.status, 200);
  const tools = GetToolsResponse.parse(await response.json());
  assert.equal(tools.length, 20);
  assert.ok(tools.some(tool => tool.id === "text-to-video"));
  for (const path of ["/healthz", "/site-config", "/plans"]) {
    assert.equal((await request(path)).status, 200, path);
  }
});

test("protected routes return JSON 401, not 404, when signed out", async () => {
  for (const path of ["/dashboard", "/generations", "/admin/overview", "/admin/providers"]) {
    const response = await request(path);
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).code, "UNAUTHENTICATED");
  }
  assert.equal((await request("/storage/uploads/request-url", undefined, {
    method: "POST", body: JSON.stringify({ name: "test.png", size: 8, contentType: "image/png" }),
  })).status, 401);
});

test("dashboard initializes the free account and returns its own activity", async () => {
  const response = await request("/dashboard", userId);
  assert.equal(response.status, 200);
  const data = GetDashboardResponse.parse(await response.json());
  assert.equal(data.planName, "Free");
  assert.equal(data.creditBalance, 0);
  assert.ok(data.recentGenerations.some(g => g.id === creationId));
});

test("generation history stays scoped to its owner", async () => {
  for (const identity of [userId, adminId]) {
    const response = await request("/generations", identity);
    assert.equal(response.status, 200);
    const items = GetGenerationsResponse.parse(await response.json());
    assert.equal(items.some(g => g.id === creationId), identity === userId);
  }
});

test("ordinary users cannot read administration endpoints", async () => {
  for (const path of ["/admin/overview", "/admin/providers", "/admin/tools", "/admin/plans", "/admin/users"]) {
    const response = await request(path, userId);
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).code, "FORBIDDEN");
  }
});

test("administrators get valid overview and provider responses", async () => {
  const overview = await request("/admin/overview", adminId);
  assert.equal(overview.status, 200);
  assert.ok(GetAdminOverviewResponse.parse(await overview.json()).totalUsers >= 2);
  const response = await request("/admin/providers", adminId);
  assert.equal(response.status, 200);
  const providers = GetAdminProvidersResponse.parse(await response.json());
  assert.deepEqual(providers.map(p => p.id).sort(), ["fal", "replicate", "runway"]);
  for (const path of ["/admin/tools", "/admin/plans", "/admin/users"]) {
    assert.equal((await request(path, adminId)).status, 200, path);
  }
});

test("CLERK_USER_IDS promotes an existing account without granting ordinary users access", async () => {
  await db.update(usersTable).set({ role: "user" }).where(eq(usersTable.clerkId, adminId));
  // This account already exists; creation-time role assignment cannot fix it.
  process.env.CLERK_USER_IDS = ` , ${adminId} , `;
  for (const path of ["/admin/overview", "/admin/tools", "/admin/plans", "/admin/providers"]) {
    assert.equal((await request(path, adminId)).status, 200, path);
    assert.equal((await request(path, userId)).status, 403, path);
    assert.equal((await request(path)).status, 401, path);
  }
  const [account] = await db.select().from(usersTable).where(eq(usersTable.clerkId, adminId));
  assert.equal(account.role, "admin");
});

test("an allowlisted but suspended owner remains blocked", async () => {
  await db.update(usersTable).set({ role: "user", status: "suspended" }).where(eq(usersTable.clerkId, adminId));
  try {
    const response = await request("/admin/overview", adminId);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "ACCOUNT_UNAVAILABLE");
  } finally {
    await db.update(usersTable).set({ status: "active" }).where(eq(usersTable.clerkId, adminId));
  }
});

test("provider and tool settings persist and require admin access; keys never leave the server", async () => {
  const [provider] = await db.select().from(aiProvidersTable).where(eq(aiProvidersTable.id, "replicate"));
  const [tool] = await db.select().from(aiToolsTable).where(eq(aiToolsTable.id, "text-to-image"));
  const originalKey = process.env.REPLICATE_API_TOKEN;
  // Only configuration detection is tested; no paid provider request is sent.
  const fixtureKey = `test-only-${randomUUID()}`;
  const providerUpdate = { method: "PATCH", body: JSON.stringify({ enabled: true, priority: 2, models: ["test/model"] }) };
  const toolUpdate = { method: "PATCH", body: JSON.stringify({ provider: "replicate", model: "test/model" }) };
  try {
    assert.equal((await request("/admin/providers/replicate", userId, providerUpdate)).status, 403);
    assert.equal((await request("/admin/tools/text-to-image", userId, toolUpdate)).status, 403);
    process.env.REPLICATE_API_TOKEN = "   ";
    const providersMissing = await (await request("/admin/providers", adminId)).json();
    assert.equal(providersMissing.find((p: { id: string }) => p.id === "replicate").configured, false);
    process.env.REPLICATE_API_TOKEN = fixtureKey;
    const updated = await request("/admin/providers/replicate", adminId, providerUpdate);
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).configured, true);
    const updatedTool = await request("/admin/tools/text-to-image", adminId, toolUpdate);
    assert.equal(updatedTool.status, 200);
    assert.equal((await updatedTool.json()).providerConfigured, true);
    const publicTools = await (await request("/tools")).json();
    assert.equal(publicTools.find((t: { id: string }) => t.id === tool.id).providerConfigured, true);
    const providerResponse = await (await request("/admin/providers", adminId)).text();
    assert.ok(!providerResponse.includes(fixtureKey));
    const saved = JSON.parse(providerResponse).find((p: { id: string }) => p.id === provider.id);
    assert.deepEqual(saved.models, ["test/model"]);
    assert.equal(saved.priority, 2);
    delete process.env.REPLICATE_API_TOKEN;
    const unconfiguredTools = await (await request("/tools")).json();
    assert.equal(unconfiguredTools.find((t: { id: string }) => t.id === tool.id).providerConfigured, false);
  } finally {
    await db.update(aiToolsTable).set({ providerId: tool.providerId, model: tool.model }).where(eq(aiToolsTable.id, tool.id));
    await db.update(aiProvidersTable).set({ enabled: provider.enabled, priority: provider.priority, models: provider.models }).where(eq(aiProvidersTable.id, provider.id));
    if (originalKey === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = originalKey;
  }
});

test("favorite mutation validates input and preserves ownership", async () => {
  const path = `/generations/${creationId}/favorite`;
  assert.equal((await request(path, userId, { method: "PATCH", body: "{}" })).status, 400);
  assert.equal((await request(path, adminId, {
    method: "PATCH", body: JSON.stringify({ favorite: true }),
  })).status, 404);
  const update = await request(path, userId, {
    method: "PATCH", body: JSON.stringify({ favorite: true }),
  });
  assert.equal(update.status, 200);
  const favorites = GetGenerationsResponse.parse(await (await request("/generations?favoritesOnly=true", userId)).json());
  assert.ok(favorites.some(g => g.id === creationId && g.favorite));
});

test("unconfigured AI fails explicitly without consuming credits", async () => {
  const response = await request("/generations", userId, {
    method: "POST",
    body: JSON.stringify({ toolId: "text-to-image", prompt: "A test image", inputFiles: [], settings: {} }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "PROVIDER_NOT_CONFIGURED");
});

test("private uploads round-trip and reject other users", {
  skip: !process.env.PRIVATE_OBJECT_DIR ? "App Storage has not been configured." : false,
}, async () => {
  const response = await request("/storage/uploads/request-url", userId, {
    method: "POST", body: JSON.stringify({ name: "test.png", size: 8, contentType: "image/png" }),
  });
  assert.equal(response.status, 200);
  const { uploadURL, objectPath } = await response.json() as { uploadURL: string; objectPath: string };
  uploadedPath = objectPath;
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const upload = await fetch(uploadURL, { method: "PUT", headers: { "content-type": "image/png" }, body: bytes });
  assert.ok(upload.ok);
  const read = await request(`/storage${objectPath}`, userId);
  assert.equal(read.status, 200);
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);
  assert.equal((await request(`/storage${objectPath}`, adminId)).status, 403);
  assert.equal((await request(`/storage${objectPath}`)).status, 401);
  const signedRead = await new ObjectStorageService().getObjectEntityReadURL(objectPath);
  const providerRead = await fetch(signedRead);
  assert.equal(providerRead.status, 200);
  assert.deepEqual(new Uint8Array(await providerRead.arrayBuffer()), bytes);
});

test("generation pipeline persists images/video, deducts credits, and refunds failures once (simulated provider)", {
  skip: !process.env.PRIVATE_OBJECT_DIR ? "App Storage has not been configured." : false,
}, async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.REPLICATE_API_TOKEN;
  const originalProvider = (await db.select().from(aiProvidersTable).where(eq(aiProvidersTable.id, "replicate")))[0];
  const ids = ["text-to-image", "image-to-image", "image-to-video"];
  const originals = await db.select().from(aiToolsTable).where(inArray(aiToolsTable.id, ids));
  const storedFiles: string[] = [];
  let nextJob = 0;
  const jobStates = new Map<string, "succeeded" | "failed">();
  let category: "photo" | "video" = "photo";
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZhsAAAAASUVORK5CYII=", "base64");
  const storage = new ObjectStorageService();
  try {
    assert.ok(uploadedPath, "The real storage round-trip must pass first.");
    process.env.REPLICATE_API_TOKEN = "test-only-provider-fixture";
    await db.update(aiProvidersTable).set({ enabled: true }).where(eq(aiProvidersTable.id, "replicate"));
    for (const id of ids) {
      await db.update(aiToolsTable).set({ providerId: "replicate", model: "test/model" }).where(eq(aiToolsTable.id, id));
    }
    await db.update(creditsTable).set({ balance: 100 }).where(eq(creditsTable.clerkId, userId));
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://api.replicate.com/")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          assert.ok(body.input.prompt);
          if (body.input.image) {
            assert.equal((await originalFetch(body.input.image)).status, 200, "Provider can read signed input URL.");
            assert.equal(body.input.video, undefined, "An uploaded image must not become a video input.");
          }
          const id = `test-job-${++nextJob}`;
          jobStates.set(id, body.input.prompt === "fail fixture" ? "failed" : "succeeded");
          return Response.json({ id, status: "starting" });
        }
        const id = url.split("/").at(-1)!;
        return Response.json({
          id, status: jobStates.get(id),
          output: `https://replicate.delivery/fixture/output.${category === "video" ? "mp4" : "png"}`,
        });
      }
      if (url.startsWith("https://replicate.delivery/fixture/")) {
        // Provider response is simulated; storage, database, and routes are real.
        return new Response(imageBytes, { headers: { "content-type": category === "video" ? "video/mp4" : "image/png" } });
      }
      return originalFetch(input, init);
    };
    let expectedBalance = 100;
    for (const toolId of ids) {
      category = toolId === "image-to-video" ? "video" : "photo";
      const response = await request("/generations", userId, {
        method: "POST", body: JSON.stringify({
          toolId, prompt: "generation fixture", inputFiles: toolId === "text-to-image" ? [] : [uploadedPath],
        }),
      });
      assert.equal(response.status, 202, await response.clone().text());
      const submitted = await response.json();
      const tool = originals.find(t => t.id === toolId)!;
      expectedBalance -= tool.credits;
      let dashboard = await (await request("/dashboard", userId)).json();
      assert.equal(dashboard.creditBalance, expectedBalance);
      const histories = await Promise.all([request("/generations", userId), request("/generations", userId)]);
      const rows = GetGenerationsResponse.parse(await histories[0].json());
      assert.equal(histories[1].status, 200);
      const completed = rows.find(g => g.id === submitted.id)!;
      assert.equal(completed.status, "completed");
      assert.equal(completed.outputFiles.length, 1, "Concurrent polling must not duplicate output records.");
      storedFiles.push(...completed.outputFiles);
      const output = await request(`/storage${completed.outputFiles[0]}`, userId);
      assert.equal(output.status, 200);
      assert.equal(output.headers.get("content-type"), category === "video" ? "video/mp4" : "image/png");
      assert.equal((await request(`/storage${completed.outputFiles[0]}`, adminId)).status, 403);
      dashboard = await (await request("/dashboard", userId)).json();
      assert.equal(dashboard.creditBalance, expectedBalance);
    }
    const invalidImage = await request("/generations", userId, {
      method: "POST", body: JSON.stringify({ toolId: "image-to-video", prompt: "test", inputFiles: [] }),
    });
    assert.equal(invalidImage.status, 400);
    const failedResponse = await request("/generations", userId, {
      method: "POST", body: JSON.stringify({ toolId: "text-to-image", prompt: "fail fixture", inputFiles: [] }),
    });
    assert.equal(failedResponse.status, 202);
    const failed = await failedResponse.json();
    await Promise.all([request("/generations", userId), request("/generations", userId)]);
    await request("/generations", userId);
    const history = await (await request("/generations", userId)).json();
    assert.equal(history.find((g: { id: string }) => g.id === failed.id).status, "failed");
    assert.equal((await (await request("/dashboard", userId)).json()).creditBalance, expectedBalance);
    const ledger = await db.select().from(creditTransactionsTable).where(eq(creditTransactionsTable.clerkId, userId));
    assert.equal(ledger.filter(row => row.reason === "generation").length, 4);
    assert.equal(ledger.filter(row => row.reason === "generation_refund").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = originalKey;
    for (const tool of originals) {
      await db.update(aiToolsTable).set({ providerId: tool.providerId, model: tool.model }).where(eq(aiToolsTable.id, tool.id));
    }
    await db.update(aiProvidersTable).set({ enabled: originalProvider.enabled }).where(eq(aiProvidersTable.id, "replicate"));
    for (const path of storedFiles) {
      await (await storage.getObjectEntityFile(path)).delete({ ignoreNotFound: true });
    }
  }
});

test("suspended accounts cannot access the workspace", async () => {
  await db.update(usersTable).set({ status: "suspended" }).where(eq(usersTable.clerkId, userId));
  const response = await request("/dashboard", userId);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "ACCOUNT_UNAVAILABLE");
  await db.update(usersTable).set({ status: "active" }).where(eq(usersTable.clerkId, userId));
});

test("delete mutation refuses other owners and removes the creation", async () => {
  assert.equal((await request(`/generations/${creationId}`, adminId, { method: "DELETE" })).status, 404);
  assert.equal((await request(`/generations/${creationId}`, userId, { method: "DELETE" })).status, 204);
  const data = GetGenerationsResponse.parse(await (await request("/generations", userId)).json());
  assert.ok(!data.some(g => g.id === creationId));
});
