import { eq } from "drizzle-orm";
import { db, pool, aiProvidersTable, aiToolsTable } from "@workspace/db";

// Only fill unassigned tools; never overwrite an administrator's model choice.
const assignments = [
  { id: "text-to-image", model: "black-forest-labs/flux-schnell" },
  { id: "image-to-image", model: "black-forest-labs/flux-dev" },
  { id: "image-to-video", model: "wan-video/wan-2.2-i2v-fast" },
];

try {
  await db.transaction(async (tx) => {
    const [provider] = await tx.select().from(aiProvidersTable)
      .where(eq(aiProvidersTable.id, "replicate")).limit(1);
    if (!provider) throw new Error("Replicate provider is missing; the existing seed must be run first.");
    await tx.update(aiProvidersTable).set({
      enabled: true,
      models: [...new Set([...provider.models, ...assignments.map((item) => item.model)])],
      updatedAt: new Date(),
    }).where(eq(aiProvidersTable.id, provider.id));
    for (const assignment of assignments) {
      const [tool] = await tx.select().from(aiToolsTable)
        .where(eq(aiToolsTable.id, assignment.id)).limit(1);
      if (!tool) throw new Error(`Missing tool: ${assignment.id}`);
      if (tool.model?.trim()) continue;
      await tx.update(aiToolsTable).set({
        providerId: provider.id, model: assignment.model, updatedAt: new Date(),
      }).where(eq(aiToolsTable.id, tool.id));
    }
  });
  console.log("Default models configured for unassigned generation tools. REPLICATE_API_TOKEN is required to run them.");
} finally {
  await pool.end();
}
