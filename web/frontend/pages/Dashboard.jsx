import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Page,
  Layout,
  Text,
  Button,
  Badge,
  IndexTable,
  TextField,
  Select,
  Collapsible,
  EmptyState,
  Tooltip,
} from "@shopify/polaris";
import { useAuditData } from "../hooks/useAuditData";
import { useAppBridge } from "@shopify/app-bridge-react";

/* ─────────────────────────── Design Tokens ─────────────────────────── */
const colors = {
  accent: "#5C6AC4",      // Shopify indigo
  accentLight: "#EBF0FF",
  surface: "#FFFFFF",
  surfaceAlt: "#F9FAFB",
  border: "#E8ECF0",
  textPrimary: "#1A1D23",
  textSecondary: "#6D7175",
  textMuted: "#9BA0A6",
  success: "#008060",
  successBg: "#E3F5EE",
  warning: "#995200",
  warningBg: "#FFF4DB",
  critical: "#AE2E24",
  criticalBg: "#FFEEED",
  info: "#1865C2",
  infoBg: "#E5F1FF",
};

const radius = { sm: "6px", md: "10px", lg: "14px", xl: "20px" };

const shadow = {
  card: "0 1px 3px rgba(26,29,35,0.08), 0 0 0 1px rgba(26,29,35,0.06)",
  hover: "0 4px 16px rgba(92,106,196,0.14), 0 0 0 1px rgba(92,106,196,0.12)",
};

/* ─────────────────────────── Helper Components ─────────────────────── */

function Card({ children, style = {}, hover = false }) {
  const [isHovered, setIsHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => hover && setIsHovered(true)}
      onMouseLeave={() => hover && setIsHovered(false)}
      style={{
        background: colors.surface,
        borderRadius: radius.lg,
        boxShadow: isHovered ? shadow.hover : shadow.card,
        transition: "box-shadow 0.2s ease",
        overflow: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
      <div style={{ width: "3px", height: "18px", background: colors.accent, borderRadius: "2px" }} />
      <span style={{ fontSize: "13px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: colors.textSecondary }}>
        {children}
      </span>
    </div>
  );
}

function ScoreRing({ score, color, size = 64 }) {
  const stroke = size < 60 ? 4.5 : 5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const fill = Math.min(circ, Math.max(0, ((score || 0) / 100) * circ));

  return (
    <svg width={size} height={size} style={{ display: "block", flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={colors.border} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${fill} ${circ}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 0.8s cubic-bezier(.4,0,.2,1)" }}
      />
      <text x="50%" y="52%" dominantBaseline="middle" textAnchor="middle" fontSize={size < 60 ? "11" : "13"} fontWeight="700" fill={colors.textPrimary}>
        {score ?? 0}%
      </text>
    </svg>
  );
}

/* ─────────────────────────── Badge helpers ─────────────────────────── */
const SEVERITY_CONFIG = {
  CRITICAL: { label: "Critical", bg: colors.criticalBg, color: colors.critical, dot: "#D82C0D" },
  HIGH:     { label: "High",     bg: colors.warningBg,  color: colors.warning,  dot: "#FFC400" },
  MEDIUM:   { label: "Medium",   bg: "#EFF5FF",         color: "#1865C2",       dot: "#5C6AC4" },
  LOW:      { label: "Low",      bg: "#F3F4F6",         color: "#6D7175",       dot: "#9BA0A6" },
  NONE:     { label: "Healthy",  bg: colors.successBg,  color: colors.success,  dot: "#008060" },
};

function SeverityPill({ severity }) {
  const cfg = SEVERITY_CONFIG[severity?.toUpperCase()] || { label: severity, bg: "#F3F4F6", color: "#6D7175", dot: "#9BA0A6" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "5px",
      padding: "3px 10px", borderRadius: "20px",
      background: cfg.bg, color: cfg.color,
      fontSize: "12px", fontWeight: 600,
    }}>
      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: cfg.dot, flexShrink: 0 }} />
      {cfg.label}
    </span>
  );
}

function parseRecommendation(recStr) {
  if (!recStr || typeof recStr !== "string") {
    return {
      why: "",
      matters: "",
      trust: "",
      conversion: "",
      paid: "",
      action: recStr || "",
      shortSummary: recStr || "",
    };
  }

  const lines = recStr.split("\n");
  const parsed = {
    why: "",
    matters: "",
    trust: "",
    conversion: "",
    paid: "",
    action: "",
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("Why this was flagged:")) {
      parsed.why = trimmed.replace("Why this was flagged:", "").trim();
    } else if (trimmed.startsWith("Why it matters:")) {
      parsed.matters = trimmed.replace("Why it matters:", "").trim();
    } else if (trimmed.startsWith("Impact on trust:")) {
      parsed.trust = trimmed.replace("Impact on trust:", "").trim();
    } else if (trimmed.startsWith("Impact on conversion:")) {
      parsed.conversion = trimmed.replace("Impact on conversion:", "").trim();
    } else if (trimmed.startsWith("Impact on paid traffic:")) {
      parsed.paid = trimmed.replace("Impact on paid traffic:", "").trim();
    } else if (trimmed.startsWith("Recommended action:")) {
      parsed.action = trimmed.replace("Recommended action:", "").trim();
    }
  });

  let shortSummary = "";
  if (parsed.action) {
    shortSummary = parsed.action;
  } else if (parsed.why) {
    shortSummary = parsed.why;
  } else {
    shortSummary = lines[0];
  }

  return { ...parsed, shortSummary };
}

function getImpactBadgeStyle(impactVal) {
  if (!impactVal) return { bg: "#F3F4F6", color: "#6D7175" };
  const lower = impactVal.toLowerCase();
  if (lower.includes("critical") || lower.includes("stop") || lower.includes("sink")) {
    return { bg: colors.criticalBg, color: colors.critical };
  }
  if (lower.includes("high") || lower.includes("waste") || lower.includes("risk")) {
    return { bg: colors.warningBg, color: colors.warning };
  }
  if (lower.includes("medium") || lower.includes("reduce") || lower.includes("roi")) {
    return { bg: "#EFF5FF", color: "#1865C2" };
  }
  return { bg: "#F3F4F6", color: "#6D7175" };
}

const VERDICT_CONFIG = {
  "Ready to Scale: Proceed with ad spend": { bg: colors.successBg, border: "#00806020", color: colors.success, icon: "✦" },
  "Almost Ready: Fix remaining issues": { bg: colors.infoBg, border: "#1865C220", color: colors.info, icon: "◑" },
  "Not Ready: Do not run ads": { bg: colors.warningBg, border: "#99520020", color: colors.warning, icon: "⚠" },
  "High Risk: Review before scaling paid traffic": { bg: colors.criticalBg, border: "#AE2E2420", color: colors.critical, icon: "🚫" },
  "Waiting for Sync": { bg: "#FFFDF0", border: "#99520020", color: colors.warning, icon: "⟳" },
};

