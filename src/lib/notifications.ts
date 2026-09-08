let permissionRequested = false;
let permissionGranted = false;

export function requestNotificationPermission(): void {
  if (permissionRequested) return;
  if (typeof Notification === "undefined") return;
  permissionRequested = true;
  if (Notification.permission === "granted") {
    permissionGranted = true;
    return;
  }
  if (Notification.permission === "denied") return;
  Notification.requestPermission().then((result) => {
    permissionGranted = result === "granted";
  });
}

export function isNotificationPermissionGranted(): boolean {
  if (typeof Notification === "undefined") return false;
  return Notification.permission === "granted";
}

export function showNotification(
  title: string,
  body: string,
  options?: { tag?: string; icon?: string },
): void {
  if (!isNotificationPermissionGranted()) return;
  if (document.hasFocus()) return;

  try {
    const notif = new Notification(title, {
      body,
      tag: options?.tag,
      icon: options?.icon,
      silent: false,
    });
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
    setTimeout(() => notif.close(), 8000);
  } catch (e) {
    console.warn("[Notifications] Failed to show notification:", e);
  }
}

export function notifyMention(username: string, text: string): void {
  const truncated = text.length > 80 ? text.slice(0, 80) + "..." : text;
  showNotification(`💬 Mentioned by ${username}`, truncated, { tag: "mention" });
}

export function notifyAutoForgeError(error: string): void {
  const truncated = error.length > 100 ? error.slice(0, 100) + "..." : error;
  showNotification("⚠️ AutoForge Error", truncated, { tag: "autoforge-error" });
}

export function notifyActivitySpike(newLines: number, velocity: number): void {
  showNotification("🔥 Activity Spike", `${newLines} new messages | ${velocity}/min velocity`, {
    tag: "activity-spike",
  });
}

export function notifyProviderFailure(provider: string): void {
  showNotification("🔌 Provider Fallback", `${provider} failed — falling back to next provider`, {
    tag: "provider-fallback",
  });
}

export function notifyQueueMessage(message: string): void {
  const truncated = message.length > 60 ? message.slice(0, 60) + "..." : message;
  showNotification("📤 Message Queued", `Will retry: "${truncated}"`, { tag: "message-queue" });
}
