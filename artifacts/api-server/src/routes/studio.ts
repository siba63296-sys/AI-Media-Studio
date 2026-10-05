import { getAuth } from "@clerk/express";
import {
  CreateGenerationBody,
  CreateGenerationResponse,
  CreateAdminPlanBody,
  CreateAdminPlanResponse,
  DeleteGenerationParams,
  DeleteGenerationResponse,
  DeleteAdminPlanParams,
  DeleteAdminPlanResponse,
  SetGenerationFavoriteBody,
  GetAdminOverviewResponse,
  GetAdminPlansResponse,
  GetAdminProvidersResponse,
  GetAdminToolsResponse,
  GetAdminUsersQueryParams,
  GetAdminUsersResponse,
  GetDashboardResponse,
  GetGenerationsQueryParams,
  GetGenerationsResponse,
  GetPlansResponse,
  GetSiteConfigResponse,
  GetToolsResponse,
  SetGenerationFavoriteParams,
  SetGenerationFavoriteResponse,
  SiteConfigInput,
  UpdateAdminPlanBody,
  UpdateAdminPlanParams,
  UpdateAdminPlanResponse,
  UpdateAdminProviderBody,
  UpdateAdminProviderParams,
  UpdateAdminProviderResponse,
  UpdateAdminSettingsBody,
  UpdateAdminSettingsResponse,
  UpdateAdminToolBody,
  UpdateAdminToolParams,
  UpdateAdminToolResponse,
  UpdateAdminUserBody,
  UpdateAdminUserParams,
  UpdateAdminUserResponse,
} from "@workspace/api-zod";
import {
  adminSettingsTable,
  aiProvidersTable,
  aiToolsTable,
  creditTransactionsTable,
  creditsTable,
  couponUsageTable,
  couponsTable,
  generationFilesTable,
  generationsTable,
  paymentsTable,
  plansTable,
  siteSettingsTable,
  subscriptionsTable,
  usageLogsTable,
  usersTable,
} from "@workspace/db/schema";
import { db } from "@workspace/db";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  checkAiJob,
  isProviderKeyConfigured,
  storeProviderOutputs,
  submitAiJob,
} from "../lib/aiProviders";
import { Router, type Request, type RequestHandler, type Response } from "express";

const router = Router();
const DEFAULT_SITE_CONFIG = {
  name: "Zevora AI Studio",
  tagline: "Create. Edit. Transform with AI.",
  homepageText: "Powerful AI photo and video tools in one studio.",
  contactEmail: null,
  logoUrl: null,
  maintenanceMode: false,
};

function sendError(
  res: Response,
  status: number,
  message: string,
  code?: string,
): void {
  res.status(status).json({ error: message, code });
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function configuredAdminIds(): Set<string> {
  return new Set(
    (process.env.CLERK_USER_IDS ?? process.env.ADMIN_CLERK_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

async function ensureAccount(
  req: Request,
  res: Response,
): Promise<{ id: string; role: "user" | "admin"; status: "active" | "suspended" } | null> {
  const clerkId = getAuth(req).userId;
  if (!clerkId) {
    sendError(res, 401, "Sign in to continue.", "UNAUTHENTICATED");
    return null;
  }

  const [existing] = await db
    .select({
      id: usersTable.clerkId,
      role: usersTable.role,
      status: usersTable.status,
    })
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId))
    .limit(1);

  if (!existing) {
    const [freePlan] = await db
      .select({ id: plansTable.id, credits: plansTable.credits })
      .from(plansTable)
      .where(eq(plansTable.id, "free"))
      .limit(1);
    if (!freePlan) {
      sendError(res, 503, "The account catalog has not been initialized.", "SETUP_REQUIRED");
      return null;
    }

    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(usersTable)
        .values({
          clerkId,
          role: configuredAdminIds().has(clerkId) ? "admin" : "user",
        })
        .onConflictDoNothing()
        .returning({ id: usersTable.clerkId });
      if (inserted.length === 0) return;

      await tx.insert(creditsTable).values({
        clerkId,
        balance: freePlan.credits,
      });
      await tx.insert(subscriptionsTable).values({
        clerkId,
        planId: freePlan.id,
        status: "active",
      });
      if (freePlan.credits > 0) {
        await tx.insert(creditTransactionsTable).values({
          clerkId,
          amount: freePlan.credits,
          reason: "free_plan_start",
          reference: `free-plan:${clerkId}`,
        });
      }
    });
  }

  const [account] = await db
    .select({
      id: usersTable.clerkId,
      role: usersTable.role,
      status: usersTable.status,
    })
    .from(usersTable)
    .where(eq(usersTable.clerkId, clerkId))
    .limit(1);

  if (!account || account.status === "suspended") {
    sendError(res, 403, "This account is not currently available.", "ACCOUNT_UNAVAILABLE");
    return null;
  }
  // The allowlist also applies to accounts created before owner setup.
  // Identity comes exclusively from the verified Clerk session, never the body.
  if (account.role !== "admin" && configuredAdminIds().has(clerkId)) {
    await db
      .update(usersTable)
      .set({ role: "admin", updatedAt: new Date() })
      .where(eq(usersTable.clerkId, clerkId));
    account.role = "admin";
  }
  return account;
}