/* ─────────────────────────── Main Dashboard ────────────────────────── */
export default function Dashboard() {
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const { data, isLoading, refetch } = useAuditData();
  const [isSyncing, setIsSyncing] = useState(false);

  const [expandedIssues, setExpandedIssues] = useState({});
  const [searchValue, setSearchValue] = useState("");
  const [severityFilter, setSeverityFilter] = useState("ALL");

  const [overrides, setOverrides] = useState([]);
  const [isSavingOverride, setIsSavingOverride] = useState(false);

  const fetchOverrides = async () => {
    try {
      const res = await fetch("/v1/api/overrides");
      const resData = await res.json();
      if (res.ok && resData.success) {
        setOverrides(resData.overrides || []);
      }
    } catch (err) {
      console.error("Error fetching overrides:", err);
    }
  };

  useEffect(() => {
    fetchOverrides();
  }, []);

  const handleToggleOverride = async (ruleType, isIgnored) => {
    setIsSavingOverride(true);
    try {
      const res = await fetch("/v1/api/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleType, isIgnored }),
      });
      const resData = await res.json();
      if (res.ok && resData.success) {
        shopify.toast.show(
          isIgnored 
            ? "Rule ignored. Re-calculating scores..." 
            : "Rule restored. Re-calculating scores..."
        );
        await refetch();
        await fetchOverrides();
      } else {
        shopify.toast.show(resData.error || "Failed to update override.", { isError: true });
      }
    } catch (err) {
      shopify.toast.show("An error occurred.", { isError: true });
    }
    setIsSavingOverride(false);
  };



  useEffect(() => {
    if (!isLoading) {
      const status = data?.subscription?.status;
      if (status !== "ACTIVE" && status !== "PENDING") {
        navigate("/", { replace: true });
      }
    }
  }, [data, isLoading, navigate]);

  const latestJobStatus = data?.planDetails?.latestJob?.status;
  const isCooldownActive = data?.planDetails?.isCooldownActive;

  // Background polling for active re-analysis jobs
  useEffect(() => {
    let interval;
    if (latestJobStatus === "PENDING" || latestJobStatus === "PROCESSING") {
      interval = setInterval(() => {
        refetch();
      }, 4000); // Poll every 4 seconds for immediate merchant responsiveness
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [latestJobStatus, refetch]);

  const handleRunSync = async () => {
    if (isCooldownActive) {
      shopify.toast.show("Re-analysis cooldown is currently active.", { isError: true });
      return;
    }
    setIsSyncing(true);
    try {
      const response = await fetch("/v1/jobs/trigger-sync", { method: "POST" });
      const resData = await response.json();
      if (response.ok && resData.success) {
        shopify.toast.show("Commercial re-analysis started.");
        await refetch();
      } else {
        shopify.toast.show(resData.message || "Failed to start sync.", { isError: true });
      }
    } catch (error) {
      shopify.toast.show("An error occurred.", { isError: true });
    }
    setIsSyncing(false);
  };

  const toggleIssueExpansion = (id) => {
    setExpandedIssues((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const status = data?.subscription?.status;
  const verdict = data?.verdict || "Waiting for Sync";
  const scores = data?.scores || {
    productDataQuality: 0,
    visualTrust: 0,
    catalogConsistency: 0,
    conversionReadiness: 0,
    fulfillmentTrust: 0,
    dropshippingPerception: 0,
    catalogMaintenance: 0,
    trustScore: 0,
    trustClassification: 'Waiting for Sync'
  };
  const scoreExplanations = data?.scoreExplanations || {};
  const issues = data?.issues || [];
  const products = data?.products || [];
  const shopDomain = data?.shop?.domain || "";
  const isFeatureLocked = data?.plan === "LIGHT" && false;
  const storeReadinessNarrative = data?.storeReadinessNarrative || null;
  const impactBucketSummary = data?.impactBucketSummary || null;
  const deliveryAdvisory = data?.deliveryAdvisory || null;

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const matchesSearch = p.title.toLowerCase().includes(searchValue.toLowerCase());
      const matchesSeverity = severityFilter === "ALL" || p.severity === severityFilter;
      return matchesSearch && matchesSeverity;
    });
  }, [products, searchValue, severityFilter]);

  const verdictCfg = VERDICT_CONFIG[verdict] || VERDICT_CONFIG["Waiting for Sync"];

  /* ── Loading State ── */
  if (isLoading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: "16px" }}>
        <div style={{
          width: "40px", height: "40px", borderRadius: "50%",
          border: `3px solid ${colors.accentLight}`,
          borderTopColor: colors.accent,
          animation: "spin 0.8s linear infinite",
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <span style={{ color: colors.textSecondary, fontSize: "14px" }}>Loading audit data…</span>
      </div>
    );
  }

  if (status !== "ACTIVE" && status !== "PENDING") return null;

  const scoreMetrics = [
    {
      label: "Data Quality",
      measures: "Titles, descriptions, pricing validity",
      score: scores.productDataQuality,
      color: "#5C6AC4",
      icon: "◈",
      explanation: scoreExplanations?.dataQuality?.explanation || null,
      tooltip: "Evaluates description copy length, structure, benefit orientation, and lack of supplier boilerplate. A product with strong copy can still carry store risk if delivery, pricing, or image issues exist.",
    },
    {
      label: "Visual Trust",
      measures: "Image count, missing images, excessive imagery",
      score: scores.visualTrust,
      color: "#00A3BF",
      icon: "◉",
      explanation: scoreExplanations?.visualTrust?.explanation || null,
      tooltip: "Measures image resolution, gallery volume, diversity, and absence of duplicate or poor-quality visuals.",
    },
    {
      label: "Consistency",
      measures: "Pricing gaps, inventory anomalies, catalog coherence",
      score: scores.catalogConsistency,
      color: "#00B779",
      icon: "◆",
      explanation: scoreExplanations?.consistency?.explanation || null,
      tooltip: "Evaluates pricing alignment across variants, inventory reliability, and catalog structural balance.",
    },
    {
      label: "Readiness",
      measures: "Commercial readiness & scaling risk",
      score: scores.conversionReadiness,
      color: "#637381",
      icon: "◎",
      explanation: scoreExplanations?.readiness?.explanation || null,
      tooltip: "Commercial scaling readiness metric. Assesses overall conversion confidence before launching or increasing paid traffic spend.",
    },
  ];

  return (
    <div style={{ background: colors.surfaceAlt, minHeight: "100vh" }}>
      {/* ── Page Shell ── */}
      <Page
        title=""
        primaryAction={{
          content: isCooldownActive 
            ? "Sync Cooldown Active"
            : (latestJobStatus === "PENDING" || latestJobStatus === "PROCESSING")
              ? "Re-analysis Running..."
              : "Run Sync",
          onAction: handleRunSync,
          loading: isSyncing || latestJobStatus === "PENDING" || latestJobStatus === "PROCESSING",
          disabled: isCooldownActive || latestJobStatus === "PENDING" || latestJobStatus === "PROCESSING",
        }}
      >
        {/* ── Custom Page Header ── */}
        <div style={{ marginBottom: "28px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "16px" }}>
            <div>
              <h1 style={{ margin: 0, fontSize: "22px", fontWeight: 700, color: colors.textPrimary, letterSpacing: "-0.3px" }}>
                Commercial Risk Intelligence
              </h1>
              <p style={{ margin: "4px 0 0", fontSize: "14px", color: colors.textSecondary }}>
                Identify commercial risk signals and resolve issues before scaling ad spend.
              </p>
            </div>
          </div>
        </div>
        
        {/* ── Plan Details Banner ── */}
        {data?.planDetails && (
          <div style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.md,
            padding: "12px 20px",
            marginBottom: "20px",
            boxShadow: shadow.card,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "16px"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "14px", fontWeight: 700, color: colors.textPrimary }}>Active Plan:</span>
              <Badge status="success">{data.planDetails.plan} Tier</Badge>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "10px", color: colors.textSecondary, textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.03em" }}>Catalog Scan Status</span>
                <span style={{ fontSize: "13px", fontWeight: 500, color: colors.textPrimary, marginTop: "2px" }}>
                  Scanned: <strong style={{ fontWeight: 700 }}>{data?.shop?.totalProductsCount || data.planDetails.productsAnalyzed}</strong> products | Monitored: <strong style={{ fontWeight: 700 }}>{data.planDetails.productsAnalyzed}</strong> of {data.planDetails.maxProducts}
                </span>
              </div>
              <div style={{ width: "1px", height: "24px", background: colors.border }} />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "10px", color: colors.textSecondary, textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.03em" }}>Image Limit</span>
                <span style={{ fontSize: "14px", fontWeight: 700, color: colors.textPrimary, marginTop: "2px" }}>
                  {data.planDetails.imagesPerProduct} / product
                </span>
              </div>
              <div style={{ width: "1px", height: "24px", background: colors.border }} />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: "10px", color: colors.textSecondary, textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.03em" }}>Audit Frequency</span>
                <span style={{ fontSize: "14px", fontWeight: 700, color: colors.textPrimary, marginTop: "2px" }}>
                  {data.planDetails.scanFrequency}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ── Trial-Safe Limits Banner ── */}
        {data?.trialInfo?.isTrial && (
          <div style={{
            background: "#FFFBF0",
            border: "1px solid #FFC40040",
            borderRadius: radius.md,
            padding: "14px 20px",
            marginBottom: "20px",
            boxShadow: shadow.card,
            display: "flex",
            alignItems: "flex-start",
            gap: "12px",
          }}>
            <span style={{ fontSize: "18px", flexShrink: 0, marginTop: "1px" }}>🔒</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#7A5400", marginBottom: "4px" }}>
                Free Trial Active
                {data.trialInfo.daysRemaining > 0 && (
                  <span style={{
                    marginLeft: "10px",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "#995200",
                    background: "#FFF0C0",
                    border: "1px solid #FFC40040",
                    borderRadius: "20px",
                    padding: "2px 10px",
                  }}>
                    {data.trialInfo.daysRemaining} day{data.trialInfo.daysRemaining !== 1 ? "s" : ""} remaining
                  </span>
                )}
              </div>
              <div style={{ fontSize: "13px", color: "#7A5400", lineHeight: "1.6" }}>
                Your store audit is running with trial-safe limits. ScaleGuard will still show your main trust, catalog and conversion risks.{" "}
                <span style={{ fontWeight: 600 }}>
                  Paid plans unlock full product coverage, deeper monitoring and advanced commercial intelligence.
                </span>
              </div>
              {data.trialInfo.trialProductCap && (
                <div style={{
                  marginTop: "8px",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "16px",
                  fontSize: "12px",
                  color: "#995200",
                }}>
                  <span>📦 Products monitored: <strong>up to {data.trialInfo.trialProductCap}</strong></span>
                  <span>🔁 Scan frequency: <strong>{data.trialInfo.scanFrequency}</strong></span>
                  <span>🤖 AI intelligence: <strong>Enabled on paid plan</strong></span>
                </div>
              )}
            </div>
            <button
              onClick={() => navigate("/")}
              style={{
                flexShrink: 0,
                fontSize: "12px",
                fontWeight: 700,
                color: "#5C6AC4",
                background: "transparent",
                border: "1px solid #5C6AC430",
                borderRadius: "8px",
                padding: "6px 14px",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Upgrade Plan
            </button>
          </div>
        )}

        {/* ── Active Sync Status Banner ── */}
        {(latestJobStatus === "PENDING" || latestJobStatus === "PROCESSING") && (
          <div style={{
            background: colors.infoBg,
            border: `1px solid ${colors.info}30`,
            borderRadius: radius.md,
            padding: "16px 20px",
            marginBottom: "20px",
            boxShadow: shadow.card,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            animation: "pulse 2s infinite"
          }}>
            <style>{`
              @keyframes pulse {
                0% { opacity: 0.95; }
                50% { opacity: 1; transform: scale(1.001); }
                100% { opacity: 0.95; }
              }
              @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
              }
            `}</style>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "20px", animation: "spin 2s linear infinite" }}>🔄</span>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: colors.info }}>
                  Commercial re-analysis started
                </div>
                <div style={{ fontSize: "12px", color: colors.textSecondary, marginTop: "2px" }}>
                  Updated products and catalog signals are being reprocessed in the background.
                </div>
              </div>
            </div>
            <div style={{
              fontSize: "11px",
              color: colors.textSecondary,
              paddingLeft: "30px",
              lineHeight: "1.5",
              borderTop: `1px solid ${colors.info}15`,
              paddingTop: "8px",
              marginTop: "4px"
            }}>
              Updated scores and issue status may take time to refresh depending on:
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                <li>Store size ({data?.planDetails?.productsAnalyzed} products)</li>
                <li>Updated products & inventory complexity</li>
                <li>Active subscription tier (<strong>{data?.planDetails?.plan} Tier</strong>: priority queue)</li>
              </ul>
            </div>
          </div>
        )}

        {/* ── Cooldown Banner ── */}
        {isCooldownActive && data?.planDetails?.cooldownRemainingMs > 0 && (
          <div style={{
            background: "#FFFBF0",
            border: `1px solid #FFC40030`,
            borderRadius: radius.md,
            padding: "12px 20px",
            marginBottom: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "16px" }}>⏳</span>
              <div style={{ fontSize: "13px", color: colors.warning, fontWeight: 500 }}>
                Next manual re-analysis will be available in <strong>{Math.ceil(data.planDetails.cooldownRemainingMs / (60 * 1000))} minutes</strong> due to active tier limit.
              </div>
            </div>
            <Badge status="attention">{data.planDetails.plan} Cooldown</Badge>
          </div>
        )}
        
        {/* ── 0. Data Sufficiency Warning ── */}
        {data?.isDataSufficient === false && (
          <div style={{ marginBottom: "20px" }}>
            <div style={{
              padding: "12px 20px",
              borderRadius: radius.md,
              background: colors.warningBg,
              border: `1px solid ${colors.warning}30`,
              display: "flex", alignItems: "center", gap: "12px",
            }}>
              <span style={{ fontSize: "18px" }}>💡</span>
              <div style={{ fontSize: "13px", color: colors.warning, fontWeight: 500 }}>
                {data.dataIssues?.[0] || "Catalog data is limited. Add more products for a more comprehensive audit."}
              </div>
            </div>
          </div>
        )}

        <Layout>
          {/* ── 1. Verdict Banner ── */}
          <Layout.Section>
            <div style={{
              padding: "20px 24px",
              borderRadius: radius.lg,
              background: verdictCfg.bg,
              border: `1px solid ${verdictCfg.border}`,
              display: "flex", alignItems: "center", gap: "16px",
            }}>
              <div style={{
                width: "40px", height: "40px", borderRadius: radius.md,
                background: verdictCfg.color + "18",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "20px", color: verdictCfg.color, flexShrink: 0,
              }}>
                {verdictCfg.icon}
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: verdictCfg.color }}>
                    Verdict: {verdict}
                  </div>
                  {data?.products?.some(p => p.performance) && (
                    <span style={{
                      padding: "2px 8px", borderRadius: "4px",
                      background: colors.info, color: "white",
                      fontSize: "10px", fontWeight: 800, textTransform: "uppercase"
                    }}>
                      Performance Layer Active
                    </span>
                  )}
                </div>
                {data?.storeRecommendation && (
                  <div style={{ fontSize: "14px", fontWeight: 600, color: colors.textPrimary, marginTop: "4px" }}>
                    {data.storeRecommendation}
                  </div>
                )}
                <div style={{ fontSize: "12px", color: colors.textSecondary, marginTop: "4px", opacity: 0.8 }}>
                  Based on your recent catalog audit — this is your recommended action for scaling.
                </div>
              </div>
            </div>
          </Layout.Section>

          {/* ── 1.5. Store Readiness Narrative ── */}
          {storeReadinessNarrative && (
            <Layout.Section>
              <div style={{
                padding: "16px 20px",
                borderRadius: radius.md,
                background: scores.conversionReadiness >= 85
                  ? colors.successBg
                  : scores.conversionReadiness >= 70
                    ? colors.infoBg
                    : scores.conversionReadiness >= 45
                      ? "#FFFBF0"
                      : colors.criticalBg,
                border: `1px solid ${scores.conversionReadiness >= 85
                  ? colors.success + '30'
                  : scores.conversionReadiness >= 70
                    ? colors.info + '30'
                    : scores.conversionReadiness >= 45
                      ? '#FFC40030'
                      : colors.critical + '30'}`,
                display: "flex",
                alignItems: "flex-start",
                gap: "14px",
              }}>
                <span style={{ fontSize: "20px", flexShrink: 0, marginTop: "1px" }}>
                  {scores.conversionReadiness >= 85 ? '✅' :
                   scores.conversionReadiness >= 70 ? 'ℹ️' :
                   scores.conversionReadiness >= 45 ? '⚠️' : '🚨'}
                </span>
                <div>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: colors.textPrimary, marginBottom: "4px" }}>
                    Store Readiness Summary
                  </div>
                  <div style={{ fontSize: "13px", color: colors.textSecondary, lineHeight: "1.6" }}>
                    {storeReadinessNarrative}
                  </div>
                </div>
              </div>
            </Layout.Section>
          )}

          {/* ── Persistent Delivery Advisory (when acknowledged) ── */}
          {deliveryAdvisory && (
            <Layout.Section>
              <div style={{
                padding: "14px 18px",
                borderRadius: radius.md,
                background: "#FFF8F0",
                border: "1px solid #FF990040",
                display: "flex",
                alignItems: "flex-start",
                gap: "12px",
              }}>
                <span style={{ fontSize: "18px", flexShrink: 0 }}>📦</span>
                <div>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#7A4A00", marginBottom: "4px" }}>
                    {deliveryAdvisory.title}
                  </div>
                  <div style={{ fontSize: "12px", color: colors.textSecondary, lineHeight: "1.6" }}>
                    {deliveryAdvisory.message}
                  </div>
                </div>
              </div>
            </Layout.Section>
          )}

          {/* ── 2. Health Score Cards ── */}
          <Layout.Section>
            <SectionLabel>Catalog Health Overview</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "14px" }}>
              {scoreMetrics.map((metric) => (
                <Card key={metric.label} hover style={{ padding: "20px 16px" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                    <ScoreRing score={metric.score} color={metric.color} />
                    <div style={{ textAlign: "center" }}>
                      <Tooltip content={metric.tooltip} dismissOnMouseOut>
                        <span style={{ fontSize: "14px", fontWeight: 700, color: colors.textPrimary, cursor: "help", borderBottom: `1px dashed ${colors.textMuted}` }}>
                          {metric.label} ⓘ
                        </span>
                      </Tooltip>
                      <div style={{ fontSize: "10px", color: colors.accent, fontWeight: 600, marginTop: "4px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        {metric.measures}
                      </div>
                      {metric.explanation ? (
                        <div style={{
                          fontSize: "11px",
                          color: colors.textMuted,
                          marginTop: "8px",
                          lineHeight: "1.5",
                          textAlign: "center",
                        }}>
                          {metric.explanation}
                        </div>
                      ) : (
                        <div style={{ fontSize: "11px", color: colors.textMuted, marginTop: "6px" }}>Catalog metric</div>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </Layout.Section>

          {/* ── 2.5. Store Trust Intelligence ── */}
          <Layout.Section>
            <SectionLabel>Store Trust Intelligence</SectionLabel>
            <Card style={{ padding: "20px 24px", background: colors.surface }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "16px", marginBottom: "20px", borderBottom: `1px solid ${colors.border}`, paddingBottom: "16px" }}>
                <div>
                  <div style={{ fontSize: "16px", fontWeight: 700, color: colors.textPrimary }}>Store Trust Summary</div>
                  <div style={{ fontSize: "13px", color: colors.textSecondary, marginTop: "2px" }}>
                    Overall customer trust assessment and brand credibility signals.
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ fontSize: "14px", fontWeight: 600, color: colors.textSecondary }}>Trust Status:</span>
                  <span style={{
                    padding: "6px 16px",
                    borderRadius: radius.md,
                    background: scores.trustClassification === 'Excellent' || scores.trustClassification === 'Good' ? colors.successBg : scores.trustClassification === 'Fair' ? colors.infoBg : colors.warningBg,
                    color: scores.trustClassification === 'Excellent' || scores.trustClassification === 'Good' ? colors.success : scores.trustClassification === 'Fair' ? colors.info : colors.warning,
                    fontSize: "14px",
                    fontWeight: 700,
                    textTransform: "uppercase"
                  }}>
                    {scores.trustClassification || 'Fair'}
                  </span>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))", gap: "14px" }}>
                <div style={{ padding: "16px 14px", background: colors.surfaceAlt, borderRadius: radius.md, border: `1px solid ${colors.border}`, display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
                  <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <ScoreRing score={scores.trustScore} color={colors.accent} size={54} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Tooltip content="Composite index combining copy quality, visual presentation, shipping transparency, pricing integrity, and brand credibility." dismissOnMouseOut>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: colors.textPrimary, lineHeight: "1.3", cursor: "help", borderBottom: `1px dashed ${colors.textMuted}`, display: "inline-block" }}>
                        Trust Score ⓘ
                      </div>
                    </Tooltip>
                    <div style={{ fontSize: "11px", color: colors.textSecondary, marginTop: "4px", lineHeight: "1.3" }}>Weighted trust index</div>
                  </div>
                </div>
                <div style={{ padding: "16px 14px", background: colors.surfaceAlt, borderRadius: radius.md, border: `1px solid ${colors.border}`, display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
                  <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <ScoreRing score={scores.fulfillmentTrust} color="#00A3BF" size={54} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Tooltip content="Assesses shipping speed, delivery transparency, supplier communication, and logistics risk." dismissOnMouseOut>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: colors.textPrimary, lineHeight: "1.3", cursor: "help", borderBottom: `1px dashed ${colors.textMuted}`, display: "inline-block" }}>
                        Fulfillment Trust ⓘ
                      </div>
                    </Tooltip>
                    <div style={{ fontSize: "11px", color: colors.textSecondary, marginTop: "4px", lineHeight: "1.3" }}>Delivery timeline & risk</div>
                  </div>
                </div>
                <div style={{ padding: "16px 14px", background: colors.surfaceAlt, borderRadius: radius.md, border: `1px solid ${colors.border}`, display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
                  <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <ScoreRing score={scores.dropshippingPerception} color="#FF9900" size={54} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Tooltip content="Evaluates overseas supplier cues, generic copy patterns, and uncurated store signals." dismissOnMouseOut>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: colors.textPrimary, lineHeight: "1.3", cursor: "help", borderBottom: `1px dashed ${colors.textMuted}`, display: "inline-block" }}>
                        Dropship Perception ⓘ
                      </div>
                    </Tooltip>
                    <div style={{ fontSize: "11px", color: colors.textSecondary, marginTop: "4px", lineHeight: "1.3" }}>Import & supplier cues</div>
                  </div>
                </div>
                <div style={{ padding: "16px 14px", background: colors.surfaceAlt, borderRadius: radius.md, border: `1px solid ${colors.border}`, display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
                  <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <ScoreRing score={scores.catalogMaintenance} color="#00B779" size={54} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Tooltip content="Measures active storefront organization, ghost listings, title standards, and catalog upkeep." dismissOnMouseOut>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: colors.textPrimary, lineHeight: "1.3", cursor: "help", borderBottom: `1px dashed ${colors.textMuted}`, display: "inline-block" }}>
                        Catalog Maintenance ⓘ
                      </div>
                    </Tooltip>
                    <div style={{ fontSize: "11px", color: colors.textSecondary, marginTop: "4px", lineHeight: "1.3" }}>Polish & metadata</div>
                  </div>
                </div>
              </div>
            </Card>
          </Layout.Section>

          {/* ── 2.7. ScaleGuard Advisor Insights (Quick Wins, High-Impact Fixes & Commercial Recommendations) ── */}
          <Layout.Section>
            <SectionLabel>ScaleGuard Advisor Insights</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "16px" }}>
              {/* Quick Wins */}
              <Card style={{ padding: "20px 24px", display: "flex", flexDirection: "column", height: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                  <span style={{ fontSize: "18px" }}>⚡</span>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: colors.textPrimary }}>Top Quick Wins</span>
                </div>
                <p style={{ fontSize: "13px", color: colors.textSecondary, marginBottom: "16px" }}>
                  Fast, low-effort adjustments (low volume/effort) to boost buyer confidence right away.
                </p>
                {(!data?.quickWins || data.quickWins.length === 0) ? (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "130px", border: `1px dashed ${colors.border}`, borderRadius: radius.md, color: colors.textMuted, fontSize: "13px" }}>
                    No pending quick wins! Store looks pristine.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px", flex: 1 }}>
                    {data.quickWins.map((win, idx) => (
                      <div key={idx} style={{ padding: "12px", background: colors.surfaceAlt, borderRadius: radius.md, border: `1px solid ${colors.border}` }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 700, color: colors.textPrimary }}>{win.title}</span>
                          <div style={{ display: "flex", gap: "4px" }}>
                            <span style={{ padding: "2px 6px", borderRadius: "4px", background: colors.successBg, color: colors.success, fontSize: "10px", fontWeight: 700 }}>
                              {win.effort} Effort
                            </span>
                            <span style={{ padding: "2px 6px", borderRadius: "4px", background: colors.accentLight, color: colors.accent, fontSize: "10px", fontWeight: 700 }}>
                              {win.impact} Impact
                            </span>
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: colors.textSecondary, lineHeight: "1.4" }}>{win.action}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {/* High-Impact Fixes */}
              <Card style={{ padding: "20px 24px", display: "flex", flexDirection: "column", height: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                  <span style={{ fontSize: "18px" }}>🔥</span>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: colors.textPrimary }}>High-Impact Fixes</span>
                </div>
                <p style={{ fontSize: "13px", color: colors.textSecondary, marginBottom: "16px" }}>
                  Broader catalog improvements affecting higher product volumes to drive conversion gains.
                </p>
                {(!data?.highImpactFixes || data.highImpactFixes.length === 0) ? (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "130px", border: `1px dashed ${colors.border}`, borderRadius: radius.md, color: colors.textMuted, fontSize: "13px" }}>
                    No pending high-impact fixes!
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px", flex: 1 }}>
                    {data.highImpactFixes.map((fix, idx) => (
                      <div key={idx} style={{ padding: "12px", background: colors.surfaceAlt, borderRadius: radius.md, border: `1px solid ${colors.border}` }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" }}>
                          <span style={{ fontSize: "13px", fontWeight: 700, color: colors.textPrimary }}>{fix.title}</span>
                          <div style={{ display: "flex", gap: "4px" }}>
                            <span style={{ padding: "2px 6px", borderRadius: "4px", background: colors.warningBg, color: colors.warning, fontSize: "10px", fontWeight: 700 }}>
                              High Volume
                            </span>
                            <span style={{ padding: "2px 6px", borderRadius: "4px", background: colors.accentLight, color: colors.accent, fontSize: "10px", fontWeight: 700 }}>
                              {fix.impact} Impact
                            </span>
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: colors.textSecondary, lineHeight: "1.4" }}>{fix.action}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {/* Commercial Recommendations */}
              <Card style={{ padding: "20px 24px", display: "flex", flexDirection: "column", height: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                  <span style={{ fontSize: "18px" }}>📈</span>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: colors.textPrimary }}>Commercial Advisor Insights</span>
                </div>
                <p style={{ fontSize: "13px", color: colors.textSecondary, marginBottom: "16px" }}>
                  Strategic guidance for store scaling, conversion optimization, and paid ad readiness.
                </p>
                {(!data?.commercialRecommendations || data.commercialRecommendations.length === 0) ? (
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "130px", border: `1px dashed ${colors.border}`, borderRadius: radius.md, color: colors.textMuted, fontSize: "13px" }}>
                    All commercial readiness standards met. Ready for paid traffic!
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px", flex: 1 }}>
                    {data.commercialRecommendations.map((rec, idx) => (
                      <div key={idx} style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "10px 12px", background: colors.surfaceAlt, borderRadius: radius.md, borderLeft: `3px solid ${colors.accent}` }}>
                        <span style={{ fontSize: "14px", marginTop: "2px" }}>💡</span>
                        <div style={{ fontSize: "13px", color: colors.textPrimary, fontWeight: 500, lineHeight: "1.4" }}>{rec}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </Layout.Section>

          {/* ── Impact Buckets ── */}
          {impactBucketSummary && impactBucketSummary.length > 0 && (
            <Layout.Section>
              <SectionLabel>Issues by Commercial Impact</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
                {impactBucketSummary.map((bucket) => {
                  const bucketSeverityCfg = SEVERITY_CONFIG[bucket.highestSeverity?.toUpperCase()] || SEVERITY_CONFIG.LOW;
                  return (
                    <div
                      key={bucket.bucket}
                      style={{
                        padding: "14px 16px",
                        borderRadius: radius.md,
                        background: colors.surface,
                        border: `1px solid ${colors.border}`,
                        boxShadow: shadow.card,
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontSize: "16px" }}>{bucket.icon}</span>
                          <span style={{ fontSize: "13px", fontWeight: 700, color: colors.textPrimary }}>{bucket.label}</span>
                        </div>
                        <span style={{
                          padding: "2px 8px",
                          borderRadius: "12px",
                          background: bucketSeverityCfg.bg,
                          color: bucketSeverityCfg.color,
                          fontSize: "11px",
                          fontWeight: 700,
                        }}>
                          {bucketSeverityCfg.label}
                        </span>
                      </div>
                      <div style={{ fontSize: "11px", color: colors.textSecondary, lineHeight: "1.4" }}>
                        {bucket.description}
                      </div>
                      <div style={{ display: "flex", gap: "12px", marginTop: "4px" }}>
                        <span style={{ fontSize: "12px", fontWeight: 700, color: colors.textPrimary }}>
                          {bucket.issueCount} issue type{bucket.issueCount !== 1 ? 's' : ''}
                        </span>
                        {bucket.affectedProductCount > 0 && (
                          <span style={{ fontSize: "12px", color: colors.textSecondary }}>
                            · {bucket.affectedProductCount} affected product{bucket.affectedProductCount !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Layout.Section>
          )}

          {/* ── 3. Priority Fixes ── */}
          <Layout.Section>
            <SectionLabel>Priority Risks Before Scaling</SectionLabel>
            <Card>
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${colors.border}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                  <div style={{ fontSize: "13px", color: colors.textSecondary }}>
                    Grouped by issue type — tackle these to improve your readiness score.
                  </div>
                  {issues.length > 0 && (
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map(sev => {
                        const count = issues.filter(i => i.severity?.toUpperCase() === sev).length;
                        if (count === 0) return null;
                        const cfg = SEVERITY_CONFIG[sev];
                        return (
                          <span key={sev} style={{
                            padding: "2px 8px", borderRadius: "12px",
                            background: cfg.bg, color: cfg.color,
                            fontSize: "11px", fontWeight: 700,
                          }}>
                            {count} {cfg.label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {issues.length === 0 ? (
                <div style={{ padding: "48px 24px", textAlign: "center" }}>
                  <div style={{ fontSize: "36px", marginBottom: "12px" }}>🎉</div>
                  <div style={{ fontSize: "16px", fontWeight: 600, color: colors.textPrimary, marginBottom: "6px" }}>No Issues Detected</div>
                  <div style={{ fontSize: "13px", color: colors.textSecondary }}>Your catalog meets all readiness standards. You&apos;re ready to scale!</div>
                </div>
              ) : (
                <div>
                  {issues.map((item, idx) => {
                    const { id, type, severity, recommendation, affectedCount, items, affectedProductTitles } = item;
                    const isExpanded = expandedIssues[id];
                    const cfg = SEVERITY_CONFIG[severity?.toUpperCase()] || SEVERITY_CONFIG.LOW;
                    const parsedRec = parseRecommendation(recommendation);

                    return (
                      <div key={id} style={{ borderBottom: idx < issues.length - 1 ? `1px solid ${colors.border}` : "none" }}>
                        <div
                          onClick={() => toggleIssueExpansion(id)}
                          style={{
                            padding: "16px 20px",
                            display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
                            cursor: "pointer",
                            background: isExpanded ? colors.surfaceAlt : "transparent",
                            transition: "background 0.15s ease",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1, minWidth: 0 }}>
                            <div style={{
                              width: "8px", height: "8px", borderRadius: "50%",
                              background: cfg.dot, flexShrink: 0,
                            }} />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: "14px", fontWeight: 700, color: colors.textPrimary, marginBottom: "2px" }}>{type}</div>
                              <div style={{
                                fontSize: "12px", color: colors.textSecondary, lineHeight: "1.4",
                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
                              }}>
                                {parsedRec.shortSummary}
                              </div>
                            </div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
                            <span style={{
                              padding: "3px 10px", borderRadius: "20px",
                              background: colors.surfaceAlt, border: `1px solid ${colors.border}`,
                              fontSize: "12px", color: colors.textSecondary, fontWeight: 500,
                            }}>
                              {affectedCount} affected
                            </span>
                            <SeverityPill severity={severity} />
                            <span style={{
                              width: "24px", height: "24px", borderRadius: "50%",
                              background: colors.accentLight, color: colors.accent,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: "13px", fontWeight: 700,
                              transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                              transition: "transform 0.2s ease",
                            }}>
                              ⌄
                            </span>
                          </div>
                        </div>

                        <Collapsible open={isExpanded} id={id}>
                          <div style={{
                            padding: "0 20px 16px 44px",
                            background: colors.surfaceAlt,
                          }}>
                            {/* Structured Diagnosis & Action Panel */}
                            <div style={{
                              padding: "16px 20px",
                              marginBottom: "14px",
                              background: colors.surface,
                              border: `1px solid ${colors.border}`,
                              borderRadius: radius.md,
                              boxShadow: shadow.card,
                            }}>
                              {/* Impact Badges */}
                              {(parsedRec.trust || parsedRec.conversion || parsedRec.paid) && (
                                <div style={{
                                  display: "flex", flexWrap: "wrap", gap: "8px",
                                  marginBottom: (parsedRec.why || parsedRec.action) ? "14px" : "0",
                                  paddingBottom: (parsedRec.why || parsedRec.action) ? "12px" : "0",
                                  borderBottom: (parsedRec.why || parsedRec.action) ? `1px solid ${colors.border}` : "none",
                                }}>
                                  {parsedRec.trust && (
                                    <span style={{
                                      display: "inline-flex", alignItems: "center", gap: "6px",
                                      padding: "3px 10px", borderRadius: "14px",
                                      background: getImpactBadgeStyle(parsedRec.trust).bg,
                                      color: getImpactBadgeStyle(parsedRec.trust).color,
                                      fontSize: "11px", fontWeight: 600,
                                    }}>
                                      🛡️ Trust: <strong>{parsedRec.trust}</strong>
                                    </span>
                                  )}
                                  {parsedRec.conversion && (
                                    <span style={{
                                      display: "inline-flex", alignItems: "center", gap: "6px",
                                      padding: "3px 10px", borderRadius: "14px",
                                      background: getImpactBadgeStyle(parsedRec.conversion).bg,
                                      color: getImpactBadgeStyle(parsedRec.conversion).color,
                                      fontSize: "11px", fontWeight: 600,
                                    }}>
                                      ⚡ Conversion: <strong>{parsedRec.conversion}</strong>
                                    </span>
                                  )}
                                  {parsedRec.paid && (
                                    <span style={{
                                      display: "inline-flex", alignItems: "center", gap: "6px",
                                      padding: "3px 10px", borderRadius: "14px",
                                      background: getImpactBadgeStyle(parsedRec.paid).bg,
                                      color: getImpactBadgeStyle(parsedRec.paid).color,
                                      fontSize: "11px", fontWeight: 600,
                                    }}>
                                      🎯 Paid Traffic: <strong>{parsedRec.paid}</strong>
                                    </span>
                                  )}
                                </div>
                              )}

                              {/* Why & Action Grid */}
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px" }}>
                                {parsedRec.why && (
                                  <div style={{ background: colors.surfaceAlt, padding: "12px 14px", borderRadius: radius.sm, border: `1px solid ${colors.border}` }}>
                                    <div style={{ fontSize: "11px", fontWeight: 700, color: colors.textSecondary, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px" }}>
                                      Why Flagged & Business Impact
                                    </div>
                                    <div style={{ fontSize: "12px", color: colors.textPrimary, fontWeight: 500, lineHeight: "1.4" }}>
                                      {parsedRec.why}
                                    </div>
                                    {parsedRec.matters && (
                                      <div style={{ fontSize: "12px", color: colors.textSecondary, marginTop: "6px", lineHeight: "1.4" }}>
                                        {parsedRec.matters}
                                      </div>
                                    )}
                                  </div>
                                )}

                                {parsedRec.action && (
                                  <div style={{ background: "#F0F7FF", padding: "12px 14px", borderRadius: radius.sm, border: "1px solid #B4D5FF" }}>
                                    <div style={{ fontSize: "11px", fontWeight: 700, color: colors.info, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px" }}>
                                      💡 Recommended Action
                                    </div>
                                    <div style={{ fontSize: "12px", color: colors.textPrimary, fontWeight: 600, lineHeight: "1.4" }}>
                                      {parsedRec.action}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div style={{
                              background: colors.surface,
                              border: `1px solid ${colors.border}`,
                              borderRadius: radius.md,
                              overflow: "hidden",
                            }}>
                              {/* Sub-header */}
                              <div style={{ padding: "10px 16px",
                                borderBottom: `1px solid ${colors.border}`,
                                display: "flex", alignItems: "center", justifyContent: "space-between",
                              }}>
                                <span style={{ fontSize: "12px", fontWeight: 600, color: colors.textSecondary, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                  Affected Products ({items?.length ?? affectedProductTitles.length})
                                </span>
                                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                                  <span style={{ fontSize: "11px", color: colors.textMuted }}>Click to edit</span>
                                  {/* Override buttons */}
                                  {item.rawType && ['UNREALISTIC_INVENTORY', 'UNIFORM_INVENTORY'].includes(item.rawType) && (
                                    <>
                                      <div style={{ height: "12px", width: "1px", background: colors.border }} />
                                      <button
                                        onClick={() => handleToggleOverride(item.rawType, true)}
                                        disabled={isSavingOverride}
                                        style={{
                                          border: `1px solid ${colors.border}`,
                                          background: colors.surfaceAlt,
                                          color: colors.textSecondary,
                                          fontSize: "11px",
                                          fontWeight: 600,
                                          cursor: "pointer",
                                          padding: "4px 10px",
                                          borderRadius: "14px",
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "6px",
                                          transition: "all 0.2s ease"
                                        }}
                                        onMouseEnter={(e) => {
                                          e.currentTarget.style.background = colors.criticalBg;
                                          e.currentTarget.style.color = colors.critical;
                                          e.currentTarget.style.borderColor = colors.critical;
                                        }}
                                        onMouseLeave={(e) => {
                                          e.currentTarget.style.background = colors.surfaceAlt;
                                          e.currentTarget.style.color = colors.textSecondary;
                                          e.currentTarget.style.borderColor = colors.border;
                                        }}
                                      >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                                          <line x1="1" y1="1" x2="23" y2="23"></line>
                                        </svg>
                                        Ignore this rule because inventory visibility is not shown to customers on my storefront
                                      </button>
                                    </>
                                  )}
                                  {/* Delivery Risk override button */}
                                  {item.rawType && item.rawType === 'DELIVERY_RISK_CRITICAL' && (
                                    <>
                                      <div style={{ height: "12px", width: "1px", background: colors.border }} />
                                      <button
                                        onClick={() => handleToggleOverride('DELIVERY_RISK_CRITICAL', true)}
                                        disabled={isSavingOverride}
                                        style={{
                                          border: `1px solid #FF990050`,
                                          background: "#FFF8F0",
                                          color: "#7A4A00",
                                          fontSize: "11px",
                                          fontWeight: 600,
                                          cursor: "pointer",
                                          padding: "4px 10px",
                                          borderRadius: "14px",
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "6px",
                                          transition: "all 0.2s ease"
                                        }}
                                        onMouseEnter={(e) => {
                                          e.currentTarget.style.background = colors.warningBg;
                                          e.currentTarget.style.borderColor = colors.warning;
                                          e.currentTarget.style.color = colors.warning;
                                        }}
                                        onMouseLeave={(e) => {
                                          e.currentTarget.style.background = "#FFF8F0";
                                          e.currentTarget.style.borderColor = "#FF990050";
                                          e.currentTarget.style.color = "#7A4A00";
                                        }}
                                      >
                                        📦 Acknowledge as Intentional Business Model (Dropshipping / Made-to-Order)
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>

                              {/* Scrollable product list */}
                              <div style={{ maxHeight: "240px", overflowY: "auto" }}>
                                {(items ?? affectedProductTitles.map(t => ({ title: t, shopifyId: null }))).map((product, i) => {
                                  const productTitle = typeof product === "string" ? product : product.title;
                                  const shopifyId = typeof product === "string" ? null : product.shopifyId;
                                  const editUrl = shopifyId && shopDomain
                                    ? `https://${shopDomain}/admin/products/${shopifyId}`
                                    : null;
                                  const isLast = i === (items ?? affectedProductTitles).length - 1;

                                  return (
                                    <div
                                      key={i}
                                      onClick={() => editUrl && window.open(editUrl, "_blank")}
                                      style={{
                                        display: "flex", alignItems: "center", justifyContent: "space-between",
                                        padding: "10px 16px",
                                        borderBottom: isLast ? "none" : `1px solid ${colors.border}`,
                                        cursor: editUrl ? "pointer" : "default",
                                        transition: "background 0.12s ease",
                                        background: "transparent",
                                      }}
                                      onMouseEnter={e => { if (editUrl) e.currentTarget.style.background = colors.surfaceAlt; }}
                                      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
                                    >
                                      <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: 0 }}>
                                        <span style={{
                                          width: "6px", height: "6px", borderRadius: "50%",
                                          background: cfg.dot, flexShrink: 0,
                                        }} />
                                        <span style={{
                                          fontSize: "13px", color: colors.textPrimary, fontWeight: 500,
                                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                        }}>
                                          {productTitle}
                                        </span>
                                      </div>
                                      {editUrl && (
                                        <span style={{
                                          display: "flex", alignItems: "center", gap: "4px",
                                          fontSize: "11px", color: colors.accent, fontWeight: 600,
                                          flexShrink: 0, marginLeft: "12px",
                                        }}>
                                          Fix in Shopify
                                          <span style={{ fontSize: "14px", lineHeight: 1 }}>→</span>
                                        </span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        </Collapsible>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </Layout.Section>

          {/* ── 4. Product-Level Breakdown ── */}
          <Layout.Section>
            <SectionLabel>Product-Level Breakdown</SectionLabel>
            <Card>
              {/* Filter Bar */}
              <div style={{
                padding: "14px 20px",
                borderBottom: `1px solid ${colors.border}`,
                display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap",
              }}>
                <div style={{ flex: 1, minWidth: "200px" }}>
                  <TextField
                    placeholder="Search by product name…"
                    value={searchValue}
                    onChange={(val) => setSearchValue(val)}
                    autoComplete="off"
                    labelHidden
                    prefix={<span style={{ color: colors.textMuted }}>🔍</span>}
                  />
                </div>
                <div style={{ minWidth: "180px" }}>
                  <Select
                    options={[
                      { label: "All Severities", value: "ALL" },
                      { label: "Critical Only",  value: "CRITICAL" },
                      { label: "High Only",      value: "HIGH" },
                      { label: "Medium Only",    value: "MEDIUM" },
                      { label: "Low Only",       value: "LOW" },
                      { label: "Healthy Only",   value: "NONE" },
                    ]}
                    value={severityFilter}
                    onChange={(val) => setSeverityFilter(val)}
                    labelHidden
                  />
                </div>
                {(searchValue || severityFilter !== "ALL") && (
                  <button
                    onClick={() => { setSearchValue(""); setSeverityFilter("ALL"); }}
                    style={{
                      padding: "6px 14px", border: `1px solid ${colors.border}`,
                      borderRadius: radius.sm, background: "transparent",
                      fontSize: "13px", color: colors.textSecondary, cursor: "pointer",
                    }}
                  >
                    Clear filters
                  </button>
                )}
              </div>

              {/* Table */}
              <div style={{ opacity: isFeatureLocked ? 0.5 : 1, pointerEvents: isFeatureLocked ? "none" : "auto" }}>
                <IndexTable
                  resourceName={{ singular: "product", plural: "products" }}
                  itemCount={filteredProducts.length}
                  headings={[
                    { title: "Product Title" },
                    { title: <Tooltip content="Measures copy length, structure, benefit orientation, and lack of supplier boilerplate. A high description score means strong copy, but a product can still be high risk if delivery or image issues exist." dismissOnMouseOut><span>Desc Quality ⓘ</span></Tooltip> },
                    { title: <Tooltip content="Measures title, vendor, product type, tag, variant, image, and specification field coverage across catalog items." dismissOnMouseOut><span>Completeness ⓘ</span></Tooltip> },
                    { title: "Primary Issue" },
                    { title: "Recent Orders" },
                    { title: "Status / Severity" },
                  ]}
                  selectable={false}
                >
                  {filteredProducts.length === 0 ? (
                    <IndexTable.Row>
                      <IndexTable.Cell colSpan={6}>
                        <div style={{ padding: "60px", textAlign: "center" }}>
                          <div style={{ fontSize: "28px", marginBottom: "10px" }}>🔍</div>
                          <div style={{ fontSize: "15px", fontWeight: 600, color: colors.textPrimary, marginBottom: "4px" }}>No matching products</div>
                          <div style={{ fontSize: "13px", color: colors.textSecondary }}>Try adjusting your search or filter.</div>
                        </div>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ) : (
                    filteredProducts.map(({ id, title, issueType, severity, performance, descriptionQualityScore, completenessScore }, index) => (
                      <IndexTable.Row id={id} key={id} position={index}>
                        <IndexTable.Cell>
                          <div 
                            title={title}
                            style={{ 
                              fontSize: "13px", 
                              fontWeight: 600, 
                              color: colors.textPrimary,
                              maxWidth: "240px",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis"
                            }}
                          >
                            {title}
                          </div>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <span style={{ 
                            fontSize: "13px", 
                            fontWeight: 600, 
                            color: descriptionQualityScore >= 80 ? colors.success : descriptionQualityScore >= 50 ? colors.warning : colors.critical 
                          }}>
                            {descriptionQualityScore ?? 0}%
                          </span>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <span style={{ 
                            fontSize: "13px", 
                            fontWeight: 600, 
                            color: completenessScore >= 80 ? colors.success : completenessScore >= 50 ? colors.warning : colors.critical 
                          }}>
                            {completenessScore ?? 0}%
                          </span>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <span style={{ fontSize: "13px", color: issueType === "Healthy" ? colors.success : colors.textSecondary }}>
                            {issueType}
                          </span>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <span style={{ fontSize: "13px", fontWeight: 500, color: (performance?.orders > 0) ? colors.info : colors.textMuted }}>
                            {performance ? `${performance.orders} orders` : "—"}
                          </span>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <SeverityPill severity={severity} />
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))
                  )}
                </IndexTable>
              </div>
            </Card>
          </Layout.Section>

          {/* ── 5. Ignored Rules & Overrides Settings ── */}
          {overrides.length > 0 && (
            <Layout.Section>
              <SectionLabel>Ignored Rules & Overrides</SectionLabel>
              <Card>
                <div style={{ padding: "20px 24px" }}>
                  <div style={{ marginBottom: "16px" }}>
                    <div style={{ fontSize: "16px", fontWeight: 700, color: colors.textPrimary }}>
                      Ignored Rules Manager
                    </div>
                    <div style={{ fontSize: "13px", color: colors.textSecondary, marginTop: "4px" }}>
                      These active audits have been manually bypassed for your storefront. They will not impact your Scale Readiness Score or display active findings.
                    </div>
                    {overrides.length >= 3 && (
                      <div style={{
                        padding: "10px 14px",
                        borderRadius: radius.md,
                        background: colors.warningBg,
                        border: `1px solid ${colors.warning}30`,
                        display: "flex", alignItems: "center", gap: "8px",
                        marginTop: "12px"
                      }}>
                        <span style={{ fontSize: "16px" }}>⚠️</span>
                        <div style={{ fontSize: "13px", color: colors.warning, fontWeight: 600 }}>
                          Several trust-related warnings are currently ignored.
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {overrides.map((override) => (
                      <div
                        key={override.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "12px 16px",
                          border: `1px solid ${colors.border}`,
                          borderRadius: radius.md,
                          background: colors.surfaceAlt,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ fontSize: "14px" }}>👁️‍Q</span>
                          <span style={{ fontSize: "13px", fontWeight: 600, color: colors.textPrimary }}>
                            {override.ruleType.replace(/_/g, " ")}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <Button
                            size="slim"
                            outline
                            disabled={isSavingOverride}
                            onClick={() => handleToggleOverride(override.ruleType, false)}
                          >
                            Restore Rule
                          </Button>

                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            </Layout.Section>
          )}
        </Layout>

        {/* Bottom spacing */}
        <div style={{ height: "32px" }} />
      </Page>
    </div>
  );
}
