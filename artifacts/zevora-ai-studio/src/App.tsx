import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  useCreateGeneration, useDeleteGeneration, useGetAdminOverview, useGetAdminPlans,
  useGetAdminProviders, useGetAdminTools, useGetAdminUsers, useGetDashboard,
  useGetGenerations, useGetPlans, useGetSiteConfig, useGetTools, useRequestUploadUrl,
  useSetGenerationFavorite, useUpdateAdminPlan, useUpdateAdminSettings, useUpdateAdminTool,
  useCreateAdminPlan, useDeleteAdminPlan,
  getGetAdminOverviewQueryKey, getGetAdminPlansQueryKey, getGetAdminProvidersQueryKey,
  getGetAdminToolsQueryKey, getGetAdminUsersQueryKey, getGetDashboardQueryKey,
  getGetGenerationsQueryKey, getGetPlansQueryKey, getGetSiteConfigQueryKey, getGetToolsQueryKey,
} from '@workspace/api-client-react';
import type { AiTool, Generation, Plan, PlanInput, SiteConfigInput, UploadUrlRequestContentType } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, AudioLines, BadgeCheck, Check,
  CircleHelp, Clapperboard, Clock3, CloudUpload, CreditCard, Download, FileImage,
  Film, Heart, Image, Layers3, LayoutDashboard, LoaderCircle, LogOut, Menu, Moon,
  Package, Plus, Search, Settings, Shield, SlidersHorizontal, Sparkles, Sun, Trash2, Users,
  WandSparkles, X, Zap,
} from 'lucide-react';
import { Link, Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 20_000 } } });
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
function stripBase(path: string) { return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path; }

const appearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: { logoPlacement: 'inside' as const, logoLinkUrl: basePath || '/', logoImageUrl: `${window.location.origin}${basePath}/logo.svg` },
  variables: {
    colorPrimary: '#cf4937', colorForeground: '#302923', colorMutedForeground: '#756b61',
    colorDanger: '#b42318', colorBackground: '#fbf8f1', colorInput: '#f6f1e8',
    colorInputForeground: '#302923', colorNeutral: '#ded6ca', fontFamily: 'DM Sans',
    borderRadius: '0.85rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fbf8f1] rounded-2xl w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#302923] font-semibold', headerSubtitle: 'text-[#756b61]',
    socialButtonsBlockButtonText: 'text-[#302923]', formFieldLabel: 'text-[#302923]',
    footerActionLink: 'text-[#bd402e]', footerActionText: 'text-[#756b61]', dividerText: 'text-[#756b61]',
    identityPreviewEditButton: 'text-[#bd402e]', formFieldSuccessText: 'text-emerald-700',
    alertText: 'text-[#302923]', logoBox: 'rounded-xl', logoImage: 'rounded-xl',
    socialButtonsBlockButton: 'border-[#ded6ca] bg-[#f6f1e8]',
    formButtonPrimary: 'bg-[#cf4937] hover:bg-[#b83d2d] text-white',
    formFieldInput: 'border-[#ded6ca] bg-[#f6f1e8] text-[#302923]',
    footerAction: 'border-[#ded6ca]', dividerLine: 'bg-[#ded6ca]',
    alert: 'border-[#ded6ca]', otpCodeFieldInput: 'border-[#ded6ca]',
    formFieldRow: 'text-[#302923]', main: 'text-[#302923]',
  },
};

function money(amount: number, currency = 'USD') {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount); }
  catch { return `${currency} ${amount}`; }
}
function dateLabel(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function errorText(error: unknown) {
  const e = error as { message?: string; error?: string; response?: { data?: { error?: string } } } | undefined;
  const message = e?.response?.data?.error || e?.error || e?.message;
  return message?.includes('provider') && message?.includes('not configured')
    ? 'AI provider is not configured. Please contact the administrator.' : message || 'Something went wrong. Please try again.';
}
function QueryState({ loading, error, retry, children, empty, emptyText = 'Nothing here yet.' }: {
  loading: boolean; error?: unknown; retry: () => void; children: ReactNode; empty?: boolean; emptyText?: string;
}) {
  if (loading) return <div className="space-y-3" aria-label="Loading"><div className="skeleton h-24 rounded-2xl" /><div className="skeleton h-40 rounded-2xl" /></div>;
  if (error) return <div className="rounded-2xl border border-border bg-card p-8 text-center"><p className="mb-4 text-sm text-muted-foreground">{errorText(error)}</p><button className="btn-secondary" onClick={retry} data-testid="button-retry">Try again</button></div>;
  if (empty) return <div className="empty-state"><div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground"><Layers3 size={20} /></div><p>{emptyText}</p></div>;
  return <>{children}</>;
}

function useDarkMode() {
  const [dark, setDark] = useState(() => localStorage.getItem('zevora-theme') === 'dark');
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); localStorage.setItem('zevora-theme', dark ? 'dark' : 'light'); }, [dark]);
  return [dark, () => setDark(v => !v)] as const;
}
function ModeButton({ dark, toggle }: { dark: boolean; toggle: () => void }) {
  return <button aria-label="Toggle color theme" data-testid="button-theme" onClick={toggle} className="icon-button">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>;
}
function Brand({ light = false }: { light?: boolean }) {
  return <Link href="/" className={`brand ${light ? 'text-foreground' : ''}`} data-testid="link-brand"><span className="brand-mark"><span /></span><span>zevora<span className="brand-ai">AI</span></span></Link>;
}