async function ensureAdmin(req: Request, res: Response) {
  const account = await ensureAccount(req, res);
  if (!account) return null;
  if (account.role !== "admin") {
    sendError(res, 403, "Admin access is required.", "FORBIDDEN");
    return null;
  }
  return account;
}

function mapPlan(plan: typeof plansTable.$inferSelect) {
  return {
    ...plan,
    monthlyPrice: Number(plan.monthlyPrice),
    yearlyPrice: Number(plan.yearlyPrice),
    features: plan.features ?? [],
  };
}

async function mapTool(tool: typeof aiToolsTable.$inferSelect) {
  const providerId = tool.providerId ?? "unconfigured";
  const [provider] = tool.providerId
    ? await db
        .select()
        .from(aiProvidersTable)
        .where(eq(aiProvidersTable.id, tool.providerId))
        .limit(1)
    : [];
  return {
    id: tool.id,
    name: tool.name,
    category: tool.category,
    description: tool.description,
    credits: tool.credits,
    enabled: tool.enabled,
    provider: providerId,
    model: tool.model ?? "",
    providerConfigured:
      Boolean(provider?.enabled) &&
      Boolean(tool.model) &&
      isProviderKeyConfigured(providerId),
    acceptsUpload: tool.acceptsUpload,
  };
}

async function getGenerationRows(userId: string, favoritesOnly: boolean) {
  const rows = await db
    .select({
      id: generationsTable.id,
      toolId: generationsTable.toolId,
      toolName: aiToolsTable.name,
      category: generationsTable.category,
      prompt: generationsTable.prompt,
      status: generationsTable.status,
      creditsUsed: generationsTable.creditsUsed,
      favorite: generationsTable.favorite,
      createdAt: generationsTable.createdAt,
    })
    .from(generationsTable)
    .innerJoin(aiToolsTable, eq(generationsTable.toolId, aiToolsTable.id))
    .where(
      favoritesOnly
        ? and(
            eq(generationsTable.clerkId, userId),
            eq(generationsTable.favorite, true),
          )
        : eq(generationsTable.clerkId, userId),
    )
    .orderBy(desc(generationsTable.createdAt))
    .limit(100);

  if (rows.length === 0) return [];
  const files = await db
    .select()
    .from(generationFilesTable)
    .where(
      and(
        eq(generationFilesTable.clerkId, userId),
        inArray(
          generationFilesTable.generationId,
          rows.map((row) => row.id),
        ),
      ),
    );
  const byGeneration = new Map<string, typeof files>();
  for (const file of files) {
    if (!file.generationId) continue;
    const list = byGeneration.get(file.generationId) ?? [];
    list.push(file);
    byGeneration.set(file.generationId, list);
  }

  return rows.map((row) => {
    const rowFiles = byGeneration.get(row.id) ?? [];
    return {
      id: row.id,
      toolId: row.toolId,
      toolName: row.toolName,
      category: row.category,
      prompt: row.prompt,
      status: row.status,
      creditsUsed: row.creditsUsed,
      favorite: row.favorite,
      createdAt: row.createdAt.toISOString(),
      inputFiles: rowFiles
        .filter((file) => file.role === "input")
        .map((file) => file.path),
      outputFiles: rowFiles
        .filter((file) => file.role === "output")
        .map((file) => file.path),
    };
  });
}

