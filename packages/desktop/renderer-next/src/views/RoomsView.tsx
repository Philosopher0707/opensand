// Multi-Agent Collaborative Rooms view (Phase 5 Row 13).
// Replaces the #viewRooms stub with the room grid, creation modal and deliberation modal.
import { useEffect, useState } from "preact/hooks";
import type { ShellData, Room, DiscussionResult, AgentPersonaData } from "../data";
import {
  validateCreateRoomInput,
  formatRoomCard,
  createInitialModalState,
  openCreateRoomModal,
  closeCreateRoomModal,
  openConveneModal,
  closeConveneModal,
  appendTurns,
  formatConsensus,
  type DiscussionTurn,
} from "../../../src/shell/rooms-model";
import { NAV_GROUPS, viewPanelId, type ViewId } from "../../../src/shell/navigation-model";

export interface RoomsViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function RoomsView({ data, active, onSelect, refreshKey }: RoomsViewProps) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [agents, setAgents] = useState<AgentPersonaData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modals, setModals] = useState(createInitialModalState);

  const [roomName, setRoomName] = useState("");
  const [roomDesc, setRoomDesc] = useState("");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [topic, setTopic] = useState("");
  const [turns, setTurns] = useState<DiscussionTurn[]>([]);
  const [consensus, setConsensus] = useState("");
  const [showResults, setShowResults] = useState(false);
  const [discussing, setDiscussing] = useState(false);
  const [discussionError, setDiscussionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const roomList = await data.getRooms();
        if (cancelled) return;
        setRooms(Array.isArray(roomList) ? roomList : []);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, refreshKey]);

  const reload = async () => {
    try {
      const list = await data.getRooms();
      setRooms(Array.isArray(list) ? list : []);
    } catch {
      // Keep the last successful list on a refresh failure.
    }
  };

  const handleOpenCreate = async () => {
    setRoomName("");
    setRoomDesc("");
    setCreateError(null);
    // Like the legacy controller, read the roster when the dialog opens so new personas appear.
    try {
      const roster = data.getAgents ? await data.getAgents() : [];
      const members = (Array.isArray(roster) ? roster : []).filter((a) => a.kind !== "ROOM");
      setAgents(members);
      setSelectedMembers(members.map((a) => a.id));
    } catch {
      // Leave the last known roster in place.
    }
    setModals((state) => openCreateRoomModal(state));
  };

  const handleCreate = async () => {
    const input = { name: roomName, description: roomDesc, memberAgentIds: selectedMembers };
    const validation = validateCreateRoomInput(input);
    if (validation) {
      setCreateError(validation);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await data.createRoom(input);
      setModals((state) => closeCreateRoomModal(state));
      await reload();
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const handleOpenConvene = (room: Room) => {
    setModals((state) => openConveneModal(state, room.roomId));
    setTopic(room.activeTopic || "");
    setTurns([]);
    setConsensus("");
    setShowResults(false);
    setDiscussionError(null);
  };

  const handleStartDiscussion = async () => {
    const roomId = modals.activeRoomId;
    if (!roomId || !topic.trim()) return;
    setDiscussing(true);
    setDiscussionError(null);
    try {
      const result: DiscussionResult = await data.conveneDiscussion(roomId, topic.trim());
      setTurns((prev) => appendTurns(prev, result.turns));
      setConsensus(formatConsensus(result));
      setShowResults(true);
      await reload();
    } catch (err) {
      setDiscussionError(errorMessage(err));
    } finally {
      setDiscussing(false);
    }
  };

  const connections = NAV_GROUPS.find((group) => group.id === "connections");
  const activeRoom = rooms.find((room) => room.roomId === modals.activeRoomId);

  return (
    <div id={viewPanelId("rooms")} class={`view-panel ${active ? "" : "hidden"}`}>
      <div class="dashboard-container rooms-view-container">
        {connections && (
          <nav class="subnav-tabs" data-group={connections.id} aria-label="Connections views">
            {connections.tabs.map((tab) => (
              <button
                key={tab.view}
                type="button"
                class={`subnav-tab ${tab.view === "rooms" ? "active" : ""}`}
                data-view={tab.view}
                aria-current={tab.view === "rooms" ? "page" : undefined}
                onClick={() => onSelect(tab.view)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        )}

        <div class="dashboard-header">
          <div>
            <div class="dashboard-title">Multi-Agent Collaborative Rooms</div>
            <div class="dashboard-subtitle">
              Round-table discussion spaces where specialist personas deliberate and synthesize consensus.
            </div>
          </div>
          <button id="btnOpenCreateRoom" type="button" class="btn btn-primary" onClick={() => void handleOpenCreate()}>
            + Create Room
          </button>
        </div>

        {loadError && (
          <div class="rooms-error" role="alert">
            <span>Could not load rooms: {loadError}</span>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => void reload()}>Retry</button>
          </div>
        )}

        <div class="card-grid" id="roomsCardGrid">
          {loading ? (
            <div class="rooms-loading">Loading rooms…</div>
          ) : rooms.length === 0 ? (
            <div class="rooms-empty">No multi-agent rooms created yet. Click "+ Create Room" to convene a team.</div>
          ) : (
            rooms.map((room) => {
              const card = formatRoomCard(room);
              return (
                <div class="dashboard-card" key={card.roomId}>
                  <div class="card-top">
                    <div class="card-title">{card.title}</div>
                    <span class="badge badge-bot">{card.memberLabel}</span>
                  </div>
                  <div class="card-desc">{card.description}</div>
                  <div class="card-meta">
                    <span class="badge">{card.discussionLabel}</span>
                    {card.activeTopicLabel && (
                      <span class="badge" title={card.activeTopicTitle || undefined}>{card.activeTopicLabel}</span>
                    )}
                  </div>
                  <div class="card-footer">
                    <button
                      type="button"
                      class="btn btn-primary btn-xs btn-convene-room"
                      onClick={() => handleOpenConvene(room)}
                    >
                      Convene Deliberation ▶
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        id="createRoomModal"
        class={`modal-overlay${modals.createRoomModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="createRoomModalTitle"
      >
        <div class="modal-card">
          <div class="modal-header">
            <h3 id="createRoomModalTitle">Create Collaborative Room</h3>
            <button
              id="btnCloseCreateRoom"
              type="button"
              class="btn-close"
              aria-label="Close create room dialog"
              onClick={() => setModals((state) => closeCreateRoomModal(state))}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="roomName">Room Name</label>
              <input
                type="text"
                id="roomName"
                class="form-control"
                placeholder="e.g. Architecture Review Board"
                value={roomName}
                onInput={(e) => setRoomName((e.currentTarget as HTMLInputElement).value)}
              />
            </div>
            <div class="form-group">
              <label for="roomDesc">Mandate &amp; Description</label>
              <textarea
                id="roomDesc"
                class="form-control"
                rows={2}
                placeholder="e.g. Reviews system architecture and high-impact changes..."
                value={roomDesc}
                onInput={(e) => setRoomDesc((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </div>
            <div class="form-group">
              <label>Member Personas</label>
              <div id="roomMemberCheckboxes" class="room-member-checkboxes">
                {agents.filter((a) => a.kind !== "ROOM").map((agent) => (
                  <label key={agent.id} class="room-member-option">
                    <input
                      type="checkbox"
                      value={agent.id}
                      checked={selectedMembers.includes(agent.id)}
                      onChange={(e) => {
                        const checked = (e.currentTarget as HTMLInputElement).checked;
                        setSelectedMembers((prev) =>
                          checked ? [...prev, agent.id] : prev.filter((id) => id !== agent.id),
                        );
                      }}
                    />
                    <span>{agent.name} ({agent.role})</span>
                  </label>
                ))}
              </div>
            </div>
            <div id="roomFormError" class="room-form-error" role={createError ? "alert" : undefined}>
              {createError || ""}
            </div>
          </div>
          <div class="modal-actions">
            <button
              id="btnSaveRoom"
              type="button"
              class="btn btn-primary"
              disabled={creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "Creating..." : "Create Room"}
            </button>
          </div>
        </div>
      </div>

      <div
        id="conveneDiscussionModal"
        class={`modal-overlay${modals.conveneModalOpen ? "" : " hidden"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conveneModalTitle"
      >
        <div class="modal-card convene-modal-card">
          <div class="modal-header">
            <h3 id="conveneModalTitle">Convene Deliberation: {activeRoom?.name || "Room"}</h3>
            <button
              id="btnCloseConvene"
              type="button"
              class="btn-close"
              aria-label="Close discussion dialog"
              onClick={() => setModals((state) => closeConveneModal(state))}
            >
              &times;
            </button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label for="discussionTopic">Discussion Topic / Proposal</label>
              <textarea
                id="discussionTopic"
                class="form-control"
                rows={3}
                placeholder="e.g. Evaluate migrating the database layer to edge replication"
                value={topic}
                onInput={(e) => setTopic((e.currentTarget as HTMLTextAreaElement).value)}
              />
            </div>
            {discussionError && <div class="room-form-error" role="alert">{discussionError}</div>}
            <div id="discussionLiveResults" class={`discussion-live-results${showResults ? "" : " hidden"}`} aria-live="polite">
              <div class="sidebar-section-title">Round-table Contributions</div>
              <div class="discussion-feed" id="discussionFeedBox">
                {turns.map((turn) => (
                  <div class="discussion-turn" key={turn.turnIndex}>
                    <div class="turn-author">
                      Turn {turn.turnIndex}: {turn.memberName} ({turn.memberRole})
                    </div>
                    <div>{turn.content}</div>
                  </div>
                ))}
              </div>
              <div class="sidebar-section-title discussion-consensus-title">Consensus Verdict</div>
              <div class="consensus-box" id="consensusBox">{consensus}</div>
            </div>
          </div>
          <div class="modal-actions">
            <button
              id="btnStartDiscussion"
              type="button"
              class={`btn btn-primary${showResults ? " hidden" : ""}`}
              disabled={discussing || !topic.trim()}
              onClick={() => void handleStartDiscussion()}
            >
              {discussing ? "Deliberating..." : "Start Deliberation"}
            </button>
            <button
              id="btnCloseDiscussionDone"
              type="button"
              class={`btn btn-secondary${showResults ? "" : " hidden"}`}
              onClick={() => setModals((state) => closeConveneModal(state))}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
