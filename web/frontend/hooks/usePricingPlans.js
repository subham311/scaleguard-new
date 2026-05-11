import { useQuery } from "react-query";

export function usePricingPlans() {
  return useQuery({
    queryKey: ["pricingPlans"],
    queryFn: async () => {
      const response = await fetch("/v1/billing/pricing-plans");
      if (!response.ok) {
        throw new Error("Failed to fetch pricing plans");
      }
      return response.json();
    },
  });
}
