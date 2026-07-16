"use client";

import { readSetting } from "@/hooks/use-settings";

export type NotificationType = "filled" | "settled" | "errors";

const SETTING_MAP: Record<NotificationType, "notifyFilled" | "notifySettled" | "notifyErrors"> = {
  filled: "notifyFilled",
  settled: "notifySettled",
  errors: "notifyErrors",
};

export function shouldNotify(type: NotificationType): boolean {
  return readSetting(SETTING_MAP[type]);
}

export async function showBrowserNotification(title: string, body: string): Promise<void> {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  if (!readSetting("notifyBrowser")) return;

  try {
    const n = new Notification(title, { body, icon: "/favicon.ico" });
    setTimeout(() => n.close(), 5000);
  } catch {
    // Notification may fail if permissions revoked mid-session
  }
}
