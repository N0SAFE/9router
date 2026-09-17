import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";
import SubscriptionOptimizer from "../usage/components/SubscriptionOptimizer";

export default function QuotaPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <div className="flex min-w-0 flex-col gap-4">
        <SubscriptionOptimizer />
        <ProviderLimits />
      </div>
    </Suspense>
  );
}
