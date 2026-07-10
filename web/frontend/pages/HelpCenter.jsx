import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Text,
  Button,
  Badge,
  Box,
  VerticalStack,
  HorizontalStack,
  Spinner,
  Banner,
  Tabs,
  TextField,
  Icon,
} from "@shopify/polaris";
import { useAuditData } from "../hooks/useAuditData";
import { useNavigate } from "react-router-dom";
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

/* ─────────────────────────── Custom Card ───────────────────────────── */
function CustomCard({ children, padding = "24px", style = {} }) {
  return (
    <div style={{
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      border: `1px solid ${colors.border}`,
      boxShadow: shadow.card,
      padding: padding,
      width: "100%",
      ...style
    }}>
      {children}
    </div>
  );
}

/* ─────────────────────────── Collapsible FAQ Row ─────────────────────── */
function FAQRow({ question, answer }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div style={{
      borderBottom: `1px solid ${colors.border}`,
      padding: "16px 0",
    }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: "100%",
          background: "none",
          border: "none",
          padding: 0,
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: "inherit"
        }}
      >
        <Text as="span" variant="headingMd" tone="neutral">
          {question}
        </Text>
        <span style={{
          fontSize: "20px",
          color: colors.textSecondary,
          transform: isOpen ? "rotate(45deg)" : "none",
          transition: "transform 0.2s ease"
        }}>
          ＋
        </span>
      </button>
      {isOpen && (
        <div style={{ marginTop: "12px", paddingRight: "24px" }}>
          <Text as="p" variant="bodyMd" tone="subdued">
            {answer}
          </Text>
        </div>
      )}
    </div>
  );
}

