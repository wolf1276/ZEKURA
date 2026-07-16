"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { matcher } from "@/services/matcher/matcherClient";
import { readSetting } from "@/hooks/use-settings";
import { showBrowserNotification } from "@/hooks/use-notification-preferences";

const TYPE_TO_SETTING: Record<string, "notifyFilled" | "notifySettled" | "notifyErrors"> = {
  ORDER_FILLED: "notifyFilled",
  SETTLEMENT_STARTED: "notifySettled",
  ORDER_FAILED: "notifyErrors",
};

const TYPE_TO_LABEL: Record<string, string> = {
  ORDER_FILLED: "Order filled",
  SETTLEMENT_STARTED: "Settlement started",
  ORDER_FAILED: "Order failed",
};

const TYPE_TO_DESCRIPTION: Record<string, string> = {
  ORDER_FILLED: "Your order has been filled.",
  SETTLEMENT_STARTED: "Settlement has begun for your order.",
  ORDER_FAILED: "Your order could not be completed.",
};

export function WebNotificationEffect() {
  useEffect(() => {
    return matcher.subscribeActivity((event) => {
      const settingKey = TYPE_TO_SETTING[event.kind];
      if (!settingKey) return;
      if (!readSetting(settingKey)) return;

      const label = TYPE_TO_LABEL[event.kind] ?? event.kind;
      const description = TYPE_TO_DESCRIPTION[event.kind] ?? "";

      toast.success(`${label}: ${event.pair} ${event.side} ${event.amount} @ ${event.price}`);

      void showBrowserNotification(label, `${description}\n${event.pair} ${event.side} ${event.amount} @ ${event.price}`);
    });
  }, []);

  return null;
}
