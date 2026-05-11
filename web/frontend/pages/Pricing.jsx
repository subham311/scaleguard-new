import { useState, useEffect } from "react";
import {
  Page,
  Text,
  Button,
  Badge,
  HorizontalStack,
  Box,
  VerticalStack,
  Spinner,
} from "@shopify/polaris";
import { useBilling } from "../hooks/useBilling";
import { usePricingPlans } from "../hooks/usePricingPlans";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useNavigate } from "react-router-dom";

export default function Pricing() {
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [selectedPlanName, setSelectedPlanName] = useState(null);
  const { mutate: createCharge, isLoading: isCreatingCharge } = useBilling();
  const { data: plans, isLoading: isLoadingPlans, isError } = usePricingPlans();

  const handleSelectPlan = (planName) => {
    setSelectedPlanName(planName);
    createCharge(planName, {
      onSuccess: (data) => {
        setSelectedPlanName(null);
        if (data && data.confirmationUrl) {
          window.top.location.href = data.confirmationUrl;
        } else {
          shopify.toast.show("Successfully selected plan");
          // Redirect to dashboard after a short delay to show toast
          setTimeout(() => {
            navigate("/dashboard");
          }, 1500);
        }
      },
      onError: (error) => {
        setSelectedPlanName(null);
        shopify.toast.show(error.message || "Failed to create billing charge. Please try again.", {
          isError: true,
        });
      },
    });
  };

  const CheckIcon = () => (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fillRule="evenodd" clipRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" fill="var(--p-color-text-success)"/>
    </svg>
  );

  if (isLoadingPlans) {
    return (
      <Page>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "50vh" }}>
          <Spinner size="large" />
        </div>
      </Page>
    );
  }

  if (isError || !plans) {
    return (
      <Page>
        <div style={{ textAlign: "center", marginTop: "40px" }}>
          <Text as="h2" variant="headingLg" tone="critical">Failed to load pricing plans</Text>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <div style={{ textAlign: "center", marginTop: "40px", marginBottom: "48px" }}>
        <Text as="h1" variant="heading3xl">Simple, transparent pricing</Text>
        <div style={{ marginTop: "16px", maxWidth: "600px", margin: "16px auto 0" }}>
          <Text as="p" variant="bodyLg" tone="subdued">
            Choose the right ScaleGuard plan for your store's readiness. Simple pricing, no hidden fees.
          </Text>
        </div>
      </div>

      <div style={{
        display: "flex",
        flexDirection: "row",
        justifyContent: "center",
        alignItems: "stretch",
        gap: "24px",
        maxWidth: "1040px",
        margin: "0 auto",
        flexWrap: "wrap",
        paddingBottom: "60px"
      }}>
        {plans.map((plan) => (
          <div key={plan.id} style={{
            flex: "1 1 300px",
            maxWidth: "320px",
            backgroundColor: "var(--p-color-bg-surface)",
            borderRadius: "12px",
            boxShadow: plan.isPopular ? "0 12px 24px rgba(0,0,0,0.08), 0 4px 8px rgba(0,0,0,0.04)" : "0 2px 4px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.05)",
            border: plan.isPopular ? "2px solid #2c6ecb" : "1px solid var(--p-color-border)",
            padding: "32px",
            display: "flex",
            flexDirection: "column",
            position: "relative",
            transform: plan.isPopular ? "scale(1.02)" : "none",
            zIndex: plan.isPopular ? 1 : 0
          }}>
            {plan.isPopular && (
              <div style={{ position: "absolute", top: "-12px", left: "0", right: "0", textAlign: "center" }}>
                <Badge status="info">Most Popular</Badge>
              </div>
            )}
            <Text as="h2" variant="headingLg">{plan.name}</Text>
            <div style={{ marginTop: "8px", minHeight: "48px" }}>
              <Text as="p" variant="bodyMd" tone="subdued">{plan.description}</Text>
            </div>
            <div style={{ margin: "24px 0" }}>
              <Text as="h3" variant="heading3xl">${plan.price} <span style={{ fontSize: "16px", fontWeight: "normal", color: "var(--p-color-text-subdued)" }}>/mo</span></Text>
            </div>
            <Button 
              primary={plan.isPopular} 
              fullWidth 
              onClick={() => handleSelectPlan(plan.name)} 
              loading={isCreatingCharge && selectedPlanName === plan.name}
              disabled={isCreatingCharge && selectedPlanName !== plan.name}
            >
              Select {plan.name}
            </Button>
            
            <div style={{ height: "1px", backgroundColor: "var(--p-color-border)", margin: "24px 0" }} />
            
            <ul style={{ listStyle: "none", padding: 0, margin: 0, flex: 1 }}>
              {plan.features.map((feat, i) => (
                <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "16px" }}>
                  <div style={{ marginTop: "2px" }}><CheckIcon /></div>
                  <Text as="span" variant="bodyMd">{feat}</Text>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Page>
  );
}