export default function HelpCenter() {
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const { data: auditData, isLoading, refetch } = useAuditData();
  const [selectedTab, setSelectedTab] = useState(0);

  // Form states
  const [formName, setFormName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formSubject, setFormSubject] = useState("");
  const [formMessage, setFormMessage] = useState("");
  
  const [formErrors, setFormErrors] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccessMessage, setSubmitSuccessMessage] = useState(null);

  // Checkbox override states for manual checklist items
  const [fixesApplied, setFixesApplied] = useState(false);
  const [reRunCompleted, setReRunCompleted] = useState(false);

  const handleTabChange = (selectedTabIndex) => {
    setSelectedTab(selectedTabIndex);
    setSubmitSuccessMessage(null);
  };

  const isActiveSubscriber = auditData?.subscription?.status === "ACTIVE";
  const hasAuditRun = auditData?.verdict && auditData?.verdict !== "Waiting for Sync";

  // Calculate dynamic onboarding guide steps
  const steps = [
    {
      id: 1,
      title: "i. Install ScaleGuard",
      description: "App successfully installed and connected to your store.",
      completed: true,
      actionLabel: null,
      onAction: null
    },
    {
      id: 2,
      title: "ii. Run your first audit",
      description: "Scan your products, descriptions, pricing, and images for commercial quality.",
      completed: !!hasAuditRun,
      actionLabel: !hasAuditRun ? "Go to Dashboard" : null,
      onAction: () => navigate("/Dashboard")
    },
    {
      id: 3,
      title: "iii. Review your Store Readiness Verdict",
      description: "Analyze your composite Readiness score and final scaling classification.",
      completed: !!hasAuditRun,
      actionLabel: hasAuditRun ? "View Verdict" : null,
      onAction: () => navigate("/Dashboard")
    },
    {
      id: 4,
      title: "iv. Review detected issues",
      description: "Inspect specific visual trust, catalog consistency, or quality risks flagged.",
      completed: !!hasAuditRun,
      actionLabel: hasAuditRun ? "Inspect Issues" : null,
      onAction: () => navigate("/Dashboard")
    },
    {
      id: 5,
      title: "v. Review recommendations",
      description: "Check the prioritized advice and quick wins recommended for your store.",
      completed: hasAuditRun && auditData?.quickWins?.length > 0,
      actionLabel: hasAuditRun ? "View Advice" : null,
      onAction: () => navigate("/Dashboard")
    },
    {
      id: 6,
      title: "vi. Apply fixes",
      description: "Address flagged issues in your Shopify Admin (e.g. write description, upload images).",
      completed: fixesApplied || (hasAuditRun && auditData?.issues?.length === 0),
      actionLabel: "Open Shopify Admin",
      onAction: () => window.open("https://admin.shopify.com", "_blank"),
      isInteractive: true,
      checked: fixesApplied,
      onToggle: () => setFixesApplied(!fixesApplied)
    },
    {
      id: 7,
      title: "vii. Re-run the audit",
      description: "Trigger another analysis sync from your Dashboard to verify applied fixes.",
      completed: reRunCompleted || (hasAuditRun && auditData?.shop?.dataCollectedAt !== auditData?.shop?.createdAt),
      actionLabel: "Go to Dashboard",
      onAction: () => navigate("/Dashboard"),
      isInteractive: true,
      checked: reRunCompleted,
      onToggle: () => setReRunCompleted(!reRunCompleted)
    }
  ];

  const completedStepsCount = steps.filter(s => s.completed).length;
  const progressPercent = Math.round((completedStepsCount / steps.length) * 100);

  const handleSupportSubmit = async () => {
    // Basic validation
    const errors = {};
    if (!formName.trim()) errors.name = "Name is required";
    if (!formEmail.trim()) {
      errors.email = "Email is required";
    } else if (!/\S+@\S+\.\S+/.test(formEmail)) {
      errors.email = "Please enter a valid email address";
    }
    if (!formSubject.trim()) errors.subject = "Subject is required";
    if (!formMessage.trim()) {
      errors.message = "Message is required";
    } else if (formMessage.trim().length < 10) {
      errors.message = "Message must be at least 10 characters";
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      shopify.toast.show("Please fix the validation errors.", { isError: true });
      return;
    }

    setFormErrors({});
    setIsSubmitting(true);

    try {
      const response = await fetch("/v1/api/support", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: formName,
          email: formEmail,
          subject: formSubject,
          message: formMessage,
        }),
      });

      const resData = await response.json();

      if (response.ok && resData.success) {
        setSubmitSuccessMessage(resData.message);
        shopify.toast.show("Inquiry sent successfully.");
        // Clear fields
        setFormSubject("");
        setFormMessage("");
      } else {
        shopify.toast.show(resData.error || "Failed to submit enquiry.", { isError: true });
      }
    } catch (err) {
      console.error(err);
      shopify.toast.show("An error occurred during submission.", { isError: true });
    } finally {
      setIsSubmitting(false);
    }
  };

  const tabs = [
    {
      id: "getting-started",
      content: "Getting Started Guide",
      panelID: "getting-started-panel",
    },
    {
      id: "faq-docs",
      content: "FAQs & Documentation",
      panelID: "faq-docs-panel",
    },
    {
      id: "contact-support",
      content: "Contact Support",
      panelID: "contact-support-panel",
    },
  ];

  if (isLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
        <Spinner size="large" />
      </div>
    );
  }

  return (
    <Page title="Help Center">
      <div style={{ marginBottom: "24px" }}>
        <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange} fitted />
      </div>

      <Layout>
        <Layout.Section>
          {/* TAB 1: GETTING STARTED GUIDE */}
          {selectedTab === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              {/* Progress overview */}
              <CustomCard>
                <VerticalStack gap="4">
                  <HorizontalStack align="space-between">
                    <Text as="h2" variant="headingLg">Onboarding Roadmap</Text>
                    <Badge size="large" status={progressPercent === 100 ? "success" : "info"}>
                      {completedStepsCount} of {steps.length} Steps Completed ({progressPercent}%)
                    </Badge>
                  </HorizontalStack>
                  <Text as="p" tone="subdued">
                    Complete these step-by-step checklists to maximize your store conversion readiness and review confidence signals before routing advertising campaigns.
                  </Text>
                  
                  {/* Progress Bar Container */}
                  <div style={{
                    width: "100%",
                    height: "10px",
                    backgroundColor: colors.border,
                    borderRadius: "5px",
                    overflow: "hidden",
                    marginTop: "8px"
                  }}>
                    <div style={{
                      width: `${progressPercent}%`,
                      height: "100%",
                      background: `linear-gradient(90deg, ${colors.accent} 0%, #7c8beb 100%)`,
                      borderRadius: "5px",
                      transition: "width 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)"
                    }} />
                  </div>
                </VerticalStack>
              </CustomCard>

              {/* Steps timeline list */}
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {steps.map((step) => (
                  <div 
                    key={step.id}
                    style={{
                      backgroundColor: colors.surface,
                      borderRadius: radius.md,
                      border: step.completed ? `1px solid ${colors.success}40` : `1px solid ${colors.border}`,
                      boxShadow: shadow.card,
                      padding: "20px",
                      display: "flex",
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "20px",
                      flexWrap: "wrap",
                      transition: "all 0.2s ease",
                      borderLeft: step.completed ? `5px solid ${colors.success}` : `5px solid ${colors.textMuted}`
                    }}
                  >
                    <div style={{ flex: "1 1 350px" }}>
                      <HorizontalStack gap="3" align="start">
                        <div style={{
                          marginTop: "2px",
                          width: "22px",
                          height: "22px",
                          borderRadius: "50%",
                          backgroundColor: step.completed ? colors.successBg : colors.surfaceAlt,
                          border: `2px solid ${step.completed ? colors.success : colors.textMuted}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: step.completed ? colors.success : colors.textMuted,
                          fontSize: "12px",
                          fontWeight: "bold"
                        }}>
                          {step.completed ? "✓" : step.id}
                        </div>
                        <VerticalStack gap="1">
                          <Text as="h3" variant="headingMd" tone={step.completed ? "neutral" : "subdued"}>
                            {step.title}
                          </Text>
                          <Text as="p" variant="bodyMd" tone="subdued">
                            {step.description}
                          </Text>
                        </VerticalStack>
                      </HorizontalStack>
                    </div>

                    <HorizontalStack gap="3" align="center">
                      {step.isInteractive && (
                        <label style={{ 
                          display: "flex", 
                          alignItems: "center", 
                          gap: "8px", 
                          cursor: "pointer",
                          userSelect: "none",
                          fontSize: "14px",
                          color: colors.textSecondary
                        }}>
                          <input 
                            type="checkbox"
                            checked={step.checked}
                            onChange={step.onToggle}
                            style={{ 
                              width: "16px", 
                              height: "16px", 
                              accentColor: colors.accent,
                              cursor: "pointer"
                            }} 
                          />
                          Mark Done
                        </label>
                      )}
                      
                      {step.actionLabel && (
                        <Button onClick={step.onAction} size="slim" outline={!step.completed}>
                          {step.actionLabel}
                        </Button>
                      )}
                    </HorizontalStack>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 2: FAQS & DOCUMENTATION */}
          {selectedTab === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
              {/* External Docs Card */}
              <CustomCard>
                <VerticalStack gap="4">
                  <Text as="h2" variant="headingLg">Documentation Resources</Text>
                  <Text as="p" tone="subdued">
                    Browse externally hosted guides, tips, and best practices directly on the ScaleGuard portal to optimize your shop performance.
                  </Text>
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                    gap: "16px",
                    marginTop: "8px"
                  }}>
                    {[
                      { title: "Getting Started Guide", desc: "Detailed installation & initial setup guide.", url: "https://scaleguard.app/docs/getting-started" },
                      { title: "Catalog Trust Best Practices", desc: "Write premium descriptions & curate high-conversion images.", url: "https://scaleguard.app/docs/catalog-trust" },
                      { title: "Readiness Scores & Verdicts", desc: "Understand rating criteria and threshold models.", url: "https://scaleguard.app/docs/scores-and-verdicts" },
                      { title: "Fulfillment & Delivery Setup", desc: "Configure shipping details to lower delivery risk warnings.", url: "https://scaleguard.app/docs/fulfillment-risk" }
                    ].map((doc, idx) => (
                      <div 
                        key={idx}
                        onClick={() => window.open(doc.url, "_blank")}
                        style={{
                          border: `1px solid ${colors.border}`,
                          borderRadius: radius.md,
                          padding: "16px",
                          cursor: "pointer",
                          transition: "all 0.2s ease",
                          backgroundColor: colors.surfaceAlt,
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "space-between",
                          minHeight: "110px"
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = colors.accent;
                          e.currentTarget.style.boxShadow = shadow.hover;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = colors.border;
                          e.currentTarget.style.boxShadow = "none";
                        }}
                      >
                        <VerticalStack gap="1">
                          <Text as="span" variant="headingMd" tone="neutral">{doc.title}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">{doc.desc}</Text>
                        </VerticalStack>
                        <div style={{ marginTop: "12px", textAlign: "right" }}>
                          <Text as="span" variant="bodySm" tone="accent">Read doc →</Text>
                        </div>
                      </div>
                    ))}
                  </div>
                </VerticalStack>
              </CustomCard>

              {/* FAQs Accordion Card */}
              <CustomCard>
                <VerticalStack gap="4">
                  <Text as="h2" variant="headingLg">Frequently Asked Questions (FAQ)</Text>
                  <div style={{ display: "flex", flexDirection: "column", marginTop: "8px" }}>
                    <FAQRow 
                      question="What is the Store Readiness Verdict?" 
                      answer="The verdict is ScaleGuard's final readiness grade for your store before starting paid marketing. It is calculated based on 4 health categories: Data Quality, Visual Trust, Catalog Consistency, and Conversion Readiness. Scores range from 0 to 100, where >=85 means your store is Ready to Scale."
                    />
                    <FAQRow 
                      question="How frequently should I run an audit?" 
                      answer="Active subscribers can run manual syncs from the dashboard. Delta-monitoring also triggers background audits automatically depending on your plan tier (Weekly for Light, Daily for Growth, and every 3 Hours for Pro)."
                    />
                    <FAQRow 
                      question="What is a 'Spec Dump' description?" 
                      answer="A Spec Dump description is a product listing that is solely composed of raw technical specs, dimensions, or package contents without benefits-focused copywriting or purchase reassurance. This decreases purchase intent and conversions."
                    />
                    <FAQRow 
                      question="How do I solve image duplicate issues?" 
                      answer="Ensure you use unique images for distinct product variants, or edit supplier-provided graphics to reflect your brand's unique styles. Curate large galleries down to the best 6-12 high-impact visual resources."
                    />
                    <FAQRow 
                      question="How is the Dropshipping Perception Score calculated?" 
                      answer="It evaluates specific patterns that reveal dropshipping models, such as standard AliExpress/Temu supplier templates, pixelated supplier images, uniform inventory counts, and repetitive generic descriptions."
                    />
                  </div>
                </VerticalStack>
              </CustomCard>
            </div>
          )}

          {/* TAB 3: CONTACT SUPPORT */}
          {selectedTab === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              {!isActiveSubscriber ? (
                /* Non-subscriber Block State */
                <CustomCard>
                  <div style={{ 
                    padding: "40px 20px", 
                    textAlign: "center", 
                    display: "flex", 
                    flexDirection: "column", 
                    alignItems: "center",
                    gap: "16px",
                    maxWidth: "500px",
                    margin: "0 auto"
                  }}>
                    <div style={{ fontSize: "48px", marginBottom: "8px" }}>🔒</div>
                    <Text as="h2" variant="headingLg">Subscriber Priority Support Required</Text>
                    <Text as="p" tone="subdued">
                      Direct inquiries to ScaleGuard support team and automatic confirmation responses are premium features reserved for active subscription tiers (Light, Growth, or Pro).
                    </Text>
                    <div style={{ marginTop: "12px" }}>
                      <Button primary onClick={() => navigate("/Pricing")}>
                        View Subscription Plans
                      </Button>
                    </div>
                  </div>
                </CustomCard>
              ) : (
                /* Subscriber Inquiry Form */
                <CustomCard>
                  <VerticalStack gap="5">
                    <div>
                      <Text as="h2" variant="headingLg">Submit Support Inquiry</Text>
                      <Text as="p" tone="subdued">
                        Submit your technical or account questions directly to our support desk. We will get back to you shortly.
                      </Text>
                    </div>

                    {submitSuccessMessage ? (
                      <Banner status="success" onDismiss={() => setSubmitSuccessMessage(null)}>
                        <Text as="p" variant="bodyMd">
                          {submitSuccessMessage}
                        </Text>
                      </Banner>
                    ) : (
                      <form onSubmit={(e) => { e.preventDefault(); handleSupportSubmit(); }}>
                        <VerticalStack gap="4">
                          <TextField
                            label="Your Name"
                            value={formName}
                            onChange={(val) => setFormName(val)}
                            autoComplete="name"
                            error={formErrors.name}
                            disabled={isSubmitting}
                            placeholder="Enter your name"
                          />

                          <TextField
                            label="Contact Email Address"
                            type="email"
                            value={formEmail}
                            onChange={(val) => setFormEmail(val)}
                            autoComplete="email"
                            error={formErrors.email}
                            disabled={isSubmitting}
                            placeholder="merchant@example.com"
                          />

                          <TextField
                            label="Subject"
                            value={formSubject}
                            onChange={(val) => setFormSubject(val)}
                            autoComplete="off"
                            error={formErrors.subject}
                            disabled={isSubmitting}
                            placeholder="How can we help you?"
                          />

                          <TextField
                            label="Detailed Message"
                            value={formMessage}
                            onChange={(val) => setFormMessage(val)}
                            multiline={4}
                            autoComplete="off"
                            error={formErrors.message}
                            disabled={isSubmitting}
                            placeholder="Explain your inquiry in detail..."
                          />

                          <div style={{ marginTop: "8px" }}>
                            <Button 
                              submit 
                              primary 
                              loading={isSubmitting} 
                              disabled={isSubmitting}
                            >
                              Submit Inquiry
                            </Button>
                          </div>
                        </VerticalStack>
                      </form>
                    )}
                  </VerticalStack>
                </CustomCard>
              )}
            </div>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
