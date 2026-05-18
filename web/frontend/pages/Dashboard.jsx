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

function ScoreRing({ score, color }) {
  const size = 64;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const fill = ((score || 0) / 100) * circ;

  return (
    <svg width={size} height={size} style={{ display: "block" }}>
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
      <text x="50%" y="52%" dominantBaseline="middle" textAnchor="middle" fontSize="13" fontWeight="700" fill={colors.textPrimary}>
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

const VERDICT_CONFIG = {
  "Ready to Scale: Proceed with ad spend": { bg: colors.successBg, border: "#00806020", color: colors.success, icon: "✦" },
  "Almost Ready: Fix remaining issues": { bg: colors.infoBg, border: "#1865C220", color: colors.info, icon: "◑" },
  "Not Ready: Do not run ads": { bg: colors.warningBg, border: "#99520020", color: colors.warning, icon: "⚠" },
  "High Risk: Stop paid traffic": { bg: colors.criticalBg, border: "#AE2E2420", color: colors.critical, icon: "🚫" },
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

  useEffect(() => {
    if (!isLoading) {
      const status = data?.subscription?.status;
      if (status !== "ACTIVE" && status !== "PENDING") {
        navigate("/", { replace: true });
      }
    }
  }, [data, isLoading, navigate]);

  const handleRunSync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch("/v1/jobs/trigger-sync", { method: "POST" });
      if (response.ok) {
        shopify.toast.show("Sync started successfully.");
        await refetch();
      } else {
        shopify.toast.show("Failed to start sync.", { isError: true });
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
  const scores = data?.scores || { productDataQuality: 0, visualTrust: 0, catalogConsistency: 0, conversionReadiness: 0 };
  const scoreExplanations = data?.scoreExplanations || {};
  const issues = data?.issues || [];
  const products = data?.products || [];
  const shopDomain = data?.shop?.domain || "";
  const isFeatureLocked = data?.plan === "LIGHT" && false;

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
    },
    {
      label: "Visual Trust",
      measures: "Image count, missing images, excessive imagery",
      score: scores.visualTrust,
      color: "#00A3BF",
      icon: "◉",
      explanation: scoreExplanations?.visualTrust?.explanation || null,
    },
    {
      label: "Consistency",
      measures: "Pricing gaps, inventory anomalies, catalog coherence",
      score: scores.catalogConsistency,
      color: "#00B779",
      icon: "◆",
      explanation: scoreExplanations?.consistency?.explanation || null,
    },
    {
      label: "Readiness",
      measures: "Commercial readiness & scaling risk",
      score: scores.conversionReadiness,
      color: "#637381",
      icon: "◎",
      explanation: scoreExplanations?.readiness?.explanation || null,
    },
  ];

  return (
    <div style={{ background: colors.surfaceAlt, minHeight: "100vh" }}>
      {/* ── Page Shell ── */}
      <Page
        title=""
        primaryAction={{
          content: "Run Sync",
          onAction: handleRunSync,
          loading: isSyncing,
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
                <span style={{ fontSize: "10px", color: colors.textSecondary, textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.03em" }}>Products Audited</span>
                <span style={{ fontSize: "14px", fontWeight: 700, color: colors.textPrimary, marginTop: "2px" }}>
                  {data.planDetails.productsAnalyzed} / {data.planDetails.maxProducts} limit
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

          {/* ── 2. Health Score Cards ── */}
          <Layout.Section>
            <SectionLabel>Catalog Health Overview</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "14px" }}>
              {scoreMetrics.map((metric) => (
                <Card key={metric.label} hover style={{ padding: "20px 16px" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                    <ScoreRing score={metric.score} color={metric.color} />
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: "14px", fontWeight: 700, color: colors.textPrimary }}>{metric.label}</div>
                      <div style={{ fontSize: "10px", color: colors.accent, fontWeight: 600, marginTop: "2px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
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

          {/* ── 3. Priority Fixes ── */}
          <Layout.Section>
            <SectionLabel>Priority Risks Before Scaling</SectionLabel>
            <Card>
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${colors.border}` }}>
                <div style={{ fontSize: "13px", color: colors.textSecondary }}>
                  Grouped by issue type — tackle these to improve your readiness score.
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
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: "14px", fontWeight: 600, color: colors.textPrimary, marginBottom: "2px" }}>{type}</div>
                              <div style={{ fontSize: "12px", color: colors.textSecondary, lineHeight: "1.4", marginTop: "4px" }}>
                                {recommendation}
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
                                <span style={{ fontSize: "11px", color: colors.textMuted }}>Click a product to fix in Shopify</span>
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
                    { title: "Primary Issue" },
                    { title: "Recent Orders" },
                    { title: "Status / Severity" },
                  ]}
                  selectable={false}
                >
                  {filteredProducts.length === 0 ? (
                    <IndexTable.Row>
                      <IndexTable.Cell colSpan={3}>
                        <div style={{ padding: "60px", textAlign: "center" }}>
                          <div style={{ fontSize: "28px", marginBottom: "10px" }}>🔍</div>
                          <div style={{ fontSize: "15px", fontWeight: 600, color: colors.textPrimary, marginBottom: "4px" }}>No matching products</div>
                          <div style={{ fontSize: "13px", color: colors.textSecondary }}>Try adjusting your search or filter.</div>
                        </div>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ) : (
                    filteredProducts.map(({ id, title, issueType, severity, performance }, index) => (
                      <IndexTable.Row id={id} key={id} position={index}>
                        <IndexTable.Cell>
                          <span style={{ fontSize: "13px", fontWeight: 600, color: colors.textPrimary }}>{title}</span>
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
        </Layout>

        {/* Bottom spacing */}
        <div style={{ height: "32px" }} />
      </Page>
    </div>
  );
}