async function syncGenerationStatus(
  userId: string,
  rows: Array<typeof generationsTable.$inferSelect>,
): Promise<void> {
  for (const row of rows) {
    if (
      (row.status !== "processing" && row.status !== "pending") ||
      !row.providerId ||
      !row.model ||
      !row.providerJobId
    ) {
      continue;
    }
    try {
      const result = await checkAiJob({
        providerId: row.providerId,
        model: row.model,
        providerJobId: row.providerJobId,
      });
      if (result.status === "processing") continue;
      const outputFiles =
        result.status === "completed"
          ? await storeProviderOutputs({
              providerId: row.providerId,
              ownerId: userId,
              urls: result.outputUrls,
            })
          : [];
      const isCompleted = result.status === "completed" && outputFiles.length > 0;

      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(generationsTable)
          .where(
            and(
              eq(generationsTable.id, row.id),
              eq(generationsTable.clerkId, userId),
            ),
          )
          .limit(1)
          .for("update");
        if (!current || (current.status !== "processing" && current.status !== "pending")) {
          return;
        }
        if (isCompleted) {
          await tx.insert(generationFilesTable).values(
            outputFiles.map((file) => ({
              generationId: row.id,
              clerkId: userId,
              path: file.path,
              name: file.path.split("/").at(-1) ?? "generated-file",
              contentType: file.contentType,
              size: file.size,
              role: "output" as const,
            })),
          );
          await tx
            .update(generationsTable)
            .set({ status: "completed", updatedAt: new Date() })
            .where(eq(generationsTable.id, row.id));
          return;
        }

        await tx
          .update(generationsTable)
          .set({ status: "failed", errorCode: "PROVIDER_FAILED", updatedAt: new Date() })
          .where(eq(generationsTable.id, row.id));
        const refund = await tx
          .insert(creditTransactionsTable)
          .values({
            clerkId: userId,
            amount: current.creditsUsed,
            reason: "generation_refund",
            reference: `refund:${row.id}`,
          })
          .onConflictDoNothing()
          .returning({ id: creditTransactionsTable.id });
        if (refund.length > 0 && current.creditsUsed > 0) {
          await tx
            .update(creditsTable)
            .set({ balance: sql`${creditsTable.balance} + ${current.creditsUsed}` })
            .where(eq(creditsTable.clerkId, userId));
        }
      });
    } catch {
      // Provider status polling is best-effort; an unavailable provider must not
      // turn a submitted job into a fabricated success or an accidental refund.
    }
  }
}

async function getAdminUser(userId: string) {
  const [row] = await db
    .select({
      id: usersTable.clerkId,
      email: usersTable.email,
      status: usersTable.status,
      createdAt: usersTable.createdAt,
      planName: plansTable.name,
      creditBalance: creditsTable.balance,
    })
    .from(usersTable)
    .leftJoin(creditsTable, eq(usersTable.clerkId, creditsTable.clerkId))
    .leftJoin(
      subscriptionsTable,
      and(
        eq(usersTable.clerkId, subscriptionsTable.clerkId),
        eq(subscriptionsTable.status, "active"),
      ),
    )
    .leftJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(eq(usersTable.clerkId, userId))
    .limit(1);
  return row
    ? {
        id: row.id,
        email: row.email,
        planName: row.planName ?? "Unassigned",
        creditBalance: row.creditBalance ?? 0,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      }
    : null;
}

router.get(
  "/site-config",
  asyncRoute(async (_req, res) => {
    const [settings] = await db.select().from(siteSettingsTable).limit(1);
    res.json(GetSiteConfigResponse.parse(settings ?? DEFAULT_SITE_CONFIG));
  }),
);

router.get(
  "/tools",
  asyncRoute(async (_req, res) => {
    const rows = await db
      .select()
      .from(aiToolsTable)
      .where(eq(aiToolsTable.enabled, true))
      .orderBy(aiToolsTable.category, aiToolsTable.name);
    res.json(GetToolsResponse.parse(await Promise.all(rows.map(mapTool))));
  }),
);

router.get(
  "/plans",
  asyncRoute(async (_req, res) => {
    const rows = await db
      .select()
      .from(plansTable)
      .where(eq(plansTable.active, true))
      .orderBy(plansTable.monthlyPrice);
    res.json(GetPlansResponse.parse(rows.map(mapPlan)));
  }),
);

