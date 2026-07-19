"use client";

import { useEffect, useState } from "react";
import {
  listPendingSettlements,
  subscribePendingSettlements,
  type PendingSettlement,
} from "@/services/midnight/pendingSettlements";

/** Live view of this profile's own orders awaiting settleWithProtocol approval — see services/midnight/pendingSettlements.ts. */
export function usePendingSettlements(): PendingSettlement[] {
  const [list, setList] = useState<PendingSettlement[]>(() => listPendingSettlements());

  useEffect(() => subscribePendingSettlements(setList), []);

  return list;
}
