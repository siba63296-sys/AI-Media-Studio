import { db, pool } from "./index";
import { aiProvidersTable, aiToolsTable, plansTable } from "./schema";

const providers = [
  { id: "replicate", name: "Replicate", models: [] },
  { id: "fal", name: "fal.ai", models: [] },
  { id: "runway", name: "Runway", models: [] },
];

const photoTools = [
  ["text-to-image", "Text to image", "Describe an image and create it from a text prompt.", 5, "replicate", false],
  ["image-to-image", "Image to image", "Transform an uploaded image with a written direction.", 3, "replicate", true],
  ["background-remove", "Background remove", "Isolate a subject and remove its background.", 2, "fal", true],
  ["background-replace", "Background replace", "Replace the scene behind an uploaded subject.", 3, "fal", true],
  ["object-remove", "Object remove", "Remove an unwanted object from an image.", 3, "replicate", true],
  ["ai-enhance", "AI enhance", "Improve clarity, detail, and visual balance.", 3, "replicate", true],
  ["image-upscale", "Image upscale", "Increase image resolution while preserving detail.", 5, "replicate", true],
  ["product-photo", "Product photo", "Create polished product imagery for a storefront.", 5, "replicate", true],
  ["ai-portrait", "AI portrait", "Create or refine a professional portrait.", 5, "replicate", true],
  ["ai-style", "AI style", "Restyle an image using a written creative direction.", 3, "replicate", true],
  ["image-resize", "Image resize", "Resize an image for common placements.", 1, "replicate", true],
  ["image-compress", "Image compress", "Reduce an image file size while preserving quality.", 1, "replicate", true],
] as const;

const videoTools = [
  ["text-to-video", "Text to video", "Generate a short video from a written direction.", 25, "runway", false],
  ["image-to-video", "Image to video", "Animate an uploaded still image.", 20, "runway", true],
  ["video-to-video", "Video to video", "Transform the look of an uploaded clip.", 15, "runway", true],
  ["product-ad", "Product advertisement", "Create a short product-focused video.", 20, "runway", true],
  ["social-video", "Social media video", "Prepare a clip for a social placement.", 15, "runway", true],
  ["video-enhance", "Video enhancement", "Improve the appearance of an uploaded clip.", 15, "runway", true],
  ["video-resize", "Video resize", "Adapt a clip for a supported aspect ratio.", 5, "runway", true],
  ["video-compress", "Video compress", "Reduce a video file size for faster sharing.", 5, "runway", true],
] as const;

const tools = [
  ...photoTools.map(([id, name, description, credits, providerId, acceptsUpload]) => ({
    id,
    name,
    description,
    credits,
    providerId,
    acceptsUpload,
    category: "photo" as const,
  })),
  ...videoTools.map(([id, name, description, credits, providerId, acceptsUpload]) => ({
    id,
    name,
    description,
    credits,
    providerId,
    acceptsUpload,
    category: "video" as const,
  })),
];

async function seed(): Promise<void> {
  await db.insert(aiProvidersTable).values(providers).onConflictDoNothing();
  await db.insert(aiToolsTable).values(tools).onConflictDoNothing();
  await db
    .insert(plansTable)
    .values([
      {
        id: "free",
        name: "Free",
        description: "A starting point for trying the studio.",
        monthlyPrice: "0",
        yearlyPrice: "0",
        credits: 0,
        features: ["Standard tools", "Personal creation history"],
        active: true,
        popular: false,
      },
      {
        id: "pro",
        name: "Pro",
        description: "A flexible plan for regular creative work.",
        monthlyPrice: "0",
        yearlyPrice: "0",
        credits: 0,
        features: ["Higher generation limits", "Premium models", "Priority processing"],
        active: false,
        popular: true,
      },
      {
        id: "premium",
        name: "Premium",
        description: "For high-volume photo and video production.",
        monthlyPrice: "0",
        yearlyPrice: "0",
        credits: 0,
        features: ["Higher generation limits", "Premium models", "Priority processing"],
        active: false,
        popular: false,
      },
    ])
    .onConflictDoNothing();
}

try {
  await seed();
} finally {
  await pool.end();
}