router.get(
  "/dashboard",
  asyncRoute(async (req, res) => {
    const account = await ensureAccount(req, res);
    if (!account) return;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [[credit], [usage], subscription] = await Promise.all([
      db
        .select({ balance: creditsTable.balance })
        .from(creditsTable)
        .where(eq(creditsTable.clerkId, account.id))
        .limit(1),
      db
        .select({ total: count() })
        .from(generationsTable)
        .where(
          and(
            eq(generationsTable.clerkId, account.id),
            gte(generationsTable.createdAt, monthStart),
          ),
        ),
      db
        .select({ name: plansTable.name })
        .from(subscriptionsTable)
        .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
        .where(
          and(
            eq(subscriptionsTable.clerkId, account.id),
            eq(subscriptionsTable.status, "active"),
          ),
        )
        .orderBy(desc(subscriptionsTable.createdAt))
        .limit(1),
    ]);
    const recent = await getGenerationRows(account.id, false);
    res.json(
      GetDashboardResponse.parse({
        planName: subscription[0]?.name ?? "Unassigned",
        creditBalance: credit?.balance ?? 0,
        generationsThisMonth: usage?.total ?? 0,
        recentGenerations: recent.slice(0, 5),
      }),
    );
  }),
);

router.get(
  "/generations",
  asyncRoute(async (req, res) => {
    const account = await ensureAccount(req, res);
    if (!account) return;
    const parsed = GetGenerationsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, "Invalid history filter.", "INVALID_FILTER");
      return;
    }
    const pending = await db
      .select()
      .from(generationsTable)
      .where(
        and(
          eq(generationsTable.clerkId, account.id),
          inArray(generationsTable.status, ["pending", "processing"]),
          isNotNull(generationsTable.providerJobId),
        ),
      )
      .limit(10);
    await syncGenerationStatus(account.id, pending);
    res.json(
      GetGenerationsResponse.parse(
        await getGenerationRows(account.id, parsed.data.favoritesOnly ?? false),
      ),
    );
  }),
);

