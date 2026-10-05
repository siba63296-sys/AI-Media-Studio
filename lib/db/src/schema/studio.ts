import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable(
  "users",
  {
    clerkId: text("clerk_id").primaryKey(),
    email: text("email"),
    role: text("role").$type<"user" | "admin">().notNull().default("user"),
    status: text("status")
      .$type<"active" | "suspended">()
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("users_email_idx").on(table.email)],
);

export const profilesTable = pgTable("profiles", {
  clerkId: text("clerk_id")
    .primaryKey()
    .references(() => usersTable.clerkId, { onDelete: "cascade" }),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const plansTable = pgTable(
  "plans",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    monthlyPrice: numeric("monthly_price", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    yearlyPrice: numeric("yearly_price", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    currency: text("currency").notNull().default("INR"),
    credits: integer("credits").notNull().default(0),
    features: jsonb("features").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    popular: boolean("popular").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("plans_active_idx").on(table.active)],
);

export const subscriptionsTable = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkId: text("clerk_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => plansTable.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"),
    billingCycle: text("billing_cycle").$type<"monthly" | "yearly">(),
    provider: text("provider"),
    providerSubscriptionId: text("provider_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("subscriptions_user_status_idx").on(table.clerkId, table.status),
    index("subscriptions_plan_idx").on(table.planId),
  ],
);

export const creditsTable = pgTable("credits", {
  clerkId: text("clerk_id")
    .primaryKey()
    .references(() => usersTable.clerkId, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const aiProvidersTable = pgTable(
  "ai_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull().default(100),
    models: jsonb("models").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("ai_providers_enabled_priority_idx").on(table.enabled, table.priority)],
);

export const aiToolsTable = pgTable(
  "ai_tools",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").$type<"photo" | "video">().notNull(),
    description: text("description").notNull().default(""),
    credits: integer("credits").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    providerId: text("provider_id").references(() => aiProvidersTable.id, {
      onDelete: "set null",
    }),
    model: text("model"),
    acceptsUpload: boolean("accepts_upload").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("ai_tools_category_enabled_idx").on(table.category, table.enabled),
    index("ai_tools_provider_idx").on(table.providerId),
  ],
);

export const generationsTable = pgTable(
  "generations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkId: text("clerk_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => aiToolsTable.id, { onDelete: "restrict" }),
    category: text("category").$type<"photo" | "video">().notNull(),
    prompt: text("prompt").notNull().default(""),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status")
      .$type<"pending" | "processing" | "completed" | "failed">()
      .notNull()
      .default("pending"),
    providerId: text("provider_id"),
    model: text("model"),
    providerJobId: text("provider_job_id"),
    creditsUsed: integer("credits_used").notNull().default(0),
    favorite: boolean("favorite").notNull().default(false),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("generations_user_created_idx").on(table.clerkId, table.createdAt),
    index("generations_user_favorite_idx").on(table.clerkId, table.favorite),
    index("generations_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const generationFilesTable = pgTable(
  "generation_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    generationId: uuid("generation_id").references(() => generationsTable.id, {
      onDelete: "cascade",
    }),
    clerkId: text("clerk_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "cascade" }),
    path: text("path").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    role: text("role").$type<"input" | "output">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("generation_files_path_user_uq").on(table.path, table.clerkId),
    index("generation_files_generation_role_idx").on(
      table.generationId,
      table.role,
    ),
    index("generation_files_user_idx").on(table.clerkId),
  ],
);

export const creditTransactionsTable = pgTable(
  "credit_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkId: text("clerk_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    reference: text("reference"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("credit_transactions_user_created_idx").on(
      table.clerkId,
      table.createdAt,
    ),
    uniqueIndex("credit_transactions_reference_uq").on(table.reference),
  ],
);

export const paymentsTable = pgTable(
  "payments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkId: text("clerk_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id"),
    planId: text("plan_id").references(() => plansTable.id, {
      onDelete: "set null",
    }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("payments_user_created_idx").on(table.clerkId, table.createdAt),
    uniqueIndex("payments_provider_payment_uq").on(
      table.provider,
      table.providerPaymentId,
    ),
  ],
);

export const couponsTable = pgTable(
  "coupons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    discountType: text("discount_type")
      .$type<"percentage" | "fixed">()
      .notNull(),
    discountValue: numeric("discount_value", { precision: 10, scale: 2 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    usageLimit: integer("usage_limit"),
    perUserLimit: integer("per_user_limit").notNull().default(1),
    minimumPurchase: numeric("minimum_purchase", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),
    planIds: jsonb("plan_ids").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("coupons_enabled_expiry_idx").on(table.enabled, table.expiresAt)],
);

export const couponUsageTable = pgTable(
  "coupon_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => couponsTable.id, { onDelete: "cascade" }),
    clerkId: text("clerk_id")
      .notNull()
      .references(() => usersTable.clerkId, { onDelete: "cascade" }),
    paymentId: uuid("payment_id").references(() => paymentsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("coupon_usage_coupon_user_idx").on(table.couponId, table.clerkId),
  ],
);

export const siteSettingsTable = pgTable("site_settings", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull().default("Zevora AI Studio"),
  tagline: text("tagline").notNull().default("Create. Edit. Transform with AI."),
  homepageText: text("homepage_text")
    .notNull()
    .default("Powerful AI photo and video tools in one studio."),
  contactEmail: text("contact_email"),
  logoUrl: text("logo_url"),
  maintenanceMode: boolean("maintenance_mode").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const adminSettingsTable = pgTable("admin_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const usageLogsTable = pgTable(
  "usage_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkId: text("clerk_id").references(() => usersTable.clerkId, {
      onDelete: "set null",
    }),
    toolId: text("tool_id").references(() => aiToolsTable.id, {
      onDelete: "set null",
    }),
    event: text("event").notNull(),
    credits: integer("credits").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("usage_logs_user_created_idx").on(table.clerkId, table.createdAt),
    index("usage_logs_tool_created_idx").on(table.toolId, table.createdAt),
  ],
);

export const webhookEventsTable = pgTable(
  "webhook_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("webhook_events_provider_event_uq").on(
      table.provider,
      table.eventId,
    ),
  ],
);