function MarketingHome({ dark, toggle }: { dark: boolean; toggle: () => void }) {
  const { user, isLoaded, isSignedIn } = useUser();
  const { data: config, isLoading, isError, error, refetch } = useGetSiteConfig();
  const { data: plans = [], isLoading: plansLoading, isError: plansError, error: plansErr, refetch: refetchPlans } = useGetPlans();
  const { data: tools = [], isLoading: toolsLoading, isError: toolsError, error: toolsErr, refetch: refetchTools } = useGetTools();
  if (isLoaded && isSignedIn) return <Redirect to="/studio" />;
  return <main className="public-page">
    <header className="public-nav wrap">
      <Brand />
      <nav className="hidden md:flex items-center gap-8"><a href="#workflow">How it works</a><a href="#tools">Studio tools</a><Link href="/pricing">Pricing</Link></nav>
      <div className="flex items-center gap-2"><ModeButton dark={dark} toggle={toggle} /><Link href="/sign-in" className="nav-signin">Sign in</Link><Link href="/sign-up" className="button button-primary nav-cta">Start creating <ArrowRight size={15} /></Link></div>
    </header>
    {config?.maintenanceMode && <div className="maintenance-banner">The studio is temporarily under maintenance. Check back shortly.</div>}
    <section className="hero wrap">
      <div className="hero-copy reveal">
        <div className="eyebrow"><span className="eyebrow-dot" /> A studio for the work you already have</div>
        <h1>{config?.tagline || 'Make the good stuff.'}<br /><em>Even better.</em></h1>
        <p>{config?.homepageText || 'Your camera roll is full of almost-there. Turn the photos and footage you already love into polished, ready-to-share work — without the tool maze.'}</p>
        <div className="flex flex-wrap gap-3 mt-8"><Link href="/sign-up" className="button button-primary button-large">Open your studio <ArrowRight size={17} /></Link><a href="#workflow" className="button button-quiet button-large">See how it works <ArrowDown size={15} /></a></div>
        <div className="hero-proof"><div className="proof-rule" /><span>For independent makers, small teams, and the one-person creative department.</span></div>
      </div>
      <div className="hero-art" aria-label="Stylized editorial media workspace">
        <div className="art-ink-shape" />
        <div className="art-sun" />
        <div className="art-window art-window-back"><div className="art-window-label">ORIGINAL / 01</div><div className="art-photo photo-one" /></div>
        <div className="art-window art-window-front"><div className="art-window-top"><span>AFTER / 01</span><span>4:5</span></div><div className="art-photo photo-two"><span className="art-sparkle">✳</span><span className="art-image-caption">soft light<br />study no. 04</span></div></div>
        <div className="art-stamp">ZEVORA<br /><b>STUDIO</b><br />NO. 001</div>
        <div className="art-floating"><Sparkles size={14} /><span>One clear workflow.<br /><b>Your creative voice.</b></span></div>
        <div className="art-caption">SOURCE MATERIAL <span>→</span> FINISHED ASSET</div>
      </div>
    </section>
    <div className="ticker"><div className="ticker-track"><span>PHOTO FINISHING</span><i>✳</i><span>VIDEO REWORK</span><i>✳</i><span>YOUR ASSETS, REIMAGINED</span><i>✳</i><span>PHOTO FINISHING</span><i>✳</i><span>VIDEO REWORK</span><i>✳</i><span>YOUR ASSETS, REIMAGINED</span><i>✳</i></div></div>
    <section id="workflow" className="workflow-section wrap">
      <div className="section-kicker">01 / THE FLOW</div><div className="section-heading-row"><h2>Less tool-hopping.<br /><em>More making.</em></h2><p>Everything you need to go from raw material to a piece you’re proud to put your name on.</p></div>
      <div className="workflow-strip"><div className="workflow-step"><span className="step-no">01</span><CloudUpload /><h3>Bring what you have</h3><p>Start with your own photo or video. Your creative direction stays yours.</p></div><div className="step-connector"><ArrowRight /></div><div className="workflow-step"><span className="step-no">02</span><WandSparkles /><h3>Choose a focused tool</h3><p>Each tool does one useful thing, with the right controls already in reach.</p></div><div className="step-connector"><ArrowRight /></div><div className="workflow-step"><span className="step-no">03</span><Download /><h3>Keep the finished work</h3><p>Your generations live in one tidy library. Save favorites and come back anytime.</p></div></div>
    </section>
    <section id="tools" className="tools-section">
      <div className="wrap"><div className="section-kicker">02 / THE TOOLBOX</div><div className="section-heading-row"><h2>Small tools.<br /><em>Real momentum.</em></h2><p>No sprawling control panel. Just a considered set of photo and video tools for the last mile of your creative process.</p></div>
        <QueryState loading={toolsLoading} error={toolsError ? toolsErr : undefined} retry={() => void refetchTools()} empty={!toolsLoading && !toolsError && tools.length === 0} emptyText="Studio tools will appear here when they’re ready.">
          <div className="tool-mosaic">{tools.slice(0, 6).map((tool, i) => <ToolShowcaseCard key={tool.id} tool={tool} index={i} />)}</div>
        </QueryState>
        <div className="text-center mt-9"><Link href="/sign-up" className="button button-outline">Explore your studio <ArrowRight size={15} /></Link></div>
      </div>
    </section>
    <section className="manifesto wrap"><div className="manifesto-orbit"><div className="orbit-core"><span>Z</span></div><div className="orbit-dot" /><div className="orbit-ring" /></div><div className="manifesto-copy"><div className="section-kicker">A BETTER KIND OF AI TOOL</div><h2>Your taste is the<br /><em>point.</em></h2><p>AI can help with the heavy lifting. It shouldn’t flatten what makes your work yours. Zevora gives your existing media room to go further — you stay in the director’s chair.</p><Link href="/sign-up" className="text-link">Make something yours <ArrowRight size={16} /></Link></div></section>
    <section id="pricing" className="pricing-section"><div className="wrap"><div className="section-kicker">03 / SIMPLE PRICING</div><div className="section-heading-row"><h2>Room to make.<br /><em>Room to grow.</em></h2><p>Pick a plan that fits your pace. No surprise upgrades in the middle of a project.</p></div>
      <QueryState loading={plansLoading} error={plansError ? plansErr : undefined} retry={() => void refetchPlans()} empty={!plansLoading && !plansError && plans.length === 0} emptyText="Plans will be available here soon.">
        <div className="plans-grid">{plans.filter(p => p.active).map(plan => <PlanCard key={plan.id} plan={plan} />)}</div>
      </QueryState>
    </div></section>
    <footer className="public-footer wrap"><Brand /><p>Make room for the work that matters.</p><div className="flex gap-5"><a href="#workflow">How it works</a><a href="#pricing">Pricing</a>{config?.contactEmail && <a href={`mailto:${config.contactEmail}`}>Contact</a>}</div><small>© {new Date().getFullYear()} {config?.name || 'Zevora AI Studio'}</small></footer>
  </main>;
}
function ToolShowcaseCard({ tool, index }: { tool: AiTool; index: number }) {
  const pict = tool.category === 'video' ? <Clapperboard /> : <FileImage />;
  const textures = ['tile-terracotta', 'tile-sage', 'tile-sand', 'tile-indigo', 'tile-clay', 'tile-pine'];
  return <Link href={`/tools/${encodeURIComponent(tool.id)}`} className={`showcase-tool ${textures[index % textures.length]}`} data-testid={`card-public-tool-${tool.id}`}><div className="showcase-icon">{pict}</div><div className="showcase-meta">{tool.category} / {tool.credits} credits</div><h3>{tool.name}</h3><p>{tool.description}</p><span className="showcase-arrow"><ArrowUpRight size={18} /></span></Link>;
}
function PlanCard({ plan, compact = false }: { plan: Plan; compact?: boolean }) {
  return <article className={`plan-card ${plan.popular ? 'plan-popular' : ''} ${compact ? 'plan-compact' : ''}`}>
    {plan.popular && <span className="popular-label">MOST POPULAR</span>}
    <div className="plan-card-top"><div><h3>{plan.name}</h3><p>{plan.description}</p></div><span className="plan-symbol"><Zap size={17} /></span></div>
    <div className="plan-price">{money(plan.monthlyPrice, plan.currency || 'USD')}<small> / month</small></div>
    <div className="plan-credits">{plan.credits} credits each month</div>
    <ul>{plan.features.map((feature, i) => <li key={`${plan.id}-${i}`}><Check size={15} />{feature}</li>)}</ul>
    <Link href="/sign-up" className={plan.popular ? 'button button-primary w-full' : 'button button-outline w-full'}>Choose {plan.name} <ArrowRight size={15} /></Link>
  </article>;
}