router.post(
  "/generations",
  asyncRoute(async (req, res) => {
    const account = await ensureAccount(req, res);
    if (!account) return;
    const parsed = CreateGenerationBody.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "Invalid generation request.", "INVALID_GENERATION");
      return;
    }
    const [tool] = await db
      .select()
      .from(aiToolsTable)
      .where(eq(aiToolsTable.id, parsed.data.toolId))
      .limit(1);
    if (!tool || !tool.enabled || !tool.providerId || !tool.model) {
      sendError(
        res,
        503,
        "AI provider is not configured. Please contact the administrator.",
        "PROVIDER_NOT_CONFIGURED",
      );
      return;
    }
    const [provider] = await db
      .select()
      .from(aiProvidersTable)
      .where(eq(aiProvidersTable.id, tool.providerId))
      .limit(1);
    if (!provider?.enabled || !isProviderKeyConfigured(tool.providerId)) {
      sendError(
        res,
        503,
        "AI provider is not configured. Please contact the administrator.",
        "PROVIDER_NOT_CONFIGURED",
      );
      return;
    }
    const [balance] = await db
      .select({ balance: creditsTable.balance })
      .from(creditsTable)
      .where(eq(creditsTable.clerkId, account.id))
      .limit(1);
    if ((balance?.balance ?? 0) < tool.credits) {
      sendError(res, 402, "You do not have enough credits for this tool.", "INSUFFICIENT_CREDITS");
      return;
    }

    const inputFiles = parsed.data.inputFiles ?? [];
    if (
      ["image-to-image", "image-to-video"].includes(tool.id) &&
      inputFiles.length !== 1
    ) {
      sendError(res, 400, "Choose exactly one input image.", "INVALID_INPUT_FILE");
      return;
    }
    if (inputFiles.length > 0 && !tool.acceptsUpload) {
      sendError(res, 400, "This tool does not accept uploaded media.", "UPLOAD_NOT_SUPPORTED");
      return;
    }
    const inputMetadata: Array<{
      path: string;
      name: string;
      contentType: string;
      size: number;
    }> = [];
    const prefix = `/objects/uploads/${account.id}/`;
    try {
      const { ObjectStorageService } = await import("../lib/objectStorage");
      const objectStorage = new ObjectStorageService();
      for (const path of inputFiles) {
        if (!path.startsWith(prefix) || path.split("/").includes("..")) {
          sendError(res, 400, "One of the selected files is not accessible.", "INVALID_INPUT_FILE");
          return;
        }
        const file = await objectStorage.getObjectEntityFile(path);
        const [metadata] = await file.getMetadata();
        const size = Number(metadata.size ?? 0);
        const contentType = String(metadata.contentType ?? "");
        if (
          ["image-to-image", "image-to-video"].includes(tool.id) &&
          !contentType.startsWith("image/")
        ) {
          sendError(res, 400, "This tool requires an image, not a video.", "INVALID_INPUT_FILE");
          return;
        }
        if (size <= 0 || size > 50 * 1024 * 1024) {
          sendError(res, 400, "One of the selected files exceeds the 50 MB limit.", "INVALID_INPUT_FILE");
          return;
        }
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
          sendError(res, 400, "One of the selected files has an unsupported type.", "INVALID_INPUT_FILE");
          return;
        }
        inputMetadata.push({
          path,
          name: path.split("/").at(-1) ?? "uploaded-file",
          contentType,
          size,
        });
      }

      const providerResult = await submitAiJob({
        providerId: tool.providerId,
        model: tool.model,
        ownerId: account.id,
        prompt: parsed.data.prompt,
        category: tool.category,
        inputFiles,
        inputContentTypes: inputMetadata.map((file) => file.contentType),
        settings: parsed.data.settings ?? {},
      });
      if (!providerResult.providerJobId || providerResult.status === "failed") {
        sendError(res, 503, "The AI provider could not start this generation.", "PROVIDER_REJECTED");
        return;
      }

      const outputFiles =
        providerResult.status === "completed"
          ? await storeProviderOutputs({
              providerId: tool.providerId,
              ownerId: account.id,
              urls: providerResult.outputUrls,
            })
          : [];
      if (providerResult.status === "completed" && outputFiles.length === 0) {
        sendError(res, 503, "The provider returned no valid output files.", "PROVIDER_OUTPUT_INVALID");
        return;
      }

      const generationId = randomUUID();
      const status =
        providerResult.status === "completed" ? "completed" : "processing";
      const result = await db.transaction(async (tx) => {
        const charged = await tx
          .update(creditsTable)
          .set({ balance: sql`${creditsTable.balance} - ${tool.credits}` })
          .where(
            and(
              eq(creditsTable.clerkId, account.id),
              gte(creditsTable.balance, tool.credits),
            ),
          )
          .returning({ balance: creditsTable.balance });
        if (charged.length === 0) return null;

        const [generation] = await tx
          .insert(generationsTable)
          .values({
            id: generationId,
            clerkId: account.id,
            toolId: tool.id,
            category: tool.category,
            prompt: parsed.data.prompt,
            settings: parsed.data.settings ?? {},
            status,
            providerId: tool.providerId,
            model: tool.model,
            providerJobId: providerResult.providerJobId,
            creditsUsed: tool.credits,
          })
          .returning();
        await tx.insert(creditTransactionsTable).values({
          clerkId: account.id,
          amount: -tool.credits,
          reason: "generation",
          reference: `generation:${generationId}`,
        });
        const files = [
          ...inputMetadata.map((file) => ({
            generationId,
            clerkId: account.id,
            path: file.path,
            name: file.name,
            contentType: file.contentType,
            size: file.size,
            role: "input" as const,
          })),
          ...outputFiles.map((file) => ({
            generationId,
            clerkId: account.id,
            path: file.path,
            name: file.path.split("/").at(-1) ?? "generated-file",
            contentType: file.contentType,
            size: file.size,
            role: "output" as const,
          })),
        ];
        if (files.length > 0) await tx.insert(generationFilesTable).values(files);
        await tx.insert(usageLogsTable).values({
          clerkId: account.id,
          toolId: tool.id,
          event: "generation_submitted",
          credits: tool.credits,
        });
        return generation;
      });
      if (!result) {
        sendError(res, 402, "You do not have enough credits for this tool.", "INSUFFICIENT_CREDITS");
        return;
      }
      const [created] = await getGenerationRows(account.id, false).then((rows) =>
        rows.filter((row) => row.id === generationId),
      );
      res.status(202).json(CreateGenerationResponse.parse(created));
    } catch (error) {
      if (error instanceof Error && error.name === "AiProviderError") {
        sendError(res, 503, error.message, "PROVIDER_ERROR");
        return;
      }
      throw error;
    }
  }),
);

