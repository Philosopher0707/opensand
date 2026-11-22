import type { Room, DiscussionResult, CreateRoomInput } from "../../../src/shell/rooms-model";

export interface RoomsData {
  getRooms(): Promise<Room[]>;
  createRoom(payload: CreateRoomInput): Promise<Room>;
  conveneDiscussion(roomId: string, topic: string): Promise<DiscussionResult>;
}

export function roomsData(bridge?: any, http?: typeof fetch): RoomsData {
  const getBridge = () => bridge ?? (typeof window !== "undefined" ? (window as any).opensand : undefined);
  return {
    async getRooms(): Promise<Room[]> {
      if (typeof window !== "undefined" && (window as any).__testRooms !== undefined) {
        return (window as any).__testRooms;
      }
      const b = getBridge();
      if (b?.getRooms) {
        try {
          const res = await b.getRooms();
          if (Array.isArray(res)) return res;
        } catch {
          // fall through to the HTTP route
        }
      }
      try {
        const res = http ? await http("/api/rooms") : await fetch("/api/rooms");
        if (res.ok) {
          const data = await res.json();
          return Array.isArray(data) ? data : [];
        }
      } catch {
        // Fallback when the fetch route is not available
      }
      return [];
    },

    async createRoom(payload: CreateRoomInput): Promise<Room> {
      const b = getBridge();
      if (b?.createRoom) {
        try {
          return await b.createRoom(payload);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http("/api/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not create room (HTTP ${res.status})`);
      return data as Room;
    },

    async conveneDiscussion(roomId: string, topic: string): Promise<DiscussionResult> {
      const b = getBridge();
      if (b?.runRoomDiscussion) {
        try {
          return await b.runRoomDiscussion(roomId, topic);
        } catch {
          // fall through to the HTTP route
        }
      }
      const res = http
        ? await http(`/api/rooms/${encodeURIComponent(roomId)}/discuss`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topic }),
          })
        : await fetch(`/api/rooms/${encodeURIComponent(roomId)}/discuss`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topic }),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Could not start discussion (HTTP ${res.status})`);
      return data as DiscussionResult;
    },
  };
}
