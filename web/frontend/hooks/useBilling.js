import { useMutation } from "react-query";

export function useBilling() {
  return useMutation({
    mutationFn: async (planName) => {
      const response = await fetch("/v1/billing/create-charge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan: planName }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || errorData.error || "Failed to create charge");
      }
      return response.json();
    },
  });
}