router.patch(
  "/generations/:generationId/favorite",
  asyncRoute(async (req, res) => {
    const account = await ensureAccount(req, res);
    if (!account) return;
    const params = SetGenerationFavoriteParams.safeParse(req.params);
    const body = SetGenerationFavoriteBody.safeParse(req.body);
    if (!params.success || !body.success) {
      sendError(res, 400, "Invalid favorite update.", "INVALID_FAVORITE");
      return;
    }
    const updated = await db
      .update(generationsTable)
      .set({ favorite: body.data.favorite, updatedAt: new Date() })
      .where(
        and(
          eq(generationsTable.id, params.data.generationId),
          eq(generationsTable.clerkId, account.id),
        ),
      )
      .returning({ id: generationsTable.id });
    if (updated.length === 0) {
      sendError(res, 404, "Generation not found.", "NOT_FOUND");
      return;
    }
    const [generation] = await getGenerationRows(account.id, false).then((rows) =>
      rows.filter((row) => row.id === params.data.generationId),
    );
    res.json(SetGenerationFavoriteResponse.parse(generation));
  }),
);

router.delete(
  "/generations/:generationId",
  asyncRoute(async (req, res) => {
    const account = await ensureAccount(req, res);
    if (!account) return;
    const params = DeleteGenerationParams.safeParse(req.params);
    if (!params.success) {
      sendError(res, 400, "Invalid generation ID.", "INVALID_GENERATION");
      return;
    }
    const deleted = await db
      .delete(generationsTable)
      .where(
        and(
          eq(generationsTable.id, params.data.generationId),
          eq(generationsTable.clerkId, account.id),
        ),
      )
      .returning({ id: generationsTable.id });
    if (deleted.length === 0) {
      sendError(res, 404, "Generation not found.", "NOT_FOUND");
      return;
    }
    res.status(204).json(DeleteGenerationResponse.parse(undefined));
  }),
);

router.get(
  "/admin/overview",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const [[users], [paid], [generations], [failed], [credits]] = await Promise.all([
      db.select({ total: count() }).from(usersTable),
      db
        .select({ total: count() })
        .from(subscriptionsTable)
        .where(and(eq(subscriptionsTable.status, "active"), ne(subscriptionsTable.planId, "free"))),
      db.select({ total: count() }).from(generationsTable),
      db
        .select({ total: count() })
        .from(generationsTable)
        .where(eq(generationsTable.status, "failed")),
      db
        .select({ total: sql<number>`coalesce(sum(${generationsTable.creditsUsed}), 0)` })
        .from(generationsTable)
        .where(eq(generationsTable.status, "completed")),
    ]);
    res.json(
      GetAdminOverviewResponse.parse({
        totalUsers: users?.total ?? 0,
        premiumUsers: paid?.total ?? 0,
        totalGenerations: generations?.total ?? 0,
        failedGenerations: failed?.total ?? 0,
        creditsUsed: Number(credits?.total ?? 0),
      }),
    );
  }),
);

router.get(
  "/admin/tools",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const rows = await db.select().from(aiToolsTable).orderBy(aiToolsTable.category, aiToolsTable.name);
    res.json(GetAdminToolsResponse.parse(await Promise.all(rows.map(mapTool))));
  }),
);

router.patch(
  "/admin/tools/:toolId",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const params = UpdateAdminToolParams.safeParse(req.params);
    const body = UpdateAdminToolBody.safeParse(req.body);
    if (!params.success || !body.success || Object.keys(body.data).length === 0) {
      sendError(res, 400, "Invalid tool update.", "INVALID_TOOL");
      return;
    }
    const update: Partial<typeof aiToolsTable.$inferInsert> = {};
    if (body.data.credits !== undefined) update.credits = body.data.credits;
    if (body.data.enabled !== undefined) update.enabled = body.data.enabled;
    if (body.data.model !== undefined) update.model = body.data.model || null;
    if (body.data.provider !== undefined) {
      if (body.data.provider !== "unconfigured") {
        const [provider] = await db
          .select({ id: aiProvidersTable.id })
          .from(aiProvidersTable)
          .where(eq(aiProvidersTable.id, body.data.provider))
          .limit(1);
        if (!provider) {
          sendError(res, 400, "Choose a configured provider.", "INVALID_PROVIDER");
          return;
        }
        update.providerId = provider.id;
      } else {
        update.providerId = null;
      }
    }
    const [tool] = await db
      .update(aiToolsTable)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(aiToolsTable.id, params.data.toolId))
      .returning();
    if (!tool) {
      sendError(res, 404, "Tool not found.", "NOT_FOUND");
      return;
    }
    res.json(UpdateAdminToolResponse.parse(await mapTool(tool)));
  }),
);

router.get(
  "/admin/plans",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const rows = await db.select().from(plansTable).orderBy(plansTable.monthlyPrice);
    res.json(GetAdminPlansResponse.parse(rows.map(mapPlan)));
  }),
);

