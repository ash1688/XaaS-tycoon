// The playtest log's browser half: what the student does in the UI (pages, modals, price previews, quotes, controls),
// queued and sent to the server in small batches. It never shows an error or holds the game up: a batch that fails is
// dropped.
import type { UiEventParams, UiEventsBody, UiEventType } from "@xaas/server/api-types";

/** How long an event waits for others to join its batch. */
const BATCH_MS = 5000;
/** The most events a batch carries: the server's limit. */
const MAX_BATCH = 50;

/** "loadBalancer" or "Set your price" -> "load-balancer", "set-your-price": the form the server takes ids in. */
export const toId = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** day: the game's day now, or undefined before the game has loaded, when an event takes the day it's sent on. */
export function createUiLog(code: string, id: string, day: () => number | undefined) {
  const url = `/api/codes/${encodeURIComponent(code)}/companies/${encodeURIComponent(id)}/ui-events`;
  const queued: { type: UiEventType; at: number; day: number | undefined; params?: UiEventParams }[] = [];
  let timer: number | undefined;

  function track(type: UiEventType, given?: UiEventParams) {
    const params = given && { ...given };
    for (const key of ["control", "value", "modal", "page"] as const) {
      if (params?.[key] !== undefined) params[key] = toId(params[key]!);
    }
    queued.push({ type, at: Date.now(), day: day(), params });
    if (queued.length >= MAX_BATCH) send();
    else timer ??= window.setTimeout(send, BATCH_MS);
  }

  /** Sends what's queued. keepalive lets the last batch go out as the page closes. */
  function send(keepalive = false) {
    window.clearTimeout(timer);
    timer = undefined;
    const now = Date.now();
    while (queued.length) {
      const batch = queued.splice(0, MAX_BATCH);
      const body: UiEventsBody = {
        events: batch.map((e) => ({ type: e.type, ago: Math.max(0, now - e.at), day: e.day ?? day() ?? 0, params: e.params })),
      };
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive }).catch(
        () => {},
      );
    }
  }

  // Sends straight away when the tab is hidden or closed, which may be the last chance.
  const onHidden = () => document.visibilityState === "hidden" && send(true);
  const onPageHide = () => send(true);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onPageHide);

  function stop() {
    send(true);
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("pagehide", onPageHide);
  }

  return { track, send, stop };
}
