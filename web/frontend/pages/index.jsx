import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Page,
  Text,
  Button,
  Badge,
} from "@shopify/polaris";
import { useAuditData } from "../hooks/useAuditData";

export default function HomePage() {
  const navigate = useNavigate();
  const { data, isLoading } = useAuditData();

  useEffect(() => {
    if (!isLoading) {
      // If store already has completed audit or active subscription, go directly to Dashboard
      if (data?.verdict && data.verdict !== 'Waiting for Sync') {
        navigate("/Dashboard", { replace: true });
      }
    }
  }, [data, isLoading, navigate]);

  const hasUsedFreeAudit = data?.hasUsedFreeAudit;
  const isSubscribed = data?.isSubscribed;

  let auditButtonText = "Run Free Store Audit";
  let helperText = "1 free initial store audit included. No credit card or upfront plan selection required.";

  if (isSubscribed) {
    auditButtonText = "Go to Live Dashboard";
    helperText = "Your store is enrolled in continuous commercial monitoring.";
  } else if (hasUsedFreeAudit) {
    auditButtonText = "View Audit Report";
    helperText = "Review your free audit findings. Upgrade anytime to unlock all findings.";
  }

  if (isLoading) {
    return (
      <Page>
        <div style={{ padding: "60px 20px", textAlign: "center" }}>
          <Text as="p" variant="bodyLg">Loading ScaleGuard...</Text>
        </div>
      </Page>
    );
  }

  const FeatureCard = ({ icon, title, description }) => (
    <div style={{
      flex: "1 1 300px",
      backgroundColor: "#ffffff",
      borderRadius: "12px",
      border: "1px solid var(--p-color-border)",
      padding: "32px",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: "16px"
    }}>
      <div style={{
        width: "48px",
        height: "48px",
        borderRadius: "8px",
        backgroundColor: "var(--p-color-bg-surface-secondary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "24px"
      }}>
        {icon}
      </div>
      <Text as="h3" variant="headingLg">{title}</Text>
      <Text as="p" variant="bodyMd" tone="subdued">{description}</Text>
    </div>
  );

  return (
    <div style={{ backgroundColor: "var(--p-color-bg)", minHeight: "100vh", padding: "40px 20px" }}>
      <div style={{ maxWidth: "1040px", margin: "0 auto" }}>
        {/* Hero Section */}
        <div style={{ 
          textAlign: "center", 
          padding: "80px 20px 60px",
          backgroundColor: "#ffffff",
          borderRadius: "16px",
          border: "1px solid var(--p-color-border)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.03)",
          marginBottom: "32px"
        }}>
          <Badge status="critical">The Pre-Scale Audit Engine</Badge>
          <div style={{ marginTop: "24px", marginBottom: "24px" }}>
            <Text as="h1" variant="heading3xl">
              Stop wasting ad spend on a store that isn't ready.
            </Text>
          </div>
          <div style={{ maxWidth: "700px", margin: "0 auto 32px" }}>
            <Text as="p" variant="bodyLg" tone="subdued">
              ScaleGuard is the brutally honest pre-scale audit engine. We analyze your catalog health, visual trust, and consistency to give you a definitive verdict: Ready to Scale, or High Risk.
            </Text>
          </div>
          <Button size="large" primary onClick={() => navigate("/Dashboard")}>
            {auditButtonText}
          </Button>
          <div style={{ marginTop: "12px" }}>
            <Text as="p" variant="bodySm" tone="subdued">
              {helperText}
            </Text>
          </div>
        </div>

        {/* Analysis-Only Assurance */}
        <div style={{
          backgroundColor: "#f6f8fa",
          borderRadius: "12px",
          border: "1px solid #d0d7de",
          padding: "20px 24px",
          marginBottom: "32px",
          display: "flex",
          alignItems: "flex-start",
          gap: "16px"
        }}>
          <div style={{
            fontSize: "24px",
            lineHeight: 1,
            flexShrink: 0,
            marginTop: "2px"
          }}>
            🛡️
          </div>
          <div>
            <div style={{ marginBottom: "6px" }}>
              <Text as="h3" variant="headingSm" fontWeight="bold">
                100% Analysis-Only — Zero Store Modifications
              </Text>
            </div>
            <Text as="p" variant="bodySm" tone="subdued">
              <strong>ScaleGuard is analysis-only.</strong> It does not change orders, products, prices, descriptions, images, theme, layout, customers or settings. Orders access is used only to understand order activity, fulfilment/shipping patterns and delivery-related signals to protect your ad spend.
            </Text>
          </div>
        </div>

        {/* Features Section */}
        <div style={{
          display: "flex",
          flexDirection: "row",
          gap: "24px",
          flexWrap: "wrap",
        }}>
          <FeatureCard 
            icon="🔍"
            title="Deep Catalog Detection"
            description="We instantly detect missing prices, missing images, weak descriptions, and incomplete variants across your entire store."
          />
          <FeatureCard 
            icon="⚖️"
            title="The Scaling Verdict"
            description="No confusing vanity metrics. Get a single, definitive decision: Ready to Scale, Almost Ready, Not Ready, or High Risk."
          />
          <FeatureCard 
            icon="🛠️"
            title="Prioritized Fixes"
            description="Don't guess what to fix. We give you a prioritized list of the exact products that are hurting your conversion rate."
          />
        </div>
      </div>
    </div>
  );
}