router.post(
  "/admin/plans",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const body = CreateAdminPlanBody.safeParse(req.body);
    if (!body.success) {
      sendError(res, 400, "Invalid plan details.", "INVALID_PLAN");
      return;
    }
    const idBase = body.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32);
    const [plan] = await db
      .insert(plansTable)
      .values({
        id: `${idBase || "plan"}-${randomUUID().slice(0, 8)}`,
        name: body.data.name,
        description: body.data.description,
        monthlyPrice: String(body.data.monthlyPrice),
        yearlyPrice: String(body.data.yearlyPrice),
        currency: body.data.currency ?? "INR",
        credits: body.data.credits,
        features: body.data.features ?? [],
        active: body.data.active ?? false,
        popular: body.data.popular ?? false,
      })
      .returning();
    res.status(201).json(CreateAdminPlanResponse.parse(mapPlan(plan)));
  }),
);

router.patch(
  "/admin/plans/:planId",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const params = UpdateAdminPlanParams.safeParse(req.params);
    const body = UpdateAdminPlanBody.safeParse(req.body);
    if (!params.success || !body.success) {
      sendError(res, 400, "Invalid plan update.", "INVALID_PLAN");
      return;
    }
    const [plan] = await db
      .update(plansTable)
      .set({
        ...body.data,
        monthlyPrice:
          body.data.monthlyPrice === undefined
            ? undefined
            : String(body.data.monthlyPrice),
        yearlyPrice:
          body.data.yearlyPrice === undefined
            ? undefined
            : String(body.data.yearlyPrice),
        updatedAt: new Date(),
      })
      .where(eq(plansTable.id, params.data.planId))
      .returning();
    if (!plan) {
      sendError(res, 404, "Plan not found.", "NOT_FOUND");
      return;
    }
    res.json(UpdateAdminPlanResponse.parse(mapPlan(plan)));
  }),
);

router.delete(
  "/admin/plans/:planId",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const params = DeleteAdminPlanParams.safeParse(req.params);
    if (!params.success) {
      sendError(res, 400, "Invalid plan ID.", "INVALID_PLAN");
      return;
    }
    if (params.data.planId === "free") {
      sendError(res, 409, "The free plan cannot be removed.", "PLAN_IN_USE");
      return;
    }
    const [inUse] = await db
      .select({ total: count() })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.planId, params.data.planId));
    if ((inUse?.total ?? 0) > 0) {
      sendError(res, 409, "A plan with account subscriptions cannot be removed.", "PLAN_IN_USE");
      return;
    }
    const deleted = await db
      .delete(plansTable)
      .where(eq(plansTable.id, params.data.planId))
      .returning({ id: plansTable.id });
    if (deleted.length === 0) {
      sendError(res, 404, "Plan not found.", "NOT_FOUND");
      return;
    }
    res.status(204).json(DeleteAdminPlanResponse.parse(undefined));
  }),
);

router.get(
  "/admin/providers",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const rows = await db
      .select()
      .from(aiProvidersTable)
      .orderBy(aiProvidersTable.priority, aiProvidersTable.name);
    res.json(
      GetAdminProvidersResponse.parse(
        rows.map((provider) => ({
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled,
          configured: isProviderKeyConfigured(provider.id),
          priority: provider.priority,
          models: provider.models ?? [],
        })),
      ),
    );
  }),
);

router.patch(
  "/admin/providers/:providerId",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const params = UpdateAdminProviderParams.safeParse(req.params);
    const body = UpdateAdminProviderBody.safeParse(req.body);
    if (!params.success || !body.success || Object.keys(body.data).length === 0) {
      sendError(res, 400, "Invalid provider update.", "INVALID_PROVIDER");
      return;
    }
    const [provider] = await db
      .update(aiProvidersTable)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(aiProvidersTable.id, params.data.providerId))
      .returning();
    if (!provider) {
      sendError(res, 404, "Provider not found.", "NOT_FOUND");
      return;
    }
    res.json(
      UpdateAdminProviderResponse.parse({
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled,
        configured: isProviderKeyConfigured(provider.id),
        priority: provider.priority,
        models: provider.models ?? [],
      }),
    );
  }),
);