function ClerkCacheReset() {
  const { addListener } = useClerk(); const qc = useQueryClient();
  useEffect(() => { let prev: string | null | undefined; const unsub = addListener(({ user }) => { const id = user?.id ?? null; if (prev !== undefined && prev !== id) qc.clear(); prev = id; }); return unsub; }, [addListener, qc]);
  return null;
}
function HomeRedirect() { const { isLoaded } = useUser(); return <>{!isLoaded && <div className="auth-loading"><div className="skeleton h-8 w-40 rounded-lg" /><div className="skeleton mt-5 h-3 w-60 rounded" /></div>}<Show when="signed-in"><Redirect to="/studio" /></Show><Show when="signed-out"><PublicRoute /></Show></>; }
function PublicRoute() { const [dark, toggle] = useDarkMode(); return <MarketingHome dark={dark} toggle={toggle} />; }
function AuthScreen({ kind }: { kind: 'in' | 'up' }) {
  return <div className="auth-page"><div className="auth-art"><Brand /><div><div className="section-kicker">A LITTLE MORE ROOM TO MAKE</div><p>Tools should get out of the way<br />when the good work begins.</p></div><span className="auth-art-mark">Z.</span></div><div className="auth-panel">
    {kind === 'in' ? <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /> : <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />}
    <Link href="/" className="auth-back"><ArrowLeft size={14} /> Back to Zevora</Link>
  </div></div>;
}
function ClerkProviderRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={appearance}
    signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}
    localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Pick up right where your work left off.' } }, signUp: { start: { title: 'Make space for your ideas', subtitle: 'Create your Zevora studio.' } } }}
    routerPush={to => setLocation(stripBase(to))} routerReplace={to => setLocation(stripBase(to), { replace: true })}>
    <ClerkCacheReset />
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/sign-in/*?" component={() => <AuthScreen kind="in" />} />
      <Route path="/sign-up/*?" component={() => <AuthScreen kind="up" />} />
      <Route path="/studio" component={() => <Protected><StudioHome /></Protected>} />
      <Route path="/tools/:toolId" component={() => <Protected><ToolEditor /></Protected>} />
      <Route path="/creations" component={() => <Protected><LibraryPage favorites={false} /></Protected>} />
      <Route path="/favorites" component={() => <Protected><LibraryPage favorites /></Protected>} />
      <Route path="/credits" component={() => <Protected><CreditsPage /></Protected>} />
      <Route path="/pricing" component={() => <PublicPricing />} />
      <Route path="/settings" component={() => <Protected><SettingsPage /></Protected>} />
      <Route path="/admin" component={() => <Protected><AdminPage /></Protected>} />
      <Route component={NotFound} />
    </Switch>
  </ClerkProvider>;
}
function Protected({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  if (!isLoaded) return <div className="auth-loading"><div className="skeleton h-8 w-40 rounded-lg" /><div className="skeleton mt-5 h-3 w-60 rounded" /></div>;
  return isSignedIn ? <>{children}</> : <Redirect to="/" />;
}

const navPrimary = [
  { href: '/studio', label: 'Overview', icon: LayoutDashboard },
  { href: '/creations', label: 'Creations', icon: Layers3 },
  { href: '/favorites', label: 'Favorites', icon: Heart },
];
function WorkspaceShell({ title, eyebrow, children, actions }: { title: string; eyebrow: string; children: ReactNode; actions?: ReactNode }) {
  const [dark, toggle] = useDarkMode(); const [mobileNav, setMobileNav] = useState(false);
  const { user } = useUser(); const { signOut } = useClerk(); const [path] = useLocation();
  const [query, setQuery] = useState('');
  return <div className="workspace">
    <aside className={`workspace-sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
      <div className="sidebar-head"><Brand /><button className="icon-button md:hidden" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="sidebar-section-label">WORKSPACE</div><nav className="sidebar-nav">{navPrimary.map(item => <Link key={item.href} href={item.href} className={`side-link ${path === item.href ? 'side-link-active' : ''}`} onClick={() => setMobileNav(false)}><item.icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.href === '/favorites' && <span className="side-link-trail" />}</Link>)}</nav>
      <div className="sidebar-section-label mt-8">MAKE SOMETHING</div><Link href="/studio#tools" className="side-link" onClick={() => setMobileNav(false)}><Sparkles size={17} /><span>Discover tools</span><ArrowUpRight size={14} className="ml-auto opacity-50" /></Link>
      <div className="sidebar-bottom"><div className="credit-mini"><div className="flex items-center justify-between"><span>Credits</span><Zap size={14} /></div><div className="credit-mini-number">Your balance</div><Link href="/credits" className="credit-mini-link">View usage <ArrowRight size={13} /></Link></div>
        <Link href="/settings" className={`side-link ${path === '/settings' ? 'side-link-active' : ''}`}><Settings size={17} /><span>Settings</span></Link>
        <Link href="/admin" className={`side-link ${path === '/admin' ? 'side-link-active' : ''}`}><Shield size={17} /><span>Admin workspace</span></Link>
        <div className="sidebar-user"><div className="avatar">{user?.firstName?.[0] || user?.primaryEmailAddress?.emailAddress?.[0]?.toUpperCase() || 'Z'}</div><div className="min-w-0"><strong>{user?.fullName || 'Your account'}</strong><small>{user?.primaryEmailAddress?.emailAddress || ''}</small></div><button className="icon-button ml-auto" aria-label="Sign out" onClick={() => signOut({ redirectUrl: basePath || '/' })}><LogOut size={16} /></button></div>
      </div>
    </aside>
    {mobileNav && <button aria-label="Close menu overlay" className="sidebar-overlay" onClick={() => setMobileNav(false)} />}
    <div className="workspace-main">
      <header className="workspace-topbar"><div className="flex items-center gap-3"><button className="icon-button md:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={18} /></button><div className="breadcrumb"><span>Studio</span><span>/</span><strong>{title}</strong></div></div>
        <div className="flex items-center gap-2"><label className="quick-search"><Search size={15} /><input placeholder="Search your studio" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search studio" data-testid="input-studio-search" /><kbd>⌘ K</kbd></label><ModeButton dark={dark} toggle={toggle} /><Link href="/credits" className="top-credit"><Zap size={14} /> Credits</Link></div></header>
      <main className="workspace-content"><div className="page-heading"><div><div className="section-kicker">{eyebrow}</div><h1>{title}</h1></div>{actions && <div className="page-heading-actions">{actions}</div>}</div>{children}</main>
    </div>
  </div>;
}

function StudioHome() {
  const dash = useGetDashboard(); const toolsQ = useGetTools();
  const tools = toolsQ.data || []; const dashboard = dash.data; const { user } = useUser();
  const [tab, setTab] = useState<'all' | 'photo' | 'video'>('all');
  const visibleTools = tools.filter(t => tab === 'all' || t.category === tab);
  return <WorkspaceShell title="Overview" eyebrow="YOUR CREATIVE DESK">
    <section className="welcome-banner"><div><div className="welcome-overline">A FRESH CANVAS AWAITS</div><h2>Good to see you{user?.firstName ? `, ${user.firstName}` : ''}.</h2><p>Pick up where inspiration left off.</p></div><div className="welcome-orbit"><div className="orbit-sm" /><Sparkles size={28} /></div></section>
    <div className="metrics-row"><QueryState loading={dash.isLoading} error={dash.isError ? dash.error : undefined} retry={() => void dash.refetch()}><div className="metric-tile"><span>AVAILABLE CREDITS</span><strong data-testid="text-credit-balance">{dashboard?.creditBalance ?? '—'}</strong><Link href="/credits">Manage credits <ArrowUpRight size={13} /></Link></div><div className="metric-tile"><span>THIS MONTH</span><strong>{dashboard?.generationsThisMonth ?? '—'}</strong><small>generations created</small></div><div className="metric-tile"><span>YOUR PLAN</span><strong className="metric-plan">{dashboard?.planName || '—'}</strong><Link href="/pricing">View plans <ArrowUpRight size={13} /></Link></div></QueryState></div>
    <section className="studio-tools-block" id="tools"><div className="subsection-heading"><div><div className="section-kicker">THE TOOLBOX</div><h2>Start with a tool</h2></div><div className="segmented">{(['all', 'photo', 'video'] as const).map(item => <button key={item} onClick={() => setTab(item)} className={tab === item ? 'segment-active' : ''}>{item}</button>)}</div></div>
      <QueryState loading={toolsQ.isLoading} error={toolsQ.isError ? toolsQ.error : undefined} retry={() => void toolsQ.refetch()} empty={!toolsQ.isLoading && !toolsQ.isError && visibleTools.length === 0} emptyText={tools.length ? 'No tools match this filter.' : 'Your tools will appear here when they’re enabled.'}>
        <div className="workspace-tool-grid">{visibleTools.map((tool, i) => <WorkspaceToolCard key={tool.id} tool={tool} index={i} />)}</div>
      </QueryState>
    </section>
    <section className="recent-section"><div className="subsection-heading"><div><div className="section-kicker">LATEST WORK</div><h2>Recent creations</h2></div><Link className="text-link" href="/creations">Browse all <ArrowRight size={15} /></Link></div>
      <QueryState loading={dash.isLoading} error={dash.isError ? dash.error : undefined} retry={() => void dash.refetch()} empty={!dash.isLoading && !dash.isError && (dashboard?.recentGenerations?.length || 0) === 0} emptyText="Your first creation is waiting to happen. Pick a tool above to begin.">
        <div className="recent-list">{dashboard?.recentGenerations?.slice(0, 4).map(g => <GenerationRow key={g.id} item={g} />)}</div>
      </QueryState>
    </section>
  </WorkspaceShell>;
}
function WorkspaceToolCard({ tool, index }: { tool: AiTool; index: number }) {
  return <Link href={`/tools/${encodeURIComponent(tool.id)}`} className={`workspace-tool-card workspace-tile-${index % 5}`} data-testid={`card-tool-${tool.id}`}><div className="tool-card-icon">{tool.category === 'video' ? <Clapperboard size={18} /> : <Image size={18} />}</div><div className="tool-card-cost">{tool.credits} CR <ArrowUpRight size={13} /></div><div className="tool-card-bottom"><span>{tool.category}</span><h3>{tool.name}</h3><p>{tool.description}</p></div></Link>;
}

function ToolEditor() {
  const params = useLocation()[0].split('/tools/')[1]?.split('/')[0]; const toolId = decodeURIComponent(params || '');
  const { data: tools = [], isLoading, isError, error, refetch } = useGetTools();
  const tool = tools.find(t => t.id === toolId);
  const [prompt, setPrompt] = useState(''); const [files, setFiles] = useState<File[]>([]); const [objects, setObjects] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false); const [notice, setNotice] = useState('');
  const uploadUrl = useRequestUploadUrl(); const create = useCreateGeneration(); const qc = useQueryClient();
  async function uploadSelected(selection: FileList | null) {
    if (!selection?.length) return;
    setNotice('');
    const accepted = Array.from(selection).slice(0, Math.max(0, 5 - files.length));
    setUploading(true);
    try {
      const paths: string[] = [];
      for (const file of accepted) {
        const supported = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4', 'video/quicktime', 'video/webm'];
        if (file.size < 1 || file.size > 52_428_800 || !supported.includes(file.type)) throw new Error(`${file.name} is not a supported media file (50 MB maximum).`);
        const result = await uploadUrl.mutateAsync({ data: { name: file.name, size: file.size, contentType: file.type as UploadUrlRequestContentType } });
        const response = await fetch(result.uploadURL, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
        if (!response.ok) throw new Error('The file upload did not complete. Please try again.');
        paths.push(result.objectPath);
      }
      setFiles(current => [...current, ...accepted]); setObjects(current => [...current, ...paths]);
    } catch (e) { setNotice(errorText(e)); }
    finally { setUploading(false); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!tool) return; setNotice('');
    create.mutate({ data: { toolId: tool.id, prompt, inputFiles: objects } }, {
      onSuccess: () => { setPrompt(''); setFiles([]); setObjects([]); void qc.invalidateQueries({ queryKey: getGetGenerationsQueryKey() }); void qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); void qc.invalidateQueries({ queryKey: getGetGenerationsQueryKey({ favoritesOnly: true }) }); },
      onError: err => setNotice(errorText(err)),
    });
  }
  const allowedTypes = tool?.category === 'video' ? 'video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp' : 'image/jpeg,image/png,image/webp,image/avif';
  return <WorkspaceShell title={tool?.name || 'Tool editor'} eyebrow="MAKE SOMETHING">
    <QueryState loading={isLoading} error={isError ? error : undefined} retry={() => void refetch()} empty={!isLoading && !isError && !tool} emptyText="This tool isn’t available or may have been disabled.">
      {tool && <div className="editor-layout">
        <div className="editor-main"><div className={`editor-preview ${tool.category === 'video' ? 'preview-video' : ''}`}><div className="preview-grid" /><div className="preview-corner preview-tl" /><div className="preview-corner preview-br" /><div className="preview-badge">{tool.category === 'video' ? <Film size={14} /> : <Image size={14} />}{tool.category.toUpperCase()} WORKSPACE</div><div className="preview-center">{files.length ? <div className="preview-file-stack">{files.slice(0, 3).map((f, i) => <div className="preview-upload-file" key={`${f.name}-${i}`}>{f.type.startsWith('image/') ? <img src={URL.createObjectURL(f)} alt={f.name} /> : <Film size={25} />}<span>{f.name}</span></div>)}</div> : <div className="preview-empty-mark"><Sparkles size={29} /><span>Your next good idea<br />starts here.</span></div>}</div><div className="preview-footer"><span>OUTPUT PREVIEW</span><span>Ready when you are</span></div></div>
          <div className="editor-footnote"><CircleHelp size={15} /><span>Results are created by your workspace’s configured AI provider. Availability can vary by tool.</span></div>
        </div>
        <form className="editor-controls" onSubmit={submit}>
          <div className="controls-heading"><div className="section-kicker">YOUR DIRECTION</div><span className="tool-cost-label"><Zap size={14} />{tool.credits} credits</span></div>
          <h2>Let’s make it yours.</h2><p className="editor-description">{tool.description}</p>
          {tool.acceptsUpload && <div className="upload-area"><input type="file" accept={allowedTypes} multiple onChange={e => void uploadSelected(e.target.files)} disabled={uploading || files.length >= 5} aria-label="Upload source media" data-testid="input-source-media" /><div className="upload-area-inner"><CloudUpload size={22} /><strong>{uploading ? 'Uploading your media…' : 'Drop in your source media'}</strong><span>Up to 5 files · 50 MB max each</span><span className="upload-cta">Browse files</span></div></div>}
          {!!files.length && <div className="selected-files">{files.map((f, i) => <div className="selected-file" key={`${f.name}-${i}`}><span>{f.name}</span><button type="button" aria-label={`Remove ${f.name}`} onClick={() => { setFiles(v => v.filter((_, j) => j !== i)); setObjects(v => v.filter((_, j) => j !== i)); }}><X size={14} /></button></div>)}</div>}
          <label className="field-label" htmlFor="prompt">YOUR PROMPT</label><textarea id="prompt" className="prompt-field" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} placeholder="Describe the feeling, finish, or change you have in mind…" required data-testid="input-generation-prompt" /><div className="prompt-hint"><span>Specific beats elaborate.</span><span>{prompt.length}/4000</span></div>
          {notice && <div className="inline-error" role="alert">{notice}</div>}
          {!tool.providerConfigured && <div className="provider-warning">AI provider is not configured. Please contact the administrator.</div>}
          <button type="submit" disabled={create.isPending || uploading || !prompt.trim() || !tool.providerConfigured} className="button button-primary generate-button">{create.isPending ? <><LoaderCircle className="spin" size={17} /> Creating…</> : <><Sparkles size={17} /> Create with AI <ArrowRight size={15} /></>}</button>
          <small className="secure-note"><Shield size={13} /> Your uploads are stored privately.</small>
          {create.isSuccess && <div className="success-note" role="status"><Check size={15} /> Generation submitted. Track its progress in Creations.</div>}
        </form>
      </div>}
    </QueryState>
  </WorkspaceShell>;
}

function GenerationRow({ item, onChanged }: { item: Generation; onChanged?: () => void }) {
  const qc = useQueryClient(); const favorite = useSetGenerationFavorite(); const remove = useDeleteGeneration();
  function invalidate() { void qc.invalidateQueries({ queryKey: getGetGenerationsQueryKey() }); void qc.invalidateQueries({ queryKey: getGetGenerationsQueryKey({ favoritesOnly: true }) }); void qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); onChanged?.(); }
  const firstFile = item.outputFiles?.[0] || item.inputFiles?.[0];
  const assetSrc = firstFile?.startsWith('/objects/') ? `/api/storage${firstFile}` : firstFile;
  return <article className="generation-row" data-testid={`row-generation-${item.id}`}>
    <div className={`generation-thumb ${item.category === 'video' ? 'generation-video' : ''}`}>{assetSrc?.startsWith('/api/storage') && item.category === 'photo' ? <img src={assetSrc} alt="" /> : item.category === 'video' ? <Film size={19} /> : <Image size={19} />}<span className={`status-dot status-${item.status}`} /></div>
    <div className="generation-info"><div className="flex items-center gap-2"><strong>{item.toolName}</strong><span className={`status-pill status-pill-${item.status}`}>{item.status}</span></div><p>{item.prompt || 'Untitled creation'}</p><small><Clock3 size={12} />{dateLabel(item.createdAt)}<span>·</span>{item.creditsUsed} credits</small></div>
    <div className="generation-actions"><button className={`icon-button ${item.favorite ? 'is-favorite' : ''}`} aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => favorite.mutate({ generationId: item.id, data: { favorite: !item.favorite } }, { onSuccess: invalidate })} data-testid={`button-favorite-${item.id}`}><Heart size={16} fill={item.favorite ? 'currentColor' : 'none'} /></button>{item.outputFiles?.[0] && <a className="icon-button" aria-label="Download result" href={assetSrc} download><Download size={16} /></a>}<button className="icon-button danger-hover" aria-label="Delete creation" onClick={() => { if (window.confirm('Delete this creation? This cannot be undone.')) remove.mutate({ generationId: item.id }, { onSuccess: invalidate }); }} data-testid={`button-delete-${item.id}`}><Trash2 size={16} /></button></div>
  </article>;
}
function LibraryPage({ favorites }: { favorites: boolean }) {
  const params = useMemo(() => favorites ? { favoritesOnly: true } : undefined, [favorites]);
  const q = useGetGenerations(params); const [filter, setFilter] = useState('all'); const [search, setSearch] = useState('');
  const list = q.data || [];
  const visible = list.filter(g => (filter === 'all' || g.category === filter) && `${g.toolName} ${g.prompt}`.toLowerCase().includes(search.toLowerCase()));
  return <WorkspaceShell title={favorites ? 'Favorites' : 'Creations'} eyebrow={favorites ? 'KEPT CLOSE' : 'YOUR WORK, IN ONE PLACE'} actions={!favorites ? <Link href="/studio" className="button button-primary"><Plus size={16} /> New creation</Link> : undefined}>
    <div className="library-controls"><div className="library-search"><Search size={16} /><input placeholder="Find a creation…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search creations" data-testid="input-search-creations" /></div><div className="segmented">{['all', 'photo', 'video'].map(f => <button key={f} onClick={() => setFilter(f)} className={filter === f ? 'segment-active' : ''}>{f}</button>)}</div></div>
    <QueryState loading={q.isLoading} error={q.isError ? q.error : undefined} retry={() => void q.refetch()} empty={!q.isLoading && !q.isError && !visible.length} emptyText={search ? 'No creations match your search.' : favorites ? 'Save a creation with the heart icon and it’ll be kept here.' : 'Your creative archive starts with your first generation.'}>
      <div className="generation-list">{visible.map(item => <GenerationRow key={item.id} item={item} />)}</div>
    </QueryState>
  </WorkspaceShell>;
}
function CreditsPage() {
  const dash = useGetDashboard(); const plans = useGetPlans();
  return <WorkspaceShell title="Credits & usage" eyebrow="A CLEAR VIEW OF YOUR ACTIVITY"><QueryState loading={dash.isLoading || plans.isLoading} error={dash.isError ? dash.error : plans.isError ? plans.error : undefined} retry={() => { void dash.refetch(); void plans.refetch(); }}>
    <div className="credits-hero"><div><div className="section-kicker">CURRENT BALANCE</div><h2>{dash.data?.creditBalance ?? '—'} <span>credits</span></h2><p>Your balance is provided by your account. It updates as generations are submitted.</p></div><div className="credit-glyph"><Zap size={31} /></div></div>
    <div className="usage-split"><div className="usage-card"><div className="section-kicker">THIS MONTH</div><div className="usage-number">{dash.data?.generationsThisMonth ?? '—'}</div><p>generations created</p></div><div className="usage-card"><div className="section-kicker">CURRENT PLAN</div><div className="usage-number usage-plan">{dash.data?.planName || '—'}</div><p>Your plan and available credits</p></div></div>
    <div className="subsection-heading mt-10"><div><div className="section-kicker">NEXT STEP</div><h2>Need a little more room?</h2></div></div><div className="plans-grid credits-plans">{plans.data?.filter(p => p.active).map(p => <PlanCard key={p.id} plan={p} compact />)}</div>
    <p className="payment-note"><Shield size={14} /> Plan selection is informational here. Payments are only confirmed by the server.</p>
  </QueryState></WorkspaceShell>;
}
function PublicPricing() {
  const q = useGetPlans(); const { isSignedIn } = useUser(); const [dark, toggle] = useDarkMode();
  return <main className="public-page"><header className="public-nav wrap"><Brand /><nav className="hidden md:flex items-center gap-8"><Link href="/">Home</Link><Link href="/#workflow">How it works</Link><Link href="/#tools">Studio tools</Link></nav><div className="flex items-center gap-2"><ModeButton dark={dark} toggle={toggle} />{isSignedIn ? <Link className="button button-primary nav-cta" href="/studio">Go to studio <ArrowRight size={14} /></Link> : <><Link href="/sign-in" className="nav-signin">Sign in</Link><Link href="/sign-up" className="button button-primary nav-cta">Start creating <ArrowRight size={14} /></Link></>}</div></header>
    <section className="pricing-section public-pricing-route"><div className="wrap"><div className="section-kicker">THE PLANS</div><div className="section-heading-row"><h2>Make at your<br /><em>own pace.</em></h2><p>Choose the amount of room you need. Every plan is powered by the real tools and credit allowances available in the studio.</p></div><QueryState loading={q.isLoading} error={q.isError ? q.error : undefined} retry={() => void q.refetch()} empty={!q.isLoading && !q.isError && !q.data?.filter(plan => plan.active).length} emptyText="Active plans will appear here when available."><div className="plans-grid">{q.data?.filter(plan => plan.active).map(plan => <PlanCard key={plan.id} plan={plan} />)}</div></QueryState><p className="payment-note"><CreditCard size={14} /> Choosing a plan does not process a payment.</p></div></section>
    <footer className="public-footer wrap"><Brand /><p>Make room for the work that matters.</p><div><Link href="/">Home</Link><Link href="/#tools">Tools</Link></div><small>Plans reported by Zevora</small></footer></main>;
}
function SettingsPage() {
  const { user } = useUser(); const { signOut } = useClerk(); const [dark, toggle] = useDarkMode();
  return <WorkspaceShell title="Settings" eyebrow="YOUR SPACE, YOUR WAY"><div className="settings-layout"><section className="settings-card"><div className="settings-card-title"><div className="settings-icon"><Users size={17} /></div><div><h2>Account</h2><p>Your identity in the studio</p></div></div><div className="settings-field"><span>Name</span><strong>{user?.fullName || '—'}</strong></div><div className="settings-field"><span>Email</span><strong>{user?.primaryEmailAddress?.emailAddress || '—'}</strong></div><div className="settings-field"><span>Account created</span><strong>{user?.createdAt ? dateLabel(user.createdAt.toString()) : '—'}</strong></div><button className="button button-outline mt-5" onClick={() => signOut({ redirectUrl: basePath || '/' })}><LogOut size={15} /> Sign out</button></section>
    <section className="settings-card"><div className="settings-card-title"><div className="settings-icon"><SlidersHorizontal size={17} /></div><div><h2>Appearance</h2><p>Find your preferred working light</p></div></div><div className="appearance-choice"><div><strong>Color theme</strong><p>Saved on this device</p></div><button className="theme-toggle" onClick={toggle} data-testid="button-settings-theme">{dark ? <><Moon size={15} /> Dark <span className="toggle-switch on" /></> : <><Sun size={15} /> Light <span className="toggle-switch" /></>}</button></div></section>
    <section className="settings-card"><div className="settings-card-title"><div className="settings-icon"><Shield size={17} /></div><div><h2>Privacy & safety</h2><p>Workspace uploads stay private</p></div></div><div className="privacy-copy"><BadgeCheck size={18} /><span>Your files are transferred directly to private object storage using a short-lived signed upload link.</span></div></section></div></WorkspaceShell>;
}

function AdminPage() {
  const [tab, setTab] = useState<'overview' | 'tools' | 'plans' | 'providers' | 'users' | 'site'>('overview');
  return <WorkspaceShell title="Admin workspace" eyebrow="SYSTEM CONTROL"><div className="admin-tabs">{(['overview', 'tools', 'plans', 'providers', 'users', 'site'] as const).map((item, i) => <button key={item} className={tab === item ? 'admin-tab-active' : ''} onClick={() => setTab(item)}>{[<LayoutDashboard size={15} />, <WandSparkles size={15} />, <Package size={15} />, <AudioLines size={15} />, <Users size={15} />, <Settings size={15} />][i]}{item === 'site' ? 'site settings' : item}</button>)}</div>
    {tab === 'overview' && <AdminOverviewPanel />}
    {tab === 'tools' && <AdminToolsPanel />}
    {tab === 'plans' && <AdminPlansPanel />}
    {tab === 'providers' && <AdminProvidersPanel />}
    {tab === 'users' && <AdminUsersPanel />}
    {tab === 'site' && <AdminSitePanel />}
  </WorkspaceShell>;
}
function AdminOverviewPanel() {
  const q = useGetAdminOverview();
  return <QueryState loading={q.isLoading} error={q.isError ? q.error : undefined} retry={() => void q.refetch()}><div className="admin-metric-grid">{[
    ['Total users', q.data?.totalUsers], ['Premium users', q.data?.premiumUsers], ['Generations', q.data?.totalGenerations], ['Failed generations', q.data?.failedGenerations], ['Credits used', q.data?.creditsUsed],
  ].map(([label, value]) => <div className="admin-metric" key={label}><span>{label}</span><strong>{value ?? '—'}</strong><small>Reported by the studio API</small></div>)}</div><div className="admin-note"><Shield size={17} /><div><strong>Operational data, not estimates.</strong><p>Metrics reflect what the service currently reports. No values are inferred or filled in.</p></div></div></QueryState>;
}
function AdminToolsPanel() {
  const q = useGetAdminTools(); const update = useUpdateAdminTool(); const qc = useQueryClient(); const [notice, setNotice] = useState('');
  const patch = (toolId: string, data: { credits?: number; enabled?: boolean; provider?: string; model?: string }) => update.mutate({ toolId, data }, { onSuccess: () => { setNotice('Tool settings saved.'); void qc.invalidateQueries({ queryKey: getGetAdminToolsQueryKey() }); void qc.invalidateQueries({ queryKey: getGetToolsQueryKey() }); }, onError: e => setNotice(errorText(e)) });
  return <QueryState loading={q.isLoading} error={q.isError ? q.error : undefined} retry={() => void q.refetch()} empty={!q.isLoading && !q.isError && !q.data?.length} emptyText="No tools are registered."><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Tool</th><th>Type</th><th>Credits</th><th>Provider / model</th><th>Provider status</th><th>Enabled</th></tr></thead><tbody>{q.data?.map(tool => <tr key={tool.id}><td><strong>{tool.name}</strong><small>{tool.description}</small></td><td>{tool.category}</td><td><input aria-label={`${tool.name} credits`} className="table-input narrow" type="number" min="0" defaultValue={tool.credits} onBlur={e => { const n = Number(e.currentTarget.value); if (n !== tool.credits) patch(tool.id, { credits: n }); }} /></td><td><span>{tool.provider}</span><small>{tool.model}</small></td><td><span className={`admin-status ${tool.providerConfigured ? 'configured' : 'unconfigured'}`}>{tool.providerConfigured ? 'Configured' : 'Not configured'}</span></td><td><button className={`toggle-switch ${tool.enabled ? 'on' : ''}`} aria-label={`${tool.enabled ? 'Disable' : 'Enable'} ${tool.name}`} onClick={() => patch(tool.id, { enabled: !tool.enabled })} /></td></tr>)}</tbody></table></div>{notice && <div className="admin-notice" role="status">{notice}</div>}</QueryState>;
}
function AdminPlansPanel() {
  const q = useGetAdminPlans(); const create = useCreateAdminPlan(); const update = useUpdateAdminPlan(); const remove = useDeleteAdminPlan(); const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false); const [notice, setNotice] = useState(''); const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [monthly, setMonthly] = useState(''); const [yearly, setYearly] = useState(''); const [credits, setCredits] = useState(''); const [features, setFeatures] = useState('');
  function refresh() { void qc.invalidateQueries({ queryKey: getGetAdminPlansQueryKey() }); void qc.invalidateQueries({ queryKey: getGetPlansQueryKey() }); }
  function submit(e: FormEvent) { e.preventDefault(); create.mutate({ data: { name, description, monthlyPrice: Number(monthly), yearlyPrice: Number(yearly), credits: Number(credits), features: features.split('\n').map(s => s.trim()).filter(Boolean), active: true, popular: false } }, { onSuccess: () => { setName(''); setDescription(''); setMonthly(''); setYearly(''); setCredits(''); setFeatures(''); setShowForm(false); setNotice('Plan created.'); refresh(); }, onError: e => setNotice(errorText(e)) }); }
  return <><div className="admin-panel-heading"><div><h2>Plans</h2><p>Manage active offers and plan details.</p></div><button className="button button-primary" onClick={() => setShowForm(v => !v)}><Plus size={15} /> {showForm ? 'Close form' : 'Create plan'}</button></div>
    {showForm && <form className="plan-editor-form" onSubmit={submit}><div className="form-grid"><label>Plan name<input required value={name} onChange={e => setName(e.target.value)} /></label><label>Description<input value={description} onChange={e => setDescription(e.target.value)} /></label><label>Monthly price<input required min="0" type="number" value={monthly} onChange={e => setMonthly(e.target.value)} /></label><label>Yearly price<input required min="0" type="number" value={yearly} onChange={e => setYearly(e.target.value)} /></label><label>Monthly credits<input required min="0" type="number" value={credits} onChange={e => setCredits(e.target.value)} /></label><label>Features, one per line<textarea value={features} onChange={e => setFeatures(e.target.value)} /></label></div><button className="button button-primary" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Save new plan'}</button></form>}
    <QueryState loading={q.isLoading} error={q.isError ? q.error : undefined} retry={() => void q.refetch()} empty={!q.isLoading && !q.isError && !q.data?.length} emptyText="No plans have been created."><div className="admin-plan-list">{q.data?.map(plan => <AdminPlanRow key={plan.id} plan={plan} onUpdate={(data) => update.mutate({ planId: plan.id, data }, { onSuccess: () => { setNotice('Plan updated.'); refresh(); }, onError: e => setNotice(errorText(e)) })} onDelete={() => { if (window.confirm(`Delete ${plan.name}?`)) remove.mutate({ planId: plan.id }, { onSuccess: refresh, onError: e => setNotice(errorText(e)) }); }} />)}</div></QueryState>
    {notice && <div className="admin-notice" role="status">{notice}</div>}</>;
}
function AdminPlanRow({ plan, onUpdate, onDelete }: { plan: Plan; onUpdate: (data: PlanInput) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false); const [name, setName] = useState(plan.name); const [description, setDescription] = useState(plan.description); const [price, setPrice] = useState(String(plan.monthlyPrice)); const [year, setYear] = useState(String(plan.yearlyPrice)); const [credits, setCredits] = useState(String(plan.credits));
  const completeData = (updates: Partial<PlanInput> = {}): PlanInput => ({ name: plan.name, description: plan.description, monthlyPrice: plan.monthlyPrice, yearlyPrice: plan.yearlyPrice, currency: plan.currency || 'USD', credits: plan.credits, features: plan.features, active: plan.active, popular: plan.popular, ...updates });
  return <article className="admin-plan-row"><div className="admin-plan-summary"><div><h3>{plan.name}</h3><p>{plan.description}</p><small>{money(plan.monthlyPrice, plan.currency)} monthly · {plan.credits} credits · {plan.active ? 'Active' : 'Inactive'}</small></div><div className="flex items-center gap-2"><button className={`toggle-switch ${plan.active ? 'on' : ''}`} aria-label={`${plan.active ? 'Deactivate' : 'Activate'} ${plan.name}`} onClick={() => onUpdate(completeData({ active: !plan.active }))} /><button className="icon-button" aria-label={`Edit ${plan.name}`} onClick={() => setEditing(v => !v)}><Settings size={15} /></button><button className="icon-button danger-hover" aria-label={`Delete ${plan.name}`} onClick={onDelete}><Trash2 size={15} /></button></div></div>
    {editing && <div className="plan-inline-edit"><input aria-label="Plan name" value={name} onChange={e => setName(e.target.value)} /><input aria-label="Plan description" value={description} onChange={e => setDescription(e.target.value)} /><input aria-label="Monthly price" type="number" value={price} onChange={e => setPrice(e.target.value)} /><input aria-label="Yearly price" type="number" value={year} onChange={e => setYear(e.target.value)} /><input aria-label="Credits" type="number" value={credits} onChange={e => setCredits(e.target.value)} /><button className="button button-primary button-small" onClick={() => { onUpdate(completeData({ name, description, monthlyPrice: Number(price), yearlyPrice: Number(year), credits: Number(credits) })); setEditing(false); }}>Save changes</button></div>}
  </article>;
}
function AdminProvidersPanel() {
  const q = useGetAdminProviders();
  return <QueryState loading={q.isLoading} error={q.isError ? q.error : undefined} retry={() => void q.refetch()} empty={!q.isLoading && !q.isError && !q.data?.length} emptyText="No AI providers are registered."><div className="provider-grid">{q.data?.map(provider => <article className="provider-card" key={provider.id}><div className="provider-card-head"><div className="settings-icon"><AudioLines size={17} /></div><span className={`admin-status ${provider.configured ? 'configured' : 'unconfigured'}`}>{provider.configured ? 'Configured' : 'Not configured'}</span></div><h3>{provider.name}</h3><p>Priority {provider.priority} · {provider.enabled ? 'Enabled' : 'Disabled'}</p><div className="provider-models">{provider.models.length ? provider.models.map(model => <span key={model}>{model}</span>) : <span>No model list reported</span>}</div></article>)}</div></QueryState>;
}
function AdminUsersPanel() {
  const [search, setSearch] = useState(''); const q = useGetAdminUsers(search.trim() ? { search: search.trim() } : undefined, { query: { queryKey: getGetAdminUsersQueryKey(search.trim() ? { search: search.trim() } : undefined) } });
  return <><div className="admin-panel-heading"><div><h2>Users</h2><p>Search account records reported by the service.</p></div><div className="library-search"><Search size={15} /><input placeholder="Search by email…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search users" /></div></div>
    <QueryState loading={q.isLoading} error={q.isError ? q.error : undefined} retry={() => void q.refetch()} empty={!q.isLoading && !q.isError && !q.data?.length} emptyText={search ? 'No users match that search.' : 'No user records are available.'}><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>User</th><th>Plan</th><th>Credits</th><th>Status</th><th>Joined</th></tr></thead><tbody>{q.data?.map(user => <tr key={user.id}><td><strong>{user.email || 'Email unavailable'}</strong><small>ID {user.id}</small></td><td>{user.planName}</td><td>{user.creditBalance}</td><td><span className={`admin-status ${user.status === 'active' ? 'configured' : 'unconfigured'}`}>{user.status}</span></td><td>{dateLabel(user.createdAt)}</td></tr>)}</tbody></table></div></QueryState>
  </>;
}
function AdminSitePanel() {
  const q = useGetSiteConfig(); const save = useUpdateAdminSettings(); const qc = useQueryClient(); const [notice, setNotice] = useState('');
  const [name, setName] = useState(''); const [tagline, setTagline] = useState(''); const [homepageText, setHomepageText] = useState(''); const [contactEmail, setContactEmail] = useState(''); const [logoUrl, setLogoUrl] = useState(''); const [maintenanceMode, setMaintenance] = useState(false);
  useEffect(() => { if (q.data) { setName(q.data.name); setTagline(q.data.tagline); setHomepageText(q.data.homepageText || ''); setContactEmail(q.data.contactEmail || ''); setLogoUrl(q.data.logoUrl || ''); setMaintenance(q.data.maintenanceMode); } }, [q.data]);
  function submit(e: FormEvent) { e.preventDefault(); const data: SiteConfigInput = { name, tagline, homepageText, contactEmail: contactEmail || null, logoUrl: logoUrl || null, maintenanceMode }; save.mutate({ data }, { onSuccess: () => { setNotice('Site settings saved.'); void qc.invalidateQueries({ queryKey: getGetSiteConfigQueryKey() }); }, onError: e => setNotice(errorText(e)) }); }
  return <QueryState loading={q.isLoading} error={q.isError ? q.error : undefined} retry={() => void q.refetch()}><form className="site-settings-form" onSubmit={submit}><div className="settings-card-title"><div className="settings-icon"><Settings size={17} /></div><div><h2>Public brand settings</h2><p>These values appear on the public Zevora experience.</p></div></div>
    <div className="form-grid"><label>Studio name<input value={name} maxLength={80} onChange={e => setName(e.target.value)} required /></label><label>Tagline<input value={tagline} maxLength={180} onChange={e => setTagline(e.target.value)} /></label><label>Contact email<input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} /></label><label>Logo URL<input value={logoUrl} type="url" onChange={e => setLogoUrl(e.target.value)} /></label><label className="full-field">Homepage text<textarea value={homepageText} maxLength={2000} onChange={e => setHomepageText(e.target.value)} /></label></div>
    <label className="maintenance-toggle"><span><strong>Maintenance mode</strong><small>Show the public service notice while maintenance is active.</small></span><button type="button" className={`toggle-switch ${maintenanceMode ? 'on' : ''}`} aria-label="Toggle maintenance mode" onClick={() => setMaintenance(v => !v)} /></label>
    <div className="flex items-center gap-3 mt-6"><button className="button button-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save site settings'}</button>{notice && <span className="admin-notice" role="status">{notice}</span>}</div>
  </form></QueryState>;
}

function App() {
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={basePath}><ErrorBoundary resetKey={window.location.pathname}><ClerkProviderRoutes /></ErrorBoundary></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
