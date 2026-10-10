"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Subscribe to a Server-Sent Events URL.
 * The browser reconnects on its own; `status` tells the UI what is going on.
 */
export function useEventSource(url, onMessage) {
  const [status, setStatus] = useState("connecting");
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    const es = new EventSource(url);
    es.onopen = () => setStatus("live");
    es.onerror = () => setStatus("reconnecting");
    es.onmessage = (e) => {
      try {
        handler.current(JSON.parse(e.data));
      } catch {
        /* ignore a malformed event */
      }
    };
    return () => es.close();
  }, [url]);

  return status;
}