router.get(
  "/admin/users",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const parsed = GetAdminUsersQueryParams.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, "Invalid user search.", "INVALID_SEARCH");
      return;
    }
    const search = (parsed.data.search ?? "").trim().slice(0, 100);
    const users = await db
      .select({ id: usersTable.clerkId })
      .from(usersTable)
      .where(
        search
          ? or(
              ilike(usersTable.email, `%${search}%`),
              ilike(usersTable.clerkId, `%${search}%`),
            )
          : undefined,
      )
      .orderBy(desc(usersTable.createdAt))
      .limit(100);
    const rows = await Promise.all(users.map((user) => getAdminUser(user.id)));
    res.json(GetAdminUsersResponse.parse(rows.filter(Boolean)));
  }),
);

router.patch(
  "/admin/users/:userId",
  asyncRoute(async (req, res) => {
    const admin = await ensureAdmin(req, res);
    if (!admin) return;
    const params = UpdateAdminUserParams.safeParse(req.params);
    const body = UpdateAdminUserBody.safeParse(req.body);
    if (!params.success || !body.success || Object.keys(body.data).length === 0) {
      sendError(res, 400, "Invalid account update.", "INVALID_ACCOUNT");
      return;
    }
    const [target] = await db
      .select({ id: usersTable.clerkId })
      .from(usersTable)
      .where(eq(usersTable.clerkId, params.data.userId))
      .limit(1);
    if (!target) {
      sendError(res, 404, "Account not found.", "NOT_FOUND");
      return;
    }

    await db.transaction(async (tx) => {
      if (body.data.status !== undefined) {
        await tx
          .update(usersTable)
          .set({ status: body.data.status, updatedAt: new Date() })
          .where(eq(usersTable.clerkId, target.id));
      }
      if (body.data.planId !== undefined) {
        const [plan] = await tx
          .select({ id: plansTable.id })
          .from(plansTable)
          .where(eq(plansTable.id, body.data.planId))
          .limit(1);
        if (!plan) throw new Error("PLAN_NOT_FOUND");
        await tx
          .update(subscriptionsTable)
          .set({ status: "replaced", updatedAt: new Date() })
          .where(
            and(
              eq(subscriptionsTable.clerkId, target.id),
              eq(subscriptionsTable.status, "active"),
            ),
          );
        await tx.insert(subscriptionsTable).values({
          clerkId: target.id,
          planId: plan.id,
          status: "active",
        });
      }
      if (body.data.creditAdjustment !== undefined && body.data.creditAdjustment !== 0) {
        const adjustment = body.data.creditAdjustment;
        const [credits] = await tx
          .update(creditsTable)
          .set({ balance: sql`${creditsTable.balance} + ${adjustment}` })
          .where(
            adjustment < 0
              ? and(
                  eq(creditsTable.clerkId, target.id),
                  gte(creditsTable.balance, Math.abs(adjustment)),
                )
              : eq(creditsTable.clerkId, target.id),
          )
          .returning({ balance: creditsTable.balance });
        if (!credits) throw new Error("INSUFFICIENT_CREDITS");
        await tx.insert(creditTransactionsTable).values({
          clerkId: target.id,
          amount: adjustment,
          reason: "admin_adjustment",
          reference: `admin-adjustment:${randomUUID()}`,
        });
      }
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "INSUFFICIENT_CREDITS") {
        sendError(res, 409, "Credit adjustment would make the balance negative.", "INSUFFICIENT_CREDITS");
        return;
      }
      if (error instanceof Error && error.message === "PLAN_NOT_FOUND") {
        sendError(res, 400, "Plan not found.", "INVALID_PLAN");
        return;
      }
      throw error;
    });
    if (res.headersSent) return;
    const user = await getAdminUser(target.id);
    if (!user) {
      sendError(res, 404, "Account not found.", "NOT_FOUND");
      return;
    }
    res.json(UpdateAdminUserResponse.parse(user));
  }),
);

router.patch(
  "/admin/settings",
  asyncRoute(async (req, res) => {
    if (!(await ensureAdmin(req, res))) return;
    const body = UpdateAdminSettingsBody.safeParse(req.body);
    if (!body.success || Object.keys(body.data).length === 0) {
      sendError(res, 400, "Invalid site settings.", "INVALID_SETTINGS");
      return;
    }
    const [settings] = await db
      .insert(siteSettingsTable)
      .values({ id: 1, ...body.data })
      .onConflictDoUpdate({
        target: siteSettingsTable.id,
        set: { ...body.data, updatedAt: new Date() },
      })
      .returning();
    res.json(UpdateAdminSettingsResponse.parse(settings));
  }),
);

router.get(
  "/healthz",
  asyncRoute(async (_req, res) => {
    res.json({ status: "ok" });
  }),
);

export default router;
