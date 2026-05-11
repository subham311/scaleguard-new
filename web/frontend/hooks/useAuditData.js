import { useQuery } from "react-query";

export function useAuditData() {
  return useQuery({
    queryKey: ["auditData"],
    queryFn: async () => {
      const response = await fetch("/v1/api/dashboard");
      if (!response.ok) {
        throw new Error("Network response was not ok");
      }
      return response.json();
    },
    refetchOnWindowFocus: false,
  });
}
